import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  activityApi,
  apiErrorMessage,
  isApiError,
  isConcurrencyError,
  isMissingRoute,
  type BootstrapData,
} from "@/api";
import { announce } from "./announce";
import { reportConflict } from "./conflict";
import { invalidateTaskQueries, queryClient, queryKeys } from "./query";

/**
 * Undo stack (plan §9).
 *
 * Cmd+Z asks the M3 activity history to undo the exact server change. Mutation
 * responses don't include the activity seq, so we look up the most recent
 * matching row for this entity/action. If history is unavailable (older
 * server), only safe local inverses run: create → delete, edit → restore
 * fields, snooze → clear snooze, non-recurring complete → reopen. Recurring
 * completion/skip cannot be faked locally and say so.
 */

export interface UndoRegistration {
  label: string;
  activityId?: string | number | null;
  /** Used to find this action in M3 activity history when no seq is returned. */
  entityId?: string;
  action?: string;
  fallback?: () => Promise<void>;
}

interface UndoEntry extends UndoRegistration {
  id: string;
  at: number;
}

const UNDO_EVENT = "morrow:undo";
const STORAGE_KEY = "morrow.undo.v1";
const MAX_ENTRIES = 20;

/**
 * Only serializable fields survive a reload. Fallback closures cannot, so a
 * restored entry always goes through the activity history endpoint.
 */
function loadStack(): UndoEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (entry): entry is UndoEntry =>
          Boolean(entry) &&
          typeof entry === "object" &&
          typeof (entry as UndoEntry).id === "string" &&
          typeof (entry as UndoEntry).label === "string" &&
          typeof (entry as UndoEntry).at === "number",
      )
      .slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

let stack: UndoEntry[] = loadStack();
let sequence = stack.length;

function persist(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(
        stack.map(({ id, label, activityId, entityId, action, at }) => ({
          id,
          label,
          activityId,
          entityId,
          action,
          at,
        })),
      ),
    );
  } catch {
    // Storage can be full/disabled; the in-memory stack still works.
  }
}

function emit(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(UNDO_EVENT));
  }
}

export function pushUndo(entry: UndoRegistration): void {
  sequence += 1;
  stack = [
    { ...entry, id: `undo-${sequence}`, at: Date.now() },
    ...stack,
  ].slice(0, MAX_ENTRIES);
  persist();
  emit();
}

export function clearUndo(): void {
  stack = [];
  persist();
  emit();
}

export function peekUndo(): UndoEntry | undefined {
  return stack[0];
}

export async function undoLast(): Promise<boolean> {
  const entry = stack[0];
  if (!entry) {
    toast("Nothing to undo", {
      description: "Actions you take in this session will appear here.",
    });
    return false;
  }

  const finish = (): void => {
    stack = stack.filter((candidate) => candidate.id !== entry.id);
    persist();
    emit();
  };

  const succeed = (): true => {
    finish();
    announce(`Undid ${entry.label}.`);
    toast.success(`Undid ${entry.label}`);
    return true;
  };

  const useFallback = async (): Promise<boolean> => {
    if (!entry.fallback) {
      toast("Undo isn’t available locally for that change", {
        description:
          "Activity history isn’t reachable on this server, and this action has no safe local inverse.",
      });
      return false;
    }
    try {
      await entry.fallback();
      await invalidateTaskQueries(queryClient);
      return succeed();
    } catch (error) {
      if (
        isConcurrencyError(error) ||
        (isApiError(error) && error.status === 409)
      ) {
        reportConflict({
          kind: "stale",
          title: "Undo needs a fresh copy",
          message:
            "This task changed after the action you are undoing. Reload first, then try again.",
          reload: async () => {
            await invalidateTaskQueries(queryClient);
          },
        });
      } else {
        toast.error(apiErrorMessage(error));
      }
      return false;
    }
  };

  if (entry.activityId !== null && entry.activityId !== undefined) {
    try {
      await activityApi.undo(entry.activityId);
      await invalidateTaskQueries(queryClient);
      return succeed();
    } catch (error) {
      if (!isMissingRoute(error)) {
        toast.error(apiErrorMessage(error));
        return false;
      }
    }
  }

  if (entry.entityId && entry.action) {
    try {
      const bootstrap = queryClient.getQueryData<BootstrapData>(
        queryKeys.bootstrap,
      );
      const fromCursor = Math.max(0, (bootstrap?.cursor ?? 0) - 30);
      const seq = await activityApi.undoLatest({
        entityId: entry.entityId,
        action: entry.action,
        fromCursor,
      });
      if (seq !== null) {
        await invalidateTaskQueries(queryClient);
        return succeed();
      }
    } catch (error) {
      if (!isMissingRoute(error)) {
        toast.error(apiErrorMessage(error));
        return false;
      }
    }
  }

  return useFallback();
}

export function useUndoState(): {
  canUndo: boolean;
  label: string | null;
  undo: () => Promise<boolean>;
} {
  const [entry, setEntry] = useState<UndoEntry | undefined>(() => stack[0]);
  useEffect(() => {
    const refresh = () => setEntry(stack[0]);
    window.addEventListener(UNDO_EVENT, refresh);
    refresh();
    return () => window.removeEventListener(UNDO_EVENT, refresh);
  }, []);
  return {
    canUndo: Boolean(entry),
    label: entry?.label ?? null,
    undo: undoLast,
  };
}
