import * as dotenv from "dotenv";
dotenv.config();

import bcrypt from "bcryptjs";
import { db } from "./index.js";
import {
  users,
  subjects,
  questions,
  exams,
  examRoutines,
  announcements,
} from "./schema.js";

async function seed() {
  console.log("Seeding KGEC IT Department Portal Database...");

  const passwordHash = await bcrypt.hash("kgec2026", 10);

  // 1. Seed Department Administrator
  console.log("Creating Admin Account (ADMIN-KGEC-IT)...");
  const adminPasswordHash = await bcrypt.hash("admin", 10);
  const [adminUser] = await db
    .insert(users)
    .values({
      institutionalId: "ADMIN-KGEC-IT",
      fullName: "Department Administrator",
      email: "admin.it@kgec.edu.in",
      passwordHash: adminPasswordHash,
      role: "ADMIN",
      academicYear: null,
      semester: null,
      isActive: true,
    })
    .onConflictDoNothing()
    .returning();

  const teacherId = adminUser?.id || "00000000-0000-0000-0000-000000000000";

  // 2. Seed Subjects
  console.log("Creating Subjects...");
  const [dbms] = await db
    .insert(subjects)
    .values({
      subjectCode: "PCC-IT501",
      subjectName: "Database Management Systems",
      academicYear: 3,
      semester: 5,
    })
    .onConflictDoNothing()
    .returning();

  const [se] = await db
    .insert(subjects)
    .values({
      subjectCode: "IT-601",
      subjectName: "Software Engineering & System Design",
      academicYear: 3,
      semester: 6,
    })
    .onConflictDoNothing()
    .returning();

  const subjectId = dbms?.id || se?.id;

  if (subjectId) {
    // 3. Seed Question Bank (MCQ, SAQ, LAQ)
    console.log("Populating Question Bank with MCQs and Subjective Questions with Rubrics...");
    await db.insert(questions).values([
      {
        subjectId,
        createdById: teacherId,
        questionType: "MCQ",
        difficulty: "EASY",
        unitOrTopic: "Normalization",
        questionText: "Which normal form strictly eliminates transitive functional dependencies?",
        mcqOptions: [
          { id: "A", text: "First Normal Form (1NF)" },
          { id: "B", text: "Second Normal Form (2NF)" },
          { id: "C", text: "Third Normal Form (3NF)" },
          { id: "D", text: "Boyce-Codd Normal Form (BCNF)" },
        ],
        correctOptionId: "C",
        defaultMarks: "1.00",
      },
      {
        subjectId,
        createdById: teacherId,
        questionType: "MCQ",
        difficulty: "MEDIUM",
        unitOrTopic: "Transactions",
        questionText: "Which ACID property guarantees that database changes persist despite crashes after a commit?",
        mcqOptions: [
          { id: "A", text: "Atomicity" },
          { id: "B", text: "Consistency" },
          { id: "C", text: "Isolation" },
          { id: "D", text: "Durability" },
        ],
        correctOptionId: "D",
        defaultMarks: "1.00",
      },
      {
        subjectId,
        createdById: teacherId,
        questionType: "SAQ",
        difficulty: "MEDIUM",
        unitOrTopic: "Architectural Patterns",
        questionText: "Differentiate between Monolithic MVC architecture and Event-Driven Microservices in distributed systems.",
        referenceAnswer: "Monolithic MVC bundles presentation, business logic, and persistence layers into a single deployable unit sharing memory and database pools. Event-driven microservices decouple distinct domain contexts into autonomous services communicating asynchronously via message brokers (Kafka/RabbitMQ) or REST/gRPC APIs, enabling horizontal scalability and fault isolation.",
        gradingRubric: [
          { criterion: "Coupling & deployment independence", maxWeight: 2, keywords: ["decouple", "independently deployable", "single unit"] },
          { criterion: "Communication mechanisms", maxWeight: 2, keywords: ["event", "message broker", "REST", "gRPC"] },
          { criterion: "Scalability and fault tolerance", maxWeight: 1, keywords: ["horizontal scalability", "fault isolation"] },
        ],
        expectedWordCount: 150,
        defaultMarks: "5.00",
      },
      {
        subjectId,
        createdById: teacherId,
        questionType: "LAQ",
        difficulty: "HARD",
        unitOrTopic: "Clean Architecture",
        questionText: "Explain the Dependency Inversion Principle with an architectural UML class diagram for an automated script evaluation service.",
        referenceAnswer: "High-level policy modules must not depend on low-level detail modules; both must depend on abstractions. Interfaces define the contract in core domain layers while concrete OCR/DB adapters reside in outer infrastructure layers. Diagrams should illustrate an interface (e.g., IGradingEngine) implemented by OpenRouterAdapter, with EvaluationController depending solely on the abstraction.",
        gradingRubric: [
          { criterion: "Definition of Dependency Inversion", maxWeight: 3, keywords: ["abstractions", "high-level", "low-level"] },
          { criterion: "UML notation and class contracts", maxWeight: 4, keywords: ["interface", "adapter", "dependency"] },
          { criterion: "Practical applicability to script evaluation", maxWeight: 3, keywords: ["OCR", "OpenRouter", "domain layer"] },
        ],
        expectedWordCount: 300,
        defaultMarks: "10.00",
      },
    ]);
  }

  // 4. Seed Announcements
  console.log("Seeding Announcements with Media Attachments...");
  await db.insert(announcements).values([
    {
      title: "Registration Notice & Scheduled Placement Drives",
      content: "Dear Students, please find the registration notice and scheduled placement drives attached below.",
      authorId: teacherId,
      targetAcademicYear: null,
      attachments: [
        {
          fileName: "Notice_Registration.pdf",
          fileUrl: "/assets/Notice_Registration.pdf",
          fileType: "PDF",
          fileSizeBytes: 1468006,
        },
        {
          fileName: "Placement_Drive_Schedule_2026.png",
          fileUrl: "/assets/Placement_Drive_Schedule_2026.png",
          fileType: "IMAGE",
          fileSizeBytes: 2936012,
        },
      ],
      isPinned: true,
    },
  ]);

  console.log("Seeding complete! Database ready for testing.");
}

seed()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  })
  .finally(() => {
    process.exit(0);
  });
