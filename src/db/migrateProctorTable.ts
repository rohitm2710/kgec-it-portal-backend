import { db } from "./index.js";
import { sql } from "drizzle-orm";

export async function ensureProctorViolationsTable() {
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS exam_proctor_violations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        exam_id UUID NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
        student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        student_name VARCHAR(150) NOT NULL,
        student_roll VARCHAR(64) NOT NULL,
        violation_type VARCHAR(64) NOT NULL,
        message TEXT NOT NULL,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        is_seen BOOLEAN NOT NULL DEFAULT FALSE
      );
      CREATE INDEX IF NOT EXISTS proctor_viol_exam_student_idx ON exam_proctor_violations(exam_id, student_id);

      -- Ensure shared_with_teacher_ids column exists on exams table for collaborative monitoring
      ALTER TABLE exams ADD COLUMN IF NOT EXISTS shared_with_teacher_ids JSONB DEFAULT '[]'::jsonb NOT NULL;
    `);
    console.log("Database schema migrations verified: exam_proctor_violations and shared_with_teacher_ids ready.");
  } catch (err) {
    console.warn("Notice: Table creation check completed with status:", err);
  }
}
