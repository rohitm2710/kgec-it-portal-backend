import { db } from "../db/index.js";
import {
  examRoutines,
  exams,
  examQuestions,
  questions,
  examSubmissions,
  users,
  subjects,
} from "../db/schema.js";
import { and, eq, gte, lte, asc } from "drizzle-orm";
import { prepareExamQuestionsFromBlueprintTx } from "./examGenerator.js";

/**
 * Gatekeeper Service: Enforces 10-Minute Pre-Exam preparation and access rules
 * for students based on their academicYear.
 */
export async function verifyAndPrepareStudentExamAccess(studentId: string) {
  return await db.transaction(async (tx) => {
    // 1. Fetch Student Profile to check their Academic Year (e.g., 3rd Year -> academicYear = 3)
    const [student] = await tx
      .select()
      .from(users)
      .where(eq(users.id, studentId));

    if (!student || student.role !== "STUDENT" || !student.academicYear) {
      throw new Error("Valid student profile with academicYear is required.");
    }

    const now = new Date();
    const endOfDay = new Date(now);
    endOfDay.setHours(23, 59, 59, 999);

    // 2. Ask Exam Routine: "Does this student's Academic Year (e.g., 3rd Year) have an exam today?"
    const [upcomingOrLiveRoutine] = await tx
      .select({
        routine: examRoutines,
        exam: exams,
        subjectName: subjects.subjectName,
        subjectCode: subjects.subjectCode,
      })
      .from(examRoutines)
      .innerJoin(exams, eq(examRoutines.examId, exams.id))
      .innerJoin(subjects, eq(examRoutines.subjectId, subjects.id))
      .where(
        and(
          eq(examRoutines.academicYear, student.academicYear),
          gte(examRoutines.scheduledEndTime, now),
          lte(examRoutines.scheduledStartTime, endOfDay)
        )
      )
      .orderBy(asc(examRoutines.scheduledStartTime))
      .limit(1);

    // CASE 1: No exam scheduled for 3rd Year (or student's year)
    if (!upcomingOrLiveRoutine) {
      return {
        canEnterExam: false,
        notificationVisible: false,
        gateStatus: "NO_EXAM_SCHEDULED" as const,
        message: `No upcoming exam is scheduled in the routine for Year ${student.academicYear} students right now.`,
      };
    }

    const { routine, exam, subjectName, subjectCode } = upcomingOrLiveRoutine;
    const msUntilStart = new Date(routine.scheduledStartTime).getTime() - now.getTime();
    const msUntilNotification =
      new Date(routine.notificationTriggerTime).getTime() - now.getTime();

    // CASE 2: Exam exists in routine, but NOW is earlier than (scheduledStartTime - 10 minutes)
    if (now < new Date(routine.notificationTriggerTime)) {
      return {
        canEnterExam: false,
        notificationVisible: false, // Strictly hidden until 10 minutes before start
        gateStatus: "NOT_TIME_YET" as const,
        message:
          "It is not time for your exam yet. You will receive the exam notification 10 minutes before the scheduled start time.",
        secondsUntilNotificationWindow: Math.ceil(msUntilNotification / 1000),
        scheduledStartTime: routine.scheduledStartTime,
      };
    }

    // =========================================================================
    // CASE 3 & CASE 4: We are inside the 10-Minute Pre-Exam Window OR Live Window!
    // Auto-prepare the Question Paper from the DB Blueprint if not yet prepared,
    // and pre-initialize the student's submission session.
    // =========================================================================
    if (!exam.isPaperPrepared) {
      await prepareExamQuestionsFromBlueprintTx(
        tx,
        exam.id,
        exam.subjectId,
        exam.blueprintConfig
      );
    }

    // Ensure student has a prepared submission record ready
    const [existingSubmission] = await tx
      .select()
      .from(examSubmissions)
      .where(
        and(
          eq(examSubmissions.examId, exam.id),
          eq(examSubmissions.studentId, student.id)
        )
      );

    let submission = existingSubmission;
    if (!submission) {
      const [createdSub] = await tx
        .insert(examSubmissions)
        .values({
          examId: exam.id,
          routineId: routine.id,
          studentId: student.id,
          submissionMode: "ONLINE_PORTAL",
          status: now < new Date(routine.scheduledStartTime) ? "PREPARED" : "IN_PROGRESS",
          startedAt: now >= new Date(routine.scheduledStartTime) ? now : null,
        })
        .returning();
      submission = createdSub;
    }

    // CASE 3: Inside the 10-Minute Pre-Exam Notification & Preparation Window
    // (scheduledStartTime - 10 mins <= NOW < scheduledStartTime)
    if (now < new Date(routine.scheduledStartTime)) {
      await tx
        .update(examRoutines)
        .set({
          routineStatus: "PRE_EXAM_NOTIFY",
          notificationSent: true,
        })
        .where(eq(examRoutines.id, routine.id));

      return {
        canEnterExam: false, // In lobby; paper is prepared in DB, waiting for exact start second
        notificationVisible: true, // 10-minute alert is now active!
        gateStatus: "PRE_EXAM_PREPARE_10_MIN" as const,
        message: `Upcoming Exam Alert: "${exam.title}" (${subjectCode}) starts in ${Math.max(
          1,
          Math.ceil(msUntilStart / 60000)
        )} minute(s). Your question paper has been prepared—please wait in the lobby.`,
        examSummary: {
          examId: exam.id,
          routineId: routine.id,
          title: exam.title,
          subjectCode,
          subjectName,
          academicYear: routine.academicYear,
          examCategory: exam.examCategory,
          durationMinutes: exam.durationMinutes,
          totalMarks: exam.totalMarks,
          scheduledStartTime: routine.scheduledStartTime,
          secondsUntilStart: Math.max(0, Math.ceil(msUntilStart / 1000)),
        },
      };
    }

    // CASE 4: Exam Window is LIVE (scheduledStartTime <= NOW <= scheduledEndTime)
    if (submission.status === "PREPARED") {
      await tx
        .update(examSubmissions)
        .set({ status: "IN_PROGRESS", startedAt: now })
        .where(eq(examSubmissions.id, submission.id));
    }

    // Fetch sanitized questions (strip correctOptionId and referenceAnswer before sending to student)
    const paperQuestions = await tx
      .select({
        examQuestionId: examQuestions.id,
        questionId: questions.id,
        sequenceOrder: examQuestions.sequenceOrder,
        questionType: examQuestions.questionType,
        difficulty: examQuestions.difficulty,
        marksAllocated: examQuestions.marksAllocated,
        questionText: questions.questionText,
        diagramImageUrl: questions.diagramImageUrl,
        mcqOptions: questions.mcqOptions,
      })
      .from(examQuestions)
      .innerJoin(questions, eq(examQuestions.questionId, questions.id))
      .where(eq(examQuestions.examId, exam.id))
      .orderBy(asc(examQuestions.sequenceOrder));

    return {
      canEnterExam: true,
      notificationVisible: true,
      gateStatus: "EXAM_LIVE_ENTER" as const,
      message: "Exam is live. Good luck!",
      submissionId: submission.id,
      exam: {
        examId: exam.id,
        title: exam.title,
        subjectCode,
        subjectName,
        durationMinutes: exam.durationMinutes,
        scheduledEndTime: routine.scheduledEndTime,
        totalMarks: exam.totalMarks,
      },
      questions: paperQuestions,
    };
  });
}

/**
 * Polling endpoint for student notifications.
 * Returns alerts strictly if NOW >= (scheduledStartTime - 10 minutes) for student's year.
 */
export async function getStudentExamNotifications(studentId: string) {
  const [student] = await db
    .select()
    .from(users)
    .where(eq(users.id, studentId));

  if (!student || student.role !== "STUDENT" || !student.academicYear) {
    return { notifications: [] };
  }

  const now = new Date();

  const activeRoutines = await db
    .select({
      routine: examRoutines,
      examTitle: exams.title,
      subjectCode: subjects.subjectCode,
    })
    .from(examRoutines)
    .innerJoin(exams, eq(examRoutines.examId, exams.id))
    .innerJoin(subjects, eq(examRoutines.subjectId, subjects.id))
    .where(
      and(
        eq(examRoutines.academicYear, student.academicYear),
        lte(examRoutines.notificationTriggerTime, now),
        gte(examRoutines.scheduledEndTime, now)
      )
    );

  const notifications = activeRoutines.map((r) => {
    const isLive = now >= new Date(r.routine.scheduledStartTime);
    const msUntilStart = new Date(r.routine.scheduledStartTime).getTime() - now.getTime();

    return {
      routineId: r.routine.id,
      examId: r.routine.examId,
      title: r.examTitle,
      subjectCode: r.subjectCode,
      status: isLive ? "LIVE" : "STARTING_SOON",
      message: isLive
        ? `Live Assessment: "${r.examTitle}" is currently in progress. Enter now!`
        : `10-Minute Alert: "${r.examTitle}" begins in ${Math.ceil(msUntilStart / 60000)} minute(s). Question paper is prepared.`,
      scheduledStartTime: r.routine.scheduledStartTime,
      scheduledEndTime: r.routine.scheduledEndTime,
    };
  });

  return { notifications };
}
