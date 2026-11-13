import { Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  BellRing,
  Check,
  Download,
  Info,
  MonitorDown,
  Plus,
  Share,
  Smartphone,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/PageHeader";
import { useInstallPrompt } from "@/lib/install";
import { usePushStatus } from "@/lib/push";
import { cn } from "@/lib/utils";

/**
 * Install flow (plan §7). iOS is PWA-only: no installable Electron shell
 * exists for iPhone/iPad, so this page leads with the Home Screen flow and
 * never implies a desktop app helps mobile.
 *
 * Push works on iOS only from an installed Home Screen app on 16.4+.
 * Everywhere else the honest fallback holds: reminders wait inside the app.
 */

function IosSteps() {
  const steps = [
    {
      icon: <Smartphone className="h-4 w-4" aria-hidden="true" />,
      title: "Open Morrow in Safari",
      body: "Web Push on iPhone/iPad only works from Safari. Open this exact address there and sign in.",
    },
    {
      icon: <Share className="h-4 w-4" aria-hidden="true" />,
      title: "Tap Share",
      body: "Use the Share button in Safari's toolbar (the square with an arrow pointing up).",
    },
    {
      icon: <Plus className="h-4 w-4" aria-hidden="true" />,
      title: "Add to Home Screen",
      body: "Scroll down and tap “Add to Home Screen”, then Add. Morrow gets its own icon, with no browser chrome.",
    },
    {
      icon: <Check className="h-4 w-4" aria-hidden="true" />,
      title: "Open from the Home Screen",
      body: "Launch Morrow from the new icon — not from the Safari tab. Only the installed app can receive pushes.",
    },
    {
      icon: <BellRing className="h-4 w-4" aria-hidden="true" />,
      title: "Enable notifications",
      body: "Go to Settings → Devices & notifications and tap “Enable notifications”, then send the test ping.",
    },
  ];
  return (
    <ol className="mt-4 space-y-3">
      {steps.map((step, index) => (
        <li key={step.title} className="flex items-start gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-hairline bg-surface text-accent">
            {step.icon}
          </span>
          <div className="min-w-0">
            <p className="text-13 font-semibold text-ink">
              <span className="mr-1.5 text-muted">{index + 1}.</span>
              {step.title}
            </p>
            <p className="mt-0.5 text-12 leading-relaxed text-muted">{step.body}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

function CapabilityMatrix() {
  const rows: Array<{
    platform: string;
    install: string;
    push: string;
    pushOk: boolean;
    note: string;
  }> = [
    {
      platform: "iPhone / iPad · Home Screen app",
      install: "Share → Add to Home Screen",
      push: "Yes, on iOS 16.4+",
      pushOk: true,
      note: "The only way iOS delivers pushes.",
    },
    {
      platform: "iPhone / iPad · Safari tab",
      install: "—",
      push: "No",
      pushOk: false,
      note: "Apple blocks Web Push in tabs. Reminders wait inside the app.",
    },
    {
      platform: "Android · Chrome",
      install: "Install button or menu → Install",
      push: "Yes",
      pushOk: true,
      note: "Works from the installed app and from the browser tab.",
    },
    {
      platform: "Desktop · Chrome / Edge",
      install: "Install button or address-bar icon",
      push: "Yes",
      pushOk: true,
      note: "Standard Web Push; a window is optional.",
    },
  ];
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] border-collapse text-left text-12">
        <caption className="sr-only">
          What install and push can do on each platform
        </caption>
        <thead>
          <tr className="border-b border-hairline text-muted">
            <th scope="col" className="py-2 pr-3 font-medium">Platform</th>
            <th scope="col" className="py-2 pr-3 font-medium">Install</th>
            <th scope="col" className="py-2 pr-3 font-medium">Push</th>
            <th scope="col" className="py-2 font-medium">Note</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.platform} className="border-b border-hairline last:border-b-0">
              <th scope="row" className="py-2.5 pr-3 font-semibold text-ink">
                {row.platform}
              </th>
              <td className="py-2.5 pr-3 text-muted">{row.install}</td>
              <td className="py-2.5 pr-3">
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-0.5",
                    row.pushOk
                      ? "border-success/30 bg-success-soft text-success"
                      : "border-warning/30 bg-warning-soft text-warning",
                  )}
                >
                  {row.push}
                </span>
              </td>
              <td className="py-2.5 text-muted">{row.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function InstallPage() {
  const install = useInstallPrompt();
  const push = usePushStatus();

  const installed = install.installed || push.standalone;

  const promptInstall = async () => {
    const outcome = await install.promptInstall();
    if (outcome === "accepted") {
      toast.success("Installing Morrow.");
    } else if (outcome === "dismissed") {
      toast("Install dismissed", {
        description: "You can install later from the browser menu.",
      });
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-28 pt-6 md:px-8 md:pb-10 md:pt-8">
      <PageHeader
        eyebrow="Install help"
        title="Install Morrow"
        description="A PWA on desktop and mobile. iPhone and iPad install from Safari — there is no app-store or desktop shell for iOS."
        actions={
          <Link to="/settings" search={{ section: "devices" }} className="btn btn-secondary">
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Devices
          </Link>
        }
      />

      <div className="mt-7 space-y-4">
        {/* Current state: installed PWA vs browser tab. */}
        <div
          className={cn(
            "rounded-md border px-4 py-3 text-12 leading-relaxed",
            installed
              ? "border-success/30 bg-success-soft text-success"
              : "border-hairline bg-surface text-muted",
          )}
          role="status"
          aria-live="polite"
        >
          {installed ? (
            <p>
              <span className="font-semibold">Installed.</span> You are running
              the standalone app
              {push.permission === "granted" && push.subscribed
                ? " with push registered."
                : " — finish push in Settings → Devices & notifications."}{" "}
              <Link
                to="/settings"
                search={{ section: "devices" }}
                className="font-semibold underline underline-offset-2"
              >
                Open Devices
              </Link>
            </p>
          ) : (
            <p>
              <span className="font-semibold text-ink-soft">
                Browser tab, not installed.
              </span>{" "}
              {install.ios
                ? "On iPhone/iPad, push stays off until you install to the Home Screen — follow step 1 below."
                : "You can install for a standalone window, or keep using the tab — push works either way here."}
            </p>
          )}
        </div>

        {/* iOS first: PWA-only, no Electron path exists on iPhone/iPad. */}
        <section
          aria-labelledby="install-ios"
          className="rounded-md border border-hairline bg-surface p-4 md:p-5"
        >
          <h2 id="install-ios" className="flex items-center gap-2 text-13 font-semibold text-ink">
            <Smartphone className="h-4 w-4 text-accent" aria-hidden="true" />
            iPhone &amp; iPad
            {install.ios && !installed ? (
              <span className="rounded-sm border border-accent/30 bg-accent-soft px-1.5 py-0.5 text-12 font-medium text-accent">
                This device — start here
              </span>
            ) : null}
          </h2>
          <div
            className="mt-3 rounded-md border border-warning/30 bg-warning-soft px-3 py-2.5 text-12 leading-relaxed text-warning"
            role="note"
          >
            <p className="font-semibold">Requires iOS 16.4 or later.</p>
            <p className="mt-0.5">
              Older iOS cannot receive Web Push at all — Safari tabs and Home
              Screen apps alike. On 16.4+, only the installed Home Screen app
              gets pushes; a Safari tab never will.
            </p>
          </div>
          <IosSteps />
          {install.ios && installed ? (
            <Link
              to="/settings"
              search={{ section: "devices" }}
              className="btn btn-primary mt-4"
            >
              <BellRing className="h-4 w-4" aria-hidden="true" />
              Enable notifications
            </Link>
          ) : null}
        </section>

        {/* Android: beforeinstallprompt capture, menu fallback. */}
        <section
          aria-labelledby="install-android"
          className="rounded-md border border-hairline bg-surface p-4 md:p-5"
        >
          <h2 id="install-android" className="flex items-center gap-2 text-13 font-semibold text-ink">
            <Download className="h-4 w-4 text-accent" aria-hidden="true" />
            Android
            {install.android && !installed ? (
              <span className="rounded-sm border border-accent/30 bg-accent-soft px-1.5 py-0.5 text-12 font-medium text-accent">
                This device
              </span>
            ) : null}
          </h2>
          <p className="mt-1 text-12 leading-relaxed text-muted">
            Chrome on Android can install Morrow to the Home Screen, and push
            works from the installed app or the browser tab.
          </p>
          <div className="mt-3">
            {install.available ? (
              <button type="button" className="btn btn-primary" onClick={() => void promptInstall()}>
                <Download className="h-4 w-4" aria-hidden="true" />
                Install Morrow
              </button>
            ) : (
              <ol className="list-decimal space-y-1.5 pl-5 text-12 leading-relaxed text-muted">
                <li>Open Morrow in Chrome.</li>
                <li>
                  Open the browser menu (⋮) → “Add to Home screen” → Install.
                </li>
                <li>
                  Then enable notifications in Settings → Devices &amp;
                  notifications.
                </li>
              </ol>
            )}
          </div>
        </section>

        {/* Desktop: browser install button, no helper app needed. */}
        <section
          aria-labelledby="install-desktop"
          className="rounded-md border border-hairline bg-surface p-4 md:p-5"
        >
          <h2 id="install-desktop" className="flex items-center gap-2 text-13 font-semibold text-ink">
            <MonitorDown className="h-4 w-4 text-accent" aria-hidden="true" />
            Desktop
          </h2>
          <p className="mt-1 text-12 leading-relaxed text-muted">
            Install from Chrome or Edge for a standalone window and launcher
            entry. No helper app — the PWA is the desktop app.
          </p>
          <div className="mt-3">
            {install.available && install.platform === "desktop" ? (
              <button type="button" className="btn btn-primary" onClick={() => void promptInstall()}>
                <Download className="h-4 w-4" aria-hidden="true" />
                Install Morrow
              </button>
            ) : (
              <p className="text-12 leading-relaxed text-muted">
                Use the install icon in the address bar, or ⋮ → Cast, save, and
                share → Install page as app. If no install option appears, this
                browser already runs Morrow as an app — or does not support
                installing it.
              </p>
            )}
          </div>
        </section>

        {/* Honest per-platform matrix. */}
        <section
          aria-labelledby="install-matrix"
          className="rounded-md border border-hairline bg-surface p-4 md:p-5"
        >
          <h2 id="install-matrix" className="flex items-center gap-2 text-13 font-semibold text-ink">
            <Info className="h-4 w-4 text-accent" aria-hidden="true" />
            What works where
          </h2>
          <div className="mt-3">
            <CapabilityMatrix />
          </div>
          <p className="mt-3 text-12 leading-relaxed text-muted">
            Where push says “No”, nothing is broken: reminders stay listed in
            the app with their times, and the ledger on each task shows the
            honest delivery state.
          </p>
        </section>

        <p className="text-12 leading-relaxed text-muted">
          Service workers and push require HTTPS, except on localhost. If you
          use a self-signed certificate, install it on the device first; iOS
          will not trust an untrusted origin for push, and Apple rejects
          localhost as a push origin entirely.
        </p>
      </div>
    </div>
  );
}
