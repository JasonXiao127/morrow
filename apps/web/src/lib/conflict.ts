import type { Task } from "@/api";

/**
 * Explicit conflict handoff (plan §5/§7): 412/428/409 never resolve silently.
 * A mutation reports the conflict here; the shell shows a resolver with
 * "Reload latest" and, when safe, "Overwrite anyway" using the fresh rev.
 */
export type ConflictKind = "stale" | "missing-revision" | "semantic" | "sync";

export interface ConflictReport {
  kind: ConflictKind;
  title?: string;
  message?: string;
  detail?: string;
  taskTitle?: string;
  currentTask?: Task | null;
  /** Refresh all task data; never applies the pending edit. */
  reload?: () => Promise<void> | void;
  /** Apply the user's intended change against the current revision. */
  overwrite?: () => Promise<void> | void;
}

export const CONFLICT_EVENT = "morrow:conflict";

export function reportConflict(report: ConflictReport): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<ConflictReport>(CONFLICT_EVENT, { detail: report }),
  );
}

export function subscribeConflict(
  handler: (report: ConflictReport) => void,
): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<ConflictReport>).detail;
    if (detail) handler(detail);
  };
  window.addEventListener(CONFLICT_EVENT, listener);
  return () => window.removeEventListener(CONFLICT_EVENT, listener);
}
