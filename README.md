# KGEC IT Department Portal — Backend Engine & API Specification

A standalone, type-safe backend for the **Kalyani Government Engineering College (KGEC) - Department of Information Technology Portal**, built with **Express**, **TypeScript**, **Drizzle ORM**, and **Neon Serverless Postgres**, implementing the full specifications from [`kgec_it_portal_db_api_docs.md`](../kgec_it_portal_db_api_docs.md).

---

## 🏗️ Architecture & Core Modules

| Module | Source File | Description |
| :--- | :--- | :--- |
| **Database Schema** | [`src/db/schema.ts`](./src/db/schema.ts) | 8 Drizzle ORM tables: `users`, `subjects`, `questions`, `exams`, `examRoutines`, `examQuestions`, `examSubmissions`, `submissionAnswers`, `announcements`. |
| **Database Client** | [`src/db/index.ts`](./src/db/index.ts) | Configures both `dbHttp` (for fast reads) and `db` WebSocket Pool (for ACID transactions). |
| **Blueprint Generator** | [`src/services/examGenerator.ts`](./src/services/examGenerator.ts) | Randomizes and generates exam papers from Blueprint standard (`EASY`, `MEDIUM`, `HARD` per `MCQ`/`SAQ`/`LAQ`) and schedules routines. |
| **Exam Gatekeeper** | [`src/services/examRoutineGatekeeper.ts`](./src/services/examRoutineGatekeeper.ts) | Enforces 10-minute pre-exam preparation and notification window per academic year. Blocks early access, pre-allocates question papers in DB, and opens live exams at start time. |
| **AI Grading & OCR** | [`src/services/aiGradingService.ts`](./src/services/aiGradingService.ts) | OCR text extraction and reference-based OpenRouter AI grading with rubric matching. |
| **Manual Override** | [`src/services/manualGradingService.ts`](./src/services/manualGradingService.ts) | Allows instructors to manually override question marks and recalculates aggregate totals. |
| **Security & Roles** | [`src/middleware/auth.ts`](./src/middleware/auth.ts) | JWT verification and role-based access control (`TEACHER`, `STUDENT`, `ADMIN`), with developer testing headers (`x-user-id`, `x-user-role`). |

---

## ⚡ Quick Start & Local Testing

The backend is fully self-contained and ready for testing before connecting your Neon database credentials.

### 1. Run Automated Unit Tests (Offline / Mock Mode)

Run the test suite that verifies all routing, authentication, role restrictions, and the reserved programming stub:

```bash
cd backend
node test-endpoints.js
```

### 2. Start the Development Server

```bash
cd backend
npm run dev
```

The server will listen on `http://localhost:5000`.

---

## 📡 REST API Endpoints Reference

### 1. Authentication (`/api/auth`)
- `POST /api/auth/login`: Authenticates user (`institutionalId`, `password`, `role`). Returns JWT token.
- `GET /api/auth/me`: Returns active user profile with `role`, `academicYear`, and `semester`.

### 2. Question Bank (`/api/questions`)
- `POST /api/questions`: Adds an `MCQ`, `SAQ`, or `LAQ` question with reference answers and rubrics. *(Role: TEACHER)*
- `GET /api/questions/bank-summary`: Returns question count breakdown by subject, type, and difficulty. *(Role: TEACHER)*
- `GET /api/questions`: Lists filterable questions. *(Role: TEACHER)*
- `PATCH /api/questions/:id`: Updates an existing question. *(Role: TEACHER)*

### 3. Exam Blueprint & Routine (`/api/exams`, `/api/exam-routines`)
- `POST /api/exams/generate-from-blueprint`: Creates an exam blueprint and schedules routine with `notificationTriggerTime = scheduledStartTime - 10 minutes`. *(Role: TEACHER)*
- `POST /api/exams/:examId/swap-question/:examQuestionId`: Replaces an allocated question with another from the same bucket. *(Role: TEACHER)*
- `GET /api/exam-routines`: Views scheduled routines (filter by `?academicYear=3`).
- `PATCH /api/exam-routines/:routineId`: Updates start/end times or room allocation. *(Role: TEACHER)*

### 4. Student Exam Entry & 10-Minute Pre-Exam Gatekeeper (`/api/student/exams`)
- `POST /api/student/exams/enter-or-check`: 
  - **> 10 mins before start**: Returns `403 Forbidden` (`NOT_TIME_YET`) with countdown to alert.
  - **Within 10 mins of start**: Returns `200 OK` (`PRE_EXAM_PREPARE_10_MIN`), prepares question paper in DB, returns countdown.
  - **Live exam**: Returns `200 OK` (`EXAM_LIVE_ENTER`) with sanitized question paper.
- `GET /api/student/exams/notifications`: Polls active 10-minute notifications.
- `POST /api/student/exams/:examId/submit`: Submits answers, auto-grades MCQs immediately, and queues subjective answers for AI grading.
- `ALL /api/student/exams/:examId/programming/*`: Returns `501 Not Implemented` with `PROGRAMMING_EXAM_UNDER_DEVELOPMENT` reserved stub.

### 5. AI Grading, OCR & Marks Override (`/api/grading`)
- `POST /api/grading/submissions/upload-scan`: OCR extracts handwriting from scanned scripts and evaluates using OpenRouter AI.
- `PATCH /api/grading/answers/:answerId/override-marks`: Teacher overrides marks for a question; updates total scores.
- `POST /api/grading/submissions/direct-entry`: Directly inputs marks into student ledger.
- `PATCH /api/grading/submissions/:submissionId/finalize`: Finalizes and locks student score.

### 6. Media Announcements (`/api/announcements`)
- `GET /api/announcements`: Lists announcements with downloadable PDF and image attachments.
- `POST /api/announcements`: Broadcasts a new announcement with media attachments. *(Role: TEACHER)*

---

## 🗄️ Database Connection (When You Are Ready to Connect)

When ready to connect to your live Neon Postgres instance:
1. Update `.env` with your actual Neon connection strings (`DATABASE_URL` and `DIRECT_URL`).
2. Push the schema to Neon:
   ```bash
   npm run db:push
   ```
3. Seed sample data:
   ```bash
   npm run db:seed
   ```
