import type { ReactNode } from "react";

export function EmptyState({
  icon,
  title,
  description,
  action,
  compact = false,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div
      className={
        compact
          ? "flex flex-col items-center px-6 py-10 text-center"
          : "flex flex-col items-center rounded-lg border border-hairline bg-surface px-6 py-12 text-center"
      }
    >
      {icon ? (
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full border border-hairline bg-canvas text-muted">
          {icon}
        </div>
      ) : null}
      <h2 className="serif text-22 text-ink">{title}</h2>
      {description ? (
        <p className="mt-2 max-w-sm text-13 leading-relaxed text-muted">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}
