import { Link } from "@tanstack/react-router";
import { Bell, BellOff, Smartphone, WifiOff } from "lucide-react";
import { toast } from "sonner";
import { useOnline } from "@/lib/hooks";
import { usePushStatus } from "@/lib/push";
import { cn } from "@/lib/utils";

type Tone = "success" | "warning" | "danger" | "muted";

const dotClass: Record<Tone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  muted: "bg-faint",
};

const toneTextClass: Record<Tone, string> = {
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  muted: "text-muted",
};

/**
 * Today's honest delivery state (plan §4/§7). Permission + subscription state
 * drive the message; per-task truth lives in the delivery ledger.
 */
export function ArmedState() {
  const online = useOnline();
  const push = usePushStatus();

  let tone: Tone = "warning";
  let icon = <Bell className="h-4 w-4" aria-hidden="true" />;
  let message = "Push is off. Reminders will wait inside the app.";
  let action: { label: string; onClick?: () => void; toSettings?: boolean } | null = null;

  if (push.loading) {
    tone = "muted";
    icon = <Bell className="h-4 w-4" aria-hidden="true" />;
    message = "Checking this device’s reminder delivery…";
  } else if (!online) {
    tone = "muted";
    icon = <WifiOff className="h-4 w-4" aria-hidden="true" />;
    message = "Offline. Reminders are safe on the server; this view is showing saved data.";
  } else if (!push.supported) {
    tone = "warning";
    icon = <BellOff className="h-4 w-4" aria-hidden="true" />;
    message = "Push is unavailable in this browser. Reminders will wait inside the app.";
  } else if (push.ios && !push.standalone) {
    tone = "warning";
    icon = <Smartphone className="h-4 w-4" aria-hidden="true" />;
    message = "On iPhone, add Morrow to your Home Screen before enabling reminders.";
    action = { label: "Install help", toSettings: true };
  } else if (push.permission === "denied") {
    tone = "danger";
    icon = <BellOff className="h-4 w-4" aria-hidden="true" />;
    message = "Push is off. Reminders will wait inside the app.";
    action = { label: "How to re-enable", toSettings: true };
  } else if (push.permission === "granted" && push.subscribed) {
    tone = "success";
    icon = <Bell className="h-4 w-4" aria-hidden="true" />;
    message = "Armed. This device can receive reminders.";
  } else if (push.permission === "granted") {
    tone = "warning";
    icon = <Bell className="h-4 w-4" aria-hidden="true" />;
    message = "Notifications are allowed, but this device is not registered yet.";
    action = { label: "Finish setup", toSettings: true };
  } else {
    action = {
      label: "Enable notifications",
      onClick: () => {
        void (async () => {
          const result = await push.requestPermission();
          if (result === "granted") {
            toast("Notifications allowed", {
              description: "Finish device registration in Settings → Devices.",
            });
          } else if (result === "denied") {
            toast.error("Push is off", {
              description: "Reminders will wait inside the app.",
            });
          }
        })();
      },
    };
  }

  return (
    <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 border-y border-hairline py-2.5">
      <span
        className={cn("h-2 w-2 shrink-0 rounded-full", dotClass[tone])}
        aria-hidden="true"
      />
      <span className={cn("flex items-center gap-2 text-13", toneTextClass[tone])}>
        {icon}
        <span role="status" aria-live="polite">
          {message}
        </span>
      </span>
      {action ? (
        action.toSettings ? (
          <Link
            to="/settings"
            search={{ section: "devices" }}
            className="btn btn-ghost ml-auto min-h-11 px-2 text-12"
          >
            {action.label}
          </Link>
        ) : (
          <button
            type="button"
            className="btn btn-ghost ml-auto min-h-11 px-2 text-12"
            onClick={action.onClick}
          >
            {action.label}
          </button>
        )
      ) : null}
    </div>
  );
}
