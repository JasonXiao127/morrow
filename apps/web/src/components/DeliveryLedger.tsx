import { useQuery } from "@tanstack/react-query";
import { BellOff, ChevronRight } from "lucide-react";
import { ledgerApi, type Task } from "@/api";
import {
  formatRelativeTime,
  formatTimestamp,
  isTaskSnoozed,
} from "@/lib/format";

/**
 * Delivery ledger one-liner (plan §9).
 *
 * Backed by `GET /api/tasks/:id/ledger`:
 * `{ taskId, next_occurrence_at, next_occurrence_local, devices,
 *    last_sent, last_status }`.
 * The line is honest, never "All set": no reminder set and push-off both
 * say so plainly.
 */
export function DeliveryLedger({ task }: { task: Task }) {
  const query = useQuery({
    queryKey: ["tasks", "ledger", task.id],
    queryFn: () => ledgerApi.get(task.id),
    staleTime: 15_000,
    retry: false,
  });

  const hasReminder = Boolean(
    task.remindAt ||
      task.nextOccurrenceAt ||
      task.nextOccurrenceLocal ||
      task.snoozedUntil ||
      isTaskSnoozed(task),
  );

  if (query.isPending) {
    return (
      <div className="space-y-2 px-3 py-3" aria-live="polite">
        <div className="skeleton h-4 w-3/4" aria-hidden="true" />
        <div className="skeleton h-3 w-1/2" aria-hidden="true" />
      </div>
    );
  }

  if (query.isError || !query.data) {
    if (!hasReminder) {
      return (
        <div className="space-y-1 px-3 py-3 text-13 text-muted" aria-live="polite">
          <p>No reminder set for this task.</p>
          <p className="text-12 text-faint">
            Snooze it or give it a time and the ledger will appear here.
          </p>
        </div>
      );
    }
    return (
      <div className="space-y-1 px-3 py-3 text-13 text-muted" aria-live="polite">
        <p>Delivery status is unavailable right now.</p>
        <p className="text-12 text-faint">
          The reminder itself is still scheduled; this line just could not load.
        </p>
      </div>
    );
  }

  const ledger = query.data;
  const nextLabel = task.remindAt
    ? formatTimestamp(task.remindAt)
    : task.nextOccurrenceAt
      ? formatTimestamp(task.nextOccurrenceAt)
      : (task.nextOccurrenceLocal ?? ledger.nextOccurrenceLocal ?? null)
        ? `Next ${task.nextOccurrenceLocal ?? ledger.nextOccurrenceLocal}`
        : null;

  const deviceLabel =
    ledger.devices === 1 ? "1 device" : `${ledger.devices} devices`;
  const lastSentLabel = ledger.lastSent
    ? formatRelativeTime(new Date(ledger.lastSent).getTime())
    : "never sent";

  if (!hasReminder) {
    return (
      <div className="space-y-1 px-3 py-3 text-13 text-muted" aria-live="polite">
        <p>No reminder set for this task.</p>
        <p className="text-12 text-faint">
          {ledger.devices === 0
            ? "Push is off. Reminders will wait inside the app."
            : `${deviceLabel} would receive it once a time is set.`}
        </p>
      </div>
    );
  }

  return (
    <div className="px-3 py-3 text-13 text-muted" aria-live="polite">
      <p className="text-13 text-ink-soft">
        {nextLabel ?? "Reminder set"} · {deviceLabel} · Last sent {lastSentLabel}
      </p>
      {ledger.devices === 0 ? (
        <p className="mt-1.5 flex items-start gap-1.5 text-12 leading-relaxed">
          <BellOff className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>Push is off. Reminders will wait inside the app.</span>
        </p>
      ) : null}
      <details className="group mt-2">
        <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1 text-12 text-muted hover:text-ink [&::-webkit-details-marker]:hidden">
          Details
          <ChevronRight
            className="h-3.5 w-3.5 transition-transform group-open:rotate-90"
            aria-hidden="true"
          />
        </summary>
        <dl className="mt-1 space-y-1 border-t border-hairline pt-2 text-12">
          <div className="flex gap-2">
            <dt className="w-24 shrink-0 text-faint">Devices</dt>
            <dd className="mono">{ledger.devices}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-24 shrink-0 text-faint">Last status</dt>
            <dd className="mono">{ledger.lastStatus ?? "—"}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-24 shrink-0 text-faint">Last sent</dt>
            <dd className="mono">
              {ledger.lastSent ? formatTimestamp(ledger.lastSent) : "—"}
            </dd>
          </div>
        </dl>
      </details>
      <p className="mt-2 text-12 text-faint">
        Delivery is at-least-once. A duplicate push is possible after a crash;
        the service worker dedupes by delivery ID.
      </p>
    </div>
  );
}
