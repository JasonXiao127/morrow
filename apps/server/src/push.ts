/**
 * Web Push sender (§4 / §7).
 *
 * - `web-push` 3.6.x with VAPID details passed per request.
 * - Payload is plaintext JSON, strictly < 2 KB:
 *     {title, body, url, taskId, deliveryId, tag, badgeCount, kind}
 *   `deliveryId` is deterministic so the service worker can dedupe a
 *   crash-after-accept duplicate. `tag`/`Topic` coalesce bursts; iOS does not
 *   reliably replace by tag, so Topic is the real coalescing mechanism.
 * - TTL: reminders 900s, digests 86400s, tests 0s.
 * - Endpoint validation: HTTPS only, known push-provider allowlist, no
 *   loopback/private/link-local/CGNAT targets, no redirects, 5s timeout.
 *   `PUSH_ALLOW_ANY_PUBLIC_ENDPOINT=1` is an explicit opt-in for a certified
 *   self-hosted relay; the IP/hostname blocks still apply.
 * - Response policy:
 *     404/410       disable subscription, dead-letter the delivery
 *     401/403       disable subscription + alert, dead-letter
 *     400/413       dead-letter
 *     429           honour Retry-After (default 60s), status retry
 *     5xx/network   exponential backoff (30s × 2^(attempts-1), cap 1h)
 *     five tries    dead-letter
 * - Duplicate policy: Web Push has no server idempotency. We provide
 *   at-least-once delivery and a deterministic payload id — never "exactly
 *   once". The DB only moves to `sent` with
 *   `WHERE id=? AND claim_token=? AND status='sending'`.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type BetterDb } from "@morrow/db";
import { newId, toUtcIso } from "@morrow/shared";
import * as webpush from "web-push";
import { readNtfyConfig, sendNtfy } from "./ntfy.js";
import { deliveryRecipientLostAccess } from "./deliveries.js";
import type { ClaimedDelivery } from "./scheduler.js";

export const PUSH_TIMEOUT_MS = 5_000;
export const PUSH_MAX_PAYLOAD_BYTES = 2_048;
export const PUSH_MAX_ATTEMPTS = 5;
export const PUSH_LEASE_MS = 60_000;
export const BATCH_WINDOW_MS = 15 * 60 * 1000;

const TTL_REMINDER = 900;
const TTL_DIGEST = 86_400;
const TTL_TEST = 0;

const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 60 * 60 * 1000;
const RETRY_AFTER_DEFAULT_MS = 60_000;
const RETRY_AFTER_MAX_MS = 24 * 60 * 60 * 1000;

/**
 * Push services used by the browsers Morrow targets. A suffix match is
 * required (`endsWith("." + entry)`) so `evilnotify.windows.com` cannot pass
 * as `notify.windows.com`.
 */
const DEFAULT_ENDPOINT_ALLOWLIST = [
  "fcm.googleapis.com",
  "android.googleapis.com",
  "updates.push.services.mozilla.com",
  "push.services.mozilla.com",
  "web.push.apple.com",
  "push.apple.com",
  "notify.windows.com",
  "push.yandex.ru",
];

// ---------------------------------------------------------------------------
// Errors / config
// ---------------------------------------------------------------------------

export class PushNotConfiguredError extends Error {
  readonly code = "push_not_configured";
  constructor(message = "Web Push is not configured (VAPID keys missing).") {
    super(message);
    this.name = "PushNotConfiguredError";
  }
}

export class PushEndpointError extends Error {
  readonly code = "invalid_push_endpoint";
  constructor(message: string) {
    super(message);
    this.name = "PushEndpointError";
  }
}

export interface PushConfig {
  enabled: boolean;
  publicKey: string | null;
  privateKey: string | null;
  subject: string;
}

let configCache: PushConfig | null = null;
let vapidConfigured = false;

function readSecretFile(name: string): string | null {
  try {
    const dir = process.env["SECRETS_DIR"] ?? path.join(process.cwd(), "data", "secrets");
    const value = fs.readFileSync(path.join(dir, name), "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

function envSecret(name: string, fileName: string): string | null {
  const fromEnv = process.env[name]?.trim();
  if (fromEnv) return fromEnv;
  return readSecretFile(fileName);
}

function defaultSubject(): string {
  const configured = process.env["VAPID_SUBJECT"]?.trim();
  if (configured) return configured;
  const appUrl = process.env["APP_URL"]?.trim();
  if (appUrl) {
    try {
      const url = new URL(appUrl);
      if (url.protocol === "https:" && url.hostname !== "localhost") {
        return `https://${url.host}`;
      }
    } catch {
      // fall through
    }
  }
  // Apple rejects localhost; this is a dev fallback only.
  return "mailto:morrow@localhost";
}

export function loadPushConfig(): PushConfig {
  if (configCache) return configCache;
  const publicKey = envSecret("VAPID_PUBLIC_KEY", "vapid_public_key");
  const privateKey = envSecret("VAPID_PRIVATE_KEY", "vapid_private_key");
  const subject = defaultSubject();
  configCache = {
    enabled: Boolean(publicKey && privateKey),
    publicKey,
    privateKey,
    subject,
  };
  vapidConfigured = false;
  return configCache;
}

export function isPushConfigured(): boolean {
  return loadPushConfig().enabled;
}

/** Test hook after changing env/files. */
export function resetPushConfigCache(): void {
  configCache = null;
  vapidConfigured = false;
}

function vapidDetails(config: PushConfig): {
  subject: string;
  publicKey: string;
  privateKey: string;
} {
  if (!config.enabled || !config.publicKey || !config.privateKey) {
    throw new PushNotConfiguredError();
  }
  if (!vapidConfigured) {
    // Validates the subject + key format early. Throws on malformed keys.
    webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
    vapidConfigured = true;
  }
  return {
    subject: config.subject,
    publicKey: config.publicKey,
    privateKey: config.privateKey,
  };
}

// ---------------------------------------------------------------------------
// Endpoint validation (SSRF)
// ---------------------------------------------------------------------------

function isPrivateIpv4(hostname: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!match) return false;
  const octets = match.slice(1).map((part) => Number.parseInt(part, 10));
  if (octets.some((part) => part < 0 || part > 255)) return true;
  const [a = 0, b = 0] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 169 && b === 254) return true; // link-local / metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && octets[2] === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && octets[2] === 100) return true;
  if (a === 203 && b === 0 && octets[2] === 113) return true;
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function isPrivateIpv6(hostname: string): boolean {
  const raw = hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (!raw.includes(":")) return false;
  if (raw === "::" || raw === "::1") return true;
  if (raw.startsWith("fe8") || raw.startsWith("fe9") || raw.startsWith("fea") || raw.startsWith("feb")) {
    return true; // fe80::/10 link-local
  }
  if (raw.startsWith("fc") || raw.startsWith("fd")) return true; // unique local
  if (raw.startsWith("ff")) return true; // multicast
  if (raw.startsWith("::ffff:")) {
    // IPv4-mapped address. URL may render it as ::ffff:127.0.0.1 or as
    // ::ffff:7f00:1. Convert both to four octets before the private check.
    const tail = raw.slice("::ffff:".length);
    if (tail.includes(".")) return isPrivateIpv4(tail);
    const groups = tail.split(":");
    if (groups.length === 2) {
      const high = Number.parseInt(groups[0] ?? "", 16);
      const low = Number.parseInt(groups[1] ?? "", 16);
      if (Number.isFinite(high) && Number.isFinite(low)) {
        const octets = [
          (high >> 8) & 0xff,
          high & 0xff,
          (low >> 8) & 0xff,
          low & 0xff,
        ];
        return isPrivateIpv4(octets.join("."));
      }
    }
    return true;
  }
  return false;
}

function endpointAllowlist(): string[] {
  const raw = process.env["PUSH_ENDPOINT_ALLOWLIST"]?.trim();
  if (!raw) return DEFAULT_ENDPOINT_ALLOWLIST;
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function hostAllowed(hostname: string): boolean {
  if (process.env["PUSH_ALLOW_ANY_PUBLIC_ENDPOINT"] === "1") return true;
  return endpointAllowlist().some(
    (allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`),
  );
}

/**
 * Validate a push subscription endpoint before any network action. Returns
 * the parsed URL; throws PushEndpointError with a safe client-facing reason.
 */
export function validatePushEndpoint(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new PushEndpointError("Push endpoint is not a valid URL.");
  }
  if (url.protocol !== "https:") {
    throw new PushEndpointError("Push endpoint must use HTTPS.");
  }
  if (url.username || url.password) {
    throw new PushEndpointError("Push endpoint must not contain credentials.");
  }
  if (url.port !== "" && url.port !== "443") {
    throw new PushEndpointError("Push endpoint must use port 443.");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname) throw new PushEndpointError("Push endpoint has no host.");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".home.arpa") ||
    hostname.endsWith(".lan")
  ) {
    throw new PushEndpointError("Push endpoint host is not public.");
  }
  if (isPrivateIpv4(hostname) || isPrivateIpv6(url.hostname)) {
    throw new PushEndpointError("Push endpoint host is not public.");
  }
  if (!hostAllowed(hostname)) {
    throw new PushEndpointError(
      "Push endpoint host is not a recognised push provider.",
    );
  }
  return url;
}

// ---------------------------------------------------------------------------
// Payload / Topic
// ---------------------------------------------------------------------------

export interface PushNotificationPayload {
  title: string;
  body: string;
  url: string;
  taskId: string | null;
  /** Revision for notification actions; the SW sends it as If-Match. */
  taskRev?: number;
  deliveryId: string;
  tag?: string;
  badgeCount?: number;
  kind?: "reminder" | "digest" | "test";
}

function safeSameOriginPath(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    return "/today";
  }
  if (value.startsWith("/api/") || value === "/events" || value.startsWith("/events?")) {
    return "/today";
  }
  return value.slice(0, 512);
}

function cleanText(value: unknown, fallback: string, max: number): string {
  if (typeof value !== "string") return fallback;
  const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ").trim();
  return text ? text.slice(0, max) : fallback;
}

/**
 * Serialize and enforce the 2 KB plaintext limit. Body truncates first, then
 * title, so a long note can never make web-push reject the request.
 */
export function serializePushPayload(payload: PushNotificationPayload): string {
  let body = cleanText(payload.body, "A reminder is due.", 800);
  let title = cleanText(payload.title, "Morrow", 120);
  let attempts = 0;
  for (;;) {
    const document = JSON.stringify({
      title,
      body,
      url: safeSameOriginPath(payload.url),
      taskId: payload.taskId,
      ...(typeof payload.taskRev === "number" && Number.isFinite(payload.taskRev)
        ? { taskRev: Math.round(payload.taskRev) }
        : {}),
      deliveryId: payload.deliveryId,
      ...(payload.tag ? { tag: payload.tag.slice(0, 32) } : {}),
      ...(typeof payload.badgeCount === "number" && Number.isFinite(payload.badgeCount)
        ? { badgeCount: Math.max(0, Math.round(payload.badgeCount)) }
        : {}),
      ...(payload.kind ? { kind: payload.kind } : {}),
    });
    if (Buffer.byteLength(document, "utf8") < PUSH_MAX_PAYLOAD_BYTES) {
      return document;
    }
    attempts += 1;
    if (attempts > 24) {
      throw new RangeError("Push payload exceeds 2 KB after truncation.");
    }
    if (body.length > 24) body = body.slice(0, Math.floor(body.length * 0.7));
    else if (title.length > 12) title = title.slice(0, Math.floor(title.length * 0.7));
    else {
      title = "Morrow";
      body = "A reminder is due.";
    }
  }
}

/**
 * `Topic` is at most 32 base64url characters. Reminders to one device inside
 * the same 15-minute window share a topic, so the push service coalesces a
 * burst instead of stacking N notifications. After a downtime storm, every
 * digest to one device also shares that window's topic, surfacing one summary
 * rather than one push per task. The SW uses the same value as `tag`.
 */
export function pushTopic(...parts: Array<string | number | null | undefined>): string {
  const input = parts.map((part) => String(part ?? "")).join("\u0000");
  return crypto
    .createHash("sha256")
    .update(input, "utf8")
    .digest("base64url")
    .slice(0, 32);
}

export function batchBucket(now: Date, windowMs = BATCH_WINDOW_MS): number {
  return Math.floor(now.getTime() / windowMs);
}

function ttlFor(kind: ClaimedDelivery["kind"]): number {
  if (kind === "test") return TTL_TEST;
  if (kind === "digest") return TTL_DIGEST;
  return TTL_REMINDER;
}

function urgencyFor(priority: number, kind: ClaimedDelivery["kind"]): "high" | "normal" {
  // A reminder delivery is due now, so it gets high urgency. A digest is a
  // catch-up summary; only urgent digests jump the queue.
  if (kind === "test" || kind === "reminder") return "high";
  return priority >= 3 ? "high" : "normal";
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushTransportRequest {
  subscription: PushSubscriptionInput;
  payload: string;
  ttl: number;
  urgency: "high" | "normal";
  topic: string;
  timeoutMs: number;
}

export interface PushTransportResult {
  statusCode: number;
  headers?: Record<string, string>;
}

export interface PushTransport {
  send: (request: PushTransportRequest) => Promise<PushTransportResult>;
}

const defaultTransport: PushTransport = {
  async send(request) {
    const config = loadPushConfig();
    const result = await webpush.sendNotification(
      request.subscription,
      request.payload,
      {
        vapidDetails: vapidDetails(config),
        TTL: request.ttl,
        urgency: request.urgency,
        topic: request.topic,
        timeout: request.timeoutMs,
      },
    );
    return {
      statusCode: result.statusCode,
      headers: result.headers as unknown as Record<string, string>,
    };
  },
};

function normalizeHeaders(input: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input || typeof input !== "object") return out;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === "string") out[key.toLowerCase()] = value;
    else if (Array.isArray(value)) out[key.toLowerCase()] = value.join(", ");
  }
  return out;
}

interface PushFailure {
  statusCode?: number;
  headers: Record<string, string>;
  message: string;
  timeout: boolean;
}

function failureFromError(error: unknown): PushFailure {
  const headers = normalizeHeaders(
    (error as { headers?: unknown } | null)?.headers,
  );
  const statusCode =
    typeof (error as { statusCode?: unknown } | null)?.statusCode === "number"
      ? ((error as { statusCode: number }).statusCode)
      : undefined;
  const code = (error as { code?: unknown } | null)?.code;
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "push send failed";
  const timeout =
    code === "ETIMEDOUT" ||
    code === "ESOCKETTIMEDOUT" ||
    /timed?\s*out|timeout/i.test(message);
  return {
    statusCode,
    headers,
    message: message.slice(0, 300),
    timeout,
  };
}

function retryAfterMs(headers: Record<string, string>, now: Date): number | null {
  const raw = headers["retry-after"];
  if (!raw) return null;
  const seconds = Number.parseFloat(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(RETRY_AFTER_MAX_MS, Math.round(seconds * 1000));
  }
  const date = Date.parse(raw);
  if (Number.isFinite(date)) {
    return Math.min(
      RETRY_AFTER_MAX_MS,
      Math.max(0, date - now.getTime()),
    );
  }
  return null;
}

function backoffMs(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** exponent);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`push endpoint timed out after ${timeoutMs}ms`);
      (error as Error & { code?: string }).code = "ETIMEDOUT";
      reject(error);
    }, timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

// ---------------------------------------------------------------------------
// Delivery state changes
// ---------------------------------------------------------------------------

export interface PushDeliveryResult {
  id: string;
  status: "sent" | "retry" | "dead" | "skipped" | "stale";
  statusCode?: number;
  error?: string;
  retryAt?: string;
}

interface DeliveryContext {
  delivery: ClaimedDelivery;
  task: {
    id: string;
    title: string;
    notes: string | null;
    status: string;
    priority: number;
    all_day: number;
    missed_count: number;
    rev: number;
    deleted_at: string | null;
  };
  subscription: {
    id: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    enabled: number;
    deleted_at: string | null;
  } | null;
}

function loadDeliveryContext(
  db: BetterDb,
  delivery: ClaimedDelivery,
): DeliveryContext | null {
  const row = db
    .prepare(
      `SELECT d.*,
              t.title AS task_title, t.notes AS task_notes, t.status AS task_status,
              t.priority AS task_priority, t.all_day AS task_all_day,
              t.missed_count AS task_missed_count, t.rev AS task_rev,
              t.deleted_at AS task_deleted_at,
              s.endpoint AS sub_endpoint, s.p256dh AS sub_p256dh,
              s.auth AS sub_auth, s.enabled AS sub_enabled,
              s.deleted_at AS sub_deleted_at
       FROM deliveries d
       JOIN tasks t ON t.id = d.task_id
       LEFT JOIN push_subscriptions s ON s.id = d.subscription_id
       WHERE d.id = ?`,
    )
    .get(delivery.id) as Record<string, unknown> | undefined;
  if (!row) return null;
  const deliveryRow = row as unknown as ClaimedDelivery;
  return {
    delivery: deliveryRow,
    task: {
      id: String(row["task_id"]),
      title: String(row["task_title"] ?? "Reminder"),
      notes: (row["task_notes"] as string | null) ?? null,
      status: String(row["task_status"] ?? "open"),
      priority: Number(row["task_priority"] ?? 0),
      all_day: Number(row["task_all_day"] ?? 0),
      missed_count: Number(row["task_missed_count"] ?? 0),
      rev: Number(row["task_rev"] ?? 1),
      deleted_at: (row["task_deleted_at"] as string | null) ?? null,
    },
    subscription:
      row["sub_endpoint"] && row["sub_p256dh"] && row["sub_auth"]
        ? {
            id: String(row["subscription_id"] ?? ""),
            endpoint: String(row["sub_endpoint"]),
            p256dh: String(row["sub_p256dh"]),
            auth: String(row["sub_auth"]),
            enabled: Number(row["sub_enabled"] ?? 0),
            deleted_at: (row["sub_deleted_at"] as string | null) ?? null,
          }
        : null,
  };
}

function updateDeliveryState(
  db: BetterDb,
  delivery: ClaimedDelivery,
  opts: {
    status: "retry" | "dead" | "skipped";
    nextAttemptAt: string | null;
    statusCode?: number;
    error: string;
    now: Date;
  },
): boolean {
  const info = db
    .prepare(
      `UPDATE deliveries
       SET status = ?,
           next_attempt_at = ?,
           lease_until = NULL,
           claim_token = NULL,
           last_status = ?,
           last_error = ?,
           updated_at = ?,
           rev = rev + 1
       WHERE id = ? AND claim_token = ? AND status = 'sending'`,
    )
    .run(
      opts.status,
      opts.nextAttemptAt,
      opts.statusCode === undefined ? null : String(opts.statusCode),
      opts.error.slice(0, 500),
      toUtcIso(opts.now),
      delivery.id,
      delivery.claim_token,
    );
  return info.changes === 1;
}

export function disableSubscription(
  db: BetterDb,
  subscriptionId: string,
  reason: string,
  now: Date = new Date(),
): void {
  if (!subscriptionId) return;
  try {
    db.prepare(
      `UPDATE push_subscriptions
       SET enabled = 0, fail_count = fail_count + 1,
           updated_at = ?, rev = rev + 1
       WHERE id = ?`,
    ).run(toUtcIso(now), subscriptionId);
    db.prepare(
      `INSERT INTO activity
         (actor, action, entity_type, entity_id, after_json, summary, created_at)
       VALUES ('scheduler', 'push.subscription_disabled', 'push_subscription', ?,
               ?, ?, ?)`,
    ).run(
      subscriptionId,
      JSON.stringify({ reason: reason.slice(0, 300), enabled: false }),
      `Push subscription disabled: ${reason.slice(0, 160)}`,
      toUtcIso(now),
    );
  } catch {
    // Subscription deletion is best-effort; the delivery is already terminal.
  }
}

function recordSubscriptionFailure(
  db: BetterDb,
  subscriptionId: string,
  now: Date,
): void {
  if (!subscriptionId) return;
  try {
    db.prepare(
      `UPDATE push_subscriptions
       SET fail_count = fail_count + 1, updated_at = ?, rev = rev + 1
       WHERE id = ?`,
    ).run(toUtcIso(now), subscriptionId);
  } catch {
    // best effort
  }
}

function recordSubscriptionSuccess(
  db: BetterDb,
  subscriptionId: string,
  now: Date,
): void {
  if (!subscriptionId) return;
  try {
    db.prepare(
      `UPDATE push_subscriptions
       SET fail_count = 0, last_success_at = ?, updated_at = ?, rev = rev + 1
       WHERE id = ?`,
    ).run(toUtcIso(now), toUtcIso(now), subscriptionId);
  } catch {
    // best effort
  }
}

function payloadForContext(
  context: DeliveryContext,
  now: Date,
): PushNotificationPayload {
  const { delivery, task } = context;
  const reminderTopic = pushTopic(
    "batch",
    delivery.subscription_id,
    delivery.kind,
    batchBucket(now),
  );
  const topic =
    delivery.kind === "test"
      ? pushTopic("test", delivery.id)
      : reminderTopic;

  if (delivery.kind === "digest") {
    const missed = Math.max(1, task.missed_count);
    return {
      title: `${missed} ${missed === 1 ? "reminder" : "reminders"} while you were away`,
      body: task.title,
      url: `/tasks/${encodeURIComponent(task.id)}`,
      taskId: task.id,
      deliveryId: delivery.id,
      tag: topic,
      badgeCount: missed,
      kind: "digest",
    };
  }

  return {
    title: task.title,
    body: task.all_day === 1 ? "All-day reminder" : "Reminder due now",
    url: `/tasks/${encodeURIComponent(task.id)}`,
    taskId: task.id,
    taskRev: task.rev,
    deliveryId: delivery.id,
    tag: topic,
    badgeCount: 1,
    kind: "reminder",
  };
}

function applyFailure(
  db: BetterDb,
  delivery: ClaimedDelivery,
  context: DeliveryContext,
  failure: PushFailure,
  now: Date,
): PushDeliveryResult {
  const statusCode = failure.statusCode;
  const attempts = Math.max(1, delivery.attempts);
  const base = {
    id: delivery.id,
    statusCode,
    error: failure.message.slice(0, 300),
  };

  // Endpoint gone or not authorised: retrying can never succeed.
  if (statusCode === 404 || statusCode === 410) {
    disableSubscription(
      db,
      context.subscription?.id ?? delivery.subscription_id,
      `Push endpoint returned ${statusCode}.`,
      now,
    );
    updateDeliveryState(db, delivery, {
      status: "dead",
      nextAttemptAt: null,
      statusCode,
      error: `subscription gone (${statusCode})`,
      now,
    });
    return { ...base, status: "dead", error: `subscription gone (${statusCode})` };
  }

  if (statusCode === 401 || statusCode === 403) {
    disableSubscription(
      db,
      context.subscription?.id ?? delivery.subscription_id,
      `Push endpoint returned ${statusCode}.`,
      now,
    );
    updateDeliveryState(db, delivery, {
      status: "dead",
      nextAttemptAt: null,
      statusCode,
      error: `push authorisation failed (${statusCode})`,
      now,
    });
    return {
      ...base,
      status: "dead",
      error: `push authorisation failed (${statusCode})`,
    };
  }

  // Any other permanent 4xx (bad request, payload too large, redirect not
  // followed) is a dead letter. 429 is the one retryable HTTP failure.
  if (
    statusCode !== undefined &&
    statusCode >= 300 &&
    statusCode < 500 &&
    statusCode !== 429
  ) {
    updateDeliveryState(db, delivery, {
      status: "dead",
      nextAttemptAt: null,
      statusCode,
      error: `permanent push failure (${statusCode})`,
      now,
    });
    return {
      ...base,
      status: "dead",
      error: `permanent push failure (${statusCode})`,
    };
  }

  if (attempts >= PUSH_MAX_ATTEMPTS) {
    updateDeliveryState(db, delivery, {
      status: "dead",
      nextAttemptAt: null,
      statusCode,
      error: `five failed attempts: ${failure.message}`,
      now,
    });
    return { ...base, status: "dead", error: "five failed attempts" };
  }

  const waitMs =
    statusCode === 429
      ? (retryAfterMs(failure.headers, now) ?? RETRY_AFTER_DEFAULT_MS)
      : backoffMs(attempts);
  const retryAt = toUtcIso(new Date(now.getTime() + waitMs));
  updateDeliveryState(db, delivery, {
    status: "retry",
    nextAttemptAt: retryAt,
    statusCode,
    error: failure.message,
    now,
  });
  recordSubscriptionFailure(
    db,
    context.subscription?.id ?? delivery.subscription_id,
    now,
  );
  return { ...base, status: "retry", retryAt };
}

export interface PushSendOptions {
  now?: Date;
  transport?: PushTransport;
  config?: PushConfig;
  logger?: {
    warn: (obj: Record<string, unknown>, msg?: string) => void;
    info: (obj: Record<string, unknown>, msg?: string) => void;
  };
}

/**
 * Send one claimed delivery. Network work is outside any SQLite transaction;
 * the final state update is guarded by the claim token.
 */
export async function processDelivery(
  db: BetterDb,
  claimed: ClaimedDelivery,
  options: PushSendOptions = {},
): Promise<PushDeliveryResult> {
  const now = options.now ?? new Date();
  const config = options.config ?? loadPushConfig();
  const transport = options.transport ?? defaultTransport;

  const context = loadDeliveryContext(db, claimed);
  if (!context) {
    return { id: claimed.id, status: "skipped", error: "delivery row missing" };
  }
  if (context.task.deleted_at || context.task.status !== "open") {
    updateDeliveryState(db, claimed, {
      status: "skipped",
      nextAttemptAt: null,
      error: "task no longer open",
      now,
    });
    return { id: claimed.id, status: "skipped", error: "task no longer open" };
  }
  // Access can change between enqueue/claim and send (unshare, list delete,
  // task move). Re-check immediately before any network call.
  if (
    claimed.channel === "webpush" &&
    deliveryRecipientLostAccess(db, claimed)
  ) {
    updateDeliveryState(db, claimed, {
      status: "skipped",
      nextAttemptAt: null,
      error: "recipient no longer has task access",
      now,
    });
    return {
      id: claimed.id,
      status: "skipped",
      error: "recipient no longer has task access",
    };
  }
  // ntfy deliveries do not use a browser subscription. The channel is
  // configured in Settings; a missing config is terminal, not a retry loop.
  if (claimed.channel === "ntfy") {
    const config = readNtfyConfig(db);
    if (!config) {
      updateDeliveryState(db, claimed, {
        status: "dead",
        nextAttemptAt: null,
        error: "ntfy is not configured",
        now,
      });
      return { id: claimed.id, status: "dead", error: "ntfy is not configured" };
    }
    const payload = payloadForContext(context, now);
    const appUrl = (process.env["APP_URL"] ?? "").replace(/\/$/, "");
    const click =
      appUrl && payload.url.startsWith("/")
        ? `${appUrl}${payload.url}`
        : payload.url;
    const result = await sendNtfy(config, {
      title: payload.title,
      body: payload.body,
      tags: payload.kind === "test" ? ["white_check_mark"] : ["bell"],
      priority: payload.kind === "digest" ? 3 : 4,
      url: click,
    });
    if (result.ok) {
      const sent = markSentForPush(db, claimed, now);
      return {
        id: claimed.id,
        status: sent ? "sent" : "stale",
        statusCode: result.statusCode,
        ...(sent ? {} : { error: "claim token no longer current" }),
      };
    }
    const attempts = Math.max(1, claimed.attempts);
    if (attempts >= PUSH_MAX_ATTEMPTS) {
      updateDeliveryState(db, claimed, {
        status: "dead",
        nextAttemptAt: null,
        error: result.error ?? "ntfy failed",
        now,
      });
      return { id: claimed.id, status: "dead", error: result.error ?? "ntfy failed" };
    }
    const retryAt = toUtcIso(
      new Date(now.getTime() + backoffMs(attempts)),
    );
    updateDeliveryState(db, claimed, {
      status: "retry",
      nextAttemptAt: retryAt,
      error: result.error ?? "ntfy failed",
      now,
    });
    return {
      id: claimed.id,
      status: "retry",
      retryAt,
      error: result.error ?? "ntfy failed",
    };
  }

  if (
    !context.subscription ||
    context.subscription.enabled !== 1 ||
    context.subscription.deleted_at
  ) {
    updateDeliveryState(db, claimed, {
      status: "dead",
      nextAttemptAt: null,
      error: "push subscription missing or disabled",
      now,
    });
    return {
      id: claimed.id,
      status: "dead",
      error: "push subscription missing or disabled",
    };
  }

  try {
    validatePushEndpoint(context.subscription.endpoint);
  } catch (error) {
    disableSubscription(
      db,
      context.subscription.id,
      error instanceof Error ? error.message : "invalid endpoint",
      now,
    );
    updateDeliveryState(db, claimed, {
      status: "dead",
      nextAttemptAt: null,
      error: "invalid push endpoint",
      now,
    });
    return {
      id: claimed.id,
      status: "dead",
      error: error instanceof Error ? error.message : "invalid push endpoint",
    };
  }

  if (!config.enabled) {
    const retryAt = toUtcIso(new Date(now.getTime() + backoffMs(claimed.attempts)));
    updateDeliveryState(db, claimed, {
      status: "retry",
      nextAttemptAt: retryAt,
      error: "vapid keys not configured",
      now,
    });
    return {
      id: claimed.id,
      status: "retry",
      retryAt,
      error: "vapid keys not configured",
    };
  }

  const payload = payloadForContext(context, now);
  const serialized = serializePushPayload(payload);
  const topic = payload.tag ?? pushTopic("delivery", claimed.id);

  let result: PushTransportResult;
  try {
    result = await withTimeout(
      transport.send({
        subscription: {
          endpoint: context.subscription.endpoint,
          keys: {
            p256dh: context.subscription.p256dh,
            auth: context.subscription.auth,
          },
        },
        payload: serialized,
        ttl: ttlFor(claimed.kind),
        urgency: urgencyFor(context.task.priority, claimed.kind),
        topic,
        timeoutMs: PUSH_TIMEOUT_MS,
      }),
      PUSH_TIMEOUT_MS,
    );
  } catch (error) {
    return applyFailure(db, claimed, context, failureFromError(error), now);
  }

  if (result.statusCode >= 200 && result.statusCode < 300) {
    const sent = markSentForPush(db, claimed, now);
    if (!sent) {
      return {
        id: claimed.id,
        status: "stale",
        statusCode: result.statusCode,
        error: "claim token no longer current",
      };
    }
    recordSubscriptionSuccess(db, context.subscription.id, now);
    return { id: claimed.id, status: "sent", statusCode: result.statusCode };
  }

  return applyFailure(
    db,
    claimed,
    context,
    {
      statusCode: result.statusCode,
      headers: normalizeHeaders(result.headers),
      message: `push service responded ${result.statusCode}`,
      timeout: false,
    },
    now,
  );
}

/**
 * Local wrapper to avoid importing the scheduler's markSent at module load
 * (scheduler → push for sending). The SQL guard is identical.
 */
function markSentForPush(
  db: BetterDb,
  delivery: ClaimedDelivery,
  now: Date,
): boolean {
  const info = db
    .prepare(
      `UPDATE deliveries
       SET status = 'sent', sent_at = ?, lease_until = NULL, claim_token = NULL,
           last_status = 'sent', last_error = NULL, updated_at = ?, rev = rev + 1
       WHERE id = ? AND claim_token = ? AND status = 'sending'`,
    )
    .run(toUtcIso(now), toUtcIso(now), delivery.id, delivery.claim_token);
  return info.changes === 1;
}

/** Send a claimed batch with bounded concurrency (max 5 in flight). */
export async function sendClaimedDeliveries(
  db: BetterDb,
  claimed: ClaimedDelivery[],
  options: PushSendOptions = {},
): Promise<PushDeliveryResult[]> {
  const results: PushDeliveryResult[] = [];
  let nextIndex = 0;
  const workers = Math.min(5, Math.max(1, claimed.length));

  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= claimed.length) return;
      const delivery = claimed[index]!;
      try {
        results.push(await processDelivery(db, delivery, options));
      } catch (error) {
        results.push({
          id: delivery.id,
          status: "retry",
          error: error instanceof Error ? error.message.slice(0, 300) : "send error",
        });
        options.logger?.warn(
          { deliveryId: delivery.id, err: error instanceof Error ? error.message : String(error) },
          "push delivery failed unexpectedly",
        );
      }
    }
  }

  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

// ---------------------------------------------------------------------------
// Test push
// ---------------------------------------------------------------------------

export interface TestPushResult {
  sent: number;
  failed: number;
  disabled: number;
  errors: string[];
}

interface TestSubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * `POST /api/push/test`: TTL 0, one payload per subscription, no delivery row
 * (deliveries.task_id is NOT NULL and a test has no task). 404/410 disable the
 * subscription immediately.
 */
export async function sendTestPush(
  db: BetterDb,
  userId: string,
  options: PushSendOptions = {},
): Promise<TestPushResult> {
  const config = options.config ?? loadPushConfig();
  if (!config.enabled) throw new PushNotConfiguredError();
  const transport = options.transport ?? defaultTransport;
  const now = options.now ?? new Date();

  const subscriptions = db
    .prepare(
      `SELECT id, endpoint, p256dh, auth
       FROM push_subscriptions
       WHERE user_id = ? AND enabled = 1 AND deleted_at IS NULL
       ORDER BY created_at ASC`,
    )
    .all(userId) as TestSubscriptionRow[];

  const result: TestPushResult = {
    sent: 0,
    failed: 0,
    disabled: 0,
    errors: [],
  };
  const deliveryId = newId();
  const topic = pushTopic("test", deliveryId);
  const payload = serializePushPayload({
    title: "Morrow test",
    body: "Push is working on this device.",
    url: "/today",
    taskId: null,
    deliveryId,
    tag: topic,
    badgeCount: 1,
    kind: "test",
  });

  for (const subscription of subscriptions) {
    try {
      validatePushEndpoint(subscription.endpoint);
    } catch (error) {
      disableSubscription(db, subscription.id, "invalid endpoint", now);
      result.disabled += 1;
      result.failed += 1;
      result.errors.push(
        error instanceof Error ? error.message : "invalid endpoint",
      );
      continue;
    }
    try {
      const response = await withTimeout(
        transport.send({
          subscription: {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
          },
          payload,
          ttl: TTL_TEST,
          urgency: "high",
          topic,
          timeoutMs: PUSH_TIMEOUT_MS,
        }),
        PUSH_TIMEOUT_MS,
      );
      if (response.statusCode >= 200 && response.statusCode < 300) {
        result.sent += 1;
        recordSubscriptionSuccess(db, subscription.id, now);
      } else {
        result.failed += 1;
        result.errors.push(`push service responded ${response.statusCode}`);
        if (response.statusCode === 404 || response.statusCode === 410 || response.statusCode === 401 || response.statusCode === 403) {
          disableSubscription(db, subscription.id, `test push ${response.statusCode}`, now);
          result.disabled += 1;
        }
      }
    } catch (error) {
      const failure = failureFromError(error);
      result.failed += 1;
      result.errors.push(failure.message);
      if (
        failure.statusCode === 404 ||
        failure.statusCode === 410 ||
        failure.statusCode === 401 ||
        failure.statusCode === 403
      ) {
        disableSubscription(db, subscription.id, `test push ${failure.statusCode}`, now);
        result.disabled += 1;
      }
    }
  }

  return result;
}

export interface DirectPushResult {
  sent: number;
  failed: number;
  disabled: number;
  skipped: boolean;
}

/**
 * v0.2 briefs have no `deliveries.task_id` row. Send one payload to every
 * enabled device without inventing a synthetic task; failures still disable
 * dead subscriptions, and the caller records the result in activity.
 */
export async function sendDirectPush(
  db: BetterDb,
  userId: string,
  payload: Omit<PushNotificationPayload, "deliveryId"> & {
    deliveryId?: string;
  },
  options: PushSendOptions = {},
): Promise<DirectPushResult> {
  const config = options.config ?? loadPushConfig();
  if (!config.enabled) {
    return { sent: 0, failed: 0, disabled: 0, skipped: true };
  }
  const transport = options.transport ?? defaultTransport;
  const now = options.now ?? new Date();
  const subscriptions = db
    .prepare(
      `SELECT id, endpoint, p256dh, auth
         FROM push_subscriptions
        WHERE user_id = ? AND enabled = 1 AND deleted_at IS NULL
        ORDER BY created_at ASC`,
    )
    .all(userId) as TestSubscriptionRow[];
  const deliveryId = payload.deliveryId ?? newId();
  const serialized = serializePushPayload({
    ...payload,
    deliveryId,
    tag: payload.tag ?? pushTopic("brief", deliveryId),
  });
  const topic = pushTopic("brief", deliveryId);
  const result: DirectPushResult = {
    sent: 0,
    failed: 0,
    disabled: 0,
    skipped: subscriptions.length === 0,
  };
  for (const subscription of subscriptions) {
    try {
      validatePushEndpoint(subscription.endpoint);
      const response = await withTimeout(
        transport.send({
          subscription: {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
          },
          payload: serialized,
          ttl: TTL_DIGEST,
          urgency: "normal",
          topic,
          timeoutMs: PUSH_TIMEOUT_MS,
        }),
        PUSH_TIMEOUT_MS,
      );
      if (response.statusCode >= 200 && response.statusCode < 300) {
        result.sent += 1;
        recordSubscriptionSuccess(db, subscription.id, now);
      } else {
        result.failed += 1;
        if (
          response.statusCode === 404 ||
          response.statusCode === 410 ||
          response.statusCode === 401 ||
          response.statusCode === 403
        ) {
          disableSubscription(db, subscription.id, "brief push rejected", now);
          result.disabled += 1;
        }
      }
    } catch (error) {
      const failure = failureFromError(error);
      result.failed += 1;
      if (
        failure.statusCode === 404 ||
        failure.statusCode === 410 ||
        failure.statusCode === 401 ||
        failure.statusCode === 403
      ) {
        disableSubscription(db, subscription.id, "brief push rejected", now);
        result.disabled += 1;
      }
    }
  }
  return result;
}
