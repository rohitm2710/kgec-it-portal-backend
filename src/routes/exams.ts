import { Router, Request, Response } from "express";
import { db } from "../db/index.js";
import { exams, examRoutines, subjects, examSubmissions, users } from "../db/schema.js";
import { createExamAndScheduleRoutine, swapExamQuestion } from "../services/examGenerator.js";
import { authenticate, optionalAuthenticate, requireRole } from "../middleware/auth.js";
import { eq, or, desc, and, asc, sql } from "drizzle-orm";

const router = Router();

/**
 * Helper to resolve subjectId from either UUID or course code (e.g., 'PCC-CS601')
 */
async function resolveSubjectId(subjectInput: string, semesterNum: number): Promise<string> {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(subjectInput);
  if (isUuid) return subjectInput;

  const codeMatch = subjectInput.match(/([A-Z0-9]+-[A-Z0-9]+)/i);
  const searchCode = codeMatch ? codeMatch[1].toUpperCase() : subjectInput.trim();

  const [existing] = await db
    .select({ id: subjects.id })
    .from(subjects)
    .where(or(eq(subjects.subjectCode, searchCode), eq(subjects.subjectCode, subjectInput)))
    .limit(1);

  if (existing) return existing.id;

  const yearNum = semesterNum > 6 ? 4 : semesterNum > 4 ? 3 : 2;
  const [created] = await db
    .insert(subjects)
    .values({
      subjectCode: searchCode,
      subjectName: subjectInput,
      academicYear: yearNum,
      semester: semesterNum,
    })
    .returning();

  return created.id;
}

/**
 * GET /api/exams
 * Role: TEACHER, ADMIN, STUDENT
 * Lists all configured exams with covered units, difficulty distributions, and schedule
 */
router.get("/", authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const currentUserId = req.user?.id;
    const isTeacher = req.user?.role === "TEACHER";
    const isAdmin = req.user?.role === "ADMIN";

    let list = await db
      .select({
        id: exams.id,
        title: exams.title,
        subjectId: exams.subjectId,
        subjectCode: subjects.subjectCode,
        subjectName: subjects.subjectName,
        createdById: exams.createdById,
        sharedWithTeacherIds: exams.sharedWithTeacherIds,
        academicYear: exams.academicYear,
        semester: exams.semester,
        examCategory: exams.examCategory,
        durationMinutes: exams.durationMinutes,
        totalMarks: exams.totalMarks,
        coveredModules: exams.coveredModules,
        totalQuestions: exams.totalQuestions,
        easyCount: exams.easyCount,
        mediumCount: exams.mediumCount,
        hardCount: exams.hardCount,
        blueprintConfig: exams.blueprintConfig,
        isPaperPrepared: exams.isPaperPrepared,
        createdAt: exams.createdAt,
      })
      .from(exams)
      .leftJoin(subjects, eq(exams.subjectId, subjects.id))
      .orderBy(desc(exams.createdAt));

    if (isTeacher && currentUserId) {
      list = list.filter((exam) => {
        const isOwner = exam.createdById === currentUserId;
        const isShared = Array.isArray(exam.sharedWithTeacherIds) && exam.sharedWithTeacherIds.includes(currentUserId);
        return isOwner || isShared;
      });
    }

    res.status(200).json({ count: list.length, exams: list });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to list exams." });
  }
});

function computeLetterGrade(percentage: number): string {
  if (percentage >= 90) return "O";
  if (percentage >= 80) return "A+";
  if (percentage >= 70) return "A";
  if (percentage >= 60) return "B+";
  if (percentage >= 50) return "B";
  if (percentage >= 40) return "P";
  return "F";
}

const isValidUuid = (val: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val);

/**
 * GET /api/exams/ledger/summary
 * Role: TEACHER, ADMIN, STUDENT
 * Returns list of previous/concluded exams with enrolled count, appeared count, and absent count
 */
router.get("/ledger/summary", optionalAuthenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    let examList = await db
      .select({
        id: exams.id,
        title: exams.title,
        subjectId: exams.subjectId,
        subjectCode: subjects.subjectCode,
        subjectName: subjects.subjectName,
        createdById: exams.createdById,
        sharedWithTeacherIds: exams.sharedWithTeacherIds,
        academicYear: exams.academicYear,
        semester: exams.semester,
        examCategory: exams.examCategory,
        durationMinutes: exams.durationMinutes,
        totalMarks: exams.totalMarks,
        createdAt: exams.createdAt,
      })
      .from(exams)
      .leftJoin(subjects, eq(exams.subjectId, subjects.id))
      .orderBy(desc(exams.createdAt));

    // Role-based visibility for teachers: only their own exams or shared exams
    const currentUserId = req.user?.id;
    if (req.user?.role === "TEACHER" && currentUserId) {
      examList = examList.filter((exam) => {
        const isOwner = exam.createdById === currentUserId;
        const isShared = Array.isArray(exam.sharedWithTeacherIds) && exam.sharedWithTeacherIds.includes(currentUserId);
        return isOwner || isShared;
      });
    }

    // Get count of students per semester
    const allStudents = await db
      .select({
        id: users.id,
        semester: users.semester,
        academicYear: users.academicYear,
      })
      .from(users)
      .where(eq(users.role, "STUDENT"));

    // Get all submissions grouped by exam
    const allSubmissions = await db
      .select({
        examId: examSubmissions.examId,
        studentId: examSubmissions.studentId,
        totalFinalMarks: examSubmissions.totalFinalMarks,
        status: examSubmissions.status,
      })
      .from(examSubmissions);

    const submissionsByExam = new Map<string, any[]>();
    for (const sub of allSubmissions) {
      if (!submissionsByExam.has(sub.examId)) {
        submissionsByExam.set(sub.examId, []);
      }
      submissionsByExam.get(sub.examId)!.push(sub);
    }

    const result = examList.map((exam) => {
      // Find students enrolled in this exam's semester
      let enrolled = allStudents.filter((s) => s.semester === exam.semester);
      if (enrolled.length === 0 && exam.academicYear) {
        enrolled = allStudents.filter((s) => s.academicYear === exam.academicYear);
      }
      if (enrolled.length === 0) {
        enrolled = allStudents;
      }

      const examSubs = submissionsByExam.get(exam.id) || [];
      const appearedSubs = examSubs.filter(
        (s) => s.status !== "PREPARED" && s.status !== "IN_PROGRESS"
      );

      const enrolledCount = enrolled.length;
      const appearedCount = appearedSubs.length;
      const absentCount = Math.max(0, enrolledCount - appearedCount);

      let classAverage = 0;
      if (appearedCount > 0) {
        const sumMarks = appearedSubs.reduce(
          (acc, cur) => acc + (Number(cur.totalFinalMarks) || 0),
          0
        );
        classAverage = Number((sumMarks / appearedCount).toFixed(2));
      }

      return {
        id: exam.id,
        title: exam.title,
        subjectId: exam.subjectId,
        subjectCode: exam.subjectCode || "PCC-IT601",
        subjectName: exam.subjectName || exam.title,
        academicYear: exam.academicYear,
        semester: exam.semester,
        examCategory: exam.examCategory,
        durationMinutes: exam.durationMinutes,
        totalMarks: Number(exam.totalMarks) || 30,
        enrolledCount,
        appearedCount,
        absentCount,
        classAverage,
        createdAt: exam.createdAt,
      };
    });

    res.status(200).json({ count: result.length, exams: result });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to fetch exam ledger summary." });
  }
});

/**
 * GET /api/exams/:examId/marks-ledger
 * Role: TEACHER, ADMIN, STUDENT
 * Returns full marks ledger for all enrolled students in the exam.
 * If student has not submitted or appeared, displays 'AB' for marks, percentage, and grade.
 */
router.get("/:examId/marks-ledger", optionalAuthenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const { examId } = req.params;

    if (!isValidUuid(examId)) {
      res.status(400).json({ error: "Invalid examId format." });
      return;
    }

    const [exam] = await db
      .select({
        id: exams.id,
        title: exams.title,
        subjectId: exams.subjectId,
        subjectCode: subjects.subjectCode,
        subjectName: subjects.subjectName,
        academicYear: exams.academicYear,
        semester: exams.semester,
        examCategory: exams.examCategory,
        durationMinutes: exams.durationMinutes,
        totalMarks: exams.totalMarks,
        createdAt: exams.createdAt,
      })
      .from(exams)
      .leftJoin(subjects, eq(exams.subjectId, subjects.id))
      .where(eq(exams.id, examId))
      .limit(1);

    if (!exam) {
      res.status(404).json({ error: "Exam not found in database." });
      return;
    }

    // Query enrolled students for this semester
    let enrolledStudents = await db
      .select({
        id: users.id,
        fullName: users.fullName,
        institutionalId: users.institutionalId,
        semester: users.semester,
        academicYear: users.academicYear,
        email: users.email,
      })
      .from(users)
      .where(
        and(
          eq(users.role, "STUDENT"),
          exam.semester ? eq(users.semester, exam.semester) : undefined
        )
      )
      .orderBy(asc(users.institutionalId));

    if (enrolledStudents.length === 0 && exam.academicYear) {
      enrolledStudents = await db
        .select({
          id: users.id,
          fullName: users.fullName,
          institutionalId: users.institutionalId,
          semester: users.semester,
          academicYear: users.academicYear,
          email: users.email,
        })
        .from(users)
        .where(
          and(
            eq(users.role, "STUDENT"),
            eq(users.academicYear, exam.academicYear)
          )
        )
        .orderBy(asc(users.institutionalId));
    }

    if (enrolledStudents.length === 0) {
      enrolledStudents = await db
        .select({
          id: users.id,
          fullName: users.fullName,
          institutionalId: users.institutionalId,
          semester: users.semester,
          academicYear: users.academicYear,
          email: users.email,
        })
        .from(users)
        .where(eq(users.role, "STUDENT"))
        .orderBy(asc(users.institutionalId));
    }

    // Query existing submissions for this exam
    const submissions = await db
      .select({
        id: examSubmissions.id,
        studentId: examSubmissions.studentId,
        totalMcqMarks: examSubmissions.totalMcqMarks,
        totalAiSubjectiveMarks: examSubmissions.totalAiSubjectiveMarks,
        totalFinalMarks: examSubmissions.totalFinalMarks,
        status: examSubmissions.status,
        submissionMode: examSubmissions.submissionMode,
        submittedAt: examSubmissions.submittedAt,
        teacherOverallFeedback: examSubmissions.teacherOverallFeedback,
      })
      .from(examSubmissions)
      .where(eq(examSubmissions.examId, examId));

    const subMap = new Map<string, any>();
    for (const sub of submissions) {
      subMap.set(sub.studentId, sub);
    }

    const maxMarks = Number(exam.totalMarks) || 30;
    let totalScoreSum = 0;
    let appearedCount = 0;
    let highestScore = 0;
    let lowestScore = maxMarks;

    const ledger = enrolledStudents.map((student) => {
      const sub = subMap.get(student.id);
      const isAppeared =
        sub &&
        (sub.status === "SUBMITTED" ||
          sub.status === "AI_GRADED" ||
          sub.status === "MANUAL_OVERRIDDEN" ||
          sub.status === "FINALIZED" ||
          sub.submittedAt != null);

      if (isAppeared) {
        appearedCount++;
        const marks = Number(sub.totalFinalMarks) || 0;
        totalScoreSum += marks;
        if (marks > highestScore) highestScore = marks;
        if (marks < lowestScore) lowestScore = marks;

        const percentage = Number(((marks / maxMarks) * 100).toFixed(1));
        const grade = computeLetterGrade(percentage);

        return {
          studentId: student.id,
          studentName: student.fullName,
          studentRoll: student.institutionalId,
          semester: student.semester,
          academicYear: student.academicYear,
          email: student.email,
          status: "APPEARED",
          submissionStatus: sub.status,
          submissionMode: sub.submissionMode || "ONLINE_PORTAL",
          marksObtained: marks,
          maxMarks,
          percentage: `${percentage}%`,
          percentageVal: percentage,
          grade,
          feedback: sub.teacherOverallFeedback || "Assessment complete",
          submittedAt: sub.submittedAt,
        };
      } else {
        return {
          studentId: student.id,
          studentName: student.fullName,
          studentRoll: student.institutionalId,
          semester: student.semester,
          academicYear: student.academicYear,
          email: student.email,
          status: "ABSENT",
          submissionStatus: "ABSENT",
          submissionMode: null,
          marksObtained: "AB",
          maxMarks,
          percentage: "AB",
          percentageVal: null,
          grade: "AB",
          feedback: "Student was absent for this examination.",
          submittedAt: null,
        };
      }
    });

    const absentCount = enrolledStudents.length - appearedCount;
    const classAverage =
      appearedCount > 0 ? Number((totalScoreSum / appearedCount).toFixed(2)) : 0;
    if (appearedCount === 0) {
      lowestScore = 0;
    }

    res.status(200).json({
      exam: {
        id: exam.id,
        title: exam.title,
        subjectCode: exam.subjectCode || "PCC-IT601",
        subjectName: exam.subjectName || exam.title,
        academicYear: exam.academicYear,
        semester: exam.semester,
        durationMinutes: exam.durationMinutes,
        totalMarks: maxMarks,
        examCategory: exam.examCategory,
        createdAt: exam.createdAt,
      },
      summary: {
        totalEnrolled: enrolledStudents.length,
        appearedCount,
        absentCount,
        classAverage,
        highestScore: appearedCount > 0 ? highestScore : 0,
        lowestScore: appearedCount > 0 ? lowestScore : 0,
        passPercentage:
          appearedCount > 0
            ? Number(
                (
                  (ledger.filter(
                    (r) => r.status === "APPEARED" && (r.percentageVal ?? 0) >= 40
                  ).length /
                    appearedCount) *
                  100
                ).toFixed(1)
              )
            : 0,
      },
      ledger,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to fetch exam marks ledger." });
  }
});

/**
 * POST /api/exams/configure
 * Role: TEACHER, ADMIN
 * Full exam configuration: timing, semester, subject, format (MCQ vs SAQ/LAQ),
 * covered modules (Unit 1, 2, 3...), and difficulty distribution (easy/medium/hard).
 */
router.post("/configure", authenticate, requireRole("TEACHER", "ADMIN"), async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      title,
      semester,
      academicYear,
      subjectId,
      examType = "MCQ", // "MCQ" | "SAQ_LAQ" | "SUBJECTIVE"
      startTime,
      scheduledStartTime,
      durationMinutes = 60,
      coveredModules = [],
      totalQuestions = 10,
      easyCount = 4,
      mediumCount = 4,
      hardCount = 2,
      marksPerQuestion,
      notifyBeforeMinutes = 10,
      openRouterModel = "google/gemini-2.5-pro",
    } = req.body;

    const semNum = Number(semester) || 6;
    const yearNum = academicYear ? Number(academicYear) : (semNum > 6 ? 4 : semNum > 4 ? 3 : 2);
    const resolvedSubjectId = await resolveSubjectId(subjectId || "PCC-CS601", semNum);

    const start = new Date(startTime || scheduledStartTime || Date.now());
    const duration = Number(durationMinutes) || 60;
    const end = new Date(start.getTime() + duration * 60 * 1000);

    const normalizedCategory = (examType === "MCQ" || examType === "MCQ_EXAM") ? "MCQ_EXAM" : "SUBJECTIVE_EXAM";
    const defaultMark = marksPerQuestion ? Number(marksPerQuestion) : (normalizedCategory === "MCQ_EXAM" ? 1 : 5);
    const totalQ = Number(totalQuestions) || (Number(easyCount) + Number(mediumCount) + Number(hardCount)) || 10;
    const computedTotalMarks = totalQ * defaultMark;

    const parsedModules = Array.isArray(coveredModules) && coveredModules.length > 0
      ? coveredModules
      : ["Unit 1", "Unit 2", "Unit 3"];

    // Structured blueprint configuration (saved in DB for later random picking)
    const blueprint = {
      totalQuestions: totalQ,
      easyCount: Number(easyCount) || 0,
      mediumCount: Number(mediumCount) || 0,
      hardCount: Number(hardCount) || 0,
      coveredModules: parsedModules,
      examFormat: normalizedCategory === "MCQ_EXAM" ? ("MCQ" as const) : ("SAQ_LAQ" as const),
      marksPerQuestion: defaultMark,
      rules: [
        {
          questionType: normalizedCategory === "MCQ_EXAM" ? ("MCQ" as const) : ("SAQ" as const),
          difficulty: "EASY" as const,
          count: Number(easyCount) || 0,
          marksPerQuestion: defaultMark,
        },
        {
          questionType: normalizedCategory === "MCQ_EXAM" ? ("MCQ" as const) : ("SAQ" as const),
          difficulty: "MEDIUM" as const,
          count: Number(mediumCount) || 0,
          marksPerQuestion: defaultMark,
        },
        {
          questionType: normalizedCategory === "MCQ_EXAM" ? ("MCQ" as const) : ("SAQ" as const),
          difficulty: "HARD" as const,
          count: Number(hardCount) || 0,
          marksPerQuestion: defaultMark,
        },
      ],
      shuffleQuestions: true,
      allowPartialMarkingInAi: true,
      strictnessLevel: "MODERATE" as const,
    };

    const examTitle = title || `${normalizedCategory === "MCQ_EXAM" ? "MCQ" : "Subjective"} Examination - Sem ${semNum}`;

    const result = await createExamAndScheduleRoutine({
      title: examTitle,
      subjectId: resolvedSubjectId,
      createdById: req.user!.id,
      academicYear: yearNum,
      semester: semNum,
      examCategory: normalizedCategory,
      durationMinutes: duration,
      scheduledStartTime: start,
      scheduledEndTime: end,
      notifyBeforeMinutes: Number(notifyBeforeMinutes),
      openRouterModel,
      coveredModules: parsedModules,
      totalQuestions: totalQ,
      easyCount: blueprint.easyCount,
      mediumCount: blueprint.mediumCount,
      hardCount: blueprint.hardCount,
      blueprint,
    });

    res.status(201).json({
      message: "Exam configured and scheduled successfully in Neon database.",
      exam: {
        id: result.exam.id,
        title: result.exam.title,
        semester: result.exam.semester,
        academicYear: result.exam.academicYear,
        examCategory: result.exam.examCategory,
        durationMinutes: result.exam.durationMinutes,
        totalMarks: result.exam.totalMarks,
        coveredModules: result.exam.coveredModules,
        totalQuestions: result.exam.totalQuestions,
        easyCount: result.exam.easyCount,
        mediumCount: result.exam.mediumCount,
        hardCount: result.exam.hardCount,
      },
      routine: {
        id: result.routine.id,
        scheduledStartTime: result.routine.scheduledStartTime,
        scheduledEndTime: result.routine.scheduledEndTime,
        notificationTriggerTime: result.routine.notificationTriggerTime,
        routineStatus: result.routine.routineStatus,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to configure exam." });
  }
});

/**
 * POST /api/exams/generate-from-blueprint
 * Role: TEACHER, ADMIN (Backward Compatibility)
 */
router.post("/generate-from-blueprint", authenticate, requireRole("TEACHER", "ADMIN"), async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      title,
      subjectId,
      academicYear,
      semester,
      examCategory,
      durationMinutes,
      scheduledStartTime,
      scheduledEndTime,
      notifyBeforeMinutes = 10,
      openRouterModel = "google/gemini-2.5-pro",
      blueprint,
      coveredModules,
      totalQuestions,
      easyCount,
      mediumCount,
      hardCount,
    } = req.body;

    if (!title || !subjectId || !academicYear || !semester || !scheduledStartTime || !scheduledEndTime || !blueprint) {
      res.status(400).json({
        error: "Missing required fields for blueprint exam generation.",
      });
      return;
    }

    const resolvedSubjectId = await resolveSubjectId(subjectId, Number(semester));

    const result = await createExamAndScheduleRoutine({
      title,
      subjectId: resolvedSubjectId,
      createdById: req.user!.id,
      academicYear: Number(academicYear),
      semester: Number(semester),
      examCategory: examCategory || "MIXED_EXAM",
      durationMinutes: Number(durationMinutes),
      scheduledStartTime: new Date(scheduledStartTime),
      scheduledEndTime: new Date(scheduledEndTime),
      notifyBeforeMinutes: Number(notifyBeforeMinutes),
      openRouterModel,
      coveredModules: coveredModules || blueprint?.coveredModules || [],
      totalQuestions: totalQuestions || blueprint?.totalQuestions || 10,
      easyCount: easyCount ?? blueprint?.easyCount ?? 0,
      mediumCount: mediumCount ?? blueprint?.mediumCount ?? 0,
      hardCount: hardCount ?? blueprint?.hardCount ?? 0,
      blueprint,
    });

    res.status(201).json({
      message: "Exam blueprint generated and scheduled in Exam Routine successfully.",
      examId: result.exam.id,
      routineId: result.routine.id,
      academicYear: result.routine.academicYear,
      semester: result.routine.semester,
      scheduledStartTime: result.routine.scheduledStartTime,
      notificationTriggerTime: result.routine.notificationTriggerTime,
      totalMarks: Number(result.exam.totalMarks),
      routineStatus: result.routine.routineStatus,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to generate exam from blueprint." });
  }
});

/**
 * POST /api/exams/:examId/swap-question/:examQuestionId
 * Role: TEACHER
 */
router.post("/:examId/swap-question/:examQuestionId", authenticate, requireRole("TEACHER", "ADMIN"), async (req: Request, res: Response): Promise<void> => {
  try {
    const { examId, examQuestionId } = req.params;
    const updated = await swapExamQuestion(examId, examQuestionId);

    res.status(200).json({
      message: "Question swapped successfully with a new candidate from Question Bank.",
      updatedQuestion: updated,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to swap exam question." });
  }
});

export default router;
