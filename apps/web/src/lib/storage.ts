import { closeDb, getDb } from "./idb";

/**
 * Ask the browser not to evict the offline bootstrap/outbox under storage
 * pressure. This is best-effort: Safari may ignore the request, and a denied
 * request must not stop the app from working.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.storage?.persist) {
    return false;
  }
  try {
    if (await navigator.storage.persisted?.()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

/**
 * Clear the task/query half of the local cache without touching service
 * worker precache. Used when the server's workspace epoch or owner id changed:
 * queued mutations from the old workspace must not be replayed.
 *
 * Stores are cleared instead of deleting the database because a pending
 * delete blocks while another tab still holds the connection.
 */
export async function clearLocalTaskState(): Promise<void> {
  const db = await getDb();
  try {
    await db.clear("outbox");
    await db.clear("query");
  } finally {
    await closeDb();
  }
}

/**
 * Purge local PWA data on logout/session expiry (plan §7/§8).
 *
 * Removes every Cache Storage entry (including Workbox precache; it will be
 * restored on the next online load), the Morrow IndexedDB database (query
 * cache + outbox), and app-scoped localStorage/sessionStorage values. The
 * theme preference is intentionally preserved.
 */
export async function purgeLocalData(): Promise<void> {
  if (typeof window === "undefined") return;

  if ("caches" in window) {
    try {
      const names = await caches.keys();
      await Promise.all(names.map((name) => caches.delete(name)));
    } catch (error) {
      console.warn("[morrow] could not clear caches", error);
    }
  }

  // Remove the worker as well: its precache was just purged, so force a clean
  // install on the next authenticated load instead of leaving a broken shell.
  if ("serviceWorker" in navigator) {
    try {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
    } catch (error) {
      console.warn("[morrow] could not unregister service worker", error);
    }
  }

  try {
    await clearLocalTaskState();
  } catch (error) {
    console.warn("[morrow] could not clear IndexedDB", error);
  }

  try {
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key && key.startsWith("morrow.") && key !== "morrow.theme") {
        localStorage.removeItem(key);
      }
    }
  } catch {
    // Storage can be disabled; nothing else to purge.
  }

  try {
    sessionStorage.clear();
  } catch {
    // Ignore.
  }
}
