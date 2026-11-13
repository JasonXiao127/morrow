/**
 * Process-wide maintenance gate for live restore (Round 3).
 *
 * A restore closes the singleton SQLite handle and replaces the database file.
 * While that happens every other writer must be quiesced:
 *
 * - unsafe `/api` requests are answered with a retryable `503` + `Retry-After`
 *   by the global gate in `index.ts` (the restore route itself is exempt);
 * - the scheduler refuses ticks and the restore waits for an already-running
 *   tick to finish;
 * - in-flight mutating API requests are counted so the restore can drain them
 *   before closing the handle;
 * - MCP is closed before the swap and restarted afterwards.
 *
 * The gate is deliberately process-local. Compose runs one app replica; the
 * scheduler lease still protects a misconfigured multi-replica deployment.
 */

export const MAINTENANCE_RETRY_AFTER_SECONDS = 5;
const DRAIN_TIMEOUT_MS = 30_000;

export interface MaintenanceState {
  active: boolean;
  reason: string | null;
  startedAt: string | null;
}

let active = false;
let reason: string | null = null;
let startedAt: string | null = null;

let activeWrites = 0;
const writeWaiters = new Set<() => void>();

function resolveWritesIdle(): void {
  if (activeWrites !== 0) return;
  for (const resolve of [...writeWaiters]) {
    writeWaiters.delete(resolve);
    resolve();
  }
}

/** True while the database file may be swapped or reinitialized. */
export function isMaintenanceActive(): boolean {
  return active;
}

export function maintenanceState(): MaintenanceState {
  return { active, reason, startedAt };
}

/**
 * Enter maintenance. Returns false when a restore (or another maintenance
 * operation) is already active; callers map that to a retryable 503.
 */
export function beginMaintenance(nextReason = "restore"): boolean {
  if (active) return false;
  active = true;
  reason = nextReason;
  startedAt = new Date().toISOString();
  return true;
}

export function endMaintenance(): void {
  active = false;
  reason = null;
  startedAt = null;
}

/** Count one in-flight mutating request so a restore can drain it. */
export function enterWrite(): void {
  activeWrites += 1;
}

export function leaveWrite(): void {
  if (activeWrites > 0) activeWrites -= 1;
  resolveWritesIdle();
}

export function activeWriteCount(): number {
  return activeWrites;
}

/**
 * Wait until every request that entered before the gate has finished. New
 * requests cannot enter because the API hook rejects them while `active`.
 */
export async function waitForActiveWrites(
  timeoutMs = DRAIN_TIMEOUT_MS,
): Promise<boolean> {
  if (activeWrites === 0) return true;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      writeWaiters.delete(done);
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
    const done = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    writeWaiters.add(done);
  });
}

/** Test hook: clear counts/state after a failed test that left the gate on. */
export function resetMaintenanceForTests(): void {
  active = false;
  reason = null;
  startedAt = null;
  activeWrites = 0;
  for (const resolve of [...writeWaiters]) {
    writeWaiters.delete(resolve);
    resolve();
  }
}
