/**
 * Account/list access rules (v0.2 sharing).
 *
 * A list is readable/writable by its owner and by explicit `list_members`.
 * Tasks follow their list: the creator owns the row, but every member of the
 * list can see and update it. A task with no list is private to its owner.
 */
import { getDb } from "@morrow/db";

export function canAccessList(
  userId: string,
  listId: string,
  options: { includeDeleted?: boolean } = {},
): boolean {
  try {
    const liveOnly = options.includeDeleted ? "" : "AND l.deleted_at IS NULL";
    const row = getDb()
      .prepare(
        `SELECT 1 AS ok FROM lists l
          WHERE l.id = ? ${liveOnly}
            AND (l.user_id = ? OR EXISTS (
              SELECT 1 FROM list_members lm
               WHERE lm.list_id = l.id AND lm.user_id = ?
            ))
          LIMIT 1`,
      )
      .get(listId, userId, userId) as { ok: number } | undefined;
    return Boolean(row);
  } catch {
    return false;
  }
}

export function canAccessTask(
  userId: string,
  taskId: string,
  options: { includeDeleted?: boolean } = {},
): boolean {
  try {
    const liveOnly = options.includeDeleted ? "" : "AND t.deleted_at IS NULL";
    const row = getDb()
      .prepare(
        `SELECT 1 AS ok FROM tasks t
          WHERE t.id = ? ${liveOnly} AND (${TASK_ACCESS_SQL})
          LIMIT 1`,
      )
      .get(taskId, userId, userId, userId) as { ok: number } | undefined;
    return Boolean(row);
  } catch {
    return false;
  }
}

/**
 * SQL predicate fragment for task tables aliased as `t`.
 *
 * Access is creator, list owner, or explicit list member. The list-owner arm
 * matters for tasks a member created in someone else's shared list: the owner
 * must still see them, receive their reminders, and include them in briefs.
 * Callers pass the viewer id three times.
 */
export const TASK_ACCESS_SQL =
  "(t.user_id = ? OR (t.list_id IS NOT NULL AND (EXISTS (SELECT 1 FROM lists l WHERE l.id = t.list_id AND l.user_id = ?) OR EXISTS (SELECT 1 FROM list_members lm WHERE lm.list_id = t.list_id AND lm.user_id = ?))))";

/** Lists visible to a user (owned first, then shared). */
export function visibleListIds(userId: string): string[] {
  try {
    return (
      getDb()
        .prepare(
          `SELECT l.id FROM lists l
            WHERE l.deleted_at IS NULL
              AND (l.user_id = ? OR EXISTS (
                SELECT 1 FROM list_members lm
                 WHERE lm.list_id = l.id AND lm.user_id = ?
              ))
            ORDER BY l.created_at ASC`,
        )
        .all(userId, userId) as Array<{ id: string }>
    ).map((row) => row.id);
  } catch {
    return [];
  }
}
