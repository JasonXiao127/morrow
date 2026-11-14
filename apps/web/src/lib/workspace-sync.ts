/**
 * Reconcile the local offline cache with the server's workspace identity.
 *
 * Runs before the outbox replay. If the owner id or the restore epoch changed,
 * the queued mutations and persisted query snapshot belong to another
 * workspace state and are cleared before they can be applied.
 */
import { api } from "@/api";
import { clearLocalTaskState } from "./storage";
import {
  evaluateWorkspaceStamp,
  readWorkspaceStamp,
  writeWorkspaceStamp,
  type WorkspaceStamp,
} from "./workspace-state";

export async function reconcileWorkspaceState(
  storage?: Storage | null,
): Promise<boolean> {
  let state: Awaited<ReturnType<typeof api.workspaceState>>;
  try {
    state = await api.workspaceState();
  } catch {
    // Offline or transient failure: keep the queue and retry next launch.
    return false;
  }
  const userId = state.user?.id;
  if (!userId) return false;
  const current: WorkspaceStamp = {
    userId,
    epoch:
      Number.isSafeInteger(state.workspaceEpoch) && state.workspaceEpoch >= 0
        ? state.workspaceEpoch
        : 0,
  };
  const decision = evaluateWorkspaceStamp(readWorkspaceStamp(storage), current);
  if (decision.reset) {
    try {
      await clearLocalTaskState();
    } catch {
      // Leave the old stamp in place so the next launch retries the purge.
      return false;
    }
  }
  writeWorkspaceStamp(current, storage);
  return decision.reset;
}
