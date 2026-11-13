/**
 * Transport-header contract (plan §8 web, §10 deployment).
 *
 * The app CSP and the Caddy edge CSP are two copies of one policy. This file
 * pins both so a change in either place fails here instead of shipping a
 * stricter app or a weaker edge. HSTS is TLS-edge-only in development; the
 * app adds it only when NODE_ENV=production. API/probe responses are never
 * cacheable. COOP is sent on http too, but browsers only enforce it on a
 * potentially trustworthy origin (https, or localhost) — see the note below.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PASSWORD = "supersecretpw01";
const SETUP_TOKEN = "headers-test-token";

/**
 * Exact CSP the app must send (§8 web). Directive order is helmet's output
 * order; the Caddyfile uses the same policy with `; ` separators.
 * Deliberately absent: upgrade-insecure-requests (it would rewrite the
 * APP_URL and break plain-http development and LAN setups).
 */
const EXPECTED_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "worker-src 'self'",
].join(";");

let buildApp!: () => Promise<FastifyInstance>;
let apps: FastifyInstance[] = [];

beforeAll(async () => {
  process.env["NODE_ENV"] = "development";
  process.env["APP_URL"] = "http://127.0.0.1:4581";
  ({ buildApp } = await import("../src/index.js"));
});

afterAll(async () => {
  for (const app of apps) {
    try {
      await app.close();
    } catch {
      // ignore teardown errors
    }
  }
  apps = [];
  const { closeDb } = await import("@morrow/db");
  closeDb();
});

/** Fresh app + temp DB. Each app gets its own config cache and SQLite file. */
async function freshApp(
  env: Record<string, string> = {},
): Promise<FastifyInstance> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-headers-"));
  const { closeDb } = await import("@morrow/db");
  closeDb();
  const { resetConfigCache } = await import("../src/config.js");
  resetConfigCache();
  process.env["DATABASE_PATH"] = path.join(dir, "morrow.db");
  process.env["SECRETS_DIR"] = path.join(dir, "secrets");
  process.env["SETUP_TOKEN"] = SETUP_TOKEN;
  process.env["NODE_ENV"] = "development";
  process.env["APP_URL"] = "http://127.0.0.1:4581";
  fs.mkdirSync(process.env["SECRETS_DIR"], { recursive: true });
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value;
  }
  const app = await buildApp();
  apps.push(app);
  return app;
}

function cookieFrom(res: {
  headers: Record<string, unknown>;
}): string {
  const setCookie = res.headers["set-cookie"];
  const first = Array.isArray(setCookie) ? setCookie[0] : String(setCookie);
  return String(first).split(";")[0]!;
}

async function setup(app: FastifyInstance): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/setup",
    payload: { token: SETUP_TOKEN, password: PASSWORD, timezone: "UTC" },
  });
  expect(res.statusCode).toBe(201);
  return cookieFrom(res as unknown as { headers: Record<string, unknown> });
}

function cspDirectives(policy: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of policy.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [name, ...values] = trimmed.split(/\s+/);
    if (!name) continue;
    out.set(name, values.join(" "));
  }
  return out;
}

describe("CSP", () => {
  it("serves the exact app CSP and never adds upgrade-insecure-requests", async () => {
    const app = await freshApp();
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);

    const csp = String(res.headers["content-security-policy"] ?? "");
    expect(csp).toBe(EXPECTED_CSP);
    expect(csp).not.toContain("upgrade-insecure-requests");

    const directives = cspDirectives(csp);
    expect([...directives.keys()]).toEqual([
      "default-src",
      "script-src",
      "style-src",
      "font-src",
      "object-src",
      "base-uri",
      "frame-ancestors",
      "form-action",
      "connect-src",
      "img-src",
      "worker-src",
    ]);
  });

  it("Caddyfile CSP is exactly the app CSP (directive parity)", async () => {
    const app = await freshApp();
    const appCsp = String(
      (await app.inject({ method: "GET", url: "/healthz" })).headers[
        "content-security-policy"
      ] ?? "",
    );

    const caddyfile = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "..", "Caddyfile"),
      "utf8",
    );
    const line = caddyfile
      .split("\n")
      .find((entry) => entry.includes("Content-Security-Policy"));
    expect(line, "Caddyfile must set Content-Security-Policy").toBeDefined();
    const quoted = /"([^"]+)"/.exec(line!);
    expect(quoted, "CSP must be a quoted Caddy header value").not.toBeNull();
    const caddyCsp = quoted![1]!;

    expect(caddyCsp).not.toContain("upgrade-insecure-requests");
    expect(cspDirectives(caddyCsp)).toEqual(cspDirectives(appCsp));
    // Same values, not just the same directive names.
    expect(caddyCsp.replace(/;\s+/g, ";")).toBe(EXPECTED_CSP);
  });
});

describe("HSTS", () => {
  it("is absent from the app on http/development", async () => {
    const app = await freshApp();
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.headers["strict-transport-security"]).toBeUndefined();
    // Caddy owns HSTS at the TLS edge (see Caddyfile); the app must not
    // advertise it for a deployment that may not be HTTPS.
  });

  it("is present only when NODE_ENV=production", async () => {
    const app = await freshApp({
      NODE_ENV: "production",
      APP_URL: "https://morrow.example.com",
    });
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["strict-transport-security"]).toBe(
      "max-age=31536000; includeSubDomains",
    );
  });
});

describe("cache rules", () => {
  it("sets no-store on every /api response, including errors", async () => {
    const app = await freshApp();
    const cookie = await setup(app);

    const bootstrap = await app.inject({
      method: "GET",
      url: "/api/bootstrap",
      headers: { cookie },
    });
    expect(bootstrap.statusCode).toBe(200);
    expect(bootstrap.headers["cache-control"]).toBe("no-store");

    const missing = await app.inject({
      method: "GET",
      url: "/api/not-a-route",
      headers: { cookie },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers["cache-control"]).toBe("no-store");
  });

  it("sets no-store on /healthz and /readyz", async () => {
    const app = await freshApp();
    for (const url of ["/healthz", "/readyz"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers["cache-control"], url).toBe("no-store");
    }
  });

  it("reports the applied schema watermark on /readyz", async () => {
    const app = await freshApp();
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      schema?: {
        applied: number | null;
        bundled: number | null;
        pending: number;
        newer: boolean;
      };
    };
    expect(body.schema).toBeTruthy();
    expect(body.schema?.applied).toBe(body.schema?.bundled);
    expect(body.schema?.pending).toBe(0);
    expect(body.schema?.newer).toBe(false);
  });
});

describe("COOP", () => {
  it("sends Cross-Origin-Opener-Policy: same-origin on http", async () => {
    const app = await freshApp();
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.headers["cross-origin-opener-policy"]).toBe("same-origin");
    // Note: browsers only honour COOP on a potentially trustworthy origin
    // (https, or http://localhost). On a plain-http LAN origin the header is
    // inert; it is not an auth/CSRF control. SameSite=Strict + Origin checks
    // remain the actual browser protections, and TLS (RUNBOOK) is required
    // for service workers/push anyway.
  });
});
