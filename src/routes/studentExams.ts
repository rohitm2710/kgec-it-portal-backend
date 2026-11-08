import { Router, Request, Response } from "express";
import { db } from "../db/index.js";
import {
  examSubmissions,
  submissionAnswers,
  examQuestions,
  questions,
  users,
} from "../db/schema.js";
import { and, eq, inArray } from "drizzle-orm";
import { authenticate, requireRole } from "../middleware/auth.js";
import {
  verifyAndPrepareStudentExamAccess,
  getStudentExamNotifications,
} from "../services/examRoutineGatekeeper.js";
import { evaluateSubjectiveAnswerWithOpenRouter } from "../services/aiGradingService.js";

const router = Router();

/**
 * POST /api/student/exams/enter-or-check
 * Role: STUDENT
 * Checks if student's academicYear has an exam in exam_routines.
 * Blocks if early (> 10 min), prepares paper & returns 10-min notification if within 10 min,
 * enters live exam if NOW >= scheduledStartTime.
 */
router.post("/enter-or-check", authenticate, requireRole("STUDENT"), async (req: Request, res: Response): Promise<void> => {
  try {
    const studentId = req.user!.id;

    const result = await verifyAndPrepareStudentExamAccess(studentId);

    // Scenario A: > 10 mins before start (Not time yet) -> Return 403 Forbidden
    if (result.gateStatus === "NOT_TIME_YET") {
      res.status(403).json(result);
      return;
    }

    // Scenario B: Within 10-min notification window or Scenario C: Live Exam -> Return 200 OK
    res.status(200).json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to process exam gatekeeper check." });
  }
});

/**
 * GET /api/student/exams/notifications
 * Role: STUDENT
 * Returns active exam notifications strictly if NOW >= (scheduledStartTime - 10 minutes)
 */
router.get("/notifications", authenticate, requireRole("STUDENT"), async (req: Request, res: Response): Promise<void> => {
  try {
    const studentId = req.user!.id;
    const notifications = await getStudentExamNotifications(studentId);
    res.status(200).json(notifications);
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to fetch student exam notifications." });
  }
});

/**
 * POST /api/student/exams/:examId/submit
 * Role: STUDENT
 * Submits answers, auto-grades all MCQ items immediately, and queues SAQ/LAQ for OpenRouter AI
 */
router.post("/:examId/submit", authenticate, requireRole("STUDENT"), async (req: Request, res: Response): Promise<void> => {
  try {
    const { examId } = req.params;
    const studentId = req.user!.id;
    const { submissionId, answers } = req.body; // answers: [{ examQuestionId, questionId, selectedOptionId, studentAnswerText }]

    if (!answers || !Array.isArray(answers)) {
      res.status(400).json({ error: "Answers array is required." });
      return;
    }

    // 1. Fetch Question details (to auto-grade MCQs and get model answers for SAQ/LAQ)
    const questionIds = answers.map((a: any) => a.questionId);
    const questionsList = await db
      .select({
        id: questions.id,
        questionType: questions.questionType,
        correctOptionId: questions.correctOptionId,
        referenceAnswer: questions.referenceAnswer,
        gradingRubric: questions.gradingRubric,
        questionText: questions.questionText,
      })
      .from(questions)
      .where(inArray(questions.id, questionIds));

    const questionMap = new Map(questionsList.map((q) => [q.id, q]));

    // 2. Fetch marks allocated per examQuestionId
    const examQuestionsList = await db
      .select({
        id: examQuestions.id,
        marksAllocated: examQuestions.marksAllocated,
      })
      .from(examQuestions)
      .where(eq(examQuestions.examId, examId));

    const marksMap = new Map(examQuestionsList.map((eqRow) => [eqRow.id, Number(eqRow.marksAllocated)]));

    let computedMcqMarks = 0;
    let computedAiSubjectiveMarks = 0;

    const answerRecords: any[] = [];
    const subjectiveQueue: Array<{ answerRecordIndex: number; question: any; studentAnswerText: string; maxMarks: number }> = [];

    // Process each student answer
    for (let i = 0; i < answers.length; i++) {
      const ans = answers[i];
      const q = questionMap.get(ans.questionId);
      const maxMarks = marksMap.get(ans.examQuestionId) || 0;

      let autoMcq = null;
      let finalMarks = 0;

      if (q?.questionType === "MCQ") {
        if (ans.selectedOptionId && ans.selectedOptionId === q.correctOptionId) {
          autoMcq = maxMarks;
          finalMarks = maxMarks;
          computedMcqMarks += maxMarks;
        } else {
          autoMcq = 0;
          finalMarks = 0;
        }
      }

      const record = {
        submissionId,
        examQuestionId: ans.examQuestionId,
        questionId: ans.questionId,
        selectedOptionId: ans.selectedOptionId || null,
        studentAnswerText: ans.studentAnswerText || null,
        autoMcqMarks: autoMcq !== null ? autoMcq.toFixed(2) : null,
        finalAwardedMarks: finalMarks.toFixed(2),
      };

      answerRecords.push(record);

      if (q?.questionType === "SAQ" || q?.questionType === "LAQ") {
        subjectiveQueue.push({
          answerRecordIndex: i,
          question: q,
          studentAnswerText: ans.studentAnswerText || "",
          maxMarks,
        });
      }
    }

    // 3. Evaluate SAQ/LAQ via OpenRouter AI Service
    for (const item of subjectiveQueue) {
      if (item.studentAnswerText.trim()) {
        const aiOutput = await evaluateSubjectiveAnswerWithOpenRouter({
          questionType: item.question.questionType,
          questionText: item.question.questionText,
          referenceAnswer: item.question.referenceAnswer || "",
          gradingRubric: item.question.gradingRubric || [],
          studentAnswerText: item.studentAnswerText,
          maxMarks: item.maxMarks,
        });

        answerRecords[item.answerRecordIndex].aiSuggestedMarks = aiOutput.suggestedMarks.toFixed(2);
        answerRecords[item.answerRecordIndex].aiEvaluationReasoning = aiOutput.reasoning;
        answerRecords[item.answerRecordIndex].aiMatchedKeyPoints = aiOutput.matchedKeyPoints;
        answerRecords[item.answerRecordIndex].aiMissingKeyPoints = aiOutput.missingKeyPoints;
        answerRecords[item.answerRecordIndex].openRouterModelUsed = aiOutput.modelUsed;
        answerRecords[item.answerRecordIndex].finalAwardedMarks = aiOutput.suggestedMarks.toFixed(2);

        computedAiSubjectiveMarks += aiOutput.suggestedMarks;
      }
    }

    // 4. Save Answers in Database
    for (const ansRecord of answerRecords) {
      await db
        .insert(submissionAnswers)
        .values(ansRecord)
        .onConflictDoUpdate({
          target: [submissionAnswers.submissionId, submissionAnswers.examQuestionId],
          set: ansRecord,
        });
    }

    // 5. Update Submission Record
    const totalFinal = computedMcqMarks + computedAiSubjectiveMarks;
    const [finalSubmission] = await db
      .update(examSubmissions)
      .set({
        status: subjectiveQueue.length > 0 ? "AI_GRADED" : "SUBMITTED",
        totalMcqMarks: computedMcqMarks.toFixed(2),
        totalAiSubjectiveMarks: computedAiSubjectiveMarks.toFixed(2),
        totalFinalMarks: totalFinal.toFixed(2),
        submittedAt: new Date(),
      })
      .where(eq(examSubmissions.id, submissionId))
      .returning();

    res.status(200).json({
      message: "Exam submitted and graded successfully.",
      submission: finalSubmission,
      scoreSummary: {
        totalMcqMarks: computedMcqMarks,
        totalAiSubjectiveMarks: computedAiSubjectiveMarks,
        totalFinalMarks: totalFinal,
        autoGradedCount: answers.length,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to submit exam." });
  }
});

/**
 * ALL /api/student/exams/:examId/programming/*
 * Role: STUDENT
 * Reserved Stub: Returns 501 Not Implemented as specified in Section 5.4 of API Documentation
 */
router.all("/:examId/programming/*", authenticate, requireRole("STUDENT"), (_req: Request, res: Response) => {
  res.status(501).json({
    status: 501,
    error: "Not Implemented",
    code: "PROGRAMMING_EXAM_UNDER_DEVELOPMENT",
    message: "Programming Exam Code Runner & Kernel Isolation engine is reserved for Phase 2 development. Status: Coming Soon / Under Development.",
  });
});

export default router;
