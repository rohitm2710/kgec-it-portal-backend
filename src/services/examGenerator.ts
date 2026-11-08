import { db } from "../db/index.js";
import {
  exams,
  examRoutines,
  examQuestions,
  questions,
  ExamBlueprintConfig,
} from "../db/schema.js";
import { and, eq, sql, notInArray } from "drizzle-orm";

export interface CreateExamWithRoutineInput {
  title: string;
  subjectId: string;
  createdById: string;
  academicYear: number; // e.g., 3 for 3rd Year
  semester: number;     // e.g., 5 for 5th Semester
  examCategory: "MCQ_EXAM" | "SUBJECTIVE_EXAM" | "MIXED_EXAM";
  durationMinutes: number;
  scheduledStartTime: Date;
  scheduledEndTime: Date;
  notifyBeforeMinutes?: number; // Defaults to 10 minutes before start
  openRouterModel?: string;
  coveredModules?: string[];
  totalQuestions?: number;
  easyCount?: number;
  mediumCount?: number;
  hardCount?: number;
  blueprint: ExamBlueprintConfig;
}

/**
 * Helper: Picks random questions from Neon DB matching the exam's BlueprintConfig
 * if the paper hasn't been prepared yet.
 */
export async function prepareExamQuestionsFromBlueprintTx(
  tx: any,
  examId: string,
  subjectId: string,
  blueprint: ExamBlueprintConfig
) {
  const existing = await tx
    .select({ id: examQuestions.id })
    .from(examQuestions)
    .where(eq(examQuestions.examId, examId))
    .limit(1);

  if (existing.length > 0) {
    return; // Already prepared
  }

  const selectedQuestions: Array<{
    questionId: string;
    questionType: "MCQ" | "SAQ" | "LAQ" | "PROGRAMMING";
    difficulty: "EASY" | "MEDIUM" | "HARD";
    marksAllocated: string;
  }> = [];

  for (const rule of blueprint.rules || []) {
    if (rule.count <= 0) continue;

    const matchingQuestions = await tx
      .select({ id: questions.id })
      .from(questions)
      .where(
        and(
          eq(questions.subjectId, subjectId),
          eq(questions.questionType, rule.questionType),
          eq(questions.difficulty, rule.difficulty),
          eq(questions.isActive, true)
        )
      )
      .orderBy(sql`RANDOM()`)
      .limit(rule.count);

    if (matchingQuestions.length < rule.count) {
      throw new Error(
        `Insufficient questions in bank for [${rule.questionType} - ${rule.difficulty}]. ` +
          `Requested: ${rule.count}, Available: ${matchingQuestions.length}.`
      );
    }

    for (const q of matchingQuestions) {
      selectedQuestions.push({
        questionId: q.id,
        questionType: rule.questionType,
        difficulty: rule.difficulty,
        marksAllocated: rule.marksPerQuestion.toFixed(2),
      });
    }
  }

  const examQuestionRows = selectedQuestions.map((item, idx) => ({
    examId,
    questionId: item.questionId,
    questionType: item.questionType,
    difficulty: item.difficulty,
    marksAllocated: item.marksAllocated,
    sequenceOrder: idx + 1,
  }));

  await tx.insert(examQuestions).values(examQuestionRows);
  await tx
    .update(exams)
    .set({ isPaperPrepared: true })
    .where(eq(exams.id, examId));
}

export async function createExamAndScheduleRoutine(input: CreateExamWithRoutineInput) {
  return await db.transaction(async (tx) => {
    const computedTotalMarks = input.blueprint?.rules?.length
      ? input.blueprint.rules.reduce((sum, r) => sum + r.count * r.marksPerQuestion, 0)
      : ((input.totalQuestions || input.blueprint?.totalQuestions || 10) * (input.blueprint?.marksPerQuestion || 1));

    // 1. Create Exam Blueprint Record
    const [createdExam] = await tx
      .insert(exams)
      .values({
        title: input.title,
        subjectId: input.subjectId,
        createdById: input.createdById,
        academicYear: input.academicYear,
        semester: input.semester,
        examCategory: input.examCategory,
        durationMinutes: input.durationMinutes,
        totalMarks: computedTotalMarks.toFixed(2),
        coveredModules: input.coveredModules || input.blueprint?.coveredModules || [],
        totalQuestions: input.totalQuestions || input.blueprint?.totalQuestions || 10,
        easyCount: input.easyCount ?? input.blueprint?.easyCount ?? 0,
        mediumCount: input.mediumCount ?? input.blueprint?.mediumCount ?? 0,
        hardCount: input.hardCount ?? input.blueprint?.hardCount ?? 0,
        blueprintConfig: input.blueprint,
        isPaperPrepared: false,
        openRouterModel: input.openRouterModel || "google/gemini-2.5-pro",
      })
      .returning();

    // 2. Calculate exact 10-Minute Pre-Exam Notification Timestamp
    const notifyLeadMinutes = input.notifyBeforeMinutes ?? 10;
    const notificationTriggerTime = new Date(
      new Date(input.scheduledStartTime).getTime() - notifyLeadMinutes * 60 * 1000
    );

    // 3. Insert into Exam Routine Table
    const [routineEntry] = await tx
      .insert(examRoutines)
      .values({
        examId: createdExam.id,
        subjectId: input.subjectId,
        academicYear: input.academicYear,
        semester: input.semester,
        examCategory: input.examCategory,
        scheduledStartTime: new Date(input.scheduledStartTime),
        scheduledEndTime: new Date(input.scheduledEndTime),
        notifyBeforeMinutes: notifyLeadMinutes,
        notificationTriggerTime,
        routineStatus: "SCHEDULED",
        createdById: input.createdById,
      })
      .returning();

    return { exam: createdExam, routine: routineEntry };
  });
}

/**
 * Swaps a single question in an exam with another random question
 * from the same (subjectId, questionType, difficulty) bucket.
 */
export async function swapExamQuestion(examId: string, examQuestionId: string) {
  return await db.transaction(async (tx) => {
    // 1. Find the target exam question
    const [target] = await tx
      .select({
        id: examQuestions.id,
        examId: examQuestions.examId,
        questionId: examQuestions.questionId,
        questionType: examQuestions.questionType,
        difficulty: examQuestions.difficulty,
        subjectId: exams.subjectId,
      })
      .from(examQuestions)
      .innerJoin(exams, eq(examQuestions.examId, exams.id))
      .where(and(eq(examQuestions.id, examQuestionId), eq(examQuestions.examId, examId)));

    if (!target) {
      throw new Error("Exam question mapping not found.");
    }

    // 2. Find currently allocated questions to avoid picking duplicates
    const allocated = await tx
      .select({ questionId: examQuestions.questionId })
      .from(examQuestions)
      .where(eq(examQuestions.examId, examId));

    const allocatedIds = allocated.map((a: { questionId: string }) => a.questionId);

    // 3. Find a candidate replacement
    const [replacement] = await tx
      .select({ id: questions.id })
      .from(questions)
      .where(
        and(
          eq(questions.subjectId, target.subjectId),
          eq(questions.questionType, target.questionType),
          eq(questions.difficulty, target.difficulty),
          eq(questions.isActive, true),
          notInArray(questions.id, allocatedIds)
        )
      )
      .orderBy(sql`RANDOM()`)
      .limit(1);

    if (!replacement) {
      throw new Error("No alternative questions found in the Question Bank matching the required bucket.");
    }

    // 4. Update the exam question record
    const [updated] = await tx
      .update(examQuestions)
      .set({ questionId: replacement.id })
      .where(eq(examQuestions.id, target.id))
      .returning();

    return updated;
  });
}
