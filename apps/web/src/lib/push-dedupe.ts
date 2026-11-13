/**
 * Pure helpers shared by the service worker and its unit tests.
 *
 * The SW keeps a small Cache Storage bucket of recently seen `deliveryId`s.
 * Web Push is at-least-once: a crash after the push service accepted a
 * request but before the server committed `sent` can replay it. The
 * deterministic `deliveryId` is the only reliable dedupe key. `tag`/Topic
 * coalescing is separate and handles bursts of *different* reminders.
 */

export const PUSH_DEDUPE_CACHE = "morrow-push-dedupe-v1";
export const MAX_SEEN_DELIVERIES = 200;

export interface NormalizedPushPayload {
  title: string;
  body: string;
  url: string;
  taskId?: string;
  taskRev?: number;
  deliveryId: string;
  tag: string;
  badgeCount?: number;
  kind?: "reminder" | "digest" | "test";
}

export interface DedupeCacheLike {
  match: (key: string) => Promise<unknown>;
  put: (key: string, response: unknown) => Promise<void>;
  keys: () => Promise<unknown[]>;
  delete: (key: unknown) => Promise<boolean>;
}

export type DedupeCacheFactory = (name: string) => Promise<DedupeCacheLike>;

function stringValue(value: unknown, fallback: string, max: number): string {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, max)
    : fallback;
}

function safeNotificationUrl(value: unknown): string {
  const raw = typeof value === "string" && value ? value : "/today";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/today";
  if (raw === "/events" || raw.startsWith("/events?") || raw.startsWith("/api/")) {
    return "/today";
  }
  return raw.slice(0, 512);
}

export function normalizePushPayload(raw: unknown): NormalizedPushPayload {
  const data =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const deliveryId = stringValue(data["deliveryId"], "", 120);
  const kind =
    data["kind"] === "reminder" || data["kind"] === "digest" || data["kind"] === "test"
      ? data["kind"]
      : undefined;
  // A digest without an explicit server tag coalesces under one key so a
  // burst of digests replaces instead of stacking. iOS may ignore `tag`
  // anyway; the server keeps bursts small and prefers one digest.
  const defaultTag =
    kind === "digest" ? "morrow-digest" : deliveryId || "morrow-reminder";
  return {
    title: stringValue(data["title"], "Morrow", 120),
    body: stringValue(data["body"], "A reminder is due.", 800),
    url: safeNotificationUrl(data["url"]),
    ...(typeof data["taskId"] === "string" && data["taskId"]
      ? { taskId: data["taskId"].slice(0, 120) }
      : {}),
    ...(typeof data["taskRev"] === "number" && Number.isFinite(data["taskRev"])
      ? { taskRev: Math.round(data["taskRev"]) }
      : {}),
    deliveryId,
    tag: stringValue(data["tag"], defaultTag, 64),
    ...(typeof data["badgeCount"] === "number" &&
    Number.isFinite(data["badgeCount"])
      ? { badgeCount: Math.max(0, Math.round(data["badgeCount"])) }
      : {}),
    ...(kind ? { kind } : {}),
  };
}

export function dedupeKey(deliveryId: string): string {
  return `/__push/${encodeURIComponent(deliveryId)}`;
}

/**
 * Remember a delivery id. Returns false when it was already seen.
 * If Cache Storage is unavailable, returns true: showing a duplicate is
 * better than silently dropping a reminder.
 */
export async function rememberDelivery(
  cacheFactory: DedupeCacheFactory,
  deliveryId: string,
  limit = MAX_SEEN_DELIVERIES,
): Promise<boolean> {
  if (!deliveryId) return true;
  try {
    const cache = await cacheFactory(PUSH_DEDUPE_CACHE);
    const key = dedupeKey(deliveryId);
    if (await cache.match(key)) return false;
    await cache.put(key, new Response("1"));
    const keys = await cache.keys();
    if (keys.length > limit) {
      const excess = keys.slice(0, keys.length - limit);
      await Promise.all(excess.map((entry) => cache.delete(entry)));
    }
    return true;
  } catch {
    return true;
  }
}

/**
 * VAPID `applicationServerKey` is base64url; PushManager needs bytes.
 * Exported here so the page and the service worker decode it identically.
 */
export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding)
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const rawData = atob(base64);
  const output = new Uint8Array(rawData.length);
  for (let index = 0; index < rawData.length; index += 1) {
    output[index] = rawData.charCodeAt(index);
  }
  return output;
}
