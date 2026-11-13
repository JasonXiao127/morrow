/**
 * Tags (v0.2): reusable labels across lists.
 *
 * Tags are user-scoped and soft-deleted. Task membership lives in
 * `task_tags`; a task can carry at most 20 tags. All writes are auth-only and
 * bump revisions so the PWA can reconcile concurrent edits.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { getDb } from "@morrow/db";
import {
  etagForRev,
  newId,
  nowIso,
  parseIfMatch,
  uuidSchema,
} from "@morrow/shared";
import { canAccessTask } from "./access.js";
import { authenticateRequest } from "./auth.js";
import {
  badRequest,
  conflict,
  notFound,
  preconditionRequired,
  unauthorized,
} from "./errors.js";

const MAX_TAGS_PER_TASK = 20;

const tagCreateSchema = z.object({
  id: uuidSchema.optional(),
  name: z.string().trim().min(1).max(80),
  color: z.string().trim().max(32).nullable().optional(),
});

const tagPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    color: z.string().trim().max(32).nullable().optional(),
  })
  .refine((value) => value.name !== undefined || value.color !== undefined, {
    message: "nothing to update",
  });

const taskTagsSchema = z.object({
  tagIds: z.array(uuidSchema).max(MAX_TAGS_PER_TASK),
});

interface TagRow {
  id: string;
  user_id: string;
  name: string;
  color: string | null;
  rev: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

function authed(req: FastifyRequest, reply: FastifyReply) {
  const auth = authenticateRequest(req);
  if (!auth) {
    unauthorized(req, reply);
    return null;
  }
  return auth;
}

function getTag(userId: string, id: string): TagRow | null {
  const row = getDb()
    .prepare("SELECT * FROM tags WHERE id = ? AND user_id = ?")
    .get(id, userId) as TagRow | undefined;
  return row ?? null;
}

function getTaskRow(userId: string, id: string): { id: string } | null {
  return canAccessTask(userId, id) ? { id } : null;
}

function liveTagsForTask(userId: string, taskId: string): TagRow[] {
  return getDb()
    .prepare(
      `SELECT tg.* FROM tags tg
         JOIN task_tags tt ON tt.tag_id = tg.id
        WHERE tt.task_id = ? AND tg.user_id = ? AND tg.deleted_at IS NULL
        ORDER BY lower(tg.name) ASC, tg.id ASC`,
    )
    .all(taskId, userId) as TagRow[];
}

function requireTagIfMatch(
  req: FastifyRequest,
  reply: FastifyReply,
  tag: TagRow,
): boolean {
  const raw = req.headers["if-match"];
  if (raw === undefined) {
    preconditionRequired(req, reply);
    return false;
  }
  const want = parseIfMatch(raw);
  if (want === null || want !== tag.rev) {
    reply
      .code(412)
      .header("content-type", "application/problem+json")
      .header("ETag", etagForRev(tag.rev))
      .send({
        type: "about:blank",
        title: "Precondition Failed",
        status: 412,
        detail: `Stale revision. Current rev is ${tag.rev}.`,
        code: "stale_revision",
      });
    return false;
  }
  return true;
}

export async function registerTagRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/tags", async (req, reply) => {
    const auth = authed(req, reply);
    if (!auth) return reply;
    const rows = getDb()
      .prepare(
        `SELECT tg.*,
                (SELECT COUNT(*) FROM task_tags tt
                   JOIN tasks t ON t.id = tt.task_id
                  WHERE tt.tag_id = tg.id AND t.deleted_at IS NULL
                    AND t.status = 'open') AS open_count
           FROM tags tg
          WHERE tg.user_id = ? AND tg.deleted_at IS NULL
          ORDER BY lower(tg.name) ASC, tg.id ASC`,
      )
      .all(auth.user.id) as Array<TagRow & { open_count: number }>;
    return reply.send({ tags: rows });
  });

  app.post("/api/tags", async (req, reply) => {
    const auth = authed(req, reply);
    if (!auth) return reply;
    const parsed = tagCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return badRequest(req, reply, "Invalid tag.", "invalid_tag");
    }
    const data = parsed.data;
    if (data.id) {
      const existing = getTag(auth.user.id, data.id);
      if (existing) {
        if (existing.deleted_at !== null) {
          return conflict(req, reply, "tombstoned", "That tag was deleted.");
        }
        return reply
          .code(200)
          .header("ETag", etagForRev(existing.rev))
          .header("idempotent-replayed", "true")
          .send(existing);
      }
    }
    const id = data.id ?? newId();
    const now = nowIso();
    try {
      getDb()
        .prepare(
          `INSERT INTO tags (id, user_id, name, color, rev, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(id, auth.user.id, data.name, data.color ?? null, now, now);
    } catch {
      return conflict(req, reply, "tag_exists", "A tag with that name already exists.");
    }
    const row = getTag(auth.user.id, id) as TagRow;
    return reply.code(201).header("ETag", etagForRev(row.rev)).send(row);
  });

  app.patch("/api/tags/:id", async (req, reply) => {
    const auth = authed(req, reply);
    if (!auth) return reply;
    const id = (req.params as { id?: string }).id ?? "";
    const existing = getTag(auth.user.id, id);
    if (!existing) return notFound(req, reply);
    if (existing.deleted_at !== null) return notFound(req, reply);
    const parsed = tagPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return badRequest(req, reply, "Invalid tag patch.", "invalid_tag");
    }
    if (!requireTagIfMatch(req, reply, existing)) return reply;
    const now = nowIso();
    try {
      getDb()
        .prepare(
          `UPDATE tags
              SET name = ?, color = ?, rev = rev + 1, updated_at = ?
            WHERE id = ? AND user_id = ?`,
        )
        .run(
          parsed.data.name ?? existing.name,
          parsed.data.color !== undefined ? parsed.data.color : existing.color,
          now,
          id,
          auth.user.id,
        );
    } catch {
      return conflict(req, reply, "tag_exists", "A tag with that name already exists.");
    }
    const row = getTag(auth.user.id, id) as TagRow;
    return reply.header("ETag", etagForRev(row.rev)).send(row);
  });

  app.delete("/api/tags/:id", async (req, reply) => {
    const auth = authed(req, reply);
    if (!auth) return reply;
    const id = (req.params as { id?: string }).id ?? "";
    const existing = getTag(auth.user.id, id);
    if (!existing) return notFound(req, reply);
    if (existing.deleted_at !== null) return notFound(req, reply);
    if (!requireTagIfMatch(req, reply, existing)) return reply;
    const now = nowIso();
    const tx = getDb().transaction(() => {
      getDb()
        .prepare(
          `UPDATE tags
              SET deleted_at = ?, rev = rev + 1, updated_at = ?
            WHERE id = ? AND user_id = ?`,
        )
        .run(now, now, id, auth.user.id);
      getDb().prepare("DELETE FROM task_tags WHERE tag_id = ?").run(id);
    });
    tx();
    return reply.send({ ok: true, id, rev: existing.rev + 1 });
  });

  app.get("/api/tasks/:id/tags", async (req, reply) => {
    const auth = authed(req, reply);
    if (!auth) return reply;
    const id = (req.params as { id?: string }).id ?? "";
    if (!getTaskRow(auth.user.id, id)) return notFound(req, reply);
    return reply.send({ tags: liveTagsForTask(auth.user.id, id) });
  });

  app.put("/api/tasks/:id/tags", async (req, reply) => {
    const auth = authed(req, reply);
    if (!auth) return reply;
    const id = (req.params as { id?: string }).id ?? "";
    if (!getTaskRow(auth.user.id, id)) return notFound(req, reply);
    const parsed = taskTagsSchema.safeParse(req.body);
    if (!parsed.success) {
      return badRequest(req, reply, "Invalid tag selection.", "invalid_tag");
    }
    const tagIds = [...new Set(parsed.data.tagIds)];
    if (tagIds.length > 0) {
      const placeholders = tagIds.map(() => "?").join(", ");
      const count = getDb()
        .prepare(
          `SELECT COUNT(*) AS n FROM tags
            WHERE user_id = ? AND deleted_at IS NULL AND id IN (${placeholders})`,
        )
        .get(auth.user.id, ...tagIds) as { n: number };
      if (count.n !== tagIds.length) {
        return badRequest(req, reply, "One or more tags are unknown.", "unknown_tag");
      }
    }
    const now = nowIso();
    const tx = getDb().transaction(() => {
      // Merge policy: a caller replaces only their own tag links on the task.
      // Other members'/owners' task_tags rows survive a shared-task tag edit.
      // The SELECT is deliberately scoped by tags.user_id, not by task owner.
      getDb()
        .prepare(
          `DELETE FROM task_tags
            WHERE task_id = ?
              AND tag_id IN (SELECT id FROM tags WHERE user_id = ?)`,
        )
        .run(id, auth.user.id);
      const insert = getDb().prepare(
        "INSERT INTO task_tags (task_id, tag_id, created_at) VALUES (?, ?, ?)",
      );
      for (const tagId of tagIds) insert.run(id, tagId, now);
    });
    tx();
    return reply.send({ tags: liveTagsForTask(auth.user.id, id) });
  });
}
