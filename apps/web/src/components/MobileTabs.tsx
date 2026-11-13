import { Link, useRouterState } from "@tanstack/react-router";
import { CalendarDays, List, Plus, Settings, Sun } from "lucide-react";
import { cn } from "@/lib/utils";
import { useShell } from "./shell-context";

function tabClass(active: boolean): string {
  return cn(
    "flex min-h-14 flex-1 flex-col items-center justify-center gap-1 text-12 font-medium transition-colors",
    active ? "text-accent" : "text-muted hover:text-ink",
  );
}

export function MobileTabs() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const listsActive = pathname === "/lists" || pathname.startsWith("/lists/");

  return (
    <nav
      className="mobile-tabbar flex shrink-0 border-t border-hairline bg-surface md:hidden"
      aria-label="Primary"
    >
      <Link
        to="/today"
        className={tabClass(pathname === "/today")}
        aria-current={pathname === "/today" ? "page" : undefined}
      >
        <Sun className="h-5 w-5" aria-hidden="true" />
        <span>Today</span>
      </Link>
      <Link
        to="/upcoming"
        className={tabClass(pathname === "/upcoming")}
        aria-current={pathname === "/upcoming" ? "page" : undefined}
      >
        <CalendarDays className="h-5 w-5" aria-hidden="true" />
        <span>Upcoming</span>
      </Link>
      <Link
        to="/calendar"
        className={tabClass(pathname === "/calendar")}
        aria-current={pathname === "/calendar" ? "page" : undefined}
      >
        <CalendarDays className="h-5 w-5" aria-hidden="true" />
        <span>Calendar</span>
      </Link>
      <Link
        to="/lists"
        className={tabClass(listsActive)}
        aria-current={listsActive ? "page" : undefined}
      >
        <List className="h-5 w-5" aria-hidden="true" />
        <span>Lists</span>
      </Link>
      <Link
        to="/settings"
        className={tabClass(
          pathname.startsWith("/settings") || pathname === "/install",
        )}
        aria-current={
          pathname.startsWith("/settings") || pathname === "/install"
            ? "page"
            : undefined
        }
      >
        <Settings className="h-5 w-5" aria-hidden="true" />
        <span>Settings</span>
      </Link>
    </nav>
  );
}

export function CaptureFab() {
  const { openCapture } = useShell();

  return (
    <button
      type="button"
      onClick={() => openCapture()}
      className="fixed bottom-[calc(76px+env(safe-area-inset-bottom,0px))] right-4 z-30 flex h-14 w-14 items-center justify-center rounded-full border border-accent-strong bg-accent text-accent-ink shadow-lg transition-transform active:scale-95 md:hidden"
      aria-label="Add a reminder"
    >
      <Plus className="h-6 w-6" strokeWidth={2.2} aria-hidden="true" />
    </button>
  );
}
