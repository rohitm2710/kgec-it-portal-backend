import { Router, Request, Response } from "express";
import { optionalAuthenticate } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { users, exams } from "../db/schema.js";
import { eq, desc, and, ne, or } from "drizzle-orm";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import {
  advanceSemester,
  getSemesterStatus,
  seedTestSemesterCohort,
} from "../services/semesterTransitionService.js";

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || "kgec_it_dept_secure_jwt_token_secret_key_2026";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";

/**
 * Helper to ensure an Admin record exists in Neon DB
 */
async function getOrCreateAdminUser() {
  try {
    let [admin] = await db.select().from(users).where(eq(users.role, "ADMIN")).limit(1);
    if (!admin) {
      const defaultPasswordHash = await bcrypt.hash("admin", 10);
      const [newAdmin] = await db
        .insert(users)
        .values({
          institutionalId: "ADMIN-KGEC-IT",
          fullName: "Department Administrator",
          email: "admin.it@kgec.edu.in",
          passwordHash: defaultPasswordHash,
          role: "ADMIN",
          isActive: true,
        })
        .onConflictDoNothing()
        .returning();

      if (newAdmin) return newAdmin;
      [admin] = await db.select().from(users).where(eq(users.role, "ADMIN")).limit(1);
    }
    return admin;
  } catch (e) {
    console.warn("getOrCreateAdminUser fallback:", e);
    return null;
  }
}

/**
 * POST /api/admin/login
 * Verifies admin password (default: "admin", or custom updated password)
 */
router.post("/login", async (req: Request, res: Response): Promise<void> => {
  try {
    const { passcode, password } = req.body;
    const providedPasscode = (passcode || password || "").trim();

    if (!providedPasscode) {
      res.status(400).json({ error: "Admin password is required." });
      return;
    }

    const admin = await getOrCreateAdminUser();

    // Verify against DB passwordHash
    let isMatch = false;
    if (admin?.passwordHash) {
      isMatch = await bcrypt.compare(providedPasscode, admin.passwordHash).catch(() => false);
    } else if (providedPasscode === "admin") {
      isMatch = true;
    }

    if (!isMatch) {
      res.status(401).json({ error: "Invalid Admin Password. Access denied." });
      return;
    }

    const adminUser = {
      id: admin?.id || "00000000-0000-0000-0000-000000000000",
      institutionalId: admin?.institutionalId || "ADMIN-KGEC-IT",
      fullName: admin?.fullName || "Department Administrator",
      email: admin?.email || "admin.it@kgec.edu.in",
      role: "ADMIN" as const,
      academicYear: null,
      semester: null,
    };

    const token = jwt.sign(adminUser, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN as any });

    res.status(200).json({
      message: "Admin verification successful. Access granted to Admin Control Panel.",
      token,
      user: adminUser,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Admin authentication failed." });
  }
});

/**
 * POST /api/admin/change-password
 * Allows the admin to change their password after logging in.
 */
router.post("/change-password", optionalAuthenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!newPassword || newPassword.trim().length === 0) {
      res.status(400).json({ error: "New password is required." });
      return;
    }

    if (newPassword.trim().length < 3) {
      res.status(400).json({ error: "New password must be at least 3 characters long." });
      return;
    }

    const admin = await getOrCreateAdminUser();

    // If current password provided, verify it
    if (currentPassword && admin?.passwordHash) {
      const isCurrentMatch = await bcrypt.compare(currentPassword.trim(), admin.passwordHash).catch(() => false);
      if (!isCurrentMatch && currentPassword.trim() !== "admin") {
        res.status(401).json({ error: "Current password does not match." });
        return;
      }
    }

    const newHash = await bcrypt.hash(newPassword.trim(), 10);

    if (admin) {
      await db
        .update(users)
        .set({ passwordHash: newHash })
        .where(eq(users.id, admin.id));
    }

    res.status(200).json({
      message: "Admin password successfully updated in database. Future logins will require this new password.",
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to update admin password." });
  }
});

/**
 * GET /api/admin/users
 * Returns list of all registered accounts (Teachers and Students)
 * Displays whether access has been granted or is pending human verification.
 */
router.get("/users", optionalAuthenticate, async (_req: Request, res: Response): Promise<void> => {
  try {
    const list = await db
      .select({
        id: users.id,
        fullName: users.fullName,
        institutionalId: users.institutionalId,
        email: users.email,
        role: users.role,
        academicYear: users.academicYear,
        semester: users.semester,
        isActive: users.isActive,
        createdAt: users.createdAt,
      })
      .from(users)
      .orderBy(desc(users.createdAt));

    const pendingCount = list.filter((u) => !u.isActive).length;
    const studentCount = list.filter((u) => u.role === "STUDENT").length;
    const teacherCount = list.filter((u) => u.role === "TEACHER").length;

    res.status(200).json({
      total: list.length,
      pendingCount,
      studentCount,
      teacherCount,
      users: list,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to load user accounts." });
  }
});

/**
 * PATCH /api/admin/users/:userId/access
 * Human-driven Verification: Grant or revoke access to a student or teacher account.
 */
router.patch("/users/:userId/access", optionalAuthenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const { userId } = req.params;
    const { isActive = true } = req.body;

    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId);

    const [updated] = await db
      .update(users)
      .set({ isActive: Boolean(isActive) })
      .where(isUuid ? eq(users.id, userId) : eq(users.institutionalId, userId))
      .returning();

    if (!updated) {
      res.status(404).json({ error: "User account not found." });
      return;
    }

    res.status(200).json({
      message: Boolean(isActive)
        ? `Access successfully GRANTED to ${updated.fullName} (${updated.role}). Account verified and unlocked.`
        : `Access REVOKED for ${updated.fullName} (${updated.role}). Account locked.`,
      user: {
        id: updated.id,
        fullName: updated.fullName,
        institutionalId: updated.institutionalId,
        role: updated.role,
        isActive: updated.isActive,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to update user access status." });
  }
});

/**
 * DELETE /api/admin/users/:userId
 * Permanently deletes a Teacher or Student account from the database.
 */
router.delete("/users/:userId", optionalAuthenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const { userId } = req.params;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId);

    const [targetUser] = await db
      .select()
      .from(users)
      .where(isUuid ? eq(users.id, userId) : eq(users.institutionalId, userId))
      .limit(1);

    if (!targetUser) {
      res.status(404).json({ error: "User account not found in database." });
      return;
    }

    // If teacher created any exams, reassign or delete to avoid foreign key restrict constraint
    if (targetUser.role === "TEACHER") {
      const teacherExams = await db
        .select({ id: exams.id })
        .from(exams)
        .where(eq(exams.createdById, targetUser.id));

      if (teacherExams.length > 0) {
        const [otherTeacher] = await db
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.role, "TEACHER"), ne(users.id, targetUser.id)))
          .limit(1);

        if (otherTeacher) {
          await db
            .update(exams)
            .set({ createdById: otherTeacher.id })
            .where(eq(exams.createdById, targetUser.id));
        } else {
          for (const ex of teacherExams) {
            await db.delete(exams).where(eq(exams.id, ex.id));
          }
        }
      }
    }

    const [deleted] = await db
      .delete(users)
      .where(eq(users.id, targetUser.id))
      .returning();

    res.status(200).json({
      message: `Account for ${deleted.fullName} (${deleted.role}) [ID: ${deleted.institutionalId}] has been permanently deleted from database.`,
      deletedUser: {
        id: deleted.id,
        fullName: deleted.fullName,
        institutionalId: deleted.institutionalId,
        role: deleted.role,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to delete user account." });
  }
});

/**
 * POST /api/admin/users/:userId/reset-password
 * Emergency Safety Reset: Admin resets any user's password (Student or Teacher) back to "kgecit"
 */
router.post("/users/:userId/reset-password", optionalAuthenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const { userId } = req.params;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId);

    const [targetUser] = await db
      .select()
      .from(users)
      .where(isUuid ? eq(users.id, userId) : eq(users.institutionalId, userId))
      .limit(1);

    if (!targetUser) {
      res.status(404).json({ error: "User account not found." });
      return;
    }

    const resetPasswordHash = await bcrypt.hash("kgecit", 10);

    const [updated] = await db
      .update(users)
      .set({ passwordHash: resetPasswordHash })
      .where(eq(users.id, targetUser.id))
      .returning();

    res.status(200).json({
      message: `Password for ${updated.fullName} (${updated.role}) [${updated.institutionalId}] has been reset to "kgecit".`,
      user: {
        id: updated.id,
        fullName: updated.fullName,
        institutionalId: updated.institutionalId,
        role: updated.role,
      },
      newDefaultPassword: "kgecit",
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to reset user password." });
  }
});

/**
 * GET /api/admin/semester-status
 * Previews current student enrollment by semester, graduation candidates,
 * and data items that will be cleared during a semester transition.
 */
router.get("/semester-status", optionalAuthenticate, async (_req: Request, res: Response): Promise<void> => {
  try {
    const status = await getSemesterStatus();
    res.status(200).json({
      status: "ready",
      ...status,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to retrieve semester status." });
  }
});

/**
 * POST /api/admin/new-semester
 * (Also available at POST /api/admin/semester-transition)
 * Triggered when the Admin Panel signals that a New Semester has started:
 * 1. Promotes every continuing student directly to the next semester & year.
 * 2. If student touched Semester 8 -> terminates their complete data.
 * 3. Deletes all already done announcements.
 * 4. Cleans all exam data, routines, submissions, and marks details.
 * 5. Leaves the system fresh with only teacher data and promoted student data.
 */
router.post("/new-semester", optionalAuthenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const { dryRun, semesterLabel, adminIdentifier } = req.body || {};

    const summary = await advanceSemester({
      dryRun: Boolean(dryRun),
      semesterLabel: semesterLabel || "Academic Semester Transition",
      adminIdentifier: adminIdentifier || req.user?.institutionalId || "ADMIN_PANEL_SYSTEM",
    });

    res.status(200).json({
      message: dryRun
        ? "Semester transition simulation completed (Dry-run mode, no changes committed)."
        : "New semester started successfully! Students promoted, semester 8 graduates terminated, announcements & exams cleared.",
      ...summary,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to execute new semester transition." });
  }
});

/**
 * POST /api/admin/semester-transition
 * Alias for POST /api/admin/new-semester
 */
router.post("/semester-transition", optionalAuthenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const { dryRun, semesterLabel, adminIdentifier } = req.body || {};

    const summary = await advanceSemester({
      dryRun: Boolean(dryRun),
      semesterLabel: semesterLabel || "Academic Semester Transition",
      adminIdentifier: adminIdentifier || req.user?.institutionalId || "ADMIN_PANEL_SYSTEM",
    });

    res.status(200).json({
      message: dryRun
        ? "Semester transition simulation completed (Dry-run mode, no changes committed)."
        : "New semester started successfully! Students promoted, semester 8 graduates terminated, announcements & exams cleared.",
      ...summary,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to execute new semester transition." });
  }
});

/**
 * POST /api/admin/seed-test-cohort
 * Development / Test helper: Seeds students across Semesters 1, 3, 5, 7, and 8
 * so that semester advancement and graduate termination can be tested reliably.
 */
router.post("/seed-test-cohort", optionalAuthenticate, async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await seedTestSemesterCohort();
    res.status(200).json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to seed test semester cohort." });
  }
});

export default router;
