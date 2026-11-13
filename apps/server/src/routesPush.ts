/**
 * Push subscription + test endpoints (§5).
 *
 *   GET    /api/push/vapid-public-key   public VAPID key for PushManager
 *   POST   /api/push/subscriptions      upsert by endpoint_hash
 *   DELETE /api/push/subscriptions      disable/prune (soft delete)
 *   POST   /api/push/test               immediate TTL-0 test ping
 *
 * All routes require the session cookie. Endpoint URLs are validated before
 * they are stored (HTTPS + push-provider allowlist + no private hosts), so a
 * malicious subscription cannot turn the sender into an SSRF probe later.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getDb } from "@morrow/db";
import { newId, nowIso } from "@morrow/shared";
import { authenticateRequest, sha256Hex } from "./auth.js";
import { requireOwner } from "./authz.js";
import { badRequest, conflict, notFound, sendProblem, unauthorized } from "./errors.js";
import { readNtfyConfig, sendNtfy } from "./ntfy.js";
import {
  PushNotConfiguredError,
  isPushConfigured,
  loadPushConfig,
  sendTestPush,
  validatePushEndpoint,
  type TestPushResult,
} from "./push.js";
import { publishActivity } from "./sse.js";

const MAX_SUBSCRIPTIONS = 25;

const subscriptionSchema = z.object({
  endpoint: z.string().min(1).max(4096),
  keys: z.object({
    p256dh: z.string().min(1).max(512),
    auth: z.string().min(1).max(256),
  }),
});

const subscriptionBodySchema = z.union([
  z.object({
    subscription: subscriptionSchema,
    deviceLabel: z.string().max(80).optional(),
    platform: z.string().max(40).optional(),
  }),
  z
    .object({
      endpoint: z.string().min(1).max(4096),
      p256dh: z.string().min(1).max(512).optional(),
      auth: z.string().min(1).max(256).optional(),
      keys: z
        .object({
          p256dh: z.string().min(1).max(512),
          auth: z.string().min(1).max(256),
        })
        .optional(),
      deviceLabel: z.string().max(80).optional(),
      platform: z.string().max(40).optional(),
    })
    .refine((value) => Boolean(value.keys ?? (value.p256dh && value.auth)), {
      message: "p256dh and auth are required",
    }),
]);

const deleteBodySchema = z
  .object({
    endpoint: z.string().min(1).max(4096).optional(),
    id: z.string().min(1).max(64).optional(),
  })
  .refine((value) => Boolean(value.endpoint || value.id), {
    message: "endpoint or id is required",
  });

function platformFromUserAgent(userAgent: string | undefined): string {
  if (!userAgent) return "unknown";
  if (/iPad|iPhone|iPod/i.test(userAgent)) return "ios";
  if (/Android/i.test(userAgent)) return "android";
  if (/Macintosh|Mac OS X/i.test(userAgent)) return "macos";
  if (/Windows/i.test(userAgent)) return "windows";
  if (/Linux/i.test(userAgent)) return "linux";
  return "unknown";
}

function cancelPendingDeliveries(
  db: ReturnType<typeof getDb>,
  subscriptionId: string,
  now: string,
): void {
  try {
    db.prepare(
      `UPDATE deliveries
       SET status = 'skipped', next_attempt_at = NULL, claim_token = NULL,
           lease_until = NULL, last_error = 'subscription removed',
           updated_at = ?, rev = rev + 1
       WHERE subscription_id = ? AND status IN ('pending', 'retry')`,
    ).run(now, subscriptionId);
  } catch {
    // best effort
  }
}

export async function registerPushRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/push/vapid-public-key", async (req, reply) => {
    const auth = authenticateRequest(req);
    if (!auth) return unauthorized(req, reply);
    const config = loadPushConfig();
    if (!config.enabled || !config.publicKey) {
      return sendProblem(req, reply, 503, "Push Not Configured", {
        detail: "Web Push is not configured on this server.",
        code: "push_not_configured",
      });
    }
    return reply.send({ publicKey: config.publicKey, key: config.publicKey });
  });

  app.post(
    "/api/push/subscriptions",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const auth = authenticateRequest(req);
      if (!auth) return unauthorized(req, reply);

      const parsed = subscriptionBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return badRequest(req, reply, "Invalid push subscription.", "invalid_subscription");
      }
      const body = parsed.data;
      const nested = "subscription" in body ? body.subscription : null;
      const flat = "subscription" in body ? null : body;
      const endpoint = nested?.endpoint ?? flat?.endpoint ?? "";
      const p256dh = nested?.keys.p256dh ?? flat?.keys?.p256dh ?? flat?.p256dh;
      const authKey = nested?.keys.auth ?? flat?.keys?.auth ?? flat?.auth;
      if (!endpoint || !p256dh || !authKey) {
        return badRequest(req, reply, "Invalid push subscription.", "invalid_subscription");
      }

      try {
        validatePushEndpoint(endpoint);
      } catch (error) {
        return badRequest(
          req,
          reply,
          error instanceof Error ? error.message : "Invalid push endpoint.",
          "invalid_push_endpoint",
        );
      }

      const db = getDb();
      const endpointHash = sha256Hex(endpoint);
      const existing = db
        .prepare(
          `SELECT id, user_id FROM push_subscriptions WHERE endpoint_hash = ?`,
        )
        .get(endpointHash) as { id: string; user_id: string } | undefined;

      if (!existing) {
        const count = db
          .prepare(
            `SELECT COUNT(*) AS n FROM push_subscriptions
             WHERE user_id = ? AND deleted_at IS NULL`,
          )
          .get(auth.user.id) as { n: number };
        if ((count?.n ?? 0) >= MAX_SUBSCRIPTIONS) {
          return conflict(
            req,
            reply,
            "too_many_subscriptions",
            `At most ${MAX_SUBSCRIPTIONS} devices can receive push. Remove one first.`,
          );
        }
      } else if (existing.user_id !== auth.user.id) {
        return conflict(
          req,
          reply,
          "subscription_owned",
          "This push subscription belongs to another account.",
        );
      }

      const now = nowIso();
      const config = loadPushConfig();
      const id = existing?.id ?? newId();
      const deviceLabel =
        ("deviceLabel" in body ? body.deviceLabel : undefined)?.trim().slice(0, 80) ||
        null;
      const platform =
        ("platform" in body ? body.platform : undefined)?.trim().slice(0, 40) ||
        platformFromUserAgent(req.headers["user-agent"]);
      const vapidKeyId = config.publicKey
        ? sha256Hex(config.publicKey).slice(0, 16)
        : null;

      db.prepare(
        `INSERT INTO push_subscriptions
           (id, user_id, endpoint, endpoint_hash, p256dh, auth, device_label,
            platform, vapid_key_id, enabled, fail_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)
         ON CONFLICT(endpoint_hash) DO UPDATE SET
           endpoint = excluded.endpoint,
           p256dh = excluded.p256dh,
           auth = excluded.auth,
           device_label = COALESCE(excluded.device_label, push_subscriptions.device_label),
           platform = COALESCE(excluded.platform, push_subscriptions.platform),
           vapid_key_id = excluded.vapid_key_id,
           enabled = 1,
           fail_count = 0,
           deleted_at = NULL,
           updated_at = excluded.updated_at,
           rev = push_subscriptions.rev + 1`,
      ).run(
        id,
        auth.user.id,
        endpoint,
        endpointHash,
        p256dh,
        authKey,
        deviceLabel,
        platform,
        vapidKeyId,
        now,
        now,
      );

      return reply.send({ ok: true, id });
    },
  );

  app.delete("/api/push/subscriptions", async (req, reply) => {
    const auth = authenticateRequest(req);
    if (!auth) return unauthorized(req, reply);
    const parsed = deleteBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return badRequest(req, reply, "Invalid unsubscribe request.", "invalid_subscription");
    }
    const db = getDb();
    const now = nowIso();
    const row = parsed.data.endpoint
      ? (db
          .prepare(
            `SELECT id FROM push_subscriptions
             WHERE user_id = ? AND endpoint_hash = ?`,
          )
          .get(auth.user.id, sha256Hex(parsed.data.endpoint)) as
          | { id: string }
          | undefined)
      : (db
          .prepare(
            `SELECT id FROM push_subscriptions WHERE user_id = ? AND id = ?`,
          )
          .get(auth.user.id, parsed.data.id ?? "") as { id: string } | undefined);
    if (!row) return notFound(req, reply, "subscription_not_found", "Subscription not found.");

    db.prepare(
      `UPDATE push_subscriptions
       SET enabled = 0, deleted_at = ?, updated_at = ?, rev = rev + 1
       WHERE id = ? AND user_id = ?`,
    ).run(now, now, row.id, auth.user.id);
    cancelPendingDeliveries(db, row.id, now);
    return reply.send({ ok: true, id: row.id });
  });

  app.post(
    "/api/push/test",
    { config: { rateLimit: { max: 6, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const auth = authenticateRequest(req);
      if (!auth) return unauthorized(req, reply);
      if (!isPushConfigured()) {
        return sendProblem(req, reply, 503, "Push Not Configured", {
          detail: "Web Push is not configured on this server.",
          code: "push_not_configured",
        });
      }

      let result: TestPushResult;
      try {
        result = await sendTestPush(getDb(), auth.user.id);
      } catch (error) {
        if (error instanceof PushNotConfiguredError) {
          return sendProblem(req, reply, 503, "Push Not Configured", {
            detail: "Web Push is not configured on this server.",
            code: "push_not_configured",
          });
        }
        throw error;
      }

      if (result.sent + result.failed + result.disabled === 0) {
        return conflict(
          req,
          reply,
          "no_subscriptions",
          "No push devices are registered for this account.",
        );
      }

      try {
        const db = getDb();
        const now = nowIso();
        const summary =
          `Test push: ${result.sent} sent, ${result.failed} failed` +
          (result.disabled > 0 ? `, ${result.disabled} disabled` : "");
        const info = db
          .prepare(
            `INSERT INTO activity
               (actor, action, entity_type, entity_id, after_json, summary, created_at)
             VALUES ('user', 'push.test', 'user', ?, ?, ?, ?)`,
          )
          .run(
            auth.user.id,
            JSON.stringify({
              sent: result.sent,
              failed: result.failed,
              disabled: result.disabled,
            }),
            summary,
            now,
          );
        publishActivity([
          {
            seq: Number(info.lastInsertRowid),
            actor: "user",
            action: "push.test",
            entity_type: "user",
            entity_id: auth.user.id,
            after_json: JSON.stringify({
              sent: result.sent,
              failed: result.failed,
              disabled: result.disabled,
            }),
            summary,
            created_at: now,
          },
        ]);
      } catch {
        // The test result is still useful even if activity logging fails.
      }

      return reply.send({
        ok: result.sent > 0,
        sent: result.sent,
        failed: result.failed,
        disabled: result.disabled,
        ...(result.errors.length > 0 ? { errors: result.errors.slice(0, 5) } : {}),
      });
    },
  );

  // ---- POST /api/ntfy/test -------------------------------------------------
  app.post(
    "/api/ntfy/test",
    { config: { rateLimit: { max: 6, timeWindow: "1 minute" } } },
    async (req, reply) => {
      // ntfy is a workspace-global channel (single URL/topic in settings).
      const auth = requireOwner(req, reply);
      if (!auth) return reply;
      const config = readNtfyConfig(getDb());
      if (!config) {
        return sendProblem(req, reply, 503, "ntfy Not Configured", {
          detail: "Enable ntfy and set a URL and topic first.",
          code: "ntfy_not_configured",
        });
      }
      const result = await sendNtfy(config, {
        title: "Morrow test",
        body: "ntfy delivery is working.",
        tags: ["white_check_mark"],
        priority: 3,
      });
      return reply.send({
        ok: result.ok,
        statusCode: result.statusCode ?? null,
        error: result.error ?? null,
      });
    },
  );
}
