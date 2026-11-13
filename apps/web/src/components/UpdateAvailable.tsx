import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  applyServiceWorkerUpdate,
  onServiceWorkerUpdate,
  waitingServiceWorker,
} from "@/lib/pwa";

/**
 * Persistent update surface. The transient toast can be dismissed; this stays
 * visible in Settings until the waiting worker is activated.
 */
export function UpdateAvailable() {
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let mounted = true;
    const check = async () => {
      const waiting = await waitingServiceWorker();
      if (mounted) setAvailable(Boolean(waiting));
    };
    void check();
    const unsubscribe = onServiceWorkerUpdate(() => setAvailable(true));
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      mounted = false;
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  if (!available) return null;

  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-accent/40 bg-accent-soft px-3 py-2.5 text-13 text-ink">
      <span>A new version of Morrow is ready.</span>
      <button
        type="button"
        className="btn btn-secondary min-h-11"
        disabled={busy}
        aria-busy={busy}
        onClick={() => {
          setBusy(true);
          void applyServiceWorkerUpdate().finally(() => setBusy(false));
        }}
      >
        <RefreshCw className="h-4 w-4" aria-hidden="true" />
        {busy ? "Reloading…" : "Reload"}
      </button>
    </div>
  );
}
