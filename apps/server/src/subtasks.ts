/**
 * Subtasks (v0.2): lightweight child checklists on a task.
 *
 * Subtasks are deliberately separate from tasks: they are not scheduled,
 * searchable, or pushed. A task owns at most 200 live subtasks, and all reads
 * verify task ownership first.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { getDb } from "@morrow/db";
import {
  initialSortKey,
  newId,
  nowIso,
  sortKeyBetween,
  uuidSchema,
} from "@morrow/shared";
import { canAccessTask } from "./access.js";
import { authenticateRequest } from "./auth.js";
import { badRequest, notFound, unauthorized } from "./errors.js";

const MAX_SUBTASKS = 200;

const createSchema = z.object({
  id: uuidSchema.optional(),
  title: z.string().trim().min(1).max(500),
  done: z.boolean().optional(),
});

const patchSchema = z
  .object({
    title: z.string().trim().min(1).max(500).optional(),
    done: z.boolean().optional(),
  })
  .refine((value) => value.title !== undefined || value.done !== undefined, {
    message: "nothing to update",
  });

interface SubtaskRow {
  id: string;
  task_id: string;
  user_id: string;
  title: string;
  done: number | boolean;
  sort_key: string;
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

function liveTask(userId: string, taskId: string): { id: string } | null {
  return canAccessTask(userId, taskId) ? { id: taskId } : null;
}

function getSubtask(userId: string, id: string): SubtaskRow | null {
  const row = getDb()
    .prepare("SELECT * FROM subtasks WHERE id = ?")
    .get(id) as SubtaskRow | undefined;
  if (!row) return null;
  return canAccessTask(userId, row.task_id) ? row : null;
}

function listForTask(userId: string, taskId: string): SubtaskRow[] {
  if (!canAccessTask(userId, taskId)) return [];
  return getDb()
    .prepare(
      `SELECT * FROM subtasks
        WHERE task_id = ? AND deleted_at IS NULL
        ORDER BY sort_key ASC, created_at ASC`,
    )
    .all(taskId) as SubtaskRow[];
}

function activity(
  userId: string,
  action: string,
  entityId: string,
  before: unknown,
  after: unknown,
  summary: string,
): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO activity
           (actor, actor_id, action, entity_type, entity_id, before_json,
            after_json, summary, created_at)
         VALUES ('user', ?, ?, 'subtask', ?, ?, ?, ?, ?)`,
      )
      .run(
        userId,
        action,
        entityId,
        JSON.stringify(before ?? null),
        JSON.stringify(after ?? null),
        summary,
        nowIso(),
      );
  } catch {
    // Best-effort audit.
  }
}

export async function registerSubtaskRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/tasks/:id/subtasks", async (req, reply) => {
    const auth = authed(req, reply);
    if (!auth) return reply;
    const taskId = (req.params as { id?: string }).id ?? "";
    if (!liveTask(auth.user.id, taskId)) return notFound(req, reply);
    return reply.send({ subtasks: listForTask(auth.user.id, taskId) });
  });

  app.post("/api/tasks/:id/subtasks", async (req, reply) => {
    const auth = authed(req, reply);
    if (!auth) return reply;
    const taskId = (req.params as { id?: string }).id ?? "";
    if (!liveTask(auth.user.id, taskId)) return notFound(req, reply);
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return badRequest(req, reply, "Invalid subtask.", "invalid_subtask");
    }
    if (parsed.data.id) {
      const existing = getSubtask(auth.user.id, parsed.data.id);
      if (existing && existing.deleted_at === null) {
        return reply
          .code(200)
          .header("idempotent-replayed", "true")
          .send(existing);
      }
    }
    const count = getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM subtasks
          WHERE task_id = ? AND deleted_at IS NULL`,
      )
      .get(taskId) as { n: number };
    if (count.n >= MAX_SUBTASKS) {
      return badRequest(
        req,
        reply,
        `A task can have at most ${MAX_SUBTASKS} subtasks.`,
        "too_many_subtasks",
      );
    }
    const last = getDb()
      .prepare(
        `SELECT sort_key FROM subtasks
          WHERE task_id = ? AND deleted_at IS NULL
          ORDER BY sort_key DESC LIMIT 1`,
      )
      .get(taskId) as { sort_key: string } | undefined;
    const now = nowIso();
    const id = parsed.data.id ?? newId();
    const sortKey = last
      ? sortKeyBetween(last.sort_key, null)
      : initialSortKey();
    getDb()
      .prepare(
        `INSERT INTO subtasks
           (id, task_id, user_id, title, done, sort_key, rev, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        id,
        taskId,
        auth.user.id,
        parsed.data.title,
        parsed.data.done ? 1 : 0,
        sortKey,
        now,
        now,
      );
    const row = getSubtask(auth.user.id, id) as SubtaskRow;
    activity(
      auth.user.id,
      "subtask.create",
      id,
      null,
      row,
      `added subtask "${row.title}"`,
    );
    return reply.code(201).send(row);
  });

  app.patch("/api/subtasks/:id", async (req, reply) => {
    const auth = authed(req, reply);
    if (!auth) return reply;
    const id = (req.params as { id?: string }).id ?? "";
    const existing = getSubtask(auth.user.id, id);
    if (!existing || existing.deleted_at !== null) return notFound(req, reply);
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) {
      return badRequest(req, reply, "Invalid subtask patch.", "invalid_subtask");
    }
    const now = nowIso();
    getDb()
      .prepare(
        `UPDATE subtasks
            SET title = ?, done = ?, rev = rev + 1, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        parsed.data.title ?? existing.title,
        parsed.data.done !== undefined
          ? parsed.data.done
            ? 1
            : 0
          : existing.done,
        now,
        id,
      );
    const row = getSubtask(auth.user.id, id) as SubtaskRow;
    activity(
      auth.user.id,
      "subtask.update",
      id,
      existing,
      row,
      `updated subtask "${row.title}"`,
    );
    return reply.send(row);
  });

  app.delete("/api/subtasks/:id", async (req, reply) => {
    const auth = authed(req, reply);
    if (!auth) return reply;
    const id = (req.params as { id?: string }).id ?? "";
    const existing = getSubtask(auth.user.id, id);
    if (!existing || existing.deleted_at !== null) return notFound(req, reply);
    const now = nowIso();
    getDb()
      .prepare(
        `UPDATE subtasks
            SET deleted_at = ?, rev = rev + 1, updated_at = ?
          WHERE id = ?`,
      )
      .run(now, now, id);
    activity(
      auth.user.id,
      "subtask.delete",
      id,
      existing,
      null,
      `deleted subtask "${existing.title}"`,
    );
    return reply.send({ ok: true, id });
  });
}
