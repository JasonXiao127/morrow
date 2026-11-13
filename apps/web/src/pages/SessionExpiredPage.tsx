import { Link } from "@tanstack/react-router";
import { ShieldCheck } from "lucide-react";
import { BrandMark } from "@/components/BrandMark";
import { ThemeToggle } from "@/components/ThemeToggle";

export function SessionExpiredPage() {
  return (
    <main className="safe-top flex min-h-[100dvh] flex-col bg-canvas">
      <div className="flex h-16 shrink-0 items-center justify-between px-5 md:px-8">
        <Link to="/today" className="flex items-center gap-2" aria-label="Morrow">
          <BrandMark className="h-8 w-8" />
          <span className="serif text-22 leading-none">Morrow</span>
        </Link>
        <ThemeToggle />
      </div>

      <div className="flex flex-1 items-center justify-center px-6 pb-16">
        <div className="w-full max-w-md">
          <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-full border border-hairline bg-surface text-muted">
            <ShieldCheck className="h-5 w-5" aria-hidden="true" />
          </div>
          <p className="label-caps">Session expired</p>
          <h1 className="serif mt-2 text-28 md:text-[2rem] md:leading-[2.25rem]">
            You’re signed out.
          </h1>
          <p className="mt-3 text-15 leading-relaxed text-muted">
            Nothing was lost. Local caches and the offline outbox were cleared
            for safety. Sign in to pick up where you left off.
          </p>
          <div className="mt-7 flex flex-wrap gap-2">
            <Link to="/login" className="btn btn-primary">
              Sign in again
            </Link>
          </div>
          <p className="mt-6 text-12 leading-relaxed text-faint">
            Sessions idle out after 7 days and end absolutely after 30 days.
          </p>
        </div>
      </div>
    </main>
  );
}
