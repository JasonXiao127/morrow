import type { ReactNode } from "react";
import { BrandMark } from "@/components/BrandMark";
import { ThemeToggle } from "@/components/ThemeToggle";

export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="safe-top flex min-h-[100dvh] bg-canvas">
      <aside className="hidden w-[46%] flex-col justify-between border-r border-hairline bg-surface p-10 lg:flex xl:p-14">
        <div className="flex items-center gap-2.5">
          <BrandMark className="h-9 w-9" />
          <span className="serif text-28 leading-none">Morrow</span>
        </div>

        <div className="max-w-xl">
          <p className="label-caps">Self-hosted reminders · v0.3</p>
          <p className="serif mt-5 text-[clamp(2.75rem,5vw,4.5rem)] leading-[1.02] text-ink">
            Capture it,{" "}
            <br />
            sort it later.
          </p>
          <p className="mt-6 max-w-md text-15 leading-relaxed text-muted">
            A quiet place for dates, reminders, and the things you don’t want to
            forget. Deterministic at the core; optional help at the edges.
          </p>
        </div>

        <div className="space-y-3 text-13 text-muted">
          <p className="flex items-center gap-3">
            <span className="h-px w-6 bg-accent" aria-hidden="true" />
            Today, honestly. No fake “all set.”
          </p>
          <p className="flex items-center gap-3">
            <span className="h-px w-6 bg-accent" aria-hidden="true" />
            Your tasks in SQLite on your own volume.
          </p>
          <p className="flex items-center gap-3">
            <span className="h-px w-6 bg-accent" aria-hidden="true" />
            One user. No feed. No algorithm.
          </p>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-16 shrink-0 items-center justify-between px-5 md:px-8">
          <div className="flex items-center gap-2 lg:hidden">
            <BrandMark className="h-8 w-8" />
            <span className="serif text-22 leading-none">Morrow</span>
          </div>
          <div className="ml-auto">
            <ThemeToggle />
          </div>
        </div>

        <div className="flex flex-1 items-center justify-center px-5 pb-12 pt-2 md:px-8">
          <div className="w-full max-w-[400px]">{children}</div>
        </div>

        <p className="safe-bottom px-5 pb-6 text-center text-12 text-faint">
          Morrow is software you run. Nothing here is a feed.
        </p>
      </div>
    </main>
  );
}
