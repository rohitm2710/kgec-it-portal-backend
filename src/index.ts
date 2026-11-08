import * as dotenv from "dotenv";
dotenv.config();

import { app } from "./app.js";
import { initAnnouncementRetentionScheduler } from "./services/announcementRetentionService.js";
import { ensureProctorViolationsTable } from "./db/migrateProctorTable.js";

const PORT = process.env.PORT || 5000;

// When running in serverless platforms (e.g. Vercel), avoid binding to a local port
if (!process.env.VERCEL) {
  app.listen(PORT, async () => {
    console.log(`=======================================================`);
    console.log(`  KGEC IT Department Portal — Backend Engine`);
    console.log(`  Server running on http://localhost:${PORT}`);
    console.log(`  Environment: ${process.env.NODE_ENV || "development"}`);
    console.log(`=======================================================`);

    // Active 2-Month Announcement Retention Daemon
    initAnnouncementRetentionScheduler();

    // Ensure Proctor Violations table is present
    await ensureProctorViolationsTable();
  });
}

export default app;
