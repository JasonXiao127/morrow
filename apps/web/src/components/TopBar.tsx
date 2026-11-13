import { Search, Sparkles } from "lucide-react";
import { formatRelativeTime } from "@/lib/format";
import { useNow, useOnline } from "@/lib/hooks";
import { replayOutbox } from "@/lib/outbox";
import { useBootstrapQuery } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { BrandMark } from "./BrandMark";
import { Hint } from "./Hint";
import { ThemeToggle } from "./ThemeToggle";
import { useShell } from "./shell-context";

function SyncStatus() {
  const online = useOnline();
  const now = useNow(30_000);
  const { dataUpdatedAt, isFetching, isError, refetch } = useBootstrapQuery();

  let dot = "bg-success";
  let label = dataUpdatedAt
    ? `Synced ${formatRelativeTime(dataUpdatedAt, now)}`
    : "Not synced yet";

  if (!online) {
    dot = "bg-faint";
    label = "Offline";
  } else if (isFetching) {
    dot = "bg-warning";
    label = "Syncing";
  } else if (isError) {
    dot = "bg-danger";
    label = "Couldn’t refresh";
  }

  return (
    <button
      type="button"
      onClick={() => {
        // Flush queued offline work before asking the server for a snapshot;
        // otherwise the refetch hides pending creates/edits.
        void (async () => {
          await replayOutbox();
          await refetch();
        })();
      }}
      className="hidden min-h-11 items-center gap-2 rounded-md px-2 text-12 text-muted hover:bg-selection sm:flex"
      title={label}
      aria-label={`${label}. Refresh now.`}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", dot)} aria-hidden="true" />
      <span className="hidden lg:inline" role="status" aria-live="polite">
        {label}
      </span>
    </button>
  );
}

export function TopBar() {
  const { openPalette, openAssistant } = useShell();
  const { data: bootstrap } = useBootstrapQuery();
  const isOwner = bootstrap?.user?.role === "owner";

  return (
    <header className="safe-top flex min-h-14 shrink-0 items-center gap-1 border-b border-hairline bg-canvas px-2 md:gap-3 md:px-5">
      <div className="flex min-h-11 items-center gap-2 pl-1 md:hidden">
        <BrandMark className="h-7 w-7" />
        <span className="serif text-17 leading-none">Morrow</span>
      </div>

      <button
        type="button"
        onClick={openPalette}
        className="hidden h-11 w-full max-w-sm items-center gap-2 rounded-md border border-hairline bg-surface px-3 text-left text-13 text-muted transition-colors hover:border-hairline-strong md:flex"
        aria-label="Search or jump to. Open command palette."
      >
        <Search className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="truncate">Search or jump to…</span>
        <kbd className="kbd ml-auto">⌘K</kbd>
      </button>

      <div className="ml-auto flex items-center gap-0.5">
        <SyncStatus />
        <button
          type="button"
          className="icon-btn md:hidden"
          aria-label="Search and commands"
          onClick={openPalette}
        >
          <Search className="h-[18px] w-[18px]" aria-hidden="true" />
        </button>
        {isOwner ? (
          <Hint label="Assistant" side="bottom">
            <button
              type="button"
              className="icon-btn"
              aria-label="Open assistant"
              onClick={() => openAssistant()}
            >
              <Sparkles className="h-[18px] w-[18px]" aria-hidden="true" />
            </button>
          </Hint>
        ) : null}
        <ThemeToggle />
      </div>
    </header>
  );
}
