import { Router, Request, Response } from "express";
import { db } from "../db/index.js";
import { examRoutines, exams, subjects } from "../db/schema.js";
import { eq, and, asc } from "drizzle-orm";
import { authenticate, requireRole } from "../middleware/auth.js";

const router = Router();

/**
 * GET /api/exam-routines
 * Role: TEACHER (or STUDENT)
 * Views all scheduled exams in the Routine Check module (optional: ?academicYear=3)
 */
router.get("/", authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const { academicYear, semester } = req.query;

    const conditions = [];
    if (academicYear) conditions.push(eq(examRoutines.academicYear, Number(academicYear)));
    if (semester) conditions.push(eq(examRoutines.semester, Number(semester)));

    const routines = await db
      .select({
        routineId: examRoutines.id,
        examId: examRoutines.examId,
        subjectId: examRoutines.subjectId,
        subjectName: subjects.subjectName,
        subjectCode: subjects.subjectCode,
        examTitle: exams.title,
        academicYear: examRoutines.academicYear,
        semester: examRoutines.semester,
        examCategory: examRoutines.examCategory,
        roomOrLabName: examRoutines.roomOrLabName,
        scheduledStartTime: examRoutines.scheduledStartTime,
        scheduledEndTime: examRoutines.scheduledEndTime,
        notifyBeforeMinutes: examRoutines.notifyBeforeMinutes,
        notificationTriggerTime: examRoutines.notificationTriggerTime,
        routineStatus: examRoutines.routineStatus,
        totalMarks: exams.totalMarks,
        durationMinutes: exams.durationMinutes,
      })
      .from(examRoutines)
      .innerJoin(exams, eq(examRoutines.examId, exams.id))
      .innerJoin(subjects, eq(examRoutines.subjectId, subjects.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(examRoutines.scheduledStartTime));

    res.status(200).json({
      count: routines.length,
      routines,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to list exam routines." });
  }
});

/**
 * PATCH /api/exam-routines/:routineId
 * Role: TEACHER
 * Updates scheduled start/end time or academic year for a routine slot
 */
router.patch("/:routineId", authenticate, requireRole("TEACHER", "ADMIN"), async (req: Request, res: Response): Promise<void> => {
  try {
    const { routineId } = req.params;
    const { scheduledStartTime, scheduledEndTime, roomOrLabName, academicYear, routineStatus } = req.body;

    const updates: Record<string, any> = {};
    if (scheduledStartTime) {
      const startTime = new Date(scheduledStartTime);
      updates.scheduledStartTime = startTime;
      updates.notificationTriggerTime = new Date(startTime.getTime() - 10 * 60 * 1000);
    }
    if (scheduledEndTime) updates.scheduledEndTime = new Date(scheduledEndTime);
    if (roomOrLabName !== undefined) updates.roomOrLabName = roomOrLabName;
    if (academicYear !== undefined) updates.academicYear = Number(academicYear);
    if (routineStatus !== undefined) updates.routineStatus = routineStatus;
    updates.updatedAt = new Date();

    const [updated] = await db
      .update(examRoutines)
      .set(updates)
      .where(eq(examRoutines.id, routineId))
      .returning();

    if (!updated) {
      res.status(404).json({ error: "Exam routine not found." });
      return;
    }

    res.status(200).json({
      message: "Exam routine updated successfully.",
      routine: updated,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to update routine slot." });
  }
});

export default router;
