import { AlertTriangle, RefreshCw } from "lucide-react";
import { apiErrorMessage } from "@/api";

export function TaskListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="mt-7" aria-busy="true" aria-live="polite">
      <div className="mb-2 flex items-center gap-2">
        <div className="skeleton h-3 w-20" />
        <div className="skeleton h-3 w-6" />
      </div>
      <div className="border-t border-hairline">
        {Array.from({ length: rows }, (_, index) => (
          <div
            key={index}
            className="flex min-h-14 items-center gap-3 border-b border-hairline px-2 py-3 last:border-b-0"
          >
            <div className="skeleton h-5 w-5 shrink-0 rounded-full" />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="skeleton h-4 w-2/3" />
              <div className="skeleton h-3 w-24" />
            </div>
          </div>
        ))}
      </div>
      <span className="sr-only">Loading tasks</span>
    </div>
  );
}

export function TaskListError({
  error,
  onRetry,
  isRetrying = false,
}: {
  error: unknown;
  onRetry: () => void;
  isRetrying?: boolean;
}) {
  return (
    <div className="mt-7 rounded-lg border border-hairline bg-surface px-5 py-6">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-danger/30 bg-danger-soft text-danger">
          <AlertTriangle className="h-4 w-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h2 className="text-13 font-semibold text-ink">
            This view couldn’t load
          </h2>
          <p className="mt-1 text-13 leading-relaxed text-muted">
            {apiErrorMessage(error)}
          </p>
          <p className="mt-1 text-12 leading-relaxed text-faint">
            Nothing on the server was changed. Saved data may still be available
            from this device.
          </p>
          <button
            type="button"
            className="btn btn-secondary mt-4"
            onClick={onRetry}
            disabled={isRetrying}
            aria-busy={isRetrying}
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            {isRetrying ? "Trying…" : "Try again"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function LoadMoreButton({
  hasNextPage,
  isFetching,
  onClick,
}: {
  hasNextPage: boolean;
  isFetching: boolean;
  onClick: () => void;
}) {
  if (!hasNextPage) return null;
  return (
    <div className="mt-4 flex justify-center">
      <button
        type="button"
        className="btn btn-secondary"
        onClick={onClick}
        disabled={isFetching}
        aria-busy={isFetching}
      >
        {isFetching ? "Loading…" : "Load more"}
      </button>
    </div>
  );
}
