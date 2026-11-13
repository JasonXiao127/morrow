import { useCallback, useEffect, useState } from "react";
import { pushApi } from "@/api";
import { urlBase64ToUint8Array } from "./push-dedupe";

/**
 * Push state + subscription management (plan §7).
 *
 * Rules:
 * - Ask for permission only from a user gesture (Settings / after the first
 *   reminder). Never re-prompt after denial; show the OS re-enable path.
 * - iOS 16.4+ requires an installed Home Screen app for Web Push. iOS never
 *   fires `pushsubscriptionchange`, so every launch calls
 *   `resyncPushSubscription()` when permission is granted.
 * - A granted permission without a PushManager subscription is repaired on
 *   launch; the server upsert is idempotent by endpoint hash.
 */

export interface PushStatus {
  supported: boolean;
  permission: NotificationPermission | "unsupported";
  subscribed: boolean;
  standalone: boolean;
  ios: boolean;
  loading: boolean;
  busy: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  requestPermission: () => Promise<NotificationPermission | "unsupported">;
  subscribe: () => Promise<PushSubscription | null>;
  unsubscribe: () => Promise<boolean>;
  sendTest: () => Promise<{
    ok?: boolean;
    sent?: number;
    failed?: number;
    disabled?: number;
  }>;
}

export function isIosDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  const iPadOs =
    navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  return /iPad|iPhone|iPod/.test(ua) || iPadOs;
}

export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const navigatorStandalone = (
    navigator as Navigator & { standalone?: boolean }
  ).standalone;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    navigatorStandalone === true
  );
}

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "Notification" in window &&
    "serviceWorker" in navigator &&
    "PushManager" in window
  );
}

/**
 * Localhost (or plain HTTP) origins: Web Push works in desktop Chrome/Firefox
 * here, but Apple's push service rejects non-HTTPS origins and a localhost
 * VAPID subject. Callers use this for honest copy, never to block setup.
 */
export function isLocalhostOrigin(): boolean {
  if (typeof window === "undefined") return false;
  const host = window.location.hostname;
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host.endsWith(".localhost")
  );
}

async function activeRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  const existing = await navigator.serviceWorker.getRegistration();
  if (!existing) return null;
  // `getRegistration` can return a registration with no active worker while
  // an update is installing; wait briefly for it to become active.
  if (existing.active) return existing;
  try {
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<ServiceWorkerRegistration | null>((resolve) =>
        window.setTimeout(() => resolve(existing), 3_000),
      ),
    ]);
  } catch {
    return existing;
  }
}

async function fetchVapidKey(): Promise<string | null> {
  const body = await pushApi.vapidPublicKey();
  return body.publicKey || body.key || null;
}

/**
 * Create or refresh the browser subscription and upsert it server-side.
 * Safe to call repeatedly; the server keys by endpoint hash.
 */
export async function subscribeToPush(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  if (Notification.permission === "denied") return null;
  if (Notification.permission === "default") {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return null;
  }

  const registration = await activeRegistration();
  if (!registration) return null;

  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    const key = await fetchVapidKey();
    if (!key) return null;
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key) as unknown as BufferSource,
    });
  }

  await pushApi.subscribe(subscription.toJSON());
  return subscription;
}

/** Remove the browser subscription first, then the server row. */
export async function unsubscribeFromPush(): Promise<boolean> {
  if (!pushSupported()) return false;
  const registration = await activeRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return false;
  try {
    await pushApi.unsubscribe(subscription.endpoint);
  } catch {
    // The server may already have pruned a 410; still drop the local sub.
  }
  try {
    return await subscription.unsubscribe();
  } catch {
    return false;
  }
}

export async function sendTestPush(): Promise<{
  ok?: boolean;
  sent?: number;
  failed?: number;
  disabled?: number;
}> {
  return pushApi.test();
}

let launchResyncDone = false;

/**
 * Launch-time repair. iOS never fires `pushsubscriptionchange`; this is the
 * real recovery path when permission is granted but the endpoint is missing
 * or the server lost the row.
 */
export async function resyncPushSubscription(): Promise<boolean> {
  if (!pushSupported() || Notification.permission !== "granted") return false;
  try {
    await subscribeToPush();
    return true;
  } catch {
    return false;
  }
}

export function usePushStatus(): PushStatus {
  const [supported, setSupported] = useState(false);
  const [permission, setPermission] = useState<
    NotificationPermission | "unsupported"
  >("default");
  const [subscribed, setSubscribed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [standalone] = useState(isStandalone);
  const [ios] = useState(isIosDevice);

  const refresh = useCallback(async () => {
    if (!pushSupported()) {
      setSupported(false);
      setPermission("unsupported");
      setSubscribed(false);
      setLoading(false);
      return;
    }

    setSupported(true);
    setPermission(Notification.permission);
    try {
      const registration = await activeRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      setSubscribed(Boolean(subscription));
    } catch {
      setSubscribed(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);

    const onServiceWorkerMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string } | null;
      if (data?.type === "MORROW_PUSH_RESYNC") {
        void refresh();
        void resyncPushSubscription();
      }
    };
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("message", onServiceWorkerMessage);
    }

    // One launch-time repair attempt. It runs after the first refresh so a
    // denied permission or missing PushManager is never touched. Always
    // re-upsert: a local subscription can survive while the server row was
    // lost to a backup restore or database reset.
    if (!launchResyncDone) {
      launchResyncDone = true;
      window.setTimeout(() => {
        void (async () => {
          if (!pushSupported() || Notification.permission !== "granted") return;
          await resyncPushSubscription();
          await refresh();
        })();
      }, 1_500);
    }

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      if ("serviceWorker" in navigator) {
        navigator.serviceWorker.removeEventListener(
          "message",
          onServiceWorkerMessage,
        );
      }
    };
  }, [refresh]);

  const subscribe = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const subscription = await subscribeToPush();
      await refresh();
      if (!subscription) {
        setError("Push permission was not granted or no service worker is active.");
      }
      return subscription;
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not register for push notifications.",
      );
      return null;
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const unsubscribe = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const removed = await unsubscribeFromPush();
      await refresh();
      return removed;
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not remove this device.",
      );
      return false;
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const sendTest = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      return await sendTestPush();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "The test push did not send.",
      );
      throw err;
    } finally {
      setBusy(false);
    }
  }, []);

  const requestPermission = useCallback(async () => {
    if (!supported) return "unsupported" as const;
    setBusy(true);
    setError(null);
    try {
      const result = await Notification.requestPermission();
      setPermission(result);
      // Subscribing here keeps the existing Settings button working: the
      // permission response is the user gesture PushManager requires.
      if (result === "granted") {
        await subscribeToPush();
      }
      await refresh();
      return result;
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Notification permission failed.",
      );
      return Notification.permission;
    } finally {
      setBusy(false);
    }
  }, [refresh, supported]);

  return {
    supported,
    permission,
    subscribed,
    standalone,
    ios,
    loading,
    busy,
    error,
    refresh,
    requestPermission,
    subscribe,
    unsubscribe,
    sendTest,
  };
}
