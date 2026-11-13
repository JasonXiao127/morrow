/// <reference lib="webworker" />
/**
 * Morrow service worker (plan §7).
 *
 * - injectManifest precaches the hashed app shell; navigation falls back to
 *   index.html only for SPA routes.
 * - `/api/*`, `/events`, `/healthz` and `/readyz` are NetworkOnly. Authenticated
 *   API GETs and 401s are never cached.
 * - Push payloads are deduped by `deliveryId` (at-least-once Web Push) and
 *   coalesced by `tag` (Topic, max 32 base64url chars on the server).
 * - Updates are prompt-based: this SW never calls skipWaiting on install.
 *   The page sends SKIP_WAITING only after the user chooses to update.
 */
import { clientsClaim } from "workbox-core";
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { NetworkOnly } from "workbox-strategies";
import {
  normalizePushPayload,
  rememberDelivery,
  urlBase64ToUint8Array,
  type NormalizedPushPayload,
} from "./lib/push-dedupe";

interface PrecacheManifestEntry {
  url: string;
  revision: string | null;
}

declare global {
  interface WorkerGlobalScope {
    __WB_MANIFEST: Array<PrecacheManifestEntry>;
  }
}

const sw = self as unknown as ServiceWorkerGlobalScope;

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
clientsClaim();

registerRoute(
  ({ url }) =>
    url.pathname === "/events" ||
    url.pathname.startsWith("/api/") ||
    url.pathname === "/healthz" ||
    url.pathname === "/readyz",
  new NetworkOnly(),
);

registerRoute(
  new NavigationRoute(createHandlerBoundToURL("index.html"), {
    denylist: [
      /^\/api\//,
      /^\/events/,
      /^\/healthz$/,
      /^\/readyz$/,
      /^\/mcp/,
    ],
  }),
);

/* -------------------------------------------------------------------------- */
/* Updates                                                                    */
/* -------------------------------------------------------------------------- */

sw.addEventListener("message", (event: ExtendableMessageEvent) => {
  const data = event.data as { type?: string } | null;
  if (data?.type === "SKIP_WAITING") {
    void sw.skipWaiting();
  }
});

/* -------------------------------------------------------------------------- */
/* Push                                                                       */
/* -------------------------------------------------------------------------- */

interface PushData extends NormalizedPushPayload {
  title: string;
  body: string;
  url: string;
  deliveryId: string;
  tag: string;
}

function parsePushData(event: PushEvent): PushData {
  try {
    return normalizePushPayload(event.data?.json()) as PushData;
  } catch {
    return normalizePushPayload({
      title: "Morrow",
      body: event.data?.text() ?? "You have a reminder.",
    }) as PushData;
  }
}

async function setBadge(count: number): Promise<void> {
  const navigatorWithBadge = sw.navigator as unknown as {
    setAppBadge?: (value?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  try {
    if (count <= 0) {
      await navigatorWithBadge.clearAppBadge?.();
      return;
    }
    if (typeof navigatorWithBadge.setAppBadge !== "function") return;
    await navigatorWithBadge.setAppBadge(count);
  } catch {
    // Badging API is progressive; ignore.
  }
}

/**
 * Focus an existing Morrow window and navigate it, or open a new one. Used by
 * notification clicks and by failed notification actions.
 */
async function focusOrOpen(absolute: string, target: string): Promise<void> {
  const windowClients = await sw.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });

  const exact = windowClients.find((client) => client.url === absolute);
  if (exact) {
    await exact.focus();
    return;
  }

  const sameOrigin = windowClients.find((client) => {
    try {
      return new URL(client.url).origin === sw.location.origin;
    } catch {
      return false;
    }
  });
  if (sameOrigin) {
    const focused = await sameOrigin.focus();
    try {
      await focused.navigate(absolute);
      return;
    } catch {
      try {
        await focused.navigate(new URL("/today", sw.location.origin).href);
        return;
      } catch {
        focused.postMessage({ type: "MORROW_NAVIGATE", url: target });
        return;
      }
    }
  }

  try {
    await sw.clients.openWindow(absolute);
  } catch {
    try {
      await sw.clients.openWindow("/today");
    } catch {
      // Nothing else the SW can do; the OS will surface the app icon.
    }
  }
}

interface NotificationActionData {
  url?: string;
  taskId?: string;
  taskRev?: number;
  deliveryId?: string;
  badgeCount?: number;
  kind?: string;
}

/**
 * Complete or snooze from the notification shade. The server requires an
 * If-Match revision; a stale push falls back to opening the task rather than
 * pretending the action succeeded.
 */
async function runNotificationAction(
  action: "complete" | "snooze",
  data: NotificationActionData,
): Promise<void> {
  const target = normalizePushPayload({ url: data.url }).url;
  if (!data.taskId) {
    await focusOrOpen(new URL(target, sw.location.origin).href, target);
    return;
  }
  const headers: Record<string, string> = {
    "content-type": "application/json",
    // Delivery id makes a retried tap idempotent; the server also enforces
    // the revision below.
    ...(data.deliveryId
      ? { "idempotency-key": `notif:${data.deliveryId}:${action}` }
      : {}),
    ...(typeof data.taskRev === "number"
      ? { "if-match": `"rev-${data.taskRev}"` }
      : {}),
  };
  const body =
    action === "complete"
      ? {}
      : { until: new Date(Date.now() + 10 * 60_000).toISOString() };
  try {
    const response = await fetch(
      `/api/tasks/${encodeURIComponent(data.taskId)}/${action}`,
      {
        method: "POST",
        credentials: "same-origin",
        headers,
        body: JSON.stringify(body),
      },
    );
    if (response.ok) {
      const remaining = Math.max(0, (data.badgeCount ?? 1) - 1);
      await setBadge(remaining);
      return;
    }
  } catch {
    // Network failure: fall through to the app so the user sees the task.
  }
  await focusOrOpen(new URL(target, sw.location.origin).href, target);
}

sw.addEventListener("push", (event: PushEvent) => {
  event.waitUntil(
    (async () => {
      const data = parsePushData(event);

      // Dedupe replayed deliveries. No id means an older sender: show it.
      if (data.deliveryId) {
        const fresh = await rememberDelivery(
          (name) => caches.open(name) as unknown as Promise<{
            match: (key: string) => Promise<unknown>;
            put: (key: string, response: unknown) => Promise<void>;
            keys: () => Promise<unknown[]>;
            delete: (key: unknown) => Promise<boolean>;
          }>,
          data.deliveryId,
        );
        if (!fresh) return;
      }

      // `tag` is the server's Topic (<=32 chars). Same-tag notifications
      // replace/coalesce on most platforms; iOS may ignore it, so the server
      // also keeps the burst small and prefers one digest. An untagged digest
      // falls back to "morrow-digest" in normalizePushPayload so digests
      // coalesce instead of stacking; singles fall back to their deliveryId.
      const tag = (data.tag || data.deliveryId || "morrow-reminder").slice(0, 64);

      const actions =
        data.taskId && data.kind === "reminder" && data.taskRev !== undefined
          ? [
              { action: "complete", title: "Complete" },
              { action: "snooze", title: "Snooze 10m" },
            ]
          : [];
      await sw.registration.showNotification(data.title, {
        body: data.body,
        tag,
        renotify: false,
        data: {
          url: data.url,
          taskId: data.taskId,
          taskRev: data.taskRev,
          deliveryId: data.deliveryId || undefined,
          badgeCount: data.badgeCount,
          kind: data.kind,
        },
        actions,
        icon: "/icons/icon-192.png",
        badge: "/icons/icon-192.png",
        timestamp: Date.now(),
      } as NotificationOptions & {
        renotify?: boolean;
        actions?: Array<{ action: string; title: string }>;
      });

      await setBadge(data.badgeCount ?? 1);
    })(),
  );
});

sw.addEventListener("notificationclick", (event: NotificationEvent) => {
  event.notification.close();

  const data = event.notification.data as NotificationActionData | undefined;
  const target = normalizePushPayload({ url: data?.url }).url;
  const absolute = new URL(target, sw.location.origin).href;

  if (event.action === "complete" || event.action === "snooze") {
    event.waitUntil(runNotificationAction(event.action, data ?? {}));
    return;
  }

  event.waitUntil(focusOrOpen(absolute, target));
});

/* -------------------------------------------------------------------------- */
/* Subscription change                                                        */
/* -------------------------------------------------------------------------- */

async function notifyClientsToResync(): Promise<void> {
  try {
    const clients = await sw.clients.matchAll({
      type: "window",
      includeUncontrolled: true,
    });
    for (const client of clients) {
      client.postMessage({ type: "MORROW_PUSH_RESYNC" });
    }
  } catch {
    // Best effort.
  }
}

async function postSubscription(subscription: PushSubscription): Promise<boolean> {
  try {
    const response = await fetch("/api/push/subscriptions", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription: subscription.toJSON() }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Best-effort where supported. iOS never fires this event; launch-time
 * resync in the page (`resyncPushSubscription`) is the real mechanism.
 */
sw.addEventListener("pushsubscriptionchange", (event: Event) => {
  const extendable = event as ExtendableEvent & {
    newSubscription?: PushSubscription | null;
  };

  extendable.waitUntil(
    (async () => {
      try {
        let subscription = extendable.newSubscription ?? null;

        if (!subscription) {
          const response = await fetch("/api/push/vapid-public-key", {
            credentials: "same-origin",
          });
          if (!response.ok) {
            await notifyClientsToResync();
            return;
          }
          const body = (await response.json()) as {
            publicKey?: string;
            key?: string;
          };
          const key = body.publicKey || body.key;
          if (!key) {
            await notifyClientsToResync();
            return;
          }
          subscription = await sw.registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(key) as unknown as BufferSource,
          });
        }

        const ok = await postSubscription(subscription);
        if (!ok) await notifyClientsToResync();
      } catch {
        // Best effort only; the next app launch rechecks subscription state.
        await notifyClientsToResync();
      }
    })(),
  );
});
