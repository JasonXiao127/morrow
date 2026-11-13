/**
 * Capture tokens + quick capture (v0.2).
 *
 * Personal tokens let Shortcuts, Siri, a voice shortcut, or a browser
 * bookmark create a reminder without a session cookie. The token is shown
 * once, stored only as SHA-256, and can be revoked from Settings. This is a
 * deliberately narrow write surface: it can create one parsed task and
 * nothing else.
 */
import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { getDb } from "@morrow/db";
import {
  deriveReminder,
  initialSortKey,
  isValidTimeZone,
  newId,
  nowIso,
  uuidSchema,
} from "@morrow/shared";
import { authenticateRequest, sha256Hex } from "./auth.js";
import { parseCapture } from "./captureParse.js";
import { badRequest, forbidden, notFound, sendProblem, unauthorized } from "./errors.js";

const MAX_TOKENS = 20;

export type CaptureTokenKind = "capture" | "caldav";

const createSchema = z.object({
  id: uuidSchema.optional(),
  name: z.string().trim().min(1).max(80),
  kind: z.enum(["capture", "caldav"]).optional(),
});

const quickSchema = z.object({
  text: z.string().trim().min(1).max(2000),
  timezone: z.string().trim().max(64).optional(),
});

const emailSchema = z.object({
  subject: z.string().max(500).optional(),
  text: z.string().max(20_000).optional(),
  html: z.string().max(100_000).optional(),
  from: z.string().max(500).optional(),
  messageId: z.string().max(1000).optional(),
  message_id: z.string().max(1000).optional(),
  "message-id": z.string().max(1000).optional(),
  "Message-ID": z.string().max(1000).optional(),
  providerMessageId: z.string().max(1000).optional(),
  headers: z
    .union([z.string().max(100_000), z.record(z.string(), z.unknown())])
    .optional(),
});

interface CaptureTokenRow {
  id: string;
  user_id: string;
  name: string;
  kind: CaptureTokenKind;
  token_hash: string;
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

function tokenFromRequest(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (typeof header === "string" && /^Bearer\s+/i.test(header)) {
    return header.replace(/^Bearer\s+/i, "").trim();
  }
  const custom = req.headers["x-morrow-token"];
  return typeof custom === "string" && custom.trim() ? custom.trim() : null;
}

/** Scope tokens by purpose: capture/email never accepts a CalDAV credential. */
function tokenOwner(
  raw: string,
  kind: CaptureTokenKind = "capture",
): CaptureTokenRow | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM capture_tokens
        WHERE token_hash = ? AND kind = ? AND revoked_at IS NULL`,
    )
    .get(sha256Hex(raw), kind) as CaptureTokenRow | undefined;
  return row ?? null;
}

function authed(req: FastifyRequest, reply: FastifyReply) {
  const auth = authenticateRequest(req);
  if (!auth) {
    unauthorized(req, reply);
    return null;
  }
  return auth;
}

function publicToken(row: CaptureTokenRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

function idempotencyKey(req: FastifyRequest): string | null {
  const v = req.headers["idempotency-key"];
  if (typeof v !== "string" || v.trim() === "") return null;
  const key = v.trim();
  return key.length > 128 ? null : key;
}

/** Mailgun/SendGrid/Cloudflare style `Message-ID` extraction. */
export function providerMessageId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  const directKeys = [
    "messageId",
    "message_id",
    "message-id",
    "Message-ID",
    "Message-Id",
    "providerMessageId",
  ];
  for (const key of directKeys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const headers = record["headers"];
  if (typeof headers === "string") {
    for (const line of headers.split(/\r?\n/)) {
      const match = /^message-id\s*:\s*(.+)$/i.exec(line.trim());
      if (match?.[1]?.trim()) return match[1].trim();
    }
  } else if (headers && typeof headers === "object") {
    for (const [key, value] of Object.entries(
      headers as Record<string, unknown>,
    )) {
      if (key.toLowerCase() === "message-id") {
        if (typeof value === "string" && value.trim()) return value.trim();
        if (Array.isArray(value) && typeof value[0] === "string") {
          return value[0].trim();
        }
      }
    }
  }
  return null;
}

export class CaptureConflictError extends Error {
  readonly code = "idempotency_conflict";
  constructor() {
    super("That idempotency key was already used with a different payload.");
    this.name = "CaptureConflictError";
  }
}

export class CaptureInputError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CaptureInputError";
    this.code = code;
  }
}

interface CaptureDedupe {
  scope: "quick" | "email";
  /** Stable provider message id or caller Idempotency-Key. */
  key: string;
  /** Hash of the parsed payload so key reuse with new text fails closed. */
  payloadHash: string;
}

interface CaptureOutcome {
  task: Record<string, unknown>;
  parsed: ReturnType<typeof parseCapture>;
  replayed: boolean;
}

function captureOperationId(
  tokenId: string,
  scope: "quick" | "email",
  key: string,
): string {
  return `capture:${scope}:${tokenId}:${sha256Hex(key)}`;
}

function createCapturedTask(
  token: CaptureTokenRow,
  text: string,
  timezone: string | undefined,
  dedupe: CaptureDedupe | null,
): CaptureOutcome | null {
  const user = getDb()
    .prepare("SELECT * FROM users WHERE id = ? AND deleted_at IS NULL")
    .get(token.user_id) as
    | { id: string; timezone: string }
    | undefined;
  if (!user) return null;
  if (timezone && !isValidTimeZone(timezone)) {
    throw new CaptureInputError(
      "unknown_timezone",
      "That timezone is not a recognized IANA timezone.",
    );
  }
  const tz = timezone || user.timezone || "UTC";
  const capture = parseCapture(text, tz);
  let listId: string | null = null;
  if (capture.listName) {
    const list = getDb()
      .prepare(
        `SELECT id FROM lists
          WHERE user_id = ? AND deleted_at IS NULL
            AND lower(name) = lower(?)
          LIMIT 1`,
      )
      .get(user.id, capture.listName) as { id: string } | undefined;
    listId = list?.id ?? null;
  }
  const derived = deriveReminder({
    dueAt: capture.dueAt,
    dueDate: capture.dueDate,
    allDay: capture.allDay,
    timezone: tz,
    fallbackTimezone: tz,
    reminderTimeLocal: capture.reminderTimeLocal,
    remindOffsetMinutes: 0,
    explicitRemindAt: capture.remindAt ?? undefined,
    rrule: capture.rrule,
    dtstartLocal: capture.dtstartLocal,
  });
  const id = newId();
  const now = nowIso();
  const row = {
    id,
    user_id: user.id,
    list_id: listId,
    title: capture.title,
    notes: null,
    ical_uid: `${id}@morrow`,
    caldav_href: `${id}.ics`,
    status: "open",
    priority: capture.priority,
    due_at: capture.dueAt,
    due_date: capture.dueDate,
    all_day: capture.allDay ? 1 : 0,
    timezone: tz,
    remind_at: capture.remindAt ?? derived.remindAt,
    reminder_time_local: capture.reminderTimeLocal,
    remind_offset_minutes: 0,
    snoozed_until: null,
    dtstart_local: capture.dtstartLocal,
    next_occurrence_at: derived.nextOccurrenceAt,
    next_occurrence_local: derived.nextOccurrenceLocal,
    occurrence_seq: derived.occurrenceSeq,
    rrule: capture.rrule,
    recurrence_until_utc: null,
    recurrence_until_date: null,
    recurrence_count: null,
    wkst: null,
    recurrence_mode: "schedule",
    clamp_policy: "skip",
    series_ended_at: null,
    missed_count: 0,
    completed_at: null,
    sort_key: initialSortKey(),
    created_by: "capture-token",
    updated_by: "capture-token",
    rev: 1,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
  const opId = dedupe
    ? captureOperationId(token.id, dedupe.scope, dedupe.key)
    : null;
  const db = getDb();
  const tx = db.transaction((): CaptureOutcome => {
    if (opId && dedupe) {
      const prior = db
        .prepare(
          "SELECT result_json, payload_hash FROM operations WHERE op_id = ?",
        )
        .get(opId) as
        | { result_json: string; payload_hash: string | null }
        | undefined;
      if (prior) {
        if (prior.payload_hash && prior.payload_hash !== dedupe.payloadHash) {
          throw new CaptureConflictError();
        }
        const parsed = JSON.parse(prior.result_json) as {
          task?: Record<string, unknown>;
          parsed?: ReturnType<typeof parseCapture>;
        };
        if (parsed.task && parsed.parsed) {
          return { task: parsed.task, parsed: parsed.parsed, replayed: true };
        }
      }
    }
    db.prepare(
      `INSERT INTO tasks
         (id, user_id, list_id, title, notes, ical_uid, caldav_href,
          status, priority, due_at,
          due_date, all_day, timezone, remind_at, reminder_time_local,
          remind_offset_minutes, snoozed_until, dtstart_local,
          next_occurrence_at, next_occurrence_local, occurrence_seq, rrule,
          recurrence_until_utc, recurrence_until_date, recurrence_count,
          wkst, recurrence_mode, clamp_policy, series_ended_at,
          missed_count, completed_at, sort_key, created_by, updated_by,
          rev, created_at, updated_at, deleted_at)
       VALUES (@id, @user_id, @list_id, @title, @notes, @ical_uid,
               @caldav_href, @status, @priority,
               @due_at, @due_date, @all_day, @timezone, @remind_at,
               @reminder_time_local, @remind_offset_minutes,
               @snoozed_until, @dtstart_local, @next_occurrence_at,
               @next_occurrence_local, @occurrence_seq, @rrule,
               @recurrence_until_utc, @recurrence_until_date,
               @recurrence_count, @wkst, @recurrence_mode, @clamp_policy,
               @series_ended_at, @missed_count, @completed_at, @sort_key,
               @created_by, @updated_by, @rev, @created_at, @updated_at,
               @deleted_at)`,
    ).run(row);
    db.prepare("UPDATE capture_tokens SET last_used_at = ? WHERE id = ?").run(
      now,
      token.id,
    );
    if (opId && dedupe) {
      db.prepare(
        `INSERT OR IGNORE INTO operations
           (op_id, kind, entity_id, base_rev, payload_hash, result_json, created_at)
         VALUES (?, ?, ?, NULL, ?, ?, ?)`,
      ).run(
        opId,
        "capture",
        id,
        dedupe.payloadHash,
        JSON.stringify({ task: row, parsed: capture }),
        now,
      );
    }
    return { task: row, parsed: capture, replayed: false };
  });
  return tx();
}

export async function registerCaptureTokenRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get("/api/capture/tokens", async (req, reply) => {
    const auth = authed(req, reply);
    if (!auth) return reply;
    const rows = getDb()
      .prepare(
        `SELECT * FROM capture_tokens
          WHERE user_id = ? AND revoked_at IS NULL
          ORDER BY created_at DESC`,
      )
      .all(auth.user.id) as CaptureTokenRow[];
    return reply.send({ tokens: rows.map(publicToken) });
  });

  app.post("/api/capture/tokens", async (req, reply) => {
    const auth = authed(req, reply);
    if (!auth) return reply;
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return badRequest(req, reply, "Invalid capture token.", "invalid_token");
    }
    const count = getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM capture_tokens
          WHERE user_id = ? AND revoked_at IS NULL`,
      )
      .get(auth.user.id) as { n: number };
    if (count.n >= MAX_TOKENS) {
      return badRequest(
        req,
        reply,
        `At most ${MAX_TOKENS} capture tokens can be active.`,
        "too_many_tokens",
      );
    }
    const raw = `morrow_${crypto.randomBytes(24).toString("base64url")}`;
    const id = parsed.data.id ?? newId();
    const kind = parsed.data.kind ?? "capture";
    const now = nowIso();
    try {
      getDb()
        .prepare(
          `INSERT INTO capture_tokens
             (id, user_id, name, kind, token_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, auth.user.id, parsed.data.name, kind, sha256Hex(raw), now);
    } catch (err) {
      if (
        err instanceof Error &&
        /UNIQUE constraint failed/.test(err.message)
      ) {
        return sendProblem(req, reply, 409, "Conflict", {
          detail: "A token with that id already exists.",
          code: "token_exists",
        });
      }
      throw err;
    }
    const row = getDb()
      .prepare("SELECT * FROM capture_tokens WHERE id = ?")
      .get(id) as CaptureTokenRow;
    return reply.code(201).send({
      ...publicToken(row),
      token: raw,
      note:
        kind === "caldav"
          ? "Copy this CalDAV password now. It cannot create capture/email tasks."
          : "Copy this capture token now. It cannot be used for CalDAV.",
    });
  });

  app.delete("/api/capture/tokens/:id", async (req, reply) => {
    const auth = authed(req, reply);
    if (!auth) return reply;
    const id = (req.params as { id?: string }).id ?? "";
    const row = getDb()
      .prepare(
        "SELECT * FROM capture_tokens WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
      )
      .get(id, auth.user.id) as CaptureTokenRow | undefined;
    if (!row) return notFound(req, reply);
    getDb()
      .prepare("UPDATE capture_tokens SET revoked_at = ? WHERE id = ?")
      .run(nowIso(), id);
    return reply.send({ ok: true, id });
  });

  /**
   * Token-authenticated quick capture. Intended for Shortcuts / a voice
   * shortcut: POST { "text": "call Sam tomorrow at 9 #p2 @Work" }.
   */
  app.post(
    "/api/capture/quick",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const raw = tokenFromRequest(req);
      if (!raw) {
        return unauthorized(
          req,
          reply,
          "missing_token",
          "Send Authorization: Bearer <capture token>.",
        );
      }
      const token = tokenOwner(raw, "capture");
      if (!token) {
        return unauthorized(req, reply, "invalid_token", "Invalid capture token.");
      }
      const parsed = quickSchema.safeParse(req.body);
      if (!parsed.success) {
        return badRequest(req, reply, "Invalid quick capture.", "invalid_capture");
      }
      const key = idempotencyKey(req);
      const dedupe = key
        ? {
            scope: "quick" as const,
            key,
            payloadHash: sha256Hex(
              JSON.stringify({
                text: parsed.data.text,
                timezone: parsed.data.timezone ?? null,
              }),
            ),
          }
        : null;
      let result: CaptureOutcome | null;
      try {
        result = createCapturedTask(
          token,
          parsed.data.text,
          parsed.data.timezone,
          dedupe,
        );
      } catch (error) {
        if (error instanceof CaptureConflictError) {
          return sendProblem(req, reply, 409, "Conflict", {
            detail: error.message,
            code: error.code,
          });
        }
        if (error instanceof CaptureInputError) {
          return badRequest(req, reply, error.message, error.code);
        }
        throw error;
      }
      if (!result) return unauthorized(req, reply);
      const response = reply.code(result.replayed ? 200 : 201);
      if (result.replayed) response.header("idempotent-replayed", "true");
      return response.send({ task: result.task, parsed: result.parsed });
    },
  );

  /**
   * Inbound email webhook (Mailgun/SendGrid/Cloudflare Email Workers or any
   * service that can POST JSON). The subject becomes the reminder title and
   * the body is parsed for dates/lists/priority, so "Dentist tomorrow 9am"
   * in a subject works without a separate UI.
   */
  app.post(
    "/api/inbound/email",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const query = req.query as { token?: string } | undefined;
      const raw = query?.token?.trim() || tokenFromRequest(req);
      if (!raw) {
        return unauthorized(
          req,
          reply,
          "missing_token",
          "Send ?token=<capture token> or Authorization: Bearer <token>.",
        );
      }
      const token = tokenOwner(raw, "capture");
      if (!token) return unauthorized(req, reply, "invalid_token", "Invalid capture token.");
      const parsed = emailSchema.safeParse(req.body);
      if (!parsed.success) {
        return badRequest(req, reply, "Invalid email payload.", "invalid_email");
      }
      const allowed = (process.env["EMAIL_ALLOWED_FROM"] ?? "")
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean);
      if (allowed.length > 0) {
        const from = parsed.data.from?.trim().toLowerCase() ?? "";
        // Fail closed: when the allowlist is configured, a payload without a
        // sender does not get a pass.
        if (!from || !allowed.includes(from)) {
          return forbidden(
            req,
            reply,
            "email_sender_not_allowed",
            "That sender is not in EMAIL_ALLOWED_FROM.",
          );
        }
      }
      const plain = parsed.data.text?.trim() ?? "";
      const htmlText = parsed.data.html
        ? parsed.data.html
            .replace(/<style[\s\S]*?<\/style>/gi, " ")
            .replace(/<script[\s\S]*?<\/script>/gi, " ")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
        : "";
      const body = [parsed.data.subject, plain || htmlText]
        .filter((value) => value && value.trim() !== "")
        .join("\n")
        .slice(0, 2000);
      if (!body) {
        return badRequest(req, reply, "Email had no subject or body.", "empty_email");
      }
      // Provider retries reuse Message-ID (Mailgun/SendGrid) or, for generic
      // senders, the caller can send Idempotency-Key. A missing id has no safe
      // dedupe key: two genuinely identical emails may be intentional.
      const dedupeKey =
        providerMessageId(parsed.data) ?? idempotencyKey(req);
      const dedupe = dedupeKey
        ? {
            scope: "email" as const,
            key: dedupeKey,
            payloadHash: sha256Hex(
              JSON.stringify({
                subject: parsed.data.subject ?? null,
                body,
                from: parsed.data.from ?? null,
              }),
            ),
          }
        : null;
      let result: CaptureOutcome | null;
      try {
        result = createCapturedTask(token, body, undefined, dedupe);
      } catch (error) {
        if (error instanceof CaptureConflictError) {
          return sendProblem(req, reply, 409, "Conflict", {
            detail: error.message,
            code: error.code,
          });
        }
        throw error;
      }
      if (!result) return unauthorized(req, reply);
      const response = reply.code(result.replayed ? 200 : 201);
      if (result.replayed) response.header("idempotent-replayed", "true");
      return response.send({ task: result.task, parsed: result.parsed });
    },
  );
}
