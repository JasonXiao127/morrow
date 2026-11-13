import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CloudOff, RefreshCw, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { apiErrorMessage } from "@/api";
import { announce } from "@/lib/announce";
import { useOnline, useOutboxState } from "@/lib/hooks";
import { replayOutbox } from "@/lib/outbox";
import { invalidateTaskQueries } from "@/lib/query";
import { plural } from "@/lib/utils";
import { OutboxPanel } from "./OutboxPanel";

/**
 * Honest sync state (plan §7/§9): offline, pending count, syncing, and a
 * conflict state that requires a decision. Never says "All set" while the
 * outbox is non-empty.
 */
export function OfflineBanner() {
  const online = useOnline();
  const outbox = useOutboxState();
  const queryClient = useQueryClient();
  const [panelOpen, setPanelOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const visible = !online || outbox.count > 0 || outbox.syncing;
  if (!visible) return null;

  const syncNow = async () => {
    setBusy(true);
    try {
      const result = await replayOutbox();
      outbox.refresh();
      await invalidateTaskQueries(queryClient);
      if (result.stoppedBy === "conflict" || result.stoppedBy === "error") {
        setPanelOpen(true);
        announce("Some changes need attention.");
        toast.error("Some changes need attention", {
          description: "Review the queued changes on this device.",
        });
      } else if (result.replayed > 0) {
        announce(`Synced ${result.replayed} ${plural(result.replayed, "change")}.`);
        toast.success(
          `Synced ${result.replayed} ${plural(result.replayed, "change")}.`,
        );
      }
    } catch (error) {
      toast.error(apiErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const syncing = busy || outbox.syncing;
  const conflicts = outbox.conflicts;

  let message: string;
  if (!online) {
    message =
      outbox.count > 0
        ? `Offline — ${outbox.count} ${plural(outbox.count, "change")} saved on this device.`
        : "Offline — showing saved data. New changes save on this device.";
  } else if (syncing) {
    message = `Syncing ${outbox.count} ${plural(outbox.count, "change")}…`;
  } else if (conflicts > 0) {
    message = `${conflicts} ${plural(conflicts, "change")} ${conflicts === 1 ? "needs" : "need"} a decision before syncing.`;
  } else if (outbox.count > 0) {
    message = `${outbox.count} ${plural(outbox.count, "change")} waiting to sync.`;
  } else {
    message = "Finishing sync…";
  }

  return (
    <>
      <div
        className={
          conflicts > 0
            ? "flex flex-wrap items-center gap-2 border-b border-hairline bg-danger-soft px-4 py-2 text-13 text-danger md:px-6"
            : "flex flex-wrap items-center gap-2 border-b border-hairline bg-warning-soft px-4 py-2 text-13 text-warning md:px-6"
        }
        role="status"
        aria-live="polite"
      >
        {conflicts > 0 ? (
          <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
        ) : online ? (
          <RefreshCw
            className={syncing ? "h-4 w-4 shrink-0 animate-spin" : "h-4 w-4 shrink-0"}
            aria-hidden="true"
          />
        ) : (
          <CloudOff className="h-4 w-4 shrink-0" aria-hidden="true" />
        )}
        <span className="min-w-0">{message}</span>
        <span className="ml-auto flex items-center gap-2">
          {online && outbox.count > 0 && conflicts === 0 ? (
            <button
              type="button"
              className="btn btn-ghost min-h-11 px-2 text-12"
              onClick={() => void syncNow()}
              disabled={syncing}
              aria-busy={syncing}
            >
              Sync now
            </button>
          ) : null}
          {outbox.count > 0 ? (
            <button
              type="button"
              className="btn btn-ghost min-h-11 px-2 text-12"
              onClick={() => setPanelOpen(true)}
            >
              Review
            </button>
          ) : null}
        </span>
      </div>

      <OutboxPanel open={panelOpen} onOpenChange={setPanelOpen} />
    </>
  );
}
