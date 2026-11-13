/**
 * App server entrypoint (M0 skeleton).
 *
 * - Fastify 5, ESM, pino with secret redaction.
 * - trustProxy: exact Caddy CIDR(s) from TRUST_PROXY only — never true/*.
 * - helmet (strict CSP per §8), cookie, rate-limit (login per IP+account
 *   bucket lives in routes.ts; a global guard applies here), compress,
 *   swagger (non-production), static PWA serving when ../web/dist exists.
 * - CSRF hook: unsafe /api* methods need Origin/Sec-Fetch-Site (§8).
 * - problem+json error envelope; no secret leakage in logs/errors.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import compress from "@fastify/compress";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import swagger from "@fastify/swagger";
import Fastify from "fastify";
import { closeDb, getDb, initSchema, migrationStatus } from "@morrow/db";
import { problem } from "@morrow/shared";
import {
  countUsers,
  ensureOwnerRole,
  initAuth,
  passesCsrf,
} from "./auth.js";
import {
  closeAssistant,
  getAssistant,
  initAssistant,
} from "./assistant.js";
import {
  deploymentUrlWarnings,
  isPublicOrigin,
  loadConfig,
} from "./config.js";
import { sendProblem } from "./errors.js";
import { buildLoggerOptions } from "./logging.js";
import {
  MAINTENANCE_RETRY_AFTER_SECONDS,
  enterWrite,
  isMaintenanceActive,
  leaveWrite,
} from "./maintenance.js";
import { startMcpServer, stopMcpServer } from "./mcp.js";
import { registerRoutes } from "./routes.js";
import { registerAssistantRoutes } from "./routesAssistant.js";
import { registerAttachmentRoutes } from "./attachments.js";
import { registerCalendarRoutes } from "./caldav.js";
import { registerCaptureTokenRoutes } from "./captureTokens.js";
import { registerPushRoutes } from "./routesPush.js";
import { registerSubtaskRoutes } from "./subtasks.js";
import { registerTagRoutes } from "./tags.js";
import { startScheduler, stopScheduler } from "./scheduler.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Every method that can mutate state must be quiesced during a live restore.
// PROPFIND/REPORT/OPTIONS are read-only; MKCALENDAR, PROPPATCH and MOVE are
// WebDAV writes and must be gated alongside the REST verbs.
const UNSAFE_METHODS = new Set([
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "MKCALENDAR",
  "PROPPATCH",
  "MOVE",
]);

function isRestoreRoute(req: { method: string; url: string }): boolean {
  return (
    req.method === "POST" &&
    req.url.split("?")[0] === "/api/backup/import"
  );
}

export async function buildApp() {
  const cfg = loadConfig();
  const app = Fastify({
    logger: buildLoggerOptions({
      level: process.env["LOG_LEVEL"] ?? "info",
    }),
    // Exact CIDR(s) only; undefined = trust no proxy.
    trustProxy: cfg.trustProxy as string | string[] | undefined,
    genReqId: () =>
      `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
  });

  // Surface deployment mismatches at boot instead of letting them look like
  // bad credentials or bad setup tokens later.
  for (const warning of deploymentUrlWarnings(
    process.env["SITE_ADDRESS"],
    cfg.appUrl,
  )) {
    app.log.warn(warning);
  }
  app.log.info({ appUrl: cfg.appUrl }, "configured public origin");

  // CalDAV uses WebDAV methods Fastify does not know by default.
  app.addHttpMethod("PROPFIND", { hasBody: true });
  app.addHttpMethod("REPORT", { hasBody: true });
  app.addHttpMethod("PROPPATCH", { hasBody: true });

  // DB ready before routes (skeleton schema; Drizzle migrations authoritative).
  initSchema(getDb());
  const dbSchema = migrationStatus(getDb());
  app.log.info(
    {
      applied: dbSchema.applied,
      bundled: dbSchema.bundled,
      pending: dbSchema.pending,
      newer: dbSchema.newer,
    },
    "database schema ready",
  );
  ensureOwnerRole();
  await initAuth();

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'"],
        "style-src": ["'self'", "'unsafe-inline'"],
        "font-src": ["'self'", "data:"],
        "object-src": ["'none'"],
        "base-uri": ["'none'"],
        "frame-ancestors": ["'none'"],
        "form-action": ["'self'"],
        "connect-src": ["'self'"],
        "img-src": ["'self'", "data:"],
        "worker-src": ["'self'"],
      },
    },
    hsts: cfg.nodeEnv === "production" ? { maxAge: 31536000 } : false,
    referrerPolicy: { policy: "no-referrer" },
  });
  await app.register(rateLimit, {
    max: cfg.nodeEnv === "production" ? 300 : 2000,
    timeWindow: "1 minute",
  });
  await app.register(compress);
  // One registration for backup import + task attachments. The per-feature
  // limits are enforced again in the handlers (attachments cap at 10 MiB).
  await app.register(multipart, {
    limits: {
      fieldNameSize: 100,
      fieldSize: 1024,
      fields: 10,
      fileSize: 25 * 1024 * 1024,
      files: 2,
      headerPairs: 20,
    },
  });
  // CalDAV clients send text/calendar and XML bodies. Keep them as strings;
  // the handlers parse only the small subset they need.
  app.addContentTypeParser(
    ["text/calendar", "application/xml", "text/xml"],
    { parseAs: "string", bodyLimit: 1024 * 1024 },
    (_req, body, done) => done(null, body),
  );
  if (cfg.nodeEnv !== "production") {
    await app.register(swagger, {
      openapi: {
        info: { title: "Morrow API", version: "0.3.0" },
      },
    });
  }

  // Static PWA: serve apps/web/dist when the web track has built it.
  const webDist = path.resolve(__dirname, "..", "..", "..", "web", "dist");
  // In dev (src/) vs prod (dist/): also try the source-relative location.
  const candidates = [
    webDist,
    path.resolve(process.cwd(), "apps", "web", "dist"),
  ];
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, "index.html"))) {
        await app.register(fastifyStatic, { root: dir, prefix: "/" });
        app.log.info({ dir }, "serving PWA static assets");
        break;
      }
    } catch {
      // ignore; API-only mode
    }
  }

  // Maintenance gate (Round 3): while a live restore swaps the DB file every
  // mutating API request gets a retryable 503. The restore route itself is
  // exempt so it can complete and clear the gate. In-flight writes are counted
  // so restore.ts can drain them before closing the singleton handle.
  const trackedWrites = new WeakSet<object>();
  app.addHook("onRequest", async (req, reply) => {
    if (isRestoreRoute(req)) return;
    const path = req.url.split("?")[0] ?? "";
    const healthProbe = path === "/healthz" || path === "/readyz";
    if (isMaintenanceActive() && !healthProbe) {
      // Reads are gated too: a GET must not reopen the DB singleton between
      // closeDb() and the atomic rename. /healthz and /readyz stay live so
      // probes and the maintenance status stay observable.
      reply.header("retry-after", String(MAINTENANCE_RETRY_AFTER_SECONDS));
      return sendProblem(req, reply, 503, "Service Unavailable", {
        detail:
          "The server is restoring its database. Retry after the maintenance window.",
        code: "maintenance",
      });
    }
    if (!UNSAFE_METHODS.has(req.method)) return;
    enterWrite();
    trackedWrites.add(req);
    const release = (): void => {
      if (!trackedWrites.delete(req)) return;
      leaveWrite();
    };
    reply.raw.once("close", release);
    (req as unknown as { __morrowReleaseWrite?: () => void }).__morrowReleaseWrite =
      release;
  });
  app.addHook("onResponse", async (req) => {
    (req as unknown as { __morrowReleaseWrite?: () => void })
      .__morrowReleaseWrite?.();
  });

  // CSRF: Origin + Sec-Fetch-Site on unsafe /api* methods (§8).
  app.addHook("onRequest", async (req, reply) => {
    if (req.url.startsWith("/api/") && !passesCsrf(req, cfg.appUrl)) {
      return sendProblem(req, reply, 403, "Forbidden", {
        detail: `This request did not come from this instance. Open Morrow at ${cfg.appUrl} and try again.`,
        code: "csrf",
      });
    }
  });

  // Never cache API responses (§8 no-store).
  app.addHook("onSend", async (req, reply, payload) => {
    if (
      req.url.startsWith("/api/") ||
      req.url === "/healthz" ||
      req.url === "/readyz"
    ) {
      if (!reply.getHeader("cache-control")) {
        reply.header("cache-control", "no-store");
      }
    }
    // @fastify/rate-limit answers before the unified error handler, so its
    // 429 body is plain JSON. The §5 contract is problem+json for every API
    // error; normalise the plugin response here (the in-house login bucket
    // already sends problem+json and is left untouched).
    if (
      reply.statusCode === 429 &&
      req.url.startsWith("/api/") &&
      typeof payload === "string" &&
      String(reply.getHeader("content-type") ?? "").includes("application/json") &&
      !String(reply.getHeader("content-type") ?? "").includes("problem+json")
    ) {
      let detail = "Too many requests. Try again later.";
      try {
        const parsed = JSON.parse(payload) as { message?: unknown };
        if (typeof parsed.message === "string" && parsed.message.trim()) {
          detail = parsed.message;
        }
      } catch {
        // keep the default detail
      }
      reply.header("content-type", "application/problem+json");
      return JSON.stringify(
        problem(429, "Too Many Requests", { detail, code: "rate_limited" }),
      );
    }
    return payload;
  });

  // Assistant routes are appended before the 404/SPA handler in routes.ts.
  const assistant = initAssistant({ db: getDb(), logger: app.log });
  await registerAssistantRoutes(app, assistant);
  app.addHook("onClose", async () => {
    closeAssistant();
  });

  // v0.2 product surfaces. These must register before routes.ts installs the
  // SPA catch-all.
  await registerTagRoutes(app);
  await registerSubtaskRoutes(app);
  await registerAttachmentRoutes(app);
  await registerCaptureTokenRoutes(app);
  await registerCalendarRoutes(app);

  await registerRoutes(app);
  // M2-PUSH-BEGIN: push subscription/test routes live in their own module so
  // M1/M3 route work stays untouched.
  await registerPushRoutes(app);
  // M2-PUSH-END

  // Unified error envelope (problem+json). Zod/validation details are
  // summarized without echoing secrets. @fastify/rate-limit 429s thrown from
  // route hooks land here (not in the onSend normaliser below, which only
  // sees plugin-direct responses): map them to the same rate_limited
  // problem shape so every throttled caller sees one contract.
  app.setErrorHandler((err, req, reply) => {
    const status =
      typeof (err as { statusCode?: unknown }).statusCode === "number" &&
      (err as { statusCode: number }).statusCode >= 400 &&
      (err as { statusCode: number }).statusCode < 600
        ? (err as { statusCode: number }).statusCode
        : 500;
    const message = err instanceof Error ? err.message : "request failed";
    const rateLimited =
      status === 429 && /rate limit exceeded/i.test(message);
    const code =
      err instanceof Error && "code" in err && typeof err.code === "string"
        ? (err.code as string)
        : rateLimited
          ? "rate_limited"
          : "request_failed";
    if (status >= 500) {
      req.log.error({ err, msg: "unhandled error" });
    }
    return sendProblem(
      req,
      reply,
      status,
      status === 500
        ? "Internal Error"
        : rateLimited
          ? "Too Many Requests"
          : "Request Failed",
      {
        detail: status === 500 ? "Unexpected error." : message,
        code: rateLimited ? "rate_limited" : code,
      },
    );
  });

  return app;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const app = await buildApp();
  // M2-SCHEDULER-BEGIN: one loop per process; the scheduler_state lease is
  // the cross-container guard. Sending is awaited inside the tick, but the
  // SQLite transactions themselves never span a network call.
  // Nightly JSON backups run here (supported path §6); the volume-level
  // backup-cron.sh is only a secondary SQLite snapshot (stopgap).
  const activityRetentionDays = Number.parseInt(
    process.env["ACTIVITY_RETENTION_DAYS"] ?? "90",
    10,
  );
  startScheduler(getDb(), {
    owner: `scheduler:${process.pid}`,
    logger: app.log,
    nightlyBackup: true,
    activityRetentionDays: Number.isFinite(activityRetentionDays)
      ? activityRetentionDays
      : 90,
  });
  app.addHook("onClose", async () => {
    stopScheduler();
  });
  // M2-SCHEDULER-END
  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    try {
      await stopMcpServer();
      await app.close();
    } finally {
      closeAssistant();
      closeDb();
    }
    process.exit(0);
  };
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => void shutdown(sig));
  }
  await app.listen({ host: cfg.host, port: cfg.port });
  try {
    if (countUsers() === 0) {
      const setupUrl = `${cfg.appUrl.replace(/\/+$/, "")}/setup`;
      if (cfg.setupMode === "open") {
        if (isPublicOrigin(cfg.appUrl)) {
          app.log.warn(
            "SETUP_MODE=open on a public address: anyone who can reach this instance can claim the owner account until setup completes. Set SETUP_MODE=token before exposing it.",
          );
        }
        app.log.info(
          `First run: open ${setupUrl} and create the owner account.`,
        );
      } else {
        app.log.info(
          `First run: open ${setupUrl} and paste the setup token (SETUP_TOKEN in .env or SECRETS_DIR/setup_token).`,
        );
      }
    }
  } catch {
    // A DB hiccup here must not stop the listener; setup itself will report.
  }
  // MCP is a separate internal listener on the agent network. It is skipped
  // when no token is configured, which keeps AI-off deployments quiet. Its
  // unauthenticated /healthz is only acceptable because startMcpServer binds
  // MCP_HOST (agent interface) or 127.0.0.1, never a wildcard by default.
  try {
    await startMcpServer({
      logger: app.log,
      emit: (event) => getAssistant().handleExternalEvent(event),
    });
  } catch (error) {
    // The MCP listener is optional. A bad port or token must never take the
    // reminder core offline.
    app.log.warn({ err: error }, "MCP listener did not start; reminders continue");
  }
}

// Only auto-listen when executed directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    // Never print secrets; err here is startup failure metadata only.
    process.stderr.write(`fatal: ${(err as Error)?.message ?? err}\n`);
    process.exit(1);
  });
}
