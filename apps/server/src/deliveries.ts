/**
 * Delivery/access reconciliation (Round 3).
 *
 * A delivery row is a queued push for a task + subscription. Access can change
 * after enqueue: a member is unshared, a list is deleted, or a task moves to a
 * different list. The scheduler must not send a reminder title/note to a
 * recipient who can no longer read the task.
 *
 * The smallest correct fix is cancellation plus a send-time re-check:
 * - pending/retry web-push deliveries for recipients without access are marked
 *   `skipped` (ledger preserved, no network call);
 * - a delivery already claimed as `sending` is re-checked in
 *   `filterClaimedForSend` and `processDelivery` before the push request.
 *
 * ntfy is a workspace-global channel (not a per-member destination), so it is
 * deliberately not part of the per-subscription cancellation query.
 */
import type { BetterDb } from "@morrow/db";
import { toUtcIso } from "@morrow/shared";

/** True when a web-push delivery's subscription owner can still read the task. */
export function deliveryRecipientLostAccess(
  db: BetterDb,
  delivery: { channel: string; subscription_id: string; task_id: string },
): boolean {
  if (delivery.channel !== "webpush" || !delivery.subscription_id) return false;
  try {
    const subscription = db
      .prepare(
        "SELECT id FROM push_subscriptions WHERE id = ? AND deleted_at IS NULL",
      )
      .get(delivery.subscription_id) as { id: string } | undefined;
    if (!subscription) return false;
    const row = db
      .prepare(
        `SELECT 1 AS allowed
           FROM tasks t
           JOIN push_subscriptions s ON s.id = ?
          WHERE t.id = ?
            AND (
              s.user_id = t.user_id
              OR (t.list_id IS NOT NULL AND (
                EXISTS (
                  SELECT 1 FROM lists lo
                   WHERE lo.id = t.list_id AND lo.user_id = s.user_id
                     AND lo.deleted_at IS NULL
                )
                OR EXISTS (
                  SELECT 1
                    FROM list_members lm
                    JOIN lists l ON l.id = lm.list_id
                   WHERE lm.list_id = t.list_id
                     AND lm.user_id = s.user_id
                     AND l.deleted_at IS NULL
                )
              ))
            )
          LIMIT 1`,
      )
      .get(delivery.subscription_id, delivery.task_id);
    return !row;
  } catch {
    // If access cannot be checked, err on the side of not sending.
    return true;
  }
}

/**
 * Mark pending/retry deliveries for one task as skipped when the subscription
 * owner lost access. Returns the number of rows updated.
 */
export function cancelPendingDeliveriesForTask(
  db: BetterDb,
  taskId: string,
  now: Date = new Date(),
): number {
  try {
    const info = db
      .prepare(
        `UPDATE deliveries
            SET status = 'skipped',
                next_attempt_at = NULL,
                claim_token = NULL,
                lease_until = NULL,
                last_error = 'recipient no longer has task access',
                updated_at = ?,
                rev = rev + 1
          WHERE task_id = ?
            AND status IN ('pending', 'retry')
            AND channel = 'webpush'
            AND subscription_id <> ''
            AND subscription_id NOT IN (
              SELECT s.id
                FROM tasks t
                JOIN push_subscriptions s
                  ON s.user_id = t.user_id
                  OR (t.list_id IS NOT NULL AND (
                    EXISTS (
                      SELECT 1 FROM lists lo
                       WHERE lo.id = t.list_id AND lo.user_id = s.user_id
                         AND lo.deleted_at IS NULL
                    )
                    OR EXISTS (
                      SELECT 1
                        FROM list_members lm
                        JOIN lists l ON l.id = lm.list_id
                       WHERE lm.list_id = t.list_id
                         AND lm.user_id = s.user_id
                         AND l.deleted_at IS NULL
                    )
                  ))
               WHERE t.id = ?
            )`,
      )
      .run(toUtcIso(now), taskId, taskId);
    return Number(info.changes);
  } catch {
    return 0;
  }
}

/** Cancel by explicit task ids (list delete unlinks tasks first). */
export function cancelPendingDeliveriesForTaskIds(
  db: BetterDb,
  taskIds: readonly string[],
  now: Date = new Date(),
): number {
  let cancelled = 0;
  for (const taskId of taskIds) {
    cancelled += cancelPendingDeliveriesForTask(db, taskId, now);
  }
  return cancelled;
}

/** Cancel for every task currently in a list (unshare path). */
export function cancelPendingDeliveriesForList(
  db: BetterDb,
  listId: string,
  now: Date = new Date(),
): number {
  try {
    const ids = (
      db
        .prepare("SELECT id FROM tasks WHERE list_id = ?")
        .all(listId) as Array<{ id: string }>
    ).map((row) => row.id);
    return cancelPendingDeliveriesForTaskIds(db, ids, now);
  } catch {
    return 0;
  }
}
