/**
 * Daily retention for append-only operational tables.
 *
 * Core reminder data (tasks, lists, completions, tags, subtasks, recurrence
 * exceptions, settings) is never pruned here. These tables are logs/history:
 *
 * - activity: undo/audit ledger, configurable via ACTIVITY_RETENTION_DAYS.
 * - deliveries: terminal delivery attempts (sent/failed/dead/skipped).
 * - operations: idempotency results; only recent retries need them.
 * - agent_messages: assistant chat history (not part of the JSON backup).
 * - proposals: expired/dismissed/applied proposal records.
 * - sessions: expired or revoked login sessions.
 *
 * Each delete is bounded by an indexed timestamp and runs once per day from
 * the scheduler. The scheduler catches failures; a failed prune must never
 * fail a reminder tick.
 */
import type { BetterDb } from "@morrow/db";
import { pruneActivity } from "./activity.js";

export const DELIVERY_RETENTION_DAYS = 90;
export const OPERATION_RETENTION_DAYS = 7;
export const AGENT_MESSAGE_RETENTION_DAYS = 90;
export const PROPOSAL_RETENTION_DAYS = 30;
export const SESSION_RETENTION_DAYS = 30;
export const DEFAULT_ACTIVITY_RETENTION_DAYS = 90;

export interface RetentionResult {
  activity: number;
  deliveries: number;
  operations: number;
  agentMessages: number;
  proposals: number;
  sessions: number;
}

export interface RetentionOptions {
  now?: Date;
  /** Activity/audit history; 0 disables only the activity prune. */
  activityRetentionDays?: number;
}

function cutoff(now: Date, days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

function deleteOlder(
  db: BetterDb,
  sql: string,
  ...params: string[]
): number {
  const info = db.prepare(sql).run(...params);
  return Number(info.changes);
}

/** Run all retention prunes. Returns the number of deleted rows per table. */
export function runRetention(
  db: BetterDb,
  options: RetentionOptions = {},
): RetentionResult {
  const now = options.now ?? new Date();
  const activityDays =
    options.activityRetentionDays === undefined
      ? DEFAULT_ACTIVITY_RETENTION_DAYS
      : options.activityRetentionDays;
  const sessionCutoff = cutoff(now, SESSION_RETENTION_DAYS);
  return {
    activity:
      activityDays > 0
        ? pruneActivity(db, { before: cutoff(now, activityDays) })
        : 0,
    deliveries: deleteOlder(
      db,
      `DELETE FROM deliveries
        WHERE status IN ('sent','failed','dead','skipped')
          AND updated_at < ?`,
      cutoff(now, DELIVERY_RETENTION_DAYS),
    ),
    operations: deleteOlder(
      db,
      "DELETE FROM operations WHERE created_at < ?",
      cutoff(now, OPERATION_RETENTION_DAYS),
    ),
    agentMessages: deleteOlder(
      db,
      "DELETE FROM agent_messages WHERE created_at < ?",
      cutoff(now, AGENT_MESSAGE_RETENTION_DAYS),
    ),
    proposals: deleteOlder(
      db,
      `DELETE FROM proposals
        WHERE status IN ('expired','dismissed','applied')
          AND updated_at < ?`,
      cutoff(now, PROPOSAL_RETENTION_DAYS),
    ),
    sessions: deleteOlder(
      db,
      `DELETE FROM sessions
        WHERE expires_at < ? OR absolute_expires_at < ? OR revoked_at IS NOT NULL`,
      sessionCutoff,
      sessionCutoff,
    ),
  };
}
