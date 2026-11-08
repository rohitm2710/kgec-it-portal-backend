// Automated Endpoint Verification Test Script
// Tests the Express application and routes directly without requiring external DB network connection.

import { app } from "./dist/app.js";

async function runTests() {
  console.log("========================================================");
  console.log("  Running KGEC IT Department Portal Backend API Tests");
  console.log("========================================================\n");

  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;

  let passed = 0;
  let total = 0;

  async function test(name, fn) {
    total++;
    try {
      await fn();
      console.log(`  ✓ [PASS] ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✗ [FAIL] ${name}`);
      console.error(`    ${err.message}\n`);
    }
  }

  try {
    // 1. Health Check
    await test("GET /api/health returns 200 and healthy status", async () => {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.status !== 200) throw new Error(`Expected status 200, got ${res.status}`);
      const data = await res.json();
      if (data.status !== "healthy") throw new Error(`Expected status 'healthy', got '${data.status}'`);
    });

    // 2. Teacher Login
    let teacherToken = "";
    await test("POST /api/auth/login allows Dr. S. Roy (Teacher) login", async () => {
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          institutionalId: "FAC-IT-042",
          password: "teacher@kgec2026",
          role: "TEACHER",
        }),
      });
      if (res.status !== 200) throw new Error(`Expected status 200, got ${res.status}`);
      const data = await res.json();
      if (!data.token) throw new Error("Expected JWT token in response");
      if (data.user.role !== "TEACHER") throw new Error(`Expected role 'TEACHER', got '${data.user.role}'`);
      teacherToken = data.token;
    });

    // 3. Student Login
    let studentToken = "";
    await test("POST /api/auth/login allows Rahul Dey (Student) login with academicYear = 3", async () => {
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          institutionalId: "10200122045",
          password: "student@kgec2026",
          role: "STUDENT",
        }),
      });
      if (res.status !== 200) throw new Error(`Expected status 200, got ${res.status}`);
      const data = await res.json();
      if (!data.token) throw new Error("Expected JWT token in response");
      if (data.user.role !== "STUDENT") throw new Error(`Expected role 'STUDENT', got '${data.user.role}'`);
      if (data.user.academicYear !== 3) throw new Error(`Expected academicYear 3, got ${data.user.academicYear}`);
      studentToken = data.token;
    });

    // 4. Authenticated Me endpoint
    await test("GET /api/auth/me verifies Bearer JWT token", async () => {
      const res = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${teacherToken}` },
      });
      if (res.status !== 200) throw new Error(`Expected status 200, got ${res.status}`);
      const data = await res.json();
      if (data.user.role !== "TEACHER") throw new Error(`Expected role 'TEACHER', got '${data.user.role}'`);
    });

    // 5. Role Security: Student cannot access Teacher Question Bank creation
    await test("POST /api/questions blocks Student with 403 Forbidden", async () => {
      const res = await fetch(`${baseUrl}/api/questions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${studentToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          subjectId: "11111111-1111-1111-1111-111111111111",
          questionType: "MCQ",
          difficulty: "EASY",
          questionText: "Sample question",
        }),
      });
      if (res.status !== 403) throw new Error(`Expected 403 Forbidden, got ${res.status}`);
    });

    // 6. Programming Exam Reserved Stub (Section 5.4 of docs)
    await test("ALL /api/student/exams/:examId/programming/* returns 501 Not Implemented", async () => {
      const res = await fetch(`${baseUrl}/api/student/exams/test-exam-id/programming/run-code`, {
        method: "POST",
        headers: { Authorization: `Bearer ${studentToken}` },
      });
      if (res.status !== 501) throw new Error(`Expected status 501, got ${res.status}`);
      const data = await res.json();
      if (data.code !== "PROGRAMMING_EXAM_UNDER_DEVELOPMENT") {
        throw new Error(`Expected error code 'PROGRAMMING_EXAM_UNDER_DEVELOPMENT', got '${data.code}'`);
      }
    });

    console.log(`\n========================================================`);
    console.log(`  Tests Completed: ${passed} / ${total} passed`);
    console.log(`========================================================`);
  } finally {
    server.close();
  }
}

runTests().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});
