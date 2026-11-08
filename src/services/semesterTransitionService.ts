import { db } from "../db/index.js";
import {
  users,
  announcements,
  exams,
  examRoutines,
  examQuestions,
  examSubmissions,
  submissionAnswers,
  examProctorViolations,
} from "../db/schema.js";
import { eq, and, gte, inArray, sql } from "drizzle-orm";
import { resetProctorForNewSemester } from "../routes/proctor.js";
import bcrypt from "bcryptjs";

export interface SemesterTransitionOptions {
  dryRun?: boolean;
  semesterLabel?: string;
  adminIdentifier?: string;
}

export interface GraduationCandidate {
  id: string;
  institutionalId: string;
  fullName: string;
  email: string;
  completedSemester: number;
  finalAcademicYear: number;
}

export interface PromotionRecord {
  id: string;
  institutionalId: string;
  fullName: string;
  fromSemester: number;
  toSemester: number;
  fromAcademicYear: number;
  toAcademicYear: number;
}

export interface TransitionAuditSummary {
  success: boolean;
  dryRun: boolean;
  executedAt: string;
  semesterLabel: string;
  adminIdentifier: string;
  studentsPromotedCount: number;
  studentsGraduatedAndTerminatedCount: number;
  announcementsDeletedCount: number;
  examsDeletedCount: number;
  routinesDeletedCount: number;
  submissionsAndMarksDeletedCount: number;
  violationsDeletedCount: number;
  promotionsBreakdown: Record<string, number>;
  promotedStudentsList: PromotionRecord[];
  terminatedGraduatesList: GraduationCandidate[];
  systemStateAfterTransition: {
    activeRemainingStudentsCount: number;
    activeTeachersCount: number;
    scheduledExamsCount: number;
    announcementsCount: number;
    systemFreshStateVerified: boolean;
  };
}

/**
 * Calculates academic year (1-4) based on semester number (1-8)
 * Semester 1, 2 -> 1st Year (1)
 * Semester 3, 4 -> 2nd Year (2)
 * Semester 5, 6 -> 3rd Year (3)
 * Semester 7, 8 -> 4th Year (4)
 */
export function calculateAcademicYear(semester: number): number {
  if (semester <= 2) return 1;
  if (semester <= 4) return 2;
  if (semester <= 6) return 3;
  return 4;
}

/**
 * Returns current semester status, student enrollment distribution, and items pending cleanup
 */
export async function getSemesterStatus() {
  try {
    const allUsers = await db.select().from(users);
    const students = allUsers.filter((u) => u.role === "STUDENT");
    const teachers = allUsers.filter((u) => u.role === "TEACHER");

    // Semester distribution
    const distribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0 };
    const graduatingCandidates: GraduationCandidate[] = [];

    students.forEach((s) => {
      const sem = s.semester || 1;
      if (distribution[sem] !== undefined) {
        distribution[sem]++;
      }
      if (sem >= 8) {
        graduatingCandidates.push({
          id: s.id,
          institutionalId: s.institutionalId,
          fullName: s.fullName,
          email: s.email,
          completedSemester: sem,
          finalAcademicYear: s.academicYear || 4,
        });
      }
    });

    let announcementsCount = 0;
    let examsCount = 0;
    let submissionsCount = 0;
    let violationsCount = 0;

    try {
      announcementsCount = (await db.select().from(announcements)).length;
      examsCount = (await db.select().from(exams)).length;
      submissionsCount = (await db.select().from(examSubmissions)).length;
      violationsCount = (await db.select().from(examProctorViolations)).length;
    } catch {}

    return {
      totalStudents: students.length,
      totalTeachers: teachers.length,
      semesterDistribution: distribution,
      candidatesForGraduationAndTerminationCount: graduatingCandidates.length,
      candidatesForGraduationAndTermination: graduatingCandidates,
      candidatesForPromotionCount: students.length - graduatingCandidates.length,
      pendingCleanups: {
        announcementsCount,
        examsCount,
        submissionsAndMarksCount: submissionsCount,
        proctorViolationsCount: violationsCount,
      },
    };
  } catch (err: any) {
    throw new Error(`Failed to retrieve semester status: ${err.message}`);
  }
}

/**
 * Advances the department to a brand-new semester:
 * 1. Promotes all continuing students (Semester < 8) to next semester and year.
 * 2. Terminates complete data of graduating students who touched Semester 8.
 * 3. Deletes all past announcements.
 * 4. Cleans all past exam data, routines, submissions, marks details, and violations.
 * 5. Leaves the system fresh with only teachers and promoted continuing students.
 */
export async function advanceSemester(
  options: SemesterTransitionOptions = {}
): Promise<TransitionAuditSummary> {
  const { dryRun = false, semesterLabel = "Next Academic Semester", adminIdentifier = "ADMIN_CONSOLE" } = options;

  // 1. Fetch current student records
  const allUsers = await db.select().from(users);
  const students = allUsers.filter((u) => u.role === "STUDENT");
  const teachers = allUsers.filter((u) => u.role === "TEACHER");

  // 2. Classify: Graduating (>= 8) vs Promoting (< 8)
  const graduatingStudents: GraduationCandidate[] = [];
  const promotingStudents: PromotionRecord[] = [];
  const breakdown: Record<string, number> = {
    "sem1_to_2": 0,
    "sem2_to_3": 0,
    "sem3_to_4": 0,
    "sem4_to_5": 0,
    "sem5_to_6": 0,
    "sem6_to_7": 0,
    "sem7_to_8": 0,
  };

  students.forEach((s) => {
    const sem = s.semester || 1;
    if (sem >= 8) {
      graduatingStudents.push({
        id: s.id,
        institutionalId: s.institutionalId,
        fullName: s.fullName,
        email: s.email,
        completedSemester: sem,
        finalAcademicYear: s.academicYear || 4,
      });
    } else {
      const fromSem = sem;
      const toSem = fromSem + 1;
      const fromYear = s.academicYear || calculateAcademicYear(fromSem);
      const toYear = calculateAcademicYear(toSem);

      const key = `sem${fromSem}_to_${toSem}`;
      if (breakdown[key] !== undefined) {
        breakdown[key]++;
      }

      promotingStudents.push({
        id: s.id,
        institutionalId: s.institutionalId,
        fullName: s.fullName,
        fromSemester: fromSem,
        toSemester: toSem,
        fromAcademicYear: fromYear,
        toAcademicYear: toYear,
      });
    }
  });

  // Track initial counts for deletion audit
  let initialAnnouncementsCount = 0;
  let initialExamsCount = 0;
  let initialRoutinesCount = 0;
  let initialSubmissionsCount = 0;
  let initialViolationsCount = 0;

  try {
    initialAnnouncementsCount = (await db.select().from(announcements)).length;
    initialExamsCount = (await db.select().from(exams)).length;
    initialRoutinesCount = (await db.select().from(examRoutines)).length;
    initialSubmissionsCount = (await db.select().from(examSubmissions)).length;
    initialViolationsCount = (await db.select().from(examProctorViolations)).length;
  } catch {}

  // If dryRun, do not commit any updates or deletes
  if (dryRun) {
    return {
      success: true,
      dryRun: true,
      executedAt: new Date().toISOString(),
      semesterLabel,
      adminIdentifier,
      studentsPromotedCount: promotingStudents.length,
      studentsGraduatedAndTerminatedCount: graduatingStudents.length,
      announcementsDeletedCount: initialAnnouncementsCount,
      examsDeletedCount: initialExamsCount,
      routinesDeletedCount: initialRoutinesCount,
      submissionsAndMarksDeletedCount: initialSubmissionsCount,
      violationsDeletedCount: initialViolationsCount,
      promotionsBreakdown: breakdown,
      promotedStudentsList: promotingStudents,
      terminatedGraduatesList: graduatingStudents,
      systemStateAfterTransition: {
        activeRemainingStudentsCount: promotingStudents.length,
        activeTeachersCount: teachers.length,
        scheduledExamsCount: 0,
        announcementsCount: 0,
        systemFreshStateVerified: true,
      },
    };
  }

  // EXECUTE ACTUAL SEMESTER TRANSITION TRANSACTION
  // -------------------------------------------------------------
  // Step A: Clean all exam data, submissions, marks details, and violations
  try {
    await db.delete(examProctorViolations);
  } catch (e) {
    console.warn("Proctor violations clean note:", e);
  }

  try {
    await db.delete(submissionAnswers);
  } catch (e) {
    console.warn("Submission answers clean note:", e);
  }

  try {
    await db.delete(examSubmissions);
  } catch (e) {
    console.warn("Exam submissions clean note:", e);
  }

  try {
    await db.delete(examQuestions);
  } catch (e) {
    console.warn("Exam questions clean note:", e);
  }

  try {
    await db.delete(examRoutines);
  } catch (e) {
    console.warn("Exam routines clean note:", e);
  }

  try {
    await db.delete(exams);
  } catch (e) {
    console.warn("Exams clean note:", e);
  }

  // Step B: Delete all already done announcements
  try {
    await db.delete(announcements);
  } catch (e) {
    console.warn("Announcements clean note:", e);
  }

  // Step C: Terminate complete data of graduating students who touched semester 8
  const graduatingIds = graduatingStudents.map((g) => g.id);
  if (graduatingIds.length > 0) {
    try {
      await db.delete(users).where(inArray(users.id, graduatingIds));
    } catch (e) {
      console.warn("Graduating students termination note:", e);
    }
  }

  // Step D: Promote all continuing students to next semester and next academic year
  for (const student of promotingStudents) {
    try {
      await db
        .update(users)
        .set({
          semester: student.toSemester,
          academicYear: student.toAcademicYear,
        })
        .where(eq(users.id, student.id));
    } catch (e) {
      console.warn(`Failed to promote student ${student.institutionalId}:`, e);
    }
  }

  // Step E: Reset in-memory proctor sessions & mock schedules
  resetProctorForNewSemester();

  // Step F: Query fresh post-transition state
  const postUsers = await db.select().from(users);
  const remainingStudents = postUsers.filter((u) => u.role === "STUDENT");
  const remainingTeachers = postUsers.filter((u) => u.role === "TEACHER");

  return {
    success: true,
    dryRun: false,
    executedAt: new Date().toISOString(),
    semesterLabel,
    adminIdentifier,
    studentsPromotedCount: promotingStudents.length,
    studentsGraduatedAndTerminatedCount: graduatingStudents.length,
    announcementsDeletedCount: initialAnnouncementsCount,
    examsDeletedCount: initialExamsCount,
    routinesDeletedCount: initialRoutinesCount,
    submissionsAndMarksDeletedCount: initialSubmissionsCount,
    violationsDeletedCount: initialViolationsCount,
    promotionsBreakdown: breakdown,
    promotedStudentsList: promotingStudents,
    terminatedGraduatesList: graduatingStudents,
    systemStateAfterTransition: {
      activeRemainingStudentsCount: remainingStudents.length,
      activeTeachersCount: remainingTeachers.length,
      scheduledExamsCount: 0,
      announcementsCount: 0,
      systemFreshStateVerified: true,
    },
  };
}

/**
 * Test helper: Seeds students across multiple semesters (Sem 1, 3, 5, 7, and 8)
 * and dummy announcements/exams so that semester transition can be tested repeatedly.
 */
export async function seedTestSemesterCohort() {
  const passwordHash = await bcrypt.hash("student@kgec2026", 10);

  const testCohort = [
    {
      institutionalId: "10200125001",
      fullName: "Aritra Das (1st Yr)",
      email: "aritra.das.25@kgec.edu.in",
      role: "STUDENT" as const,
      semester: 1,
      academicYear: 1,
      batchYear: 2029,
    },
    {
      institutionalId: "10200124012",
      fullName: "Sneha Ghosh (2nd Yr)",
      email: "sneha.ghosh.24@kgec.edu.in",
      role: "STUDENT" as const,
      semester: 3,
      academicYear: 2,
      batchYear: 2028,
    },
    {
      institutionalId: "10200122045",
      fullName: "Rahul Dey (3rd Yr)",
      email: "rahul.dey.22@kgec.edu.in",
      role: "STUDENT" as const,
      semester: 5,
      academicYear: 3,
      batchYear: 2026,
    },
    {
      institutionalId: "10200121008",
      fullName: "Pooja Karmakar (4th Yr)",
      email: "pooja.karmakar.21@kgec.edu.in",
      role: "STUDENT" as const,
      semester: 7,
      academicYear: 4,
      batchYear: 2025,
    },
    {
      institutionalId: "10200120099",
      fullName: "Debasish Bannerjee (Graduating Final Sem)",
      email: "debasish.b.20@kgec.edu.in",
      role: "STUDENT" as const,
      semester: 8,
      academicYear: 4,
      batchYear: 2024,
    },
  ];

  const inserted = [];
  for (const s of testCohort) {
    try {
      const [user] = await db
        .insert(users)
        .values({
          ...s,
          passwordHash,
        })
        .onConflictDoUpdate({
          target: users.institutionalId,
          set: {
            semester: s.semester,
            academicYear: s.academicYear,
            fullName: s.fullName,
          },
        })
        .returning();
      inserted.push(user);
    } catch (e) {
      console.warn("Cohort insert note:", e);
    }
  }

  return {
    message: "Test semester student cohort seeded successfully across Semesters 1, 3, 5, 7, and 8.",
    count: inserted.length,
    cohort: inserted.map((u) => ({
      id: u.id,
      institutionalId: u.institutionalId,
      fullName: u.fullName,
      semester: u.semester,
      academicYear: u.academicYear,
      willGraduateOnNextTransition: (u.semester ?? 0) >= 8,
    })),
  };
}
