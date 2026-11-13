/**
 * ntfy delivery (v0.2): a second notification channel for self-hosters who
 * prefer an HTTP pub/sub service over Web Push.
 *
 * Settings shape (`settings.ntfy`):
 *   { enabled: true, url: "https://ntfy.sh", topic: "morrow-…", priority: 4 }
 *
 * The optional bearer token is read from SECRETS_DIR/ntfy_token (0600) or
 * NTFY_TOKEN and is never stored in SQLite, settings responses, or backups.
 * HTTPS is required unless NTFY_ALLOW_HTTP=1 (for a trusted LAN instance).
 */
import fs from "node:fs";
import path from "node:path";
import type { BetterDb } from "@morrow/db";

export interface NtfyConfig {
  enabled: boolean;
  url: string;
  topic: string;
  priority: number;
}

export interface NtfyMessage {
  title: string;
  body: string;
  /** ntfy tag names, e.g. ["bell"]. */
  tags?: string[];
  priority?: number;
  url?: string;
}

function secretDir(): string {
  return (
    process.env["SECRETS_DIR"] ?? path.join(process.cwd(), "data", "secrets")
  );
}

export function readNtfyToken(): string | null {
  const fromEnv = process.env["NTFY_TOKEN"]?.trim();
  if (fromEnv) return fromEnv;
  try {
    const value = fs
      .readFileSync(path.join(secretDir(), "ntfy_token"), "utf8")
      .trim();
    return value || null;
  } catch {
    return null;
  }
}

function parseSetting(value: string): unknown {
  try {
    const once: unknown = JSON.parse(value);
    return typeof once === "string" ? JSON.parse(once) : once;
  } catch {
    return value;
  }
}

export function readNtfyConfig(
  db: BetterDb,
  _userId?: string,
): NtfyConfig | null {
  let row: { value: string } | undefined;
  try {
    row = db
      .prepare(
        "SELECT value FROM settings WHERE key = 'ntfy' AND deleted_at IS NULL",
      )
      .get() as { value: string } | undefined;
  } catch {
    return null;
  }
  if (!row) return null;
  const parsed = parseSetting(row.value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const value = parsed as Record<string, unknown>;
  if (value["enabled"] === false) return null;
  const url = typeof value["url"] === "string" ? value["url"].trim() : "";
  const topic = typeof value["topic"] === "string" ? value["topic"].trim() : "";
  if (!url || !topic) return null;
  const priorityRaw = Number(value["priority"] ?? 3);
  const priority =
    Number.isSafeInteger(priorityRaw) && priorityRaw >= 1 && priorityRaw <= 5
      ? priorityRaw
      : 3;
  return { enabled: true, url, topic, priority };
}

function privateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (host === "localhost" || host === "::1" || host === "0.0.0.0") return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) {
    return true;
  }
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  if (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) {
    return true;
  }
  return false;
}

function ntfyUrl(config: NtfyConfig): URL {
  let base: URL;
  try {
    base = new URL(config.url);
  } catch {
    throw new Error("ntfy URL is invalid");
  }
  const allowHttp = process.env["NTFY_ALLOW_HTTP"] === "1";
  if (base.protocol !== "https:" && !(allowHttp && base.protocol === "http:")) {
    throw new Error("ntfy URL must be HTTPS (or set NTFY_ALLOW_HTTP=1)");
  }
  if (privateHost(base.hostname) && process.env["NTFY_ALLOW_PRIVATE"] !== "1") {
    throw new Error(
      "ntfy URL points at a private host; set NTFY_ALLOW_PRIVATE=1 for a trusted LAN instance",
    );
  }
  return new URL(
    `${base.origin}${base.pathname.replace(/\/$/, "")}/${encodeURIComponent(config.topic)}`,
  );
}

export async function sendNtfy(
  config: NtfyConfig,
  message: NtfyMessage,
  options: { timeoutMs?: number } = {},
): Promise<{ ok: boolean; statusCode?: number; error?: string }> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  let url: URL;
  try {
    url = ntfyUrl(config);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "invalid ntfy URL" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  const headers: Record<string, string> = {
    Title: message.title.slice(0, 200),
    Priority: String(message.priority ?? config.priority),
    "Content-Type": "text/plain; charset=utf-8",
  };
  if (message.tags?.length) headers["Tags"] = message.tags.join(",");
  if (message.url) headers["Click"] = message.url;
  const token = readNtfyToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: message.body.slice(0, 4000),
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok) {
      return {
        ok: false,
        statusCode: response.status,
        error: `ntfy responded ${response.status}`,
      };
    }
    return { ok: true, statusCode: response.status };
  } catch (err) {
    const messageText =
      err instanceof DOMException && err.name === "AbortError"
        ? "ntfy request timed out"
        : err instanceof Error
          ? err.message
          : "ntfy request failed";
    return { ok: false, error: messageText };
  } finally {
    clearTimeout(timer);
  }
}
