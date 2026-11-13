/**
 * Credential logging regression tests (Round 3).
 *
 * Two independent log paths must not persist long-lived query tokens:
 * - Fastify/pino serializes `req.url` (calendar feed / email webhook);
 * - Caddy writes access logs at the edge.
 *
 * The Caddy check is deliberately textual: `docker compose config` does not
 * validate the Caddyfile and CI may not have a Caddy binary. It pins the
 * `format filter { request>uri query { replace … } }` block that Caddy 2.5+
 * understands, and fails if someone reverts to bare `log`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  REDACTED,
  buildLoggerOptions,
  redactSensitiveQuery,
  requestLogSerializer,
} from "../src/logging.js";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

describe("Fastify request-log redaction", () => {
  it("redacts token query values while keeping the path and other params", () => {
    const url =
      "/api/calendar.ics?token=morrow_live_SECRET&view=today&access_token=abc123";
    const safe = redactSensitiveQuery(url);
    expect(safe).toContain("/api/calendar.ics?");
    expect(safe).toContain("view=today");
    expect(safe).toContain(`token=${REDACTED}`);
    expect(safe).toContain(`access_token=${REDACTED}`);
    expect(safe).not.toContain("morrow_live_SECRET");
    expect(safe).not.toContain("abc123");
  });

  it("leaves unrelated query strings untouched", () => {
    const url = "/api/tasks?view=today&limit=50";
    expect(redactSensitiveQuery(url)).toBe(url);
  });

  it("wires the sanitizer into the pino/Fastify serializer", () => {
    const options = buildLoggerOptions({ level: "info" }) as {
      serializers: { req: typeof requestLogSerializer };
      redact: { paths: string[] };
    };
    const serialized = options.serializers.req({
      id: "req_1",
      method: "GET",
      url: "/api/inbound/email?token=EMAIL-WEBHOOK-SECRET",
      ip: "203.0.113.9",
      headers: { host: "morrow.example" },
    });
    expect(JSON.stringify(serialized)).not.toContain("EMAIL-WEBHOOK-SECRET");
    expect(JSON.stringify(serialized)).toContain("[REDACTED]");
    expect(options.redact.paths).toEqual(
      expect.arrayContaining(["req.query.token", "req.headers.authorization"]),
    );
  });
});

describe("Caddy access-log redaction", () => {
  const caddyfile = fs.readFileSync(path.join(ROOT, "Caddyfile"), "utf8");

  it("uses a filter with query-token replacement instead of bare log", () => {
    expect(caddyfile).toMatch(/\blog\s*\{/);
    expect(caddyfile).toContain("format filter {");
    expect(caddyfile).toContain("request>uri query {");
    expect(caddyfile).toMatch(/replace token \[REDACTED\]/);
    expect(caddyfile).toMatch(/replace access_token \[REDACTED\]/);
    expect(caddyfile).toMatch(/replace api_key \[REDACTED\]/);
    // Bare `log` would emit request.uri with the token verbatim.
    expect(caddyfile).not.toMatch(/^\s*log\s*$/m);
  });
});
