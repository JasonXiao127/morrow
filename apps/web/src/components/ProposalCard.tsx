import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  Check,
  CheckCheck,
  ExternalLink,
  RotateCcw,
  Sparkles,
  X,
} from "lucide-react";
import type { Proposal } from "@/api";
import {
  useApplyProposal,
  useDismissProposal,
  useUndoProposal,
} from "@/lib/assistant";
import { cn } from "@/lib/utils";

/**
 * Proposal approval card (plan §9). Nothing changes until the user applies
 * the checked items. Apply is atomic; Undo all replays the before snapshots.
 */
export function ProposalCard({
  proposal,
  compact = false,
  onReview,
}: {
  proposal: Proposal;
  compact?: boolean;
  onReview?: () => void;
}) {
  const apply = useApplyProposal();
  const dismiss = useDismissProposal();
  const undo = useUndoProposal();
  const [selected, setSelected] = useState<Set<number>>(
    () => new Set(proposal.preview.map((_, index) => index)),
  );
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    setSelected(new Set(proposal.preview.map((_, index) => index)));
  }, [proposal.id, proposal.preview]);

  const pending = proposal.status === "pending";
  const applied = proposal.status === "applied";
  const count = selected.size;
  const allSelected = count === proposal.preview.length;
  const busy = apply.isPending || dismiss.isPending || undo.isPending;

  const summary = useMemo(() => {
    if (proposal.status === "applied") {
      return "Applied. Undo all restores the previous state.";
    }
    if (proposal.status === "dismissed") return "Dismissed. Nothing changed.";
    if (proposal.status === "expired") return "Expired. Ask again for a fresh plan.";
    return proposal.summary;
  }, [proposal.preview.length, proposal.status, proposal.summary]);

  const toggle = (index: number) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const applySelected = () => {
    if (count === 0) {
      setAnnouncement("Choose at least one item.");
      return;
    }
    apply.mutate(
      {
        proposal,
        operations: [...selected].sort((a, b) => a - b),
        payloadHash: allSelected ? proposal.payloadHash : undefined,
      },
      {
        onSuccess: () => setAnnouncement("Selected changes applied."),
      },
    );
  };

  return (
    <section
      className={cn(
        "rounded-md border border-hairline bg-canvas",
        compact ? "p-3" : "p-3.5",
      )}
      aria-label={`Proposal: ${proposal.summary}`}
    >
      <div className="flex items-start gap-2">
        <Sparkles
          className="mt-0.5 h-4 w-4 shrink-0 text-accent"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="label-caps">
              {pending ? "Proposal" : "Proposal · " + proposal.status}
            </span>
            <span className="flex items-center gap-1 text-12 text-faint">
              {pending ? "Nothing changed yet" : ""}
              <Link
                to="/proposal/$proposalId"
                params={{ proposalId: proposal.id }}
                className="icon-btn -mr-1 h-8 w-8"
                title="Opens proposal"
                aria-label={`Open proposal: ${proposal.summary}`}
              >
                <ExternalLink className="h-4 w-4" aria-hidden="true" />
              </Link>
            </span>
          </div>
          <p className="serif mt-1.5 text-17 leading-snug text-ink">{summary}</p>
          {proposal.preview.length > 0 ? (
            <ul className="mt-3 space-y-1.5">
              {proposal.preview.map((item, index) => {
                const checked = selected.has(index);
                return (
                  <li key={item.operationId || String(index)}>
                    <label
                      className={cn(
                        "flex min-h-11 cursor-pointer items-start gap-2.5 rounded-sm border px-2.5 py-2 text-13 transition-colors",
                        checked
                          ? "border-hairline-strong bg-surface"
                          : "border-hairline bg-transparent text-muted",
                        !pending && "cursor-default",
                      )}
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]"
                        checked={checked}
                        disabled={!pending || busy}
                        onChange={() => toggle(index)}
                        aria-label={item.detail}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-ink">{item.detail}</span>
                        <span className="mt-0.5 block text-12 text-muted">
                          {item.kind.replace(/_/g, " ")}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      </div>

      <div className="sticky bottom-0 mt-3 flex flex-wrap items-center gap-2 bg-canvas/95 py-2 backdrop-blur-sm">
        {pending ? (
          <>
            <button
              type="button"
              className="btn btn-primary min-h-11 px-3 text-12"
              onClick={applySelected}
              disabled={busy || count === 0}
              aria-busy={apply.isPending}
            >
              <CheckCheck className="h-3.5 w-3.5" aria-hidden="true" />
              {apply.isPending
                ? "Applying…"
                : compact && allSelected
                  ? "Apply all"
                  : `Apply selected${allSelected ? "" : ` (${count})`}`}
            </button>
            {compact && onReview ? (
              <button
                type="button"
                className="btn btn-secondary min-h-11 px-3 text-12"
                onClick={onReview}
                disabled={busy}
              >
                Review
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-secondary min-h-11 px-3 text-12"
              onClick={() => dismiss.mutate(proposal)}
              disabled={busy}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
              Dismiss
            </button>
            {!compact ? (
              <button
                type="button"
                className="btn btn-ghost min-h-11 px-2.5 text-12"
                onClick={() =>
                  setSelected(
                    allSelected
                      ? new Set()
                      : new Set(proposal.preview.map((_, index) => index)),
                  )
                }
                disabled={busy}
              >
                <Check className="h-3.5 w-3.5" aria-hidden="true" />
                {allSelected ? "Clear" : "Select all"}
              </button>
            ) : null}
          </>
        ) : null}
        {applied ? (
          <button
            type="button"
            className="btn btn-secondary min-h-11 px-3 text-12"
            onClick={() => undo.mutate(proposal)}
            disabled={busy}
            aria-busy={undo.isPending}
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            {undo.isPending ? "Undoing…" : "Undo all"}
          </button>
        ) : null}
      </div>
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </section>
  );
}
