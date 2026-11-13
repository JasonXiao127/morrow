import type { ReactNode } from "react";
import { BrandMark } from "./BrandMark";

export function FatalError({
  title = "Something went wrong.",
  description = "Morrow hit an unexpected problem. Your data is still on the server.",
  children,
  showRetry = true,
}: {
  title?: string;
  description?: ReactNode;
  children?: ReactNode;
  showRetry?: boolean;
}) {
  return (
    <main className="safe-top flex min-h-[100dvh] flex-col bg-canvas text-ink">
      <div className="flex flex-1 items-center justify-center px-6 py-12">
        <div className="w-full max-w-md">
          <div className="mb-8 flex items-center gap-3">
            <BrandMark />
            <span className="serif text-22">Morrow</span>
          </div>
          <p className="label-caps mb-2">A small detour</p>
          <h1 className="serif text-28 md:text-[2rem] md:leading-[2.25rem]">
            {title}
          </h1>
          <p className="mt-3 text-15 leading-relaxed text-muted">{description}</p>
          <div className="mt-8 flex flex-wrap gap-2">
            <a href="/today" className="btn btn-primary">
              Go to Today
            </a>
            {showRetry ? (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => window.location.reload()}
              >
                Try again
              </button>
            ) : null}
          </div>
          {children}
        </div>
      </div>
      <p className="safe-bottom px-6 pb-6 text-center text-12 text-faint">
        Self-hosted reminders. No feed, no algorithm.
      </p>
    </main>
  );
}
