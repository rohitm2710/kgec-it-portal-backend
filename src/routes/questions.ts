import { Router, Request, Response } from "express";
import { db } from "../db/index.js";
import { questions, subjects, users } from "../db/schema.js";
import { and, eq, sql, desc, ilike, or } from "drizzle-orm";
import { authenticate, requireRole, optionalAuthenticate } from "../middleware/auth.js";

const router = Router();

/**
 * POST /api/questions
 * Role: TEACHER
 * Adds a new MCQ, SAQ, or LAQ question to the Question Bank
 */
router.post("/", authenticate, requireRole("TEACHER", "ADMIN"), async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      subjectId,
      questionType,
      difficulty,
      unitOrTopic,
      questionText,
      diagramImageUrl,
      mcqOptions,
      correctOptionId,
      referenceAnswer,
      gradingRubric,
      expectedWordCount,
      defaultMarks,
    } = req.body;

    if (!subjectId || !questionType || !difficulty || !questionText) {
      res.status(400).json({
        error: "Missing required fields: subjectId, questionType, difficulty, and questionText are mandatory.",
      });
      return;
    }

    // Resolve subjectId: support passing UUID or subject code (e.g. 'IT-601', 'PCC-IT501')
    let resolvedSubjectId = subjectId;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(subjectId);

    if (!isUuid) {
      // Find subject by code or name
      const codeMatch = subjectId.match(/([A-Z0-9]+-[A-Z0-9]+)/i);
      const searchCode = codeMatch ? codeMatch[1].toUpperCase() : subjectId.trim();

      const [existingSubject] = await db
        .select()
        .from(subjects)
        .where(eq(subjects.subjectCode, searchCode))
        .limit(1);

      if (existingSubject) {
        resolvedSubjectId = existingSubject.id;
      } else {
        // Automatically create subject so upload never fails due to missing subject
        const semNum = req.body.semester ? Number(req.body.semester) : (searchCode.includes("8") ? 8 : searchCode.includes("7") ? 7 : searchCode.includes("5") ? 5 : searchCode.includes("4") ? 4 : 6);
        const yearNum = semNum > 6 ? 4 : semNum > 4 ? 3 : 2;
        const [createdSubject] = await db
          .insert(subjects)
          .values({
            subjectCode: searchCode,
            subjectName: subjectId,
            academicYear: yearNum,
            semester: semNum,
          })
          .returning();
        resolvedSubjectId = createdSubject.id;
      }
    }

    // Normalize difficulty and questionType to uppercase enums
    const normalizedType = questionType.toUpperCase();
    const normalizedDifficulty = difficulty.toUpperCase().split(" ")[0]; // "EASY", "MEDIUM", "HARD"

    // Resolve creatorId: ensure it is a valid UUID or look up by institutionalId
    let creatorId = req.user?.id || null;
    const isCreatorUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(creatorId || "");
    if (!isCreatorUuid && creatorId) {
      const [matchedUser] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.institutionalId, creatorId))
        .limit(1);
      creatorId = matchedUser ? matchedUser.id : null;
    }

    const marks = defaultMarks ? Number(defaultMarks).toFixed(2) : (normalizedType === "MCQ" ? "1.00" : normalizedType === "SAQ" ? "5.00" : "10.00");

    const [newQuestion] = await db
      .insert(questions)
      .values({
        subjectId: resolvedSubjectId,
        createdById: creatorId,
        questionType: normalizedType as any,
        difficulty: normalizedDifficulty as any,
        unitOrTopic: unitOrTopic || "General",
        questionText,
        diagramImageUrl,
        mcqOptions: normalizedType === "MCQ" ? mcqOptions : null,
        correctOptionId: normalizedType === "MCQ" ? correctOptionId : null,
        referenceAnswer: normalizedType !== "MCQ" ? referenceAnswer : null,
        gradingRubric: normalizedType !== "MCQ" ? gradingRubric : null,
        expectedWordCount: normalizedType !== "MCQ" ? expectedWordCount : null,
        defaultMarks: marks,
        isActive: true,
      })
      .returning();

    res.status(201).json({
      message: "Question successfully registered into the Question Bank.",
      question: newQuestion,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to create question." });
  }
});

/**
 * GET /api/questions/bank-summary
 * Role: TEACHER
 * Returns counts of available questions grouped by subjectId, questionType, and difficulty
 */
router.get("/bank-summary", authenticate, requireRole("TEACHER", "ADMIN"), async (_req: Request, res: Response): Promise<void> => {
  try {
    const summary = await db
      .select({
        subjectId: questions.subjectId,
        questionType: questions.questionType,
        difficulty: questions.difficulty,
        count: sql<number>`count(*)::int`,
      })
      .from(questions)
      .where(eq(questions.isActive, true))
      .groupBy(questions.subjectId, questions.questionType, questions.difficulty);

    res.status(200).json({
      totalBuckets: summary.length,
      summary,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to retrieve Question Bank summary." });
  }
});

/**
 * GET /api/questions
 * Role: PUBLIC / STUDENT / TEACHER / ADMIN
 * Lists questions with optional filters: ?subjectId=...&questionType=MCQ&difficulty=EASY
 * Sanitizes questions for students/unauthenticated (removes answers and rubrics)
 */
router.get("/", optionalAuthenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const { 
      subjectId, 
      semester, 
      academicYear, 
      questionType, 
      difficulty, 
      search, 
      limit = "100", 
      offset = "0" 
    } = req.query;

    const conditions = [eq(questions.isActive, true)];

    if (subjectId && subjectId !== "All") {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(subjectId as string);
      if (isUuid) {
        conditions.push(eq(questions.subjectId, subjectId as string));
      } else {
        conditions.push(or(
          eq(subjects.subjectCode, subjectId as string),
          ilike(subjects.subjectCode, `%${subjectId}%`),
          ilike(subjects.subjectName, `%${subjectId}%`)
        )!);
      }
    }

    if (semester && semester !== "All") {
      conditions.push(eq(subjects.semester, Number(semester)));
    }

    if (academicYear && academicYear !== "All") {
      conditions.push(eq(subjects.academicYear, Number(academicYear)));
    }

    if (questionType && questionType !== "All") {
      conditions.push(eq(questions.questionType, (questionType as string).toUpperCase() as any));
    }

    if (difficulty && difficulty !== "All") {
      conditions.push(eq(questions.difficulty, (difficulty as string).toUpperCase() as any));
    }

    if (search && (search as string).trim()) {
      const searchStr = `%${(search as string).trim()}%`;
      conditions.push(or(
        ilike(questions.questionText, searchStr),
        ilike(questions.unitOrTopic, searchStr),
        ilike(subjects.subjectCode, searchStr),
        ilike(subjects.subjectName, searchStr)
      )!);
    }

    const questionList = await db
      .select({
        id: questions.id,
        subjectId: questions.subjectId,
        subjectCode: subjects.subjectCode,
        subjectName: subjects.subjectName,
        semester: subjects.semester,
        academicYear: subjects.academicYear,
        questionType: questions.questionType,
        difficulty: questions.difficulty,
        unitOrTopic: questions.unitOrTopic,
        questionText: questions.questionText,
        diagramImageUrl: questions.diagramImageUrl,
        mcqOptions: questions.mcqOptions,
        correctOptionId: questions.correctOptionId,
        referenceAnswer: questions.referenceAnswer,
        gradingRubric: questions.gradingRubric,
        expectedWordCount: questions.expectedWordCount,
        defaultMarks: questions.defaultMarks,
        createdAt: questions.createdAt,
      })
      .from(questions)
      .leftJoin(subjects, eq(questions.subjectId, subjects.id))
      .where(and(...conditions))
      .orderBy(desc(questions.createdAt))
      .limit(parseInt(limit as string, 10))
      .offset(parseInt(offset as string, 10));

    const isPrivileged = req.user?.role === "TEACHER" || req.user?.role === "ADMIN";
    const sanitized = questionList.map(q => {
      if (!isPrivileged) {
        const { correctOptionId, referenceAnswer, ...safe } = q;
        return safe;
      }
      return q;
    });

    res.status(200).json({
      count: sanitized.length,
      questions: sanitized,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to list questions." });
  }
});

/**
 * PATCH /api/questions/:id
 * Role: TEACHER
 * Updates question fields
 */
router.patch("/:id", authenticate, requireRole("TEACHER", "ADMIN"), async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const [updated] = await db
      .update(questions)
      .set(updates)
      .where(eq(questions.id, id))
      .returning();

    if (!updated) {
      res.status(404).json({ error: "Question not found." });
      return;
    }

    res.status(200).json({
      message: "Question updated successfully.",
      question: updated,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to update question." });
  }
});

export default router;
