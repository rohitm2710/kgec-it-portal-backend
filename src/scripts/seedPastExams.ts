import * as dotenv from "dotenv";
dotenv.config();

import bcrypt from "bcryptjs";
import { db } from "../db/index.js";
import {
  users,
  subjects,
  exams,
  examSubmissions,
} from "../db/schema.js";
import { eq, and } from "drizzle-orm";

async function main() {
  console.log("Seeding authentic past exams and student roster...");

  const passwordHash = await bcrypt.hash("kgec2026", 10);

  // 1. Get or create Teacher
  let [teacher] = await db.select().from(users).where(eq(users.role, "TEACHER")).limit(1);
  if (!teacher) {
    const [newTeacher] = await db.insert(users).values({
      institutionalId: "FAC-IT-042",
      fullName: "Dr. S. Roy",
      email: "s.roy@kgec.edu.in",
      passwordHash,
      role: "TEACHER",
    }).returning();
    teacher = newTeacher;
  }

  // 2. Seed enrolled 3rd Year / 6th Semester students
  const semester6Students = [
    { roll: "10200122001", name: "Aarav Sharma", email: "aarav.sharma.22@kgec.edu.in" },
    { roll: "10200122015", name: "Debojyoti Banerjee", email: "debojyoti.b.22@kgec.edu.in" },
    { roll: "10200122028", name: "Ishita Mukherjee", email: "ishita.m.22@kgec.edu.in" },
    { roll: "10200122035", name: "Pritam Roy", email: "pritam.roy.22@kgec.edu.in" },
    { roll: "10200122045", name: "Rahul Dey", email: "rahul.dey.22@kgec.edu.in" },
    { roll: "10200122052", name: "Sayan Chakraborty", email: "sayan.c.22@kgec.edu.in" },
    { roll: "10200122058", name: "Tanmoy Das", email: "tanmoy.das.22@kgec.edu.in" },
  ];

  const studentMap = new Map<string, string>(); // roll -> uuid

  for (const s of semester6Students) {
    const [existing] = await db
      .select()
      .from(users)
      .where(eq(users.institutionalId, s.roll))
      .limit(1);

    if (existing) {
      // update semester to 6 and academicYear to 3
      await db
        .update(users)
        .set({ semester: 6, academicYear: 3, fullName: s.name })
        .where(eq(users.id, existing.id));
      studentMap.set(s.roll, existing.id);
    } else {
      const [created] = await db
        .insert(users)
        .values({
          institutionalId: s.roll,
          fullName: s.name,
          email: s.email,
          passwordHash,
          role: "STUDENT",
          academicYear: 3,
          semester: 6,
          batchYear: 2026,
        })
        .returning();
      studentMap.set(s.roll, created.id);
    }
  }

  // 3. Ensure Subjects
  let [dbmsSubject] = await db
    .select()
    .from(subjects)
    .where(eq(subjects.subjectCode, "PCC-CS601"))
    .limit(1);

  if (!dbmsSubject) {
    const [newSub] = await db
      .insert(subjects)
      .values({
        subjectCode: "PCC-CS601",
        subjectName: "Database Management Systems",
        academicYear: 3,
        semester: 6,
      })
      .returning();
    dbmsSubject = newSub;
  }

  let [seSubject] = await db
    .select()
    .from(subjects)
    .where(eq(subjects.subjectCode, "IT-601"))
    .limit(1);

  if (!seSubject) {
    const [newSub] = await db
      .insert(subjects)
      .values({
        subjectCode: "IT-601",
        subjectName: "Software Engineering & System Design",
        academicYear: 3,
        semester: 6,
      })
      .returning();
    seSubject = newSub;
  }

  // 4. Seed Past Exam 1: CA-1 DBMS
  const exam1Date = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // 7 days ago
  const [exam1] = await db
    .insert(exams)
    .values({
      title: "Continuous Assessment 1 (CA-1): Database Management Systems",
      subjectId: dbmsSubject.id,
      createdById: teacher.id,
      academicYear: 3,
      semester: 6,
      examCategory: "MCQ_EXAM",
      durationMinutes: 30,
      totalMarks: "30.00",
      coveredModules: ["Unit 1: Relational Model", "Unit 2: Normalization", "Unit 3: SQL & Transactions"],
      totalQuestions: 15,
      easyCount: 5,
      mediumCount: 7,
      hardCount: 3,
      blueprintConfig: {
        totalQuestions: 15,
        easyCount: 5,
        mediumCount: 7,
        hardCount: 3,
        coveredModules: ["Unit 1", "Unit 2", "Unit 3"],
        examFormat: "MCQ",
        marksPerQuestion: 2,
      },
      isPaperPrepared: true,
      createdAt: exam1Date,
    })
    .returning();

  // Submissions for Exam 1:
  // Rahul Dey (10200122045) - 26/30 (Appeared)
  // Debojyoti Banerjee (10200122015) - 22/30 (Appeared)
  // Sayan Chakraborty (10200122052) - 18.5/30 (Appeared)
  // Others: Aarav, Ishita, Pritam, Tanmoy are ABSENT (AB)!
  const exam1Submissions = [
    { roll: "10200122045", marks: "26.00", mode: "ONLINE_PORTAL" as const },
    { roll: "10200122015", marks: "22.00", mode: "ONLINE_PORTAL" as const },
    { roll: "10200122052", marks: "18.50", mode: "ONLINE_PORTAL" as const },
  ];

  for (const sub of exam1Submissions) {
    const studentId = studentMap.get(sub.roll);
    if (studentId) {
      await db.insert(examSubmissions).values({
        examId: exam1.id,
        studentId,
        submissionMode: sub.mode,
        status: "FINALIZED",
        totalMcqMarks: sub.marks,
        totalAiSubjectiveMarks: "0.00",
        totalFinalMarks: sub.marks,
        evaluatedById: teacher.id,
        submittedAt: new Date(exam1Date.getTime() + 25 * 60000),
        evaluatedAt: new Date(exam1Date.getTime() + 35 * 60000),
        teacherOverallFeedback: "Excellent conceptual grasp of Relational Calculus and 3NF normalization.",
      });
    }
  }

  // 5. Seed Past Exam 2: Mid-Semester Software Engineering
  const exam2Date = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000); // 3 days ago
  const [exam2] = await db
    .insert(exams)
    .values({
      title: "Mid-Semester Examination: Software Engineering & System Design",
      subjectId: seSubject.id,
      createdById: teacher.id,
      academicYear: 3,
      semester: 6,
      examCategory: "SUBJECTIVE_EXAM",
      durationMinutes: 60,
      totalMarks: "50.00",
      coveredModules: ["Unit 1: Agile & Scrum", "Unit 2: Architectural Patterns", "Unit 3: Testing & CI/CD"],
      totalQuestions: 10,
      easyCount: 3,
      mediumCount: 4,
      hardCount: 3,
      blueprintConfig: {
        totalQuestions: 10,
        easyCount: 3,
        mediumCount: 4,
        hardCount: 3,
        coveredModules: ["Unit 1", "Unit 2", "Unit 3"],
        examFormat: "SAQ_LAQ",
        marksPerQuestion: 5,
      },
      isPaperPrepared: true,
      createdAt: exam2Date,
    })
    .returning();

  // Submissions for Exam 2:
  // Rahul Dey (10200122045) - 44.00/50 (Appeared)
  // Aarav Sharma (10200122001) - 39.50/50 (Appeared)
  // Ishita Mukherjee (10200122028) - 46.00/50 (Appeared)
  // Debojyoti, Pritam, Sayan, Tanmoy are ABSENT (AB)!
  const exam2Submissions = [
    { roll: "10200122045", marks: "44.00", mode: "ONLINE_PORTAL" as const },
    { roll: "10200122001", marks: "39.50", mode: "ONLINE_PORTAL" as const },
    { roll: "10200122028", marks: "46.00", mode: "ONLINE_PORTAL" as const },
  ];

  for (const sub of exam2Submissions) {
    const studentId = studentMap.get(sub.roll);
    if (studentId) {
      await db.insert(examSubmissions).values({
        examId: exam2.id,
        studentId,
        submissionMode: sub.mode,
        status: "FINALIZED",
        totalMcqMarks: "0.00",
        totalAiSubjectiveMarks: sub.marks,
        totalFinalMarks: sub.marks,
        evaluatedById: teacher.id,
        submittedAt: new Date(exam2Date.getTime() + 52 * 60000),
        evaluatedAt: new Date(exam2Date.getTime() + 75 * 60000),
        teacherOverallFeedback: "Well-structured microservice design answers and comprehensive unit test definitions.",
      });
    }
  }

  console.log("Seeding complete! Past exams created with both appeared students and absentees (AB).");
  process.exit(0);
}

main().catch((err) => {
  console.error("Seeding failed:", err);
  process.exit(1);
});
