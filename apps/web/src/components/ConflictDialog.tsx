import { useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { apiErrorMessage } from "@/api";
import type { ConflictReport } from "@/lib/conflict";
import { formatTaskDate } from "@/lib/format";
import { DialogFrame } from "./DialogFrame";

/**
 * 412/428/409 resolver (plan §5). Shows the current server copy and requires
 * an explicit choice: reload (discard the pending edit) or overwrite the
 * current revision. There is no silent last-write-wins path.
 */
export function ConflictDialog({
  report,
  onClose,
}: {
  report: ConflictReport | null;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState<"reload" | "overwrite" | null>(null);

  const run = async (kind: "reload" | "overwrite") => {
    const action = kind === "reload" ? report?.reload : report?.overwrite;
    if (!action) return;
    setBusy(kind);
    try {
      await action();
      onClose();
    } catch (error) {
      toast.error(apiErrorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <DialogFrame
      open={Boolean(report)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={report?.title ?? "This changed somewhere else"}
      description={report?.message ?? "Reload the latest copy before saving."}
    >
      <div className="p-5 md:p-6">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-warning/30 bg-warning-soft text-warning">
            <AlertTriangle className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h2 className="serif text-22">
              {report?.title ?? "This changed somewhere else"}
            </h2>
            <p className="mt-1.5 text-13 leading-relaxed text-muted">
              {report?.message ??
                "Reload the latest copy before saving. Nothing was overwritten."}
            </p>
          </div>
        </div>

        {report?.currentTask ? (
          <div className="mt-5 rounded-md border border-hairline bg-canvas p-3 text-13">
            <p className="label-caps">Latest on the server</p>
            <p className="mt-1.5 font-medium text-ink">
              {report.currentTask.title}
            </p>
            <p className="mt-0.5 text-12 text-muted">
              {formatTaskDate(report.currentTask)}
              {typeof report.currentTask.rev === "number"
                ? ` · revision ${report.currentTask.rev}`
                : ""}
            </p>
          </div>
        ) : null}

        {report?.detail ? (
          <p className="mt-3 text-12 leading-relaxed text-faint">{report.detail}</p>
        ) : null}

        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClose}
            disabled={busy !== null}
          >
            Keep editing
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => void run("reload")}
            disabled={busy !== null || !report?.reload}
            aria-busy={busy === "reload"}
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            {busy === "reload" ? "Reloading…" : "Reload latest"}
          </button>
          {report?.overwrite ? (
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => void run("overwrite")}
              disabled={busy !== null}
              aria-busy={busy === "overwrite"}
            >
              {busy === "overwrite" ? "Overwriting…" : "Overwrite anyway"}
            </button>
          ) : null}
        </div>
        <p className="mt-3 text-12 leading-relaxed text-faint">
          “Overwrite anyway” re-reads the current revision and applies your
          change to it. Reload discards your pending change.
        </p>
      </div>
    </DialogFrame>
  );
}
