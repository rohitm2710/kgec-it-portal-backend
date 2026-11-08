import { db } from "../db/index.js";
import { announcements } from "../db/schema.js";
import { lt, sql } from "drizzle-orm";

/**
 * Retention Policy: Automatically deletes announcements that are older than 2 months (60 days).
 * Returns the count of deleted announcements.
 */
export async function cleanupExpiredAnnouncements(): Promise<number> {
  try {
    const twoMonthsAgo = new Date();
    twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 2);

    const deleted = await db
      .delete(announcements)
      .where(lt(announcements.createdAt, twoMonthsAgo))
      .returning({ id: announcements.id, title: announcements.title, createdAt: announcements.createdAt });

    if (deleted.length > 0) {
      console.log(
        `[RETENTION POLICY] Purged ${deleted.length} announcement(s) older than 2 months (posted before ${twoMonthsAgo.toLocaleDateString()}).`
      );
    }
    return deleted.length;
  } catch (err: any) {
    console.error("[RETENTION POLICY ERROR] Failed to clean up expired announcements:", err.message);
    return 0;
  }
}

/**
 * Initializes the background retention daemon.
 * 1. Executes immediately on server boot.
 * 2. Continuously runs periodically (defaults to every 1 hour) while the system is active.
 */
export function initAnnouncementRetentionScheduler(intervalMs = 60 * 60 * 1000): NodeJS.Timeout {
  console.log("[RETENTION POLICY] 2-Month Announcement Retention Daemon initialized.");
  
  // Run on startup
  cleanupExpiredAnnouncements().catch(() => {});

  // Run periodically while active
  const timer = setInterval(() => {
    cleanupExpiredAnnouncements().catch(() => {});
  }, intervalMs);

  timer.unref(); // Allow process to exit cleanly if stopped
  return timer;
}
