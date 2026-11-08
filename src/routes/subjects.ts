import { Router, Request, Response } from "express";
import { db } from "../db/index.js";
import { subjects } from "../db/schema.js";
import { eq, asc, and, ilike, or } from "drizzle-orm";
import { authenticate } from "../middleware/auth.js";

const router = Router();

/**
 * GET /api/subjects
 * Supports query params: ?semester=6&academicYear=3&search=Database
 */
router.get("/", async (req: Request, res: Response): Promise<void> => {
  try {
    const { semester, academicYear, search } = req.query;

    const conditions = [];

    if (semester && semester !== "All") {
      conditions.push(eq(subjects.semester, Number(semester)));
    }

    if (academicYear && academicYear !== "All") {
      conditions.push(eq(subjects.academicYear, Number(academicYear)));
    }

    if (search && (search as string).trim()) {
      const q = `%${(search as string).trim()}%`;
      conditions.push(
        or(
          ilike(subjects.subjectCode, q),
          ilike(subjects.subjectName, q)
        )!
      );
    }

    const list = await db
      .select()
      .from(subjects)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(subjects.semester), asc(subjects.subjectCode));

    res.status(200).json({
      count: list.length,
      subjects: list,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to fetch subjects." });
  }
});

export default router;
