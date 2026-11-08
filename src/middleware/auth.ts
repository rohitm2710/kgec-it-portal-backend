import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export interface AuthUser {
  id: string;
  institutionalId: string;
  email: string;
  fullName?: string;
  role: "TEACHER" | "STUDENT" | "ADMIN";
  academicYear?: number | null;
  semester?: number | null;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

const JWT_SECRET = process.env.JWT_SECRET || "kgec_it_dept_secure_jwt_token_secret_key_2026";

export function authenticate(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  // 1. Bearer Token Authentication
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.split(" ")[1];
    try {
      const decoded = jwt.verify(token, JWT_SECRET) as AuthUser;
      req.user = decoded;
      return next();
    } catch (err) {
      return res.status(401).json({ error: "Invalid or expired authorization token." });
    }
  }

  // 2. Developer Header Mode for easy direct testing (curl / Postman / Insomnia)
  const devUserId = req.headers["x-user-id"] as string;
  const devUserRole = req.headers["x-user-role"] as "TEACHER" | "STUDENT" | "ADMIN";
  const devAcademicYear = req.headers["x-academic-year"] as string;

  if (devUserId && devUserRole) {
    req.user = {
      id: devUserId,
      institutionalId: devUserRole === "TEACHER" ? "FAC-IT-042" : "10200122045",
      email: devUserRole === "TEACHER" ? "s.roy@kgec.edu.in" : "rahul.dey.22@kgec.edu.in",
      role: devUserRole,
      academicYear: devAcademicYear ? parseInt(devAcademicYear, 10) : (devUserRole === "STUDENT" ? 3 : null),
      semester: devUserRole === "STUDENT" ? 5 : null,
    };
    return next();
  }

  // 3. Fallback for testing without credentials (defaults to active user or returns 401)
  return res.status(401).json({
    error: "Authentication required. Provide a Bearer token or 'x-user-id' & 'x-user-role' headers for testing.",
  });
}

/**
 * Optional Authentication: Attaches user if valid token exists, but does not block if absent
 */
export function optionalAuthenticate(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.split(" ")[1];
    try {
      const decoded = jwt.verify(token, JWT_SECRET) as AuthUser;
      req.user = decoded;
      return next();
    } catch {}
  }

  const devUserId = req.headers["x-user-id"] as string;
  const devUserRole = req.headers["x-user-role"] as "TEACHER" | "STUDENT" | "ADMIN";
  if (devUserId && devUserRole) {
    req.user = {
      id: devUserId,
      institutionalId: devUserRole === "TEACHER" ? "FAC-IT-042" : "10200122045",
      email: devUserRole === "TEACHER" ? "s.roy@kgec.edu.in" : "rahul.dey.22@kgec.edu.in",
      role: devUserRole,
      academicYear: 3,
      semester: 5,
    };
  }
  next();
}

/**
 * Role-Based Access Control Middleware
 */
export function requireRole(...allowedRoles: Array<"TEACHER" | "STUDENT" | "ADMIN">) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized. Please authenticate first." });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        error: `Forbidden. Role '${req.user.role}' is not authorized to access this resource. Required: [${allowedRoles.join(", ")}].`,
      });
    }

    next();
  };
}
