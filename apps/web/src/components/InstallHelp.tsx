import { Download, Share, Smartphone } from "lucide-react";
import { toast } from "sonner";
import { useInstallPrompt } from "@/lib/install";

export function InstallHelp() {
  const { available, installed, ios, promptInstall } = useInstallPrompt();

  const install = async () => {
    const outcome = await promptInstall();
    if (outcome === "accepted") {
      toast.success("Installing Morrow.");
    } else if (outcome === "dismissed") {
      toast("Install dismissed", {
        description: "You can install later from the browser menu.",
      });
    } else {
      toast("Use your browser’s install menu", {
        description: ios
          ? "Share → Add to Home Screen."
          : "Look for “Install app” in the address bar or browser menu.",
      });
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-hairline bg-canvas p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-hairline bg-surface text-accent">
              {ios ? (
                <Share className="h-5 w-5" aria-hidden="true" />
              ) : (
                <Download className="h-5 w-5" aria-hidden="true" />
              )}
            </div>
            <div>
              <p className="text-13 font-semibold text-ink">
                {installed ? "Morrow is installed" : "Install Morrow"}
              </p>
              <p className="mt-0.5 text-12 leading-relaxed text-muted">
                {installed
                  ? "You’re running in standalone mode. Reminders can use the full window."
                  : "Installable on desktop and mobile. iOS push requires an installed Home Screen app on 16.4+."}
              </p>
            </div>
          </div>
          {!installed ? (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void install()}
            >
              {available ? "Install" : "How to install"}
            </button>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-sm border border-hairline px-2 py-1 text-12 text-success">
              <Smartphone className="h-3.5 w-3.5" aria-hidden="true" />
              standalone
            </span>
          )}
        </div>
      </div>

      {!installed ? (
        <ol className="space-y-2 text-13 leading-relaxed text-muted">
          <li>
            <span className="font-medium text-ink-soft">Desktop Chrome or Edge:</span>{" "}
            use the install icon in the address bar, or ⋮ → Cast, save, and share →
            Install page as app.
          </li>
          <li>
            <span className="font-medium text-ink-soft">Android Chrome:</span> open
            the browser menu → Add to Home screen → Install.
          </li>
          <li>
            <span className="font-medium text-ink-soft">iPhone or iPad:</span> open
            in Safari → Share → Add to Home Screen. Open Morrow from the Home
            Screen before enabling notifications.
          </li>
          <li>
            <span className="font-medium text-ink-soft">HTTPS:</span> service
            workers and push require a secure origin (localhost is exempt).
          </li>
        </ol>
      ) : null}
    </div>
  );
}
