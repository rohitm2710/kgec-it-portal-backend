import { Router, Request, Response } from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { db } from "../db/index.js";
import { users } from "../db/schema.js";
import { eq, or, and } from "drizzle-orm";
import { authenticate } from "../middleware/auth.js";

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || "kgec_it_dept_secure_jwt_token_secret_key_2026";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";

/**
 * POST /api/auth/login
 * Public endpoint to authenticate Teacher or Student
 */
router.post("/login", async (req: Request, res: Response): Promise<void> => {
  try {
    const { institutionalId, email, password, role } = req.body;

    const identifier = institutionalId || email;
    if (!identifier || !password) {
      res.status(400).json({ error: "Institutional ID / Email and Password are required." });
      return;
    }

    const targetRole = role ? (role.toUpperCase() as "TEACHER" | "STUDENT" | "ADMIN") : undefined;

    // Look up user in database strictly
    let user = null;
    try {
      const usersList = await db
        .select()
        .from(users)
        .where(
          and(
            or(
              eq(users.institutionalId, identifier),
              eq(users.email, identifier)
            ),
            targetRole ? eq(users.role, targetRole) : undefined
          )
        )
        .limit(1);
      user = usersList[0] || null;
    } catch (_dbError) {}

    if (!user) {
      res.status(401).json({ error: "Invalid Institutional ID / Email or password." });
      return;
    }

    // Verify password strictly against database hash
    const passwordMatch = await bcrypt.compare(password, user.passwordHash).catch(() => false);
    if (!passwordMatch) {
      res.status(401).json({ error: "Invalid Institutional ID / Email or password." });
      return;
    }

    // Human-driven verification check: if user is not active, block login with clear notification!
    if (user.isActive === false) {
      res.status(403).json({
        error: "Access Pending Verification: Your account has been registered but is awaiting human verification by the Department Administrator. Once verified, access will be granted.",
        isPendingApproval: true,
        user: {
          id: user.id,
          fullName: user.fullName,
          institutionalId: user.institutionalId,
          role: user.role,
        },
      });
      return;
    }

    const payload = {
      id: user.id,
      institutionalId: user.institutionalId,
      fullName: user.fullName,
      email: user.email,
      role: user.role,
      academicYear: user.academicYear,
      semester: user.semester,
    };

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN as any });

    res.status(200).json({
      message: "Login successful.",
      token,
      user: payload,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Authentication failed." });
  }
});

/**
 * POST /api/auth/register
 * Public registration endpoint for Students and Teachers.
 * Note: isActive defaults to false! A human admin must inspect and verify the registration
 * before access is granted.
 */
router.post("/register", async (req: Request, res: Response): Promise<void> => {
  try {
    const { fullName, institutionalId, email, password, role = "STUDENT", semester } = req.body;

    if (!fullName || !institutionalId || !email || !password) {
      res.status(400).json({
        error: "Full Name, Institutional ID (Roll/Faculty ID), Email, and Password are required.",
      });
      return;
    }

    const cleanRole = role.toUpperCase() === "TEACHER" ? "TEACHER" : "STUDENT";
    const semNum = cleanRole === "STUDENT" ? Number(semester) || 1 : null;
    const yearNum = semNum ? (semNum > 6 ? 4 : semNum > 4 ? 3 : semNum > 2 ? 2 : 1) : null;

    // Check if user already exists
    const [existing] = await db
      .select({ id: users.id, email: users.email, institutionalId: users.institutionalId })
      .from(users)
      .where(
        or(
          eq(users.email, email.trim().toLowerCase()),
          eq(users.institutionalId, institutionalId.trim())
        )
      )
      .limit(1);

    if (existing) {
      res.status(400).json({
        error: "An account with this Email or Institutional ID already exists in the system.",
      });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const [newUser] = await db
      .insert(users)
      .values({
        fullName: fullName.trim(),
        institutionalId: institutionalId.trim(),
        email: email.trim().toLowerCase(),
        passwordHash,
        role: cleanRole,
        semester: semNum,
        academicYear: yearNum,
        batchYear: yearNum ? 2026 - (4 - yearNum) : 2026,
        isActive: false, // Access must be manually granted by Admin after verifying student validity!
      })
      .returning();

    res.status(201).json({
      message: `Registration received for ${newUser.fullName}. Access is currently pending human verification by the Department Administrator.`,
      user: {
        id: newUser.id,
        fullName: newUser.fullName,
        institutionalId: newUser.institutionalId,
        email: newUser.email,
        role: newUser.role,
        semester: newUser.semester,
        academicYear: newUser.academicYear,
        isActive: newUser.isActive,
      },
      isPendingApproval: true,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Registration failed." });
  }
});

/**
 * GET /api/auth/me
 * Authenticated endpoint returning active profile
 */
router.get("/me", authenticate, (req: Request, res: Response) => {
  res.status(200).json({
    user: req.user,
  });
});

/**
 * POST /api/auth/change-password
 * Authenticated endpoint for any logged-in user (Teacher or Student) to change their password
 */
router.post("/change-password", authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    const { currentPassword, newPassword } = req.body;

    if (!userId) {
      res.status(401).json({ error: "Unauthorized. Please authenticate first." });
      return;
    }

    if (!newPassword || newPassword.trim().length === 0) {
      res.status(400).json({ error: "New password is required." });
      return;
    }

    if (newPassword.trim().length < 6) {
      res.status(400).json({ error: "New password must be at least 6 characters long." });
      return;
    }

    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);

    if (!user) {
      res.status(404).json({ error: "User account not found." });
      return;
    }

    // Verify current password
    if (currentPassword) {
      const isCurrentMatch = await bcrypt.compare(currentPassword, user.passwordHash).catch(() => false);
      if (!isCurrentMatch) {
        res.status(401).json({ error: "Current password does not match." });
        return;
      }
    }

    const newHash = await bcrypt.hash(newPassword.trim(), 10);

    await db
      .update(users)
      .set({ passwordHash: newHash })
      .where(eq(users.id, user.id));

    res.status(200).json({
      message: "Password changed successfully. Please remember your new password for subsequent logins.",
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to update password." });
  }
});

export default router;
