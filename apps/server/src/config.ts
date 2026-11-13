/**
 * Server runtime config (env-driven, §8 + §10).
 *
 * Secrets are read from files under SECRETS_DIR (0600) when present,
 * falling back to env vars for local dev. Never log resolved secrets.
 */
import fs from "node:fs";
import path from "node:path";

function readFileSecret(dir: string, name: string): string | null {
  try {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (!st.isFile()) return null;
    // Warn (not fail) when permissions are wider than 0600.
    // init-env.sh creates 0600 files; operators should preserve that.
    // eslint-disable-next-line no-bitwise
    if ((st.mode & 0o177) !== 0) {
      process.stderr.write(
        `[config] warning: secret file ${p} has mode ${(
          st.mode & 0o777
        ).toString(8)}; expected 0600\n`,
      );
    }
    return fs.readFileSync(p, "utf8").trim() || null;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw err;
  }
}

function readSecret(envKey: string, fileName: string, secretsDir: string): string | null {
  const fromFile = readFileSecret(secretsDir, fileName);
  if (fromFile) return fromFile;
  const v = process.env[envKey];
  return v && v.trim() !== "" ? v.trim() : null;
}

function parsePort(v: string | undefined, fallback: number): number {
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isSafeInteger(n) || n <= 0 || n > 65535) {
    throw new Error(`invalid PORT: ${v}`);
  }
  return n;
}

export interface ServerConfig {
  host: string;
  port: number;
  databasePath: string;
  secretsDir: string;
  /** Exact Caddy CIDR(s), e.g. "10.89.0.0/24" or "10.89.0.2/32,10.89.0.3/32". Never true/*. */
  trustProxy: string | string[] | undefined;
  appUrl: string;
  isSecureCookies: boolean;
  /**
   * open: first visitor claims the owner account (default, LAN/Tailscale).
   * token: setup requires SETUP_TOKEN (internet-facing deployments).
   */
  setupMode: "open" | "token";
  setupToken: string | null;
  setupTokenFile: string;
  vapidPublicKey: string | null;
  opencodeUrl: string | null;
  readyzToken: string | null;
  sessionIdleSeconds: number;
  sessionAbsoluteSeconds: number;
  stepUpSeconds: number;
  nodeEnv: string;
}

let cached: ServerConfig | null = null;

/** Load + validate config. Throws on invalid TRUST_PROXY / PORT. */
export function loadConfig(): ServerConfig {
  if (cached) return cached;
  const secretsDir =
    process.env["SECRETS_DIR"] ?? path.join(process.cwd(), "data", "secrets");
  const host = process.env["HOST"] ?? "0.0.0.0";
  const port = parsePort(process.env["PORT"], 3000);
  const nodeEnv = process.env["NODE_ENV"] ?? "development";
  const appUrl = process.env["APP_URL"] ?? `http://localhost:${port}`;

  // trustProxy: exact CIDR/IP only. Comma-separated list allowed.
  // Empty = do not trust any proxy (direct LAN/dev).
  const rawProxy = (process.env["TRUST_PROXY"] ?? "").trim();
  let trustProxy: string | string[] | undefined;
  if (rawProxy !== "") {
    if (rawProxy === "true" || rawProxy === "*" || rawProxy === "0.0.0.0/0") {
      throw new Error(
        "refusing to start: TRUST_PROXY must be exact Caddy CIDR(s), never true/*",
      );
    }
    const parts = rawProxy
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const cidrRe = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/;
    const v6Re = /^[0-9a-fA-F:]+(\/\d{1,3})?$/;
    for (const p of parts) {
      if (!cidrRe.test(p) && !v6Re.test(p)) {
        throw new Error(`invalid TRUST_PROXY entry: ${p}`);
      }
    }
    trustProxy = parts.length === 1 ? parts[0] : parts;
  }

  const rawSetupMode = (process.env["SETUP_MODE"] ?? "open")
    .trim()
    .toLowerCase();
  if (rawSetupMode !== "open" && rawSetupMode !== "token") {
    throw new Error(`invalid SETUP_MODE: ${rawSetupMode} (use open or token)`);
  }
  const setupMode: "open" | "token" = rawSetupMode;

  const setupToken =
    readSecret("SETUP_TOKEN", "setup_token", secretsDir) ?? null;
  if (setupMode === "token" && !setupToken) {
    throw new Error(
      "SETUP_MODE=token requires SETUP_TOKEN in .env or SECRETS_DIR/setup_token",
    );
  }
  const vapidPublicKey =
    readSecret("VAPID_PUBLIC_KEY", "vapid_public_key", secretsDir) ??
    process.env["VAPID_PUBLIC_KEY"] ??
    null;
  const readyzToken =
    readSecret("READYZ_TOKEN", "readyz_token", secretsDir) ?? null;
  const opencodeUrl = process.env["OPENCODE_URL"] ?? null;
  const isSecureCookies =
    appUrl.startsWith("https://") || nodeEnv === "production";

  cached = {
    host,
    port,
    databasePath:
      process.env["DATABASE_PATH"] ??
      path.join(process.cwd(), "data", "morrow.db"),
    secretsDir,
    trustProxy,
    appUrl,
    isSecureCookies,
    setupMode,
    setupToken,
    setupTokenFile: path.join(secretsDir, "setup_token"),
    vapidPublicKey,
    opencodeUrl,
    readyzToken,
    sessionIdleSeconds: 7 * 24 * 3600,
    sessionAbsoluteSeconds: 30 * 24 * 3600,
    stepUpSeconds: 10 * 60,
    nodeEnv,
  };
  return cached;
}

/**
 * Warnings for a SITE_ADDRESS / APP_URL pair that cannot be the same origin.
 * Missets are not fatal (same-origin requests still work, and the manifest,
 * CalDAV hrefs, and Web Push click URLs are relative) but absolute links and
 * the default VAPID subject would point at the wrong URL.
 */
export function deploymentUrlWarnings(
  siteAddress: string | undefined,
  appUrl: string,
): string[] {
  const warnings: string[] = [];
  let app: URL;
  try {
    app = new URL(appUrl);
  } catch {
    return [`APP_URL is not a valid absolute URL: ${appUrl}`];
  }
  if (app.protocol !== "http:" && app.protocol !== "https:") {
    warnings.push(`APP_URL must use http:// or https:// (got ${appUrl}).`);
  }
  if (app.pathname !== "/" || app.search !== "" || app.hash !== "") {
    warnings.push(
      `APP_URL must be a bare origin without a path, query, or fragment (got ${appUrl}).`,
    );
  }
  if (appUrl.endsWith("/")) {
    warnings.push(`APP_URL should not end with a slash (got ${appUrl}).`);
  }

  const site = siteAddress?.trim();
  if (!site) return warnings;
  if (site.startsWith("/")) {
    warnings.push(
      `SITE_ADDRESS must be ":<port>", "http(s)://…", or a hostname (got ${site}).`,
    );
    return warnings;
  }

  // A bare :port is plain HTTP (except Caddy's TLS port); a hostname makes
  // Caddy use automatic HTTPS.
  let expectedScheme: "http:" | "https:" = site.startsWith(":")
    ? site === ":443"
      ? "https:"
      : "http:"
    : "https:";
  let siteHost: string | null = null;
  if (!site.startsWith(":")) {
    try {
      const parsed = new URL(
        site.startsWith("http://") || site.startsWith("https://")
          ? site
          : `https://${site}`,
      );
      expectedScheme = parsed.protocol === "http:" ? "http:" : "https:";
      siteHost = parsed.host;
    } catch {
      warnings.push(`SITE_ADDRESS is not a valid host or URL: ${site}.`);
      return warnings;
    }
  }

  if (app.protocol !== expectedScheme) {
    warnings.push(
      `APP_URL uses ${app.protocol.slice(0, -1)} but SITE_ADDRESS=${site} serves ${expectedScheme.slice(0, -1)}. Set APP_URL to the exact browser origin.`,
    );
  }
  if (siteHost && app.host !== siteHost) {
    warnings.push(
      `APP_URL host (${app.host}) does not match SITE_ADDRESS (${siteHost}). Absolute links and the default VAPID subject will point at the wrong host.`,
    );
  }
  return warnings;
}

/**
 * True when APP_URL names an address that is not obviously local/private.
 * Used only to warn about an open first-run claim on a public address; it is
 * not an access control (a DNS name can resolve anywhere).
 */
export function isPublicOrigin(appUrl: string): boolean {
  let host: string;
  try {
    host = new URL(appUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (
    host === "localhost" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".home.arpa")
  ) {
    return false;
  }
  if (/^127\./.test(host)) return false;
  if (/^10\./.test(host)) return false;
  if (/^192\.168\./.test(host)) return false;
  const rfc1918 = /^172\.(\d{1,3})\./.exec(host);
  if (rfc1918) {
    const second = Number(rfc1918[1]);
    if (second >= 16 && second <= 31) return false;
  }
  if (/^169\.254\./.test(host)) return false;
  const cgnat = /^100\.(\d{1,3})\./.exec(host);
  if (cgnat) {
    const second = Number(cgnat[1]);
    if (second >= 64 && second <= 127) return false;
  }
  if (/^f[cd][0-9a-f]{0,2}:/.test(host)) return false; // IPv6 ULA
  if (/^fe80:/.test(host)) return false; // IPv6 link-local
  return true;
}

/** Test hook: reset memoized config (e.g. after changing env in tests). */
export function resetConfigCache(): void {
  cached = null;
}
