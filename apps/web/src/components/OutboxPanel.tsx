import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CloudOff, RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { apiErrorMessage } from "@/api";
import { formatTimestamp } from "@/lib/format";
import { useOutboxState } from "@/lib/hooks";
import {
  discardOutbox,
  replayOutbox,
  retryOutboxRecord,
  type ReplayResult,
} from "@/lib/outbox";
import { announce } from "@/lib/announce";
import { invalidateTaskQueries } from "@/lib/query";
import { DialogFrame } from "./DialogFrame";

const KIND_LABEL: Record<string, string> = {
  create: "Capture",
  update: "Edit",
  complete: "Complete",
  snooze: "Snooze",
  skip: "Skip",
  delete: "Delete",
};

function describeReplay(result: ReplayResult): string {
  if (result.stoppedBy === "conflict") {
    return "A queued change conflicts with the server. Choose Keep mine or Discard below.";
  }
  if (result.stoppedBy === "offline") {
    return "Still offline. Changes remain saved on this device.";
  }
  if (result.stoppedBy === "error") {
    return "The server rejected a queued change. Review it below or discard it.";
  }
  if (result.replayed > 0) {
    return `Synced ${result.replayed} ${result.replayed === 1 ? "change" : "changes"}.`;
  }
  return "Nothing needed syncing.";
}

export function OutboxPanel({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const outbox = useOutboxState();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  const replay = async () => {
    setBusy(true);
    try {
      const result = await replayOutbox();
      announce(describeReplay(result));
      if (result.stoppedBy === "conflict" || result.stoppedBy === "error") {
        toast.error(describeReplay(result));
      } else {
        toast.success(describeReplay(result));
      }
      await invalidateTaskQueries(queryClient);
    } catch (error) {
      toast.error(apiErrorMessage(error));
    } finally {
      setBusy(false);
      outbox.refresh();
    }
  };

  const keepMine = async (opId: string) => {
    setBusy(true);
    try {
      const result = await retryOutboxRecord(opId);
      announce(describeReplay(result));
      if (result.stoppedBy === "conflict" || result.stoppedBy === "error") {
        toast.error(describeReplay(result));
      } else {
        toast.success("Re-applied your change against the latest revision.");
      }
      await invalidateTaskQueries(queryClient);
    } catch (error) {
      toast.error(apiErrorMessage(error));
    } finally {
      setBusy(false);
      outbox.refresh();
    }
  };

  const discard = async (opId: string) => {
    const confirmed = window.confirm(
      "Discard this queued change? It was not applied to the server.",
    );
    if (!confirmed) return;
    setBusy(true);
    try {
      await discardOutbox(opId);
      await invalidateTaskQueries(queryClient);
      announce("Queued change discarded.");
      toast.success("Queued change discarded.");
    } catch (error) {
      toast.error(apiErrorMessage(error));
    } finally {
      setBusy(false);
      outbox.refresh();
    }
  };

  return (
    <DialogFrame
      open={open}
      onOpenChange={onOpenChange}
      title="Changes on this device"
      description="Offline captures, edits, completions, snoozes, skips, and deletions waiting to sync."
    >
      <div className="p-5 md:p-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="serif text-22">Changes on this device</h2>
            <p className="mt-1 text-13 text-muted">
              Replayed on launch, reconnect, and when you return to Morrow.
            </p>
          </div>
          <CloudOff className="mt-1 h-5 w-5 shrink-0 text-muted" aria-hidden="true" />
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-2 text-12">
          <div className="rounded-md border border-hairline bg-canvas px-3 py-2">
            <dt className="text-muted">Pending</dt>
            <dd className="mono mt-0.5 text-15 text-ink">{outbox.count}</dd>
          </div>
          <div className="rounded-md border border-hairline bg-canvas px-3 py-2">
            <dt className="text-muted">Last synced</dt>
            <dd className="mt-0.5 text-13 text-ink">
              {outbox.lastSyncedAt ? formatTimestamp(outbox.lastSyncedAt) : "Not yet"}
            </dd>
          </div>
        </dl>

        <div className="mt-5">
          {outbox.records.length === 0 ? (
            <p className="rounded-md border border-hairline bg-canvas px-3 py-5 text-center text-13 text-muted">
              Everything on this device has synced.
            </p>
          ) : (
            <ul className="space-y-2">
              {outbox.records.map((record) => {
                const title =
                  typeof record.payload["taskTitle"] === "string"
                    ? (record.payload["taskTitle"] as string)
                    : record.entityId.slice(0, 8);
                return (
                  <li
                    key={record.opId}
                    className="rounded-md border border-hairline bg-canvas p-3"
                  >
                    <div className="flex flex-wrap items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-13 font-medium text-ink">{title}</p>
                        <p className="mt-0.5 text-12 text-muted">
                          {KIND_LABEL[record.kind] ?? record.kind} ·{" "}
                          {new Date(record.createdAt).toLocaleTimeString([], {
                            hour: "numeric",
                            minute: "2-digit",
                          })}
                          {record.attempts > 0
                            ? ` · ${record.attempts} ${record.attempts === 1 ? "attempt" : "attempts"}`
                            : ""}
                        </p>
                      </div>
                      {record.conflict ? (
                        <span className="inline-flex items-center gap-1 rounded-sm border border-warning/30 bg-warning-soft px-1.5 py-0.5 text-12 text-warning">
                          <TriangleAlert className="h-3 w-3" aria-hidden="true" />
                          Conflict
                        </span>
                      ) : (
                        <span className="rounded-sm border border-hairline px-1.5 py-0.5 text-12 text-faint">
                          Pending
                        </span>
                      )}
                    </div>
                    {record.lastError ? (
                      <p className="mt-2 text-12 leading-relaxed text-danger">
                        {record.lastError}
                      </p>
                    ) : null}
                    {record.conflict || record.lastError ? (
                      <div className="mt-2.5 flex flex-wrap gap-2">
                        {record.conflict ? (
                          <button
                            type="button"
                            className="btn btn-secondary min-h-11 px-3 text-12"
                            disabled={busy}
                            onClick={() => void keepMine(record.opId)}
                          >
                            Keep mine
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="btn btn-ghost min-h-11 px-3 text-12 text-danger"
                          disabled={busy}
                          onClick={() => void discard(record.opId)}
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                          Discard
                        </button>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
          <p className="text-12 text-faint">
            Creates, edits, completions, snoozes, skips, and deletes are saved
            on this device and sync when you reconnect. Conflicts pause the
            queue so nothing is lost silently.
          </p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void replay()}
            disabled={busy || outbox.syncing || outbox.count === 0}
            aria-busy={busy || outbox.syncing}
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            {busy || outbox.syncing ? "Syncing…" : "Sync now"}
          </button>
        </div>
      </div>
    </DialogFrame>
  );
}
