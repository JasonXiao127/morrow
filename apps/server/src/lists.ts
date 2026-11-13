/**
 * M1 lists API (§5 contract, §11 M1).
 *
 *   GET    /api/lists          live lists for the user (sort_key order)
 *   POST   /api/lists          create; client UUID idempotent (tombstone → 409)
 *   PATCH  /api/lists/:id      rename/recolor; requires If-Match (428/412)
 *   DELETE /api/lists/:id      soft delete + unlink tasks; requires If-Match
 *
 * Conventions: strong `ETag: "rev-N"` on writes; every write bumps `rev`,
 * writes one `activity` row in the SAME transaction, and calls the publish
 * hook stub after commit (live SSE fan-out lands in M2). Idempotent POSTs
 * replay through the `operations` table (`Idempotency-Key` header) and
 * through the client-supplied `id`.
 */
import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getDb } from "@morrow/db";
import {
  UUID_V7_RE,
  etagForRev,
  initialSortKey,
  newId,
  nowIso,
  parseIfMatch,
  problem,
} from "@morrow/shared";
import { canAccessList } from "./access.js";
import {
  cancelPendingDeliveriesForList,
  cancelPendingDeliveriesForTaskIds,
} from "./deliveries.js";
import {
  authenticateRequest,
  getUserByUsername,
  isStepUpFresh,
} from "./auth.js";
import {
  badRequest,
  conflict,
  forbidden,
  notFound,
  preconditionRequired,
  sendProblem,
  unauthorized,
} from "./errors.js";

interface ListRow {
  id: string;
  user_id: string;
  name: string;
  color: string | null;
  icon: string | null;
  sort_key: string;
  is_inbox: number | boolean;
  created_by: string | null;
  updated_by: string | null;
  rev: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

// ---------------------------------------------------------------------------
// Local M1 helpers (self-contained: routes.ts must stay append-only, so this
// module does not import M0 route internals).
// ---------------------------------------------------------------------------

function authed(req: FastifyRequest, reply: FastifyReply) {
  const auth = authenticateRequest(req);
  if (!auth) {
    unauthorized(req, reply);
    return null;
  }
  return auth;
}

interface ConflictCurrent {
  id: string;
  rev: number;
  updatedAt: string;
  title: string;
}

function conflictCurrent(l: ListRow): ConflictCurrent {
  return {
    id: l.id,
    rev: l.rev,
    updatedAt: l.updated_at,
    title: l.name,
  };
}

/** 409/412 carry the current compact representation + strong ETag (§5). */
function sendCurrentProblem(
  req: FastifyRequest,
  reply: FastifyReply,
  status: 409 | 412,
  code: string,
  detail: string,
  current: ConflictCurrent,
): FastifyReply {
  const traceId = (req.id ?? "") as string;
  return reply
    .code(status)
    .header("content-type", "application/problem+json")
    .header("cache-control", "no-store")
    .header("ETag", etagForRev(current.rev))
    .send({
      ...problem(status, status === 409 ? "Conflict" : "Precondition Failed", {
        detail,
        code,
        ...(traceId ? { traceId } : {}),
      }),
      current,
    });
}

/** 428 when missing, 412 (+ current representation, ETag) when stale. */
function checkIfMatch(
  req: FastifyRequest,
  reply: FastifyReply,
  current: ConflictCurrent,
): boolean {
  const raw = req.headers["if-match"];
  if (raw === undefined) {
    preconditionRequired(req, reply);
    return false;
  }
  const want = parseIfMatch(raw);
  if (want === null || want !== current.rev) {
    sendCurrentProblem(
      req,
      reply,
      412,
      "stale_revision",
      `Stale revision. Current rev is ${current.rev}.`,
      current,
    );
    return false;
  }
  return true;
}

function idempotencyKey(req: FastifyRequest): string | null {
  const v = req.headers["idempotency-key"];
  if (typeof v !== "string" || v.trim() === "") return null;
  if (v.length > 128) return null;
  return v.trim();
}

function sha256Json(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function lookupOperation(opId: string): string | null {
  try {
    const row = getDb()
      .prepare("SELECT result_json FROM operations WHERE op_id = ?")
      .get(opId) as { result_json: string } | undefined;
    return row?.result_json ?? null;
  } catch {
    return null;
  }
}

/** Called inside the write transaction: rolls back with the mutation. */
function storeOperationTx(opts: {
  opId: string;
  kind: string;
  entityId: string | null;
  baseRev: number | null;
  payloadHash: string | null;
  result: unknown;
}): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO operations
         (op_id, kind, entity_id, base_rev, payload_hash, result_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.opId,
      opts.kind,
      opts.entityId,
      opts.baseRev,
      opts.payloadHash,
      JSON.stringify(opts.result),
      nowIso(),
    );
}

export interface InboxIdentityConflict {
  taskId: string;
  field: "ical_uid" | "caldav_href";
  value: string;
  existingTaskId: string;
  existingHref: string;
}

/**
 * Tasks unlinked from a deleted list fall back to their owner's virtual Inbox.
 * The per-collection unique indexes scope Inbox rows by `user_id`, so a live
 * UID/href already in that Inbox would abort the bulk UPDATE with a raw
 * SQLite 500. Detect the conflict before the transaction instead.
 *
 * The Inbox is virtual: `list_id IS NULL` plus the user's `is_inbox=1` row.
 * Both are checked so the result reflects what CalDAV clients would see.
 */
export function findInboxIdentityConflicts(
  listId: string,
  limit = 10,
): InboxIdentityConflict[] {
  const inboxScope = `(x.list_id IS NULL OR x.list_id = (
    SELECT il.id FROM lists il
     WHERE il.user_id = x.user_id AND il.is_inbox = 1
       AND il.deleted_at IS NULL
     LIMIT 1
  ))`;
  const rows = getDb()
    .prepare(
      `SELECT t.id AS task_id, 'ical_uid' AS field,
              t.ical_uid AS value, x.id AS existing_task_id,
              COALESCE(x.caldav_href, x.id || '.ics') AS existing_href
         FROM tasks t
         JOIN tasks x
           ON x.id <> t.id AND x.deleted_at IS NULL
          AND x.user_id = t.user_id AND ${inboxScope}
        WHERE t.list_id = ? AND t.deleted_at IS NULL
          AND t.ical_uid IS NOT NULL AND x.ical_uid = t.ical_uid
        UNION ALL
       SELECT t.id AS task_id, 'caldav_href' AS field,
              t.caldav_href AS value, x.id AS existing_task_id,
              COALESCE(x.caldav_href, x.id || '.ics') AS existing_href
         FROM tasks t
         JOIN tasks x
           ON x.id <> t.id AND x.deleted_at IS NULL
          AND x.user_id = t.user_id AND ${inboxScope}
        WHERE t.list_id = ? AND t.deleted_at IS NULL
          AND t.caldav_href IS NOT NULL AND x.caldav_href = t.caldav_href
        UNION ALL
       -- A base resource and an exception share one collection namespace.
       SELECT t.id AS task_id, 'caldav_href' AS field,
              t.caldav_href AS value, x.id AS existing_task_id,
              xe.caldav_href AS existing_href
         FROM tasks t
         JOIN tasks x
           ON x.id <> t.id AND x.deleted_at IS NULL
          AND x.user_id = t.user_id AND ${inboxScope}
         JOIN task_recurrence_exceptions xe
           ON xe.task_id = x.id AND xe.deleted_at IS NULL
        WHERE t.list_id = ? AND t.deleted_at IS NULL
          AND t.caldav_href IS NOT NULL AND xe.caldav_href = t.caldav_href
        UNION ALL
       SELECT t.id AS task_id, 'caldav_href' AS field,
              e.caldav_href AS value, x.id AS existing_task_id,
              COALESCE(x.caldav_href, x.id || '.ics') AS existing_href
         FROM tasks t
         JOIN task_recurrence_exceptions e
           ON e.task_id = t.id AND e.deleted_at IS NULL
         JOIN tasks x
           ON x.id <> t.id AND x.deleted_at IS NULL
          AND x.user_id = t.user_id AND ${inboxScope}
        WHERE t.list_id = ? AND t.deleted_at IS NULL
          AND x.caldav_href = e.caldav_href
        UNION ALL
       SELECT t.id AS task_id, 'caldav_href' AS field,
              e.caldav_href AS value, x.id AS existing_task_id,
              xe.caldav_href AS existing_href
         FROM tasks t
         JOIN task_recurrence_exceptions e
           ON e.task_id = t.id AND e.deleted_at IS NULL
         JOIN tasks x
           ON x.id <> t.id AND x.deleted_at IS NULL
          AND x.user_id = t.user_id AND ${inboxScope}
         JOIN task_recurrence_exceptions xe
           ON xe.task_id = x.id AND xe.deleted_at IS NULL
        WHERE t.list_id = ? AND t.deleted_at IS NULL
          AND xe.caldav_href = e.caldav_href
        LIMIT ?`,
    )
    .all(
      listId,
      listId,
      listId,
      listId,
      listId,
      Math.max(1, limit),
    ) as Array<{
    task_id: string;
    field: "ical_uid" | "caldav_href";
    value: string;
    existing_task_id: string;
    existing_href: string;
  }>;
  return rows.map((row) => ({
    taskId: row.task_id,
    field: row.field,
    value: row.value,
    existingTaskId: row.existing_task_id,
    existingHref: row.existing_href,
  }));
}

export function writeActivityTx(opts: {
  batchId: string;
  opId: string | null;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  before: unknown;
  after: unknown;
  summary: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO activity
         (batch_id, op_id, actor, actor_id, action, entity_type,
          entity_id, before_json, after_json, summary, created_at)
       VALUES (?, ?, 'user', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.batchId,
      opts.opId,
      opts.actorId,
      opts.action,
      opts.entityType,
      opts.entityId,
      JSON.stringify(opts.before ?? null),
      JSON.stringify(opts.after ?? null),
      opts.summary,
      nowIso(),
    );
}

/** M2 SSE fan-out hook. No-op until the scheduler/activity feed lands. */
function publishAfterCommit(_event: {
  type: string;
  entityKind: string;
  entityId: string;
  rev: number;
}): void {
  // M2 subscribes here and replays via Last-Event-ID; M1 stays poll/bootstrap.
}

function getList(userId: string, id: string): ListRow | null {
  const row = getDb()
    .prepare("SELECT * FROM lists WHERE id = ? AND user_id = ?")
    .get(id, userId) as ListRow | undefined;
  return row ?? null;
}

function replay(reply: FastifyReply, resultJson: string, rev: number) {
  return reply
    .code(200)
    .header("ETag", etagForRev(rev))
    .header("idempotent-replayed", "true")
    .send(JSON.parse(resultJson));
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function registerListRoutes(app: FastifyInstance): Promise<void> {
  // ---- GET /api/lists -------------------------------------------------------
  app.get("/api/lists", async (req, reply) => {
    const auth = authed(req, reply);
    if (!auth) return reply;
    const rows = getDb()
      .prepare(
        `SELECT l.*,
                CASE WHEN l.user_id = ? THEN 0 ELSE 1 END AS shared,
                u.username AS owner_username
           FROM lists l
           JOIN users u ON u.id = l.user_id
          WHERE l.deleted_at IS NULL
            AND (l.user_id = ? OR EXISTS (
              SELECT 1 FROM list_members lm
               WHERE lm.list_id = l.id AND lm.user_id = ?
            ))
          ORDER BY shared ASC, l.sort_key ASC, l.created_at ASC`,
      )
      .all(auth.user.id, auth.user.id, auth.user.id) as Array<
      ListRow & { shared: number; owner_username: string }
    >;
    return reply.send({ lists: rows });
  });

  // ---- POST /api/lists ------------------------------------------------------
  app.post("/api/lists", async (req, reply) => {
    const auth = authed(req, reply);
    if (!auth) return reply;
    const body =
      req.body !== null && typeof req.body === "object"
        ? (req.body as Record<string, unknown>)
        : null;
    if (!body) return badRequest(req, reply, "Invalid list payload.");

    const name = typeof body["name"] === "string" ? body["name"].trim() : "";
    if (name.length < 1 || name.length > 200) {
      return badRequest(req, reply, "List name must be 1–200 characters.");
    }
    const rawId = body["id"];
    if (rawId !== undefined && (typeof rawId !== "string" || !UUID_V7_RE.test(rawId))) {
      return badRequest(req, reply, "List id must be a UUIDv7 when provided.");
    }
    const color =
      typeof body["color"] === "string" && body["color"].trim() !== ""
        ? body["color"].slice(0, 32)
        : null;
    const icon =
      typeof body["icon"] === "string" && body["icon"].trim() !== ""
        ? body["icon"].slice(0, 64)
        : null;

    // Client-UUID replay: same id, live row → identical result (not a copy).
    if (rawId !== undefined) {
      const existing = getList(auth.user.id, rawId);
      if (existing) {
        if (existing.deleted_at !== null) {
          return sendCurrentProblem(
            req,
            reply,
            409,
            "tombstoned",
            "That list ID was deleted; create with a new ID.",
            conflictCurrent(existing),
          );
        }
        return reply
          .code(200)
          .header("ETag", etagForRev(existing.rev))
          .header("idempotent-replayed", "true")
          .send(existing);
      }
    }

    // Idempotency-Key replay (offline outbox retries after a dropped response).
    const key = idempotencyKey(req);
    const opId = key ? `list:create:${auth.user.id}:${key}` : null;
    if (opId) {
      const prior = lookupOperation(opId);
      if (prior) {
        try {
          const parsed = JSON.parse(prior) as { rev?: number };
          return replay(reply, prior, typeof parsed.rev === "number" ? parsed.rev : 1);
        } catch {
          // Corrupt cache entry: fall through and recreate.
        }
      }
    }

    const now = nowIso();
    const id = rawId ?? newId();
    const batchId = newId();
    const row: ListRow = {
      id,
      user_id: auth.user.id,
      name,
      color,
      icon,
      sort_key:
        typeof body["sortKey"] === "string" && body["sortKey"] !== ""
          ? body["sortKey"].slice(0, 64)
          : initialSortKey(),
      // The virtual Inbox is defined by `list_id IS NULL`; accepting a
      // client `isInbox` flag could create multiple inbox-mapped lists and
      // make the CalDAV inbox scope arbitrary.
      is_inbox: 0,
      created_by: "user",
      updated_by: "user",
      rev: 1,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };
    const tx = getDb().transaction(() => {
      getDb()
        .prepare(
          `INSERT INTO lists
             (id, user_id, name, color, icon, sort_key, is_inbox,
              created_by, updated_by, rev, created_at, updated_at, deleted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          row.id,
          row.user_id,
          row.name,
          row.color,
          row.icon,
          row.sort_key,
          row.is_inbox,
          row.created_by,
          row.updated_by,
          row.rev,
          row.created_at,
          row.updated_at,
        );
      writeActivityTx({
        batchId,
        opId: key,
        actorId: auth.user.id,
        action: "list.create",
        entityType: "list",
        entityId: id,
        before: null,
        after: row,
        summary: `created list "${name}"`,
      });
      for (const storeId of new Set(
        [opId, rawId ? `list:create:${auth.user.id}:${rawId}` : null].filter(
          (v): v is string => v !== null,
        ),
      )) {
        storeOperationTx({
          opId: storeId,
          kind: "list-create",
          entityId: id,
          baseRev: null,
          payloadHash: sha256Json({ name, color, icon }),
          result: row,
        });
      }
    });
    try {
      tx();
    } catch (err) {
      if (
        err instanceof Error &&
        /UNIQUE constraint failed/.test(err.message)
      ) {
        return sendProblem(req, reply, 409, "Conflict", {
          detail: "A list with that id already exists.",
          code: "list_exists",
        });
      }
      throw err;
    }
    publishAfterCommit({ type: "list.create", entityKind: "list", entityId: id, rev: 1 });
    return reply.code(201).header("ETag", etagForRev(1)).send(row);
  });

  // ---- PATCH /api/lists/:id ---------------------------------------------------
  app.patch("/api/lists/:id", async (req, reply) => {
    const auth = authed(req, reply);
    if (!auth) return reply;
    const id = (req.params as { id?: string }).id ?? "";
    const existing = getList(auth.user.id, id);
    if (!existing || existing.deleted_at !== null) return notFound(req, reply);

    // Idempotent retry first: a dropped 200 replays without touching If-Match.
    const key = idempotencyKey(req);
    const opId = key ? `list:patch:${auth.user.id}:${id}:${key}` : null;
    if (opId) {
      const prior = lookupOperation(opId);
      if (prior) {
        try {
          const parsed = JSON.parse(prior) as { rev?: number };
          return replay(reply, prior, typeof parsed.rev === "number" ? parsed.rev : existing.rev);
        } catch {
          // fall through
        }
      }
    }

    if (!checkIfMatch(req, reply, conflictCurrent(existing))) return reply;

    const body =
      req.body !== null && typeof req.body === "object"
        ? (req.body as Record<string, unknown>)
        : null;
    if (!body) return badRequest(req, reply, "Invalid list patch.");

    const patch: Partial<Pick<ListRow, "name" | "color" | "icon" | "sort_key">> = {};
    if (body["name"] !== undefined) {
      const name = typeof body["name"] === "string" ? body["name"].trim() : "";
      if (name.length < 1 || name.length > 200) {
        return badRequest(req, reply, "List name must be 1–200 characters.");
      }
      patch.name = name;
    }
    if (body["color"] !== undefined) {
      patch.color =
        typeof body["color"] === "string" && body["color"].trim() !== ""
          ? body["color"].slice(0, 32)
          : null;
    }
    if (body["icon"] !== undefined) {
      patch.icon =
        typeof body["icon"] === "string" && body["icon"].trim() !== ""
          ? body["icon"].slice(0, 64)
          : null;
    }
    if (body["sortKey"] !== undefined) {
      if (typeof body["sortKey"] !== "string" || body["sortKey"] === "") {
        return badRequest(req, reply, "sortKey must be a non-empty string.");
      }
      patch.sort_key = body["sortKey"].slice(0, 64);
    }
    if (Object.keys(patch).length === 0) {
      return badRequest(req, reply, "Empty list patch.");
    }

    const now = nowIso();
    const batchId = newId();
    const tx = getDb().transaction(() => {
      getDb()
        .prepare(
          `UPDATE lists
              SET name = ?, color = ?, icon = ?, sort_key = ?,
                  updated_by = 'user', rev = rev + 1, updated_at = ?
            WHERE id = ?`,
        )
        .run(
          patch.name ?? existing.name,
          patch.color !== undefined ? patch.color : existing.color,
          patch.icon !== undefined ? patch.icon : existing.icon,
          patch.sort_key ?? existing.sort_key,
          now,
          id,
        );
      const after = getList(auth.user.id, id) as ListRow;
      writeActivityTx({
        batchId,
        opId: key,
        actorId: auth.user.id,
        action: "list.update",
        entityType: "list",
        entityId: id,
        before: existing,
        after,
        summary: `updated list "${after.name}"`,
      });
      if (opId) {
        storeOperationTx({
          opId,
          kind: "list-patch",
          entityId: id,
          baseRev: existing.rev,
          payloadHash: sha256Json(patch),
          result: after,
        });
      }
    });
    tx();
    const after = getList(auth.user.id, id) as ListRow;
    publishAfterCommit({
      type: "list.update",
      entityKind: "list",
      entityId: id,
      rev: after.rev,
    });
    return reply.header("ETag", etagForRev(after.rev)).send(after);
  });

  // ---- DELETE /api/lists/:id ----------------------------------------------------
  app.delete("/api/lists/:id", async (req, reply) => {
    const auth = authed(req, reply);
    if (!auth) return reply;
    const id = (req.params as { id?: string }).id ?? "";
    const existing = getList(auth.user.id, id);
    if (!existing || existing.deleted_at !== null) return notFound(req, reply);
    if (!checkIfMatch(req, reply, conflictCurrent(existing))) return reply;

    // Unlinking members into the Inbox must not collide with a live UID/href
    // already there: the unique index would abort the transaction with a raw
    // 500. Fail closed with a typed conflict before any state changes.
    const identityConflicts = findInboxIdentityConflicts(id);
    if (identityConflicts.length > 0) {
      const conflict = identityConflicts[0] as InboxIdentityConflict;
      return sendCurrentProblem(
        req,
        reply,
        409,
        "inbox_identity_conflict",
        `Task ${conflict.taskId} uses ${conflict.field} "${conflict.value}", which is already live in the Inbox (${conflict.existingHref}). Resolve the duplicate before deleting this list.`,
        conflictCurrent(existing),
      );
    }

    const now = nowIso();
    const batchId = newId();
    const tx = getDb().transaction(() => {
      // Mirror the hard-delete FK (SET NULL): member tasks survive as inbox
      // tasks instead of pointing at a tombstone. Journal the memberships so
      // undo can restore them instead of leaving an empty list.
      const linked = getDb()
        .prepare(
          "SELECT COUNT(*) AS n FROM tasks WHERE list_id = ? AND deleted_at IS NULL",
        )
        .get(id) as { n: number };
      const memberTaskIds = (
        getDb()
          .prepare("SELECT id FROM tasks WHERE list_id = ?")
          .all(id) as Array<{ id: string }>
      ).map((task) => task.id);
      getDb()
        .prepare("UPDATE tasks SET list_id = NULL, updated_at = ? WHERE list_id = ?")
        .run(now, id);
      // Members lose access when the list is deleted; their queued reminders
      // must not be sent after the tasks fall back to the owner's Inbox.
      cancelPendingDeliveriesForTaskIds(getDb(), memberTaskIds, new Date(now));
      getDb()
        .prepare(
          `UPDATE lists
              SET deleted_at = ?, updated_by = 'user', rev = rev + 1, updated_at = ?
            WHERE id = ?`,
        )
        .run(now, now, id);
      const after = getList(auth.user.id, id) as ListRow;
      writeActivityTx({
        batchId,
        opId: null,
        actorId: auth.user.id,
        action: "list.delete",
        entityType: "list",
        entityId: id,
        before: { ...existing, memberTaskIds },
        after,
        summary: `deleted list "${existing.name}" (${linked.n} tasks unlinked)`,
      });
    });
    tx();
    const after = getList(auth.user.id, id) as ListRow;
    publishAfterCommit({
      type: "list.delete",
      entityKind: "list",
      entityId: id,
      rev: after.rev,
    });
    return reply
      .header("ETag", etagForRev(after.rev))
      .send({ ok: true, id, rev: after.rev });
  });

  // ---- GET /api/lists/:id/members -------------------------------------------
  app.get("/api/lists/:id/members", async (req, reply) => {
    const auth = authed(req, reply);
    if (!auth) return reply;
    const id = (req.params as { id?: string }).id ?? "";
    if (!canAccessList(auth.user.id, id)) return notFound(req, reply);
    const members = getDb()
      .prepare(
        `SELECT u.id, u.username, u.timezone, 'owner' AS role
           FROM lists l
           JOIN users u ON u.id = l.user_id
          WHERE l.id = ? AND l.deleted_at IS NULL
          UNION
          SELECT u.id, u.username, u.timezone, lm.role
            FROM list_members lm
            JOIN users u ON u.id = lm.user_id
           WHERE lm.list_id = ?`,
      )
      .all(id, id) as Array<{
      id: string;
      username: string;
      timezone: string;
      role: string;
    }>;
    return reply.send({ members });
  });

  // ---- POST /api/lists/:id/share (owner + step-up) ---------------------------
  app.post("/api/lists/:id/share", async (req, reply) => {
    const auth = authed(req, reply);
    if (!auth) return reply;
    const id = (req.params as { id?: string }).id ?? "";
    const existing = getList(auth.user.id, id);
    if (!existing || existing.deleted_at !== null) return notFound(req, reply);
    if (!isStepUpFresh(auth.session)) {
      return forbidden(
        req,
        reply,
        "step_up_required",
        "Confirm your password before sharing a list.",
      );
    }
    const body =
      req.body !== null && typeof req.body === "object"
        ? (req.body as Record<string, unknown>)
        : null;
    const username =
      typeof body?.["username"] === "string"
        ? body["username"].trim().toLowerCase()
        : "";
    const user = getUserByUsername(username);
    if (!user) return notFound(req, reply, "unknown_user", "No such account.");
    if (user.id === auth.user.id) {
      return conflict(req, reply, "already_owner", "You already own this list.");
    }
    const now = nowIso();
    try {
      getDb()
        .prepare(
          `INSERT INTO list_members (list_id, user_id, role, created_at)
           VALUES (?, ?, 'member', ?)`,
        )
        .run(id, user.id, now);
    } catch {
      return conflict(req, reply, "already_member", "That account already has access.");
    }
    writeActivityTx({
      batchId: newId(),
      opId: null,
      actorId: auth.user.id,
      action: "list.share",
      entityType: "list",
      entityId: id,
      before: null,
      after: { userId: user.id, username: user.username, role: "member" },
      summary: `shared list "${existing.name}" with ${user.username}`,
    });
    return reply.code(201).send({ ok: true, member: { id: user.id, username: user.username, role: "member" } });
  });

  // ---- DELETE /api/lists/:id/share/:userId ----------------------------------
  app.delete("/api/lists/:id/share/:userId", async (req, reply) => {
    const auth = authed(req, reply);
    if (!auth) return reply;
    const id = (req.params as { id?: string; userId?: string }).id ?? "";
    const userId = (req.params as { id?: string; userId?: string }).userId ?? "";
    const existing = getList(auth.user.id, id);
    if (!existing || existing.deleted_at !== null) return notFound(req, reply);
    if (!isStepUpFresh(auth.session)) {
      return forbidden(
        req,
        reply,
        "step_up_required",
        "Confirm your password before changing list access.",
      );
    }
    const member = getDb()
      .prepare(
        "SELECT role FROM list_members WHERE list_id = ? AND user_id = ?",
      )
      .get(id, userId) as { role?: string } | undefined;
    getDb()
      .prepare("DELETE FROM list_members WHERE list_id = ? AND user_id = ?")
      .run(id, userId);
    if (member) {
      // Access is checked against the now-deleted membership. Queued
      // reminders for this member become skipped before the next tick.
      cancelPendingDeliveriesForList(getDb(), id, new Date(nowIso()));
    }
    // Only a real removal is undoable; a no-op unshare must not later restore
    // a membership that never existed.
    if (member) {
      writeActivityTx({
        batchId: newId(),
        opId: null,
        actorId: auth.user.id,
        action: "list.unshare",
        entityType: "list",
        entityId: id,
        before: {
          userId,
          role: member.role === "owner" ? "owner" : "member",
        },
        after: null,
        summary: `removed access to list "${existing.name}"`,
      });
    }
    return reply.send({ ok: true });
  });
}
