import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import authRoutes from "./routes/auth.js";
import questionsRoutes from "./routes/questions.js";
import examsRoutes from "./routes/exams.js";
import examRoutinesRoutes from "./routes/examRoutines.js";
import studentExamsRoutes from "./routes/studentExams.js";
import gradingRoutes from "./routes/grading.js";
import announcementsRoutes from "./routes/announcements.js";
import subjectsRoutes from "./routes/subjects.js";
import proctorRoutes from "./routes/proctor.js";
import adminRoutes from "./routes/admin.js";

export const app = express();

// Middlewares
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// API Health Check
app.get("/api/health", (_req: Request, res: Response) => {
  res.status(200).json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    service: "KGEC Department of Information Technology Portal API",
    version: "1.0.0",
  });
});

// Register API Routes as specified in API Documentation
app.use("/api/auth", authRoutes);
app.use("/api/questions", questionsRoutes);
app.use("/api/exams", examsRoutes);
app.use("/api/exam-routines", examRoutinesRoutes);
app.use("/api/student/exams", studentExamsRoutes);
app.use("/api/grading", gradingRoutes);
app.use("/api/announcements", announcementsRoutes);
app.use("/api/subjects", subjectsRoutes);
app.use("/api/proctor", proctorRoutes);
app.use("/api/admin", adminRoutes);

// 404 Handler
app.use((req: Request, res: Response) => {
  res.status(404).json({
    error: `Cannot ${req.method} ${req.originalUrl}`,
    message: "Endpoint not found on KGEC IT Department Portal API.",
  });
});

// Centralized Error Handler
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Unhandled API Error:", err);
  res.status(err.status || 500).json({
    error: err.message || "Internal Server Error",
  });
});

export default app;
