import { db } from "../db/index.js";
import { examSubmissions, submissionAnswers, examQuestions } from "../db/schema.js";
import { eq, sql } from "drizzle-orm";

interface ManualMarkOverrideInput {
  submissionAnswerId: string;
  teacherId: string;
  newMarks: number;
  teacherComment?: string;
}

export async function overrideQuestionMarks(input: ManualMarkOverrideInput) {
  return await db.transaction(async (tx) => {
    const [answerRecord] = await tx
      .select({
        id: submissionAnswers.id,
        submissionId: submissionAnswers.submissionId,
        maxMarks: examQuestions.marksAllocated,
      })
      .from(submissionAnswers)
      .innerJoin(
        examQuestions,
        eq(submissionAnswers.examQuestionId, examQuestions.id)
      )
      .where(eq(submissionAnswers.id, input.submissionAnswerId));

    if (!answerRecord) {
      throw new Error("Submission answer record not found.");
    }

    const maxAllowed = Number(answerRecord.maxMarks);
    if (input.newMarks < 0 || input.newMarks > maxAllowed) {
      throw new Error(
        `Invalid marks: ${input.newMarks}. Must be between 0 and ${maxAllowed}.`
      );
    }

    const formattedMarks = input.newMarks.toFixed(2);
    await tx
      .update(submissionAnswers)
      .set({
        isManuallyOverridden: true,
        manualOverrideMarks: formattedMarks,
        finalAwardedMarks: formattedMarks,
        teacherComment: input.teacherComment,
        overriddenById: input.teacherId,
        overriddenAt: new Date(),
      })
      .where(eq(submissionAnswers.id, input.submissionAnswerId));

    const [totals] = await tx
      .select({
        newTotal: sql<string>`COALESCE(SUM(${submissionAnswers.finalAwardedMarks}), 0.00)`,
      })
      .from(submissionAnswers)
      .where(eq(submissionAnswers.submissionId, answerRecord.submissionId));

    const [updatedSubmission] = await tx
      .update(examSubmissions)
      .set({
        totalFinalMarks: totals.newTotal,
        status: "MANUAL_OVERRIDDEN",
        evaluatedById: input.teacherId,
        evaluatedAt: new Date(),
      })
      .where(eq(examSubmissions.id, answerRecord.submissionId))
      .returning();

    return updatedSubmission;
  });
}

/**
 * Direct entry of student marks without AI or OCR (e.g. from Manual Marks Entry module)
 */
export async function directEnterSubmissionMarks(
  submissionId: string,
  teacherId: string,
  totalMarks: number,
  teacherFeedback?: string
) {
  return await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(examSubmissions)
      .set({
        totalFinalMarks: totalMarks.toFixed(2),
        status: "MANUAL_OVERRIDDEN",
        evaluatedById: teacherId,
        teacherOverallFeedback: teacherFeedback,
        evaluatedAt: new Date(),
      })
      .where(eq(examSubmissions.id, submissionId))
      .returning();

    if (!updated) {
      throw new Error("Submission not found.");
    }

    return updated;
  });
}
