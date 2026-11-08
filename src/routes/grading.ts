import { Router, Request, Response } from "express";
import { db } from "../db/index.js";
import {
  examSubmissions,
  submissionAnswers,
  questions,
  examQuestions,
} from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { authenticate, requireRole } from "../middleware/auth.js";
import { extractTextFromScannedCopy, evaluateSubjectiveAnswerWithOpenRouter } from "../services/aiGradingService.js";
import { overrideQuestionMarks, directEnterSubmissionMarks } from "../services/manualGradingService.js";

const router = Router();

/**
 * POST /api/grading/submissions/upload-scan
 * Role: TEACHER
 * Uploads scanned answer script images, runs OCR per answer, and triggers OpenRouter AI evaluation
 */
router.post("/submissions/upload-scan", authenticate, requireRole("TEACHER", "ADMIN"), async (req: Request, res: Response): Promise<void> => {
  try {
    const { studentId, examId, scannedScriptUrls } = req.body;

    if (!studentId || !examId || !scannedScriptUrls || !Array.isArray(scannedScriptUrls)) {
      res.status(400).json({
        error: "studentId, examId, and scannedScriptUrls array are required.",
      });
      return;
    }

    // 1. Run OCR extraction hook
    const ocrResult = await extractTextFromScannedCopy(scannedScriptUrls);

    // 2. Fetch or create submission record
    let [submission] = await db
      .select()
      .from(examSubmissions)
      .where(and(eq(examSubmissions.examId, examId), eq(examSubmissions.studentId, studentId)));

    if (!submission) {
      const [newSub] = await db
        .insert(examSubmissions)
        .values({
          examId,
          studentId,
          submissionMode: "SCANNED_SCRIPT",
          status: "OCR_COMPLETED",
          scannedScriptUrls,
        })
        .returning();
      submission = newSub;
    } else {
      const [updated] = await db
        .update(examSubmissions)
        .set({
          submissionMode: "SCANNED_SCRIPT",
          status: "OCR_COMPLETED",
          scannedScriptUrls,
        })
        .where(eq(examSubmissions.id, submission.id))
        .returning();
      submission = updated;
    }

    // 3. Fetch Exam Questions and evaluate with OpenRouter AI
    const examQuestionsList = await db
      .select({
        examQuestionId: examQuestions.id,
        questionId: questions.id,
        questionType: questions.questionType,
        questionText: questions.questionText,
        referenceAnswer: questions.referenceAnswer,
        gradingRubric: questions.gradingRubric,
        marksAllocated: examQuestions.marksAllocated,
      })
      .from(examQuestions)
      .innerJoin(questions, eq(examQuestions.questionId, questions.id))
      .where(eq(examQuestions.examId, examId));

    let totalAiMarks = 0;

    for (const eqItem of examQuestionsList) {
      if (eqItem.questionType === "SAQ" || eqItem.questionType === "LAQ") {
        const aiOutput = await evaluateSubjectiveAnswerWithOpenRouter({
          questionType: eqItem.questionType,
          questionText: eqItem.questionText,
          referenceAnswer: eqItem.referenceAnswer || "",
          gradingRubric: eqItem.gradingRubric || [],
          studentAnswerText: ocrResult.extractedText,
          maxMarks: Number(eqItem.marksAllocated),
        });

        const ansData = {
          submissionId: submission.id,
          examQuestionId: eqItem.examQuestionId,
          questionId: eqItem.questionId,
          studentAnswerText: ocrResult.extractedText,
          ocrConfidenceScore: ocrResult.confidenceScore.toFixed(2),
          aiSuggestedMarks: aiOutput.suggestedMarks.toFixed(2),
          aiEvaluationReasoning: aiOutput.reasoning,
          aiMatchedKeyPoints: aiOutput.matchedKeyPoints,
          aiMissingKeyPoints: aiOutput.missingKeyPoints,
          openRouterModelUsed: aiOutput.modelUsed,
          finalAwardedMarks: aiOutput.suggestedMarks.toFixed(2),
        };

        await db
          .insert(submissionAnswers)
          .values(ansData)
          .onConflictDoUpdate({
            target: [submissionAnswers.submissionId, submissionAnswers.examQuestionId],
            set: ansData,
          });

        totalAiMarks += aiOutput.suggestedMarks;
      }
    }

    // 4. Update parent submission totals
    const [finalSub] = await db
      .update(examSubmissions)
      .set({
        status: "AI_GRADED",
        totalAiSubjectiveMarks: totalAiMarks.toFixed(2),
        totalFinalMarks: totalAiMarks.toFixed(2),
        evaluatedById: req.user!.id,
        evaluatedAt: new Date(),
      })
      .where(eq(examSubmissions.id, submission.id))
      .returning();

    res.status(200).json({
      message: "Scanned copy OCR processed and evaluated via OpenRouter AI.",
      submission: finalSub,
      ocrConfidence: ocrResult.confidenceScore,
      extractedSnippet: ocrResult.extractedText.slice(0, 300),
      totalAiMarks,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to process scanned copy." });
  }
});

/**
 * PATCH /api/grading/answers/:answerId/override-marks
 * Role: TEACHER
 * Manually edits/overrides the marks for a single question; updates finalAwardedMarks and recalculates totalFinalMarks
 */
router.patch("/answers/:answerId/override-marks", authenticate, requireRole("TEACHER", "ADMIN"), async (req: Request, res: Response): Promise<void> => {
  try {
    const { answerId } = req.params;
    const { newMarks, teacherComment } = req.body;

    if (newMarks === undefined) {
      res.status(400).json({ error: "newMarks is required." });
      return;
    }

    const updatedSubmission = await overrideQuestionMarks({
      submissionAnswerId: answerId,
      teacherId: req.user!.id,
      newMarks: Number(newMarks),
      teacherComment,
    });

    res.status(200).json({
      message: "Marks overridden successfully.",
      submission: updatedSubmission,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to override marks." });
  }
});

/**
 * POST /api/grading/submissions/direct-entry
 * Role: TEACHER
 * Directly enters final marks for a student without invoking OCR or OpenRouter
 */
router.post("/submissions/direct-entry", authenticate, requireRole("TEACHER", "ADMIN"), async (req: Request, res: Response): Promise<void> => {
  try {
    const { submissionId, totalMarks, teacherFeedback } = req.body;

    if (!submissionId || totalMarks === undefined) {
      res.status(400).json({ error: "submissionId and totalMarks are required." });
      return;
    }

    const updated = await directEnterSubmissionMarks(
      submissionId,
      req.user!.id,
      Number(totalMarks),
      teacherFeedback
    );

    res.status(200).json({
      message: "Marks directly entered into submission ledger.",
      submission: updated,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to direct-enter marks." });
  }
});

/**
 * PATCH /api/grading/submissions/:submissionId/finalize
 * Role: TEACHER
 * Locks the submission status as FINALIZED and publishes results
 */
router.patch("/submissions/:submissionId/finalize", authenticate, requireRole("TEACHER", "ADMIN"), async (req: Request, res: Response): Promise<void> => {
  try {
    const { submissionId } = req.params;

    const [finalized] = await db
      .update(examSubmissions)
      .set({
        status: "FINALIZED",
        evaluatedById: req.user!.id,
        evaluatedAt: new Date(),
      })
      .where(eq(examSubmissions.id, submissionId))
      .returning();

    if (!finalized) {
      res.status(404).json({ error: "Submission not found." });
      return;
    }

    res.status(200).json({
      message: "Submission finalized and published to Student Ledger.",
      submission: finalized,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to finalize submission." });
  }
});

export default router;
