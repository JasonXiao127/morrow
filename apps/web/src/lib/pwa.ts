/**
 * Prompt-based service worker updates (plan §7).
 *
 * vite-plugin-pwa is configured with injectManifest + registerType "prompt".
 * We register manually so the app controls when a waiting worker activates;
 * the SW never calls skipWaiting on install.
 */

export const SW_UPDATE_EVENT = "morrow:sw-update";

export interface ServiceWorkerUpdateDetail {
  registration: ServiceWorkerRegistration;
}

let updateNotified = false;
let reloadWhenActivated = false;

function dispatchUpdate(registration: ServiceWorkerRegistration): void {
  if (updateNotified || !navigator.serviceWorker.controller) return;
  updateNotified = true;
  window.dispatchEvent(
    new CustomEvent<ServiceWorkerUpdateDetail>(SW_UPDATE_EVENT, {
      detail: { registration },
    }),
  );
}

export function onServiceWorkerUpdate(
  handler: (registration: ServiceWorkerRegistration) => void,
): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<ServiceWorkerUpdateDetail>).detail;
    if (detail?.registration) handler(detail.registration);
  };
  window.addEventListener(SW_UPDATE_EVENT, listener);
  return () => window.removeEventListener(SW_UPDATE_EVENT, listener);
}

export async function applyServiceWorkerUpdate(): Promise<boolean> {
  if (!("serviceWorker" in navigator)) return false;
  const registration = await navigator.serviceWorker.getRegistration();
  const waiting = registration?.waiting;
  if (!waiting) return false;
  reloadWhenActivated = true;
  waiting.postMessage({ type: "SKIP_WAITING" });
  return true;
}

/** The waiting worker, if an update is installed but not activated yet. */
export async function waitingServiceWorker(): Promise<ServiceWorker | null> {
  if (!("serviceWorker" in navigator)) return null;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    return registration?.waiting ?? null;
  } catch {
    return null;
  }
}

export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloadWhenActivated) window.location.reload();
  });

  // If a WindowClient cannot navigate itself, the SW asks the page to route.
  navigator.serviceWorker.addEventListener("message", (event) => {
    const data = event.data as { type?: string; url?: string } | null;
    if (
      data?.type === "MORROW_NAVIGATE" &&
      typeof data.url === "string" &&
      data.url.startsWith("/") &&
      !data.url.startsWith("//")
    ) {
      window.location.assign(data.url);
    }
  });

  const register = async () => {
    try {
      const registration = await navigator.serviceWorker.register("/sw.js", {
        scope: "/",
        updateViaCache: "none",
      });

      if (registration.waiting) dispatchUpdate(registration);

      registration.addEventListener("updatefound", () => {
        const installing = registration.installing;
        if (!installing) return;
        installing.addEventListener("statechange", () => {
          if (
            installing.state === "installed" &&
            navigator.serviceWorker.controller
          ) {
            dispatchUpdate(registration);
          }
        });
      });

      let lastCheck = 0;
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "visible") return;
        const now = Date.now();
        if (now - lastCheck < 60_000) return;
        lastCheck = now;
        registration.update().catch(() => {
          // Offline is expected; a later visibility change retries.
        });
      });
    } catch (error) {
      console.warn("[morrow] service worker registration failed", error);
    }
  };

  if (document.readyState === "complete") {
    void register();
  } else {
    window.addEventListener("load", () => void register(), { once: true });
  }
}
