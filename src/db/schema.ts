import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  integer,
  numeric,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// ==========================================
// 1. POSTGRES ENUMS
// ==========================================

export const userRoleEnum = pgEnum("user_role", [
  "TEACHER",
  "STUDENT",
  "ADMIN",
]);

export const questionTypeEnum = pgEnum("question_type", [
  "MCQ",         // Multiple Choice Question (Auto-graded)
  "SAQ",         // Short Answer Question (OpenRouter AI + Manual Override)
  "LAQ",         // Long Answer Question (OpenRouter AI + Manual Override)
  "PROGRAMMING", // Reserved for future implementation
]);

export const difficultyEnum = pgEnum("difficulty_level", [
  "EASY",
  "MEDIUM",
  "HARD",
]);

export const examCategoryEnum = pgEnum("exam_category", [
  "MCQ_EXAM",
  "SUBJECTIVE_EXAM", // Contains SAQ, LAQ, or both
  "MIXED_EXAM",      // Contains MCQ + SAQ + LAQ
  "PROGRAMMING_EXAM",// Reserved for future implementation
]);

export const routineStatusEnum = pgEnum("routine_status", [
  "SCHEDULED",       // Exam is in routine; > 10 mins before start (hidden from student alerts)
  "PRE_EXAM_NOTIFY", // Within 10 mins of start; student notified & paper prepared in DB
  "LIVE",            // Exam window is currently open for students of that academic year
  "COMPLETED",       // Exam window has ended
  "CANCELLED",
]);

export const submissionModeEnum = pgEnum("submission_mode", [
  "ONLINE_PORTAL",   // Student typed/selected answers directly in Student Dashboard
  "SCANNED_SCRIPT",  // Teacher uploaded scanned physical answer copies for OCR + AI checking
]);

export const gradingStatusEnum = pgEnum("grading_status", [
  "PREPARED",        // Pre-allocated for student during the 10-minute pre-exam window
  "IN_PROGRESS",
  "SUBMITTED",
  "OCR_PROCESSING",
  "OCR_COMPLETED",
  "AI_GRADING_IN_PROGRESS",
  "AI_GRADED",
  "MANUAL_OVERRIDDEN",
  "FINALIZED",
]);

// ==========================================
// 2. JSONB TYPE DEFINITIONS
// ==========================================

export interface McqOption {
  id: string;   // e.g., "A", "B", "C", "D"
  text: string;
}

export interface GradingRubricItem {
  criterion: string;
  maxWeight: number;
  keywords?: string[];
}

export interface BlueprintRule {
  questionType: "MCQ" | "SAQ" | "LAQ" | "PROGRAMMING";
  difficulty: "EASY" | "MEDIUM" | "HARD";
  count: number;            // Number of questions to pick from DB
  marksPerQuestion: number; // Marks awarded per question in this bucket
}

export interface ExamBlueprintConfig {
  totalQuestions: number;
  easyCount: number;
  mediumCount: number;
  hardCount: number;
  coveredModules: string[]; // e.g., ["Unit 1", "Unit 2", "Unit 3"]
  examFormat: "MCQ" | "SAQ_LAQ" | "MIXED";
  marksPerQuestion?: number;
  rules?: BlueprintRule[];
  shuffleQuestions?: boolean;
  allowPartialMarkingInAi?: boolean;
  strictnessLevel?: "LENIENT" | "MODERATE" | "STRICT";
}

export interface MediaAttachment {
  fileName: string;
  fileUrl: string;
  fileType: "PDF" | "IMAGE" | "OTHER";
  fileSizeBytes?: number;
}

// ==========================================
// 3. CORE TABLES
// ==========================================

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    institutionalId: varchar("institutional_id", { length: 64 }).notNull(), // Roll No or Faculty ID
    fullName: varchar("full_name", { length: 150 }).notNull(),
    email: varchar("email", { length: 255 }).notNull(),
    passwordHash: text("password_hash").notNull(),
    role: userRoleEnum("role").notNull(),
    academicYear: integer("academic_year"), // 1 (1st Yr), 2 (2nd Yr), 3 (3rd Yr), 4 (4th Yr) — null for Teachers
    semester: integer("semester"),          // 1-8 for Students, null for Teachers
    batchYear: integer("batch_year"),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("users_email_idx").on(table.email),
    uniqueIndex("users_institutional_id_idx").on(table.institutionalId),
    index("users_academic_year_sem_idx").on(table.academicYear, table.semester),
  ]
);

export const subjects = pgTable(
  "subjects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    subjectCode: varchar("subject_code", { length: 32 }).notNull(), // e.g., "PCC-IT501"
    subjectName: varchar("subject_name", { length: 200 }).notNull(), // e.g., "Database Management Systems"
    academicYear: integer("academic_year").notNull(), // e.g., 3 for 3rd Year
    semester: integer("semester").notNull(),          // e.g., 5 or 6 for 3rd Year
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("subjects_code_idx").on(table.subjectCode),
  ]
);

// QUESTION BANK TABLE
export const questions = pgTable(
  "questions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    subjectId: uuid("subject_id")
      .references(() => subjects.id, { onDelete: "cascade" })
      .notNull(),
    createdById: uuid("created_by_id")
      .references(() => users.id, { onDelete: "set null" }),
    questionType: questionTypeEnum("question_type").notNull(),
    difficulty: difficultyEnum("difficulty").notNull(),
    unitOrTopic: varchar("unit_or_topic", { length: 150 }),
    questionText: text("question_text").notNull(),
    diagramImageUrl: text("diagram_image_url"),

    // MCQ-Specific Fields (null for SAQ / LAQ)
    mcqOptions: jsonb("mcq_options").$type<McqOption[]>(),
    correctOptionId: varchar("correct_option_id", { length: 16 }),

    // SAQ / LAQ Reference Checking Fields (Used by OpenRouter AI)
    referenceAnswer: text("reference_answer"), // Ideal model answer for AI comparison
    gradingRubric: jsonb("grading_rubric").$type<GradingRubricItem[]>(), // Stepwise marking criteria
    expectedWordCount: integer("expected_word_count"),

    // Reserved for Future Programming Exam Module
    programmingMetadata: jsonb("programming_metadata").$type<{
      allowedLanguages?: string[];
      timeLimitMs?: number;
      memoryLimitMb?: number;
      starterCode?: Record<string, string>;
      testCasesUrl?: string;
    }>(),

    defaultMarks: numeric("default_marks", { precision: 5, scale: 2 }).notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // Composite index for fast Blueprint Random Selection
    index("questions_blueprint_lookup_idx").on(
      table.subjectId,
      table.questionType,
      table.difficulty,
      table.isActive
    ),
  ]
);

// EXAMS TABLE (Defines the Blueprint Standard & Question Set)
export const exams = pgTable("exams", {
  id: uuid("id").defaultRandom().primaryKey(),
  title: varchar("title", { length: 255 }).notNull(), // e.g., "CA-2 DBMS (3rd Year IT)"
  subjectId: uuid("subject_id")
    .references(() => subjects.id, { onDelete: "restrict" })
    .notNull(),
  createdById: uuid("created_by_id")
    .references(() => users.id, { onDelete: "restrict" })
    .notNull(),
  academicYear: integer("academic_year").notNull(), // e.g., 3 (3rd Year)
  semester: integer("semester").notNull(),          // e.g., 5
  examCategory: examCategoryEnum("exam_category").notNull(),
  durationMinutes: integer("duration_minutes").notNull(),
  totalMarks: numeric("total_marks", { precision: 6, scale: 2 }).notNull(),

  // Covered units/modules (e.g., ["Unit 1", "Unit 2", "Unit 3"])
  coveredModules: jsonb("covered_modules").$type<string[]>().default([]).notNull(),

  // Structured question count breakdown
  totalQuestions: integer("total_questions").default(10).notNull(),
  easyCount: integer("easy_count").default(0).notNull(),
  mediumCount: integer("medium_count").default(0).notNull(),
  hardCount: integer("hard_count").default(0).notNull(),

  // Stores the exact blueprint criteria specified by the teacher
  blueprintConfig: jsonb("blueprint_config").$type<ExamBlueprintConfig>().notNull(),

  // Whether the questions have already been picked & locked from the DB
  isPaperPrepared: boolean("is_paper_prepared").default(false).notNull(),

  // OpenRouter AI model preference for grading SAQ/LAQ in this exam
  openRouterModel: varchar("openrouter_model", { length: 120 }).default(
    "google/gemini-2.5-pro"
  ),

  // Teachers with shared monitoring access granted by the owner teacher
  sharedWithTeacherIds: jsonb("shared_with_teacher_ids").$type<string[]>().default([]).notNull(),

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// EXAM ROUTINE TABLE ("Routine Check" Module — Controls Exam Access & 10-Min Pre-Start Alerts)
export const examRoutines = pgTable(
  "exam_routines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    examId: uuid("exam_id")
      .references(() => exams.id, { onDelete: "cascade" })
      .notNull(),
    subjectId: uuid("subject_id")
      .references(() => subjects.id, { onDelete: "cascade" })
      .notNull(),
    academicYear: integer("academic_year").notNull(), // 1, 2, 3 (3rd Year), or 4
    semester: integer("semester").notNull(),          // 1-8
    examCategory: examCategoryEnum("exam_category").notNull(),
    roomOrLabName: varchar("room_or_lab_name", { length: 64 }).default("Online Portal"),

    // Exact Exam Window
    scheduledStartTime: timestamp("scheduled_start_time", { withTimezone: true }).notNull(),
    scheduledEndTime: timestamp("scheduled_end_time", { withTimezone: true }).notNull(),

    // 10-Minute Pre-Exam Notification & Preparation Window
    notifyBeforeMinutes: integer("notify_before_minutes").default(10).notNull(),
    // Automatically set to (scheduledStartTime - 10 minutes) on creation
    notificationTriggerTime: timestamp("notification_trigger_time", {
      withTimezone: true,
    }).notNull(),

    routineStatus: routineStatusEnum("routine_status").default("SCHEDULED").notNull(),
    notificationSent: boolean("notification_sent").default(false).notNull(),
    createdById: uuid("created_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // Fast lookup when a 3rd Year student attempts to enter an exam or polls notifications
    index("exam_routines_year_time_idx").on(
      table.academicYear,
      table.scheduledStartTime,
      table.scheduledEndTime
    ),
  ]
);

// EXAM QUESTIONS MAPPING TABLE (Populated automatically by Blueprint Generator API)
export const examQuestions = pgTable(
  "exam_questions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    examId: uuid("exam_id")
      .references(() => exams.id, { onDelete: "cascade" })
      .notNull(),
    questionId: uuid("question_id")
      .references(() => questions.id, { onDelete: "restrict" })
      .notNull(),
    questionType: questionTypeEnum("question_type").notNull(),
    difficulty: difficultyEnum("difficulty").notNull(),
    marksAllocated: numeric("marks_allocated", { precision: 5, scale: 2 }).notNull(),
    sequenceOrder: integer("sequence_order").notNull(),
  },
  (table) => [
    uniqueIndex("exam_questions_unique_idx").on(
      table.examId,
      table.questionId
    ),
  ]
);

// STUDENT EXAM SUBMISSIONS (Online Portal OR Teacher-Uploaded Scanned Script)
export const examSubmissions = pgTable(
  "exam_submissions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    examId: uuid("exam_id")
      .references(() => exams.id, { onDelete: "cascade" })
      .notNull(),
    routineId: uuid("routine_id").references(() => examRoutines.id, {
      onDelete: "set null",
    }),
    studentId: uuid("student_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    submissionMode: submissionModeEnum("submission_mode").notNull(),
    status: gradingStatusEnum("status").default("PREPARED").notNull(),

    // Full script scan URLs (if uploaded as a multi-page PDF/image bundle by teacher)
    scannedScriptUrls: jsonb("scanned_script_urls").$type<string[]>(),

    // Score Breakdown
    totalMcqMarks: numeric("total_mcq_marks", { precision: 6, scale: 2 }).default("0.00"),
    totalAiSubjectiveMarks: numeric("total_ai_subjective_marks", {
      precision: 6,
      scale: 2,
    }).default("0.00"),
    totalFinalMarks: numeric("total_final_marks", { precision: 6, scale: 2 }).default(
      "0.00"
    ),

    evaluatedById: uuid("evaluated_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    teacherOverallFeedback: text("teacher_overall_feedback"),
    preparedAt: timestamp("prepared_at", { withTimezone: true }).defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("student_exam_submission_unique_idx").on(
      table.examId,
      table.studentId
    ),
  ]
);

// INDIVIDUAL QUESTION RESPONSES & HYBRID GRADING RECORD
export const submissionAnswers = pgTable(
  "submission_answers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    submissionId: uuid("submission_id")
      .references(() => examSubmissions.id, { onDelete: "cascade" })
      .notNull(),
    examQuestionId: uuid("exam_question_id")
      .references(() => examQuestions.id, { onDelete: "cascade" })
      .notNull(),
    questionId: uuid("question_id")
      .references(() => questions.id, { onDelete: "restrict" })
      .notNull(),

    // 1. Student Response Data
    selectedOptionId: varchar("selected_option_id", { length: 16 }), // For MCQ
    studentAnswerText: text("student_answer_text"), // Typed online OR extracted via OCR
    scannedAnswerImageUrls: jsonb("scanned_answer_image_urls").$type<string[]>(), // Cropped/page scans
    ocrConfidenceScore: numeric("ocr_confidence_score", { precision: 5, scale: 2 }),

    // 2. Automated MCQ Marks
    autoMcqMarks: numeric("auto_mcq_marks", { precision: 5, scale: 2 }),

    // 3. OpenRouter AI Evaluation for SAQ / LAQ
    aiSuggestedMarks: numeric("ai_suggested_marks", { precision: 5, scale: 2 }),
    aiEvaluationReasoning: text("ai_evaluation_reasoning"),
    aiMatchedKeyPoints: jsonb("ai_matched_key_points").$type<string[]>(),
    aiMissingKeyPoints: jsonb("ai_missing_key_points").$type<string[]>(),
    openRouterModelUsed: varchar("openrouter_model_used", { length: 120 }),

    // 4. Teacher Manual Entry / Override (Takes Precedence Over AI Marks)
    isManuallyOverridden: boolean("is_manually_overridden").default(false).notNull(),
    manualOverrideMarks: numeric("manual_override_marks", { precision: 5, scale: 2 }),
    teacherComment: text("teacher_comment"),
    overriddenById: uuid("overridden_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    overriddenAt: timestamp("overridden_at", { withTimezone: true }),

    // 5. Effective Final Score for this Answer
    // Resolved as: manualOverrideMarks ?? aiSuggestedMarks ?? autoMcqMarks ?? 0
    finalAwardedMarks: numeric("final_awarded_marks", {
      precision: 5,
      scale: 2,
    })
      .default("0.00")
      .notNull(),
  },
  (table) => [
    uniqueIndex("submission_question_unique_idx").on(
      table.submissionId,
      table.examQuestionId
    ),
  ]
);

// ANNOUNCEMENTS & MEDIA BROADCAST TABLE
export const announcements = pgTable("announcements", {
  id: uuid("id").defaultRandom().primaryKey(),
  title: varchar("title", { length: 255 }).notNull(),
  content: text("content").notNull(),
  authorId: uuid("author_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  targetAcademicYear: integer("target_academic_year"), // null = visible to ALL years & teachers
  targetSemester: integer("target_semester"),         // null = visible to ALL semesters
  attachments: jsonb("attachments").$type<MediaAttachment[]>().default([]).notNull(),
  isPinned: boolean("is_pinned").default(false).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// EXAM PROCTOR VIOLATION LOGS TABLE (Supports teacher 'Mark as Seen' space cleanup)
export const examProctorViolations = pgTable(
  "exam_proctor_violations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    examId: uuid("exam_id")
      .references(() => exams.id, { onDelete: "cascade" })
      .notNull(),
    studentId: uuid("student_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    studentName: varchar("student_name", { length: 150 }).notNull(),
    studentRoll: varchar("student_roll", { length: 64 }).notNull(),
    violationType: varchar("violation_type", { length: 64 }).notNull(), // 'FULLSCREEN_EXIT' | 'INTERNET_DETECTED_DURING_EXAM'
    message: text("message").notNull(),
    timestamp: timestamp("timestamp", { withTimezone: true }).defaultNow().notNull(),
    isSeen: boolean("is_seen").default(false).notNull(),
  },
  (table) => [
    index("proctor_viol_exam_student_idx").on(table.examId, table.studentId),
  ]
);
