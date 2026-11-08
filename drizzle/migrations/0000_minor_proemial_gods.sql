CREATE TYPE "public"."difficulty_level" AS ENUM('EASY', 'MEDIUM', 'HARD');--> statement-breakpoint
CREATE TYPE "public"."exam_category" AS ENUM('MCQ_EXAM', 'SUBJECTIVE_EXAM', 'MIXED_EXAM', 'PROGRAMMING_EXAM');--> statement-breakpoint
CREATE TYPE "public"."grading_status" AS ENUM('PREPARED', 'IN_PROGRESS', 'SUBMITTED', 'OCR_PROCESSING', 'OCR_COMPLETED', 'AI_GRADING_IN_PROGRESS', 'AI_GRADED', 'MANUAL_OVERRIDDEN', 'FINALIZED');--> statement-breakpoint
CREATE TYPE "public"."question_type" AS ENUM('MCQ', 'SAQ', 'LAQ', 'PROGRAMMING');--> statement-breakpoint
CREATE TYPE "public"."routine_status" AS ENUM('SCHEDULED', 'PRE_EXAM_NOTIFY', 'LIVE', 'COMPLETED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."submission_mode" AS ENUM('ONLINE_PORTAL', 'SCANNED_SCRIPT');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('TEACHER', 'STUDENT', 'ADMIN');--> statement-breakpoint
CREATE TABLE "announcements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" varchar(255) NOT NULL,
	"content" text NOT NULL,
	"author_id" uuid NOT NULL,
	"target_academic_year" integer,
	"target_semester" integer,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_pinned" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exam_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"exam_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"question_type" "question_type" NOT NULL,
	"difficulty" "difficulty_level" NOT NULL,
	"marks_allocated" numeric(5, 2) NOT NULL,
	"sequence_order" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exam_routines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"exam_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"academic_year" integer NOT NULL,
	"semester" integer NOT NULL,
	"exam_category" "exam_category" NOT NULL,
	"room_or_lab_name" varchar(64) DEFAULT 'Online Portal',
	"scheduled_start_time" timestamp with time zone NOT NULL,
	"scheduled_end_time" timestamp with time zone NOT NULL,
	"notify_before_minutes" integer DEFAULT 10 NOT NULL,
	"notification_trigger_time" timestamp with time zone NOT NULL,
	"routine_status" "routine_status" DEFAULT 'SCHEDULED' NOT NULL,
	"notification_sent" boolean DEFAULT false NOT NULL,
	"created_by_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exam_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"exam_id" uuid NOT NULL,
	"routine_id" uuid,
	"student_id" uuid NOT NULL,
	"submission_mode" "submission_mode" NOT NULL,
	"status" "grading_status" DEFAULT 'PREPARED' NOT NULL,
	"scanned_script_urls" jsonb,
	"total_mcq_marks" numeric(6, 2) DEFAULT '0.00',
	"total_ai_subjective_marks" numeric(6, 2) DEFAULT '0.00',
	"total_final_marks" numeric(6, 2) DEFAULT '0.00',
	"evaluated_by_id" uuid,
	"teacher_overall_feedback" text,
	"prepared_at" timestamp with time zone DEFAULT now(),
	"started_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"evaluated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "exams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" varchar(255) NOT NULL,
	"subject_id" uuid NOT NULL,
	"created_by_id" uuid NOT NULL,
	"academic_year" integer NOT NULL,
	"semester" integer NOT NULL,
	"exam_category" "exam_category" NOT NULL,
	"duration_minutes" integer NOT NULL,
	"total_marks" numeric(6, 2) NOT NULL,
	"blueprint_config" jsonb NOT NULL,
	"is_paper_prepared" boolean DEFAULT false NOT NULL,
	"openrouter_model" varchar(120) DEFAULT 'google/gemini-2.5-pro',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_id" uuid NOT NULL,
	"created_by_id" uuid,
	"question_type" "question_type" NOT NULL,
	"difficulty" "difficulty_level" NOT NULL,
	"unit_or_topic" varchar(150),
	"question_text" text NOT NULL,
	"diagram_image_url" text,
	"mcq_options" jsonb,
	"correct_option_id" varchar(16),
	"reference_answer" text,
	"grading_rubric" jsonb,
	"expected_word_count" integer,
	"programming_metadata" jsonb,
	"default_marks" numeric(5, 2) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subjects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_code" varchar(32) NOT NULL,
	"subject_name" varchar(200) NOT NULL,
	"academic_year" integer NOT NULL,
	"semester" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "submission_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submission_id" uuid NOT NULL,
	"exam_question_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"selected_option_id" varchar(16),
	"student_answer_text" text,
	"scanned_answer_image_urls" jsonb,
	"ocr_confidence_score" numeric(5, 2),
	"auto_mcq_marks" numeric(5, 2),
	"ai_suggested_marks" numeric(5, 2),
	"ai_evaluation_reasoning" text,
	"ai_matched_key_points" jsonb,
	"ai_missing_key_points" jsonb,
	"openrouter_model_used" varchar(120),
	"is_manually_overridden" boolean DEFAULT false NOT NULL,
	"manual_override_marks" numeric(5, 2),
	"teacher_comment" text,
	"overridden_by_id" uuid,
	"overridden_at" timestamp with time zone,
	"final_awarded_marks" numeric(5, 2) DEFAULT '0.00' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institutional_id" varchar(64) NOT NULL,
	"full_name" varchar(150) NOT NULL,
	"email" varchar(255) NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role" NOT NULL,
	"academic_year" integer,
	"semester" integer,
	"batch_year" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_questions" ADD CONSTRAINT "exam_questions_exam_id_exams_id_fk" FOREIGN KEY ("exam_id") REFERENCES "public"."exams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_questions" ADD CONSTRAINT "exam_questions_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_routines" ADD CONSTRAINT "exam_routines_exam_id_exams_id_fk" FOREIGN KEY ("exam_id") REFERENCES "public"."exams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_routines" ADD CONSTRAINT "exam_routines_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_routines" ADD CONSTRAINT "exam_routines_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_submissions" ADD CONSTRAINT "exam_submissions_exam_id_exams_id_fk" FOREIGN KEY ("exam_id") REFERENCES "public"."exams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_submissions" ADD CONSTRAINT "exam_submissions_routine_id_exam_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."exam_routines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_submissions" ADD CONSTRAINT "exam_submissions_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_submissions" ADD CONSTRAINT "exam_submissions_evaluated_by_id_users_id_fk" FOREIGN KEY ("evaluated_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exams" ADD CONSTRAINT "exams_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exams" ADD CONSTRAINT "exams_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_answers" ADD CONSTRAINT "submission_answers_submission_id_exam_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."exam_submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_answers" ADD CONSTRAINT "submission_answers_exam_question_id_exam_questions_id_fk" FOREIGN KEY ("exam_question_id") REFERENCES "public"."exam_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_answers" ADD CONSTRAINT "submission_answers_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_answers" ADD CONSTRAINT "submission_answers_overridden_by_id_users_id_fk" FOREIGN KEY ("overridden_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "exam_questions_unique_idx" ON "exam_questions" USING btree ("exam_id","question_id");--> statement-breakpoint
CREATE INDEX "exam_routines_year_time_idx" ON "exam_routines" USING btree ("academic_year","scheduled_start_time","scheduled_end_time");--> statement-breakpoint
CREATE UNIQUE INDEX "student_exam_submission_unique_idx" ON "exam_submissions" USING btree ("exam_id","student_id");--> statement-breakpoint
CREATE INDEX "questions_blueprint_lookup_idx" ON "questions" USING btree ("subject_id","question_type","difficulty","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "subjects_code_idx" ON "subjects" USING btree ("subject_code");--> statement-breakpoint
CREATE UNIQUE INDEX "submission_question_unique_idx" ON "submission_answers" USING btree ("submission_id","exam_question_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "users_institutional_id_idx" ON "users" USING btree ("institutional_id");--> statement-breakpoint
CREATE INDEX "users_academic_year_sem_idx" ON "users" USING btree ("academic_year","semester");