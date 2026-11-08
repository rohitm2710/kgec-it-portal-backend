import { Router, Request, Response } from "express";
import { db } from "../db/index.js";
import { announcements, users } from "../db/schema.js";
import { eq, or, and, isNull, desc } from "drizzle-orm";
import { authenticate, requireRole } from "../middleware/auth.js";
import { cleanupExpiredAnnouncements } from "../services/announcementRetentionService.js";

const router = Router();

/**
 * GET /api/announcements
 * Role: TEACHER, STUDENT
 * Lists announcements with PDF and Image attachments (actively purges notices older than 2 months)
 */
router.get("/", authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    // Actively purge announcements older than 2 months
    await cleanupExpiredAnnouncements();

    const user = req.user!;
    const conditions = [];

    // If user is a student with an academicYear, show general announcements + announcements for their year
    if (user.role === "STUDENT" && user.academicYear) {
      conditions.push(
        or(
          isNull(announcements.targetAcademicYear),
          eq(announcements.targetAcademicYear, user.academicYear)
        )
      );
    }

    const list = await db
      .select({
        id: announcements.id,
        title: announcements.title,
        content: announcements.content,
        authorId: announcements.authorId,
        authorName: users.fullName,
        targetAcademicYear: announcements.targetAcademicYear,
        targetSemester: announcements.targetSemester,
        attachments: announcements.attachments,
        isPinned: announcements.isPinned,
        createdAt: announcements.createdAt,
      })
      .from(announcements)
      .leftJoin(users, eq(announcements.authorId, users.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(announcements.isPinned), desc(announcements.createdAt));

    res.status(200).json({
      count: list.length,
      announcements: list,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to list announcements." });
  }
});

/**
 * POST /api/announcements
 * Role: TEACHER, ADMIN
 * Broadcasts a new notice with media attachments (PDF, Image)
 */
router.post("/", authenticate, requireRole("TEACHER", "ADMIN"), async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      title,
      content,
      targetAcademicYear,
      targetSemester,
      attachments = [],
      isPinned = false,
    } = req.body;

    if (!title || !content) {
      res.status(400).json({ error: "Title and content are required." });
      return;
    }

    const [newAnnouncement] = await db
      .insert(announcements)
      .values({
        title,
        content,
        authorId: req.user!.id,
        targetAcademicYear: targetAcademicYear ? Number(targetAcademicYear) : null,
        targetSemester: targetSemester ? Number(targetSemester) : null,
        attachments,
        isPinned: Boolean(isPinned),
      })
      .returning();

    res.status(201).json({
      message: "Announcement broadcasted successfully.",
      announcement: newAnnouncement,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to broadcast announcement." });
  }
});

/**
 * DELETE /api/announcements/cleanup
 * Role: TEACHER, ADMIN
 * Manually triggers the 2-month retention policy cleanup
 */
router.delete("/cleanup", authenticate, requireRole("TEACHER", "ADMIN"), async (_req: Request, res: Response): Promise<void> => {
  try {
    const deletedCount = await cleanupExpiredAnnouncements();
    res.status(200).json({
      message: `Retention policy executed: ${deletedCount} expired announcement(s) deleted.`,
      deletedCount,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to run retention cleanup." });
  }
});

export default router;
