/**
 * M1 search API (§5 contract, §11 M1).
 *
 *   GET /api/search?q=...&limit=&cursor=
 *
 * Title matches rank before notes matches, then by recency. Only the
 * caller's non-deleted task rows are ever read — no secrets leave this
 * endpoint (tasks carry no credentials; users/sessions are never touched).
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { getDb } from "@morrow/db";
import { nowIso } from "@morrow/shared";
import { TASK_ACCESS_SQL } from "./access.js";
import { authenticateRequest } from "./auth.js";
import { badRequest, unauthorized } from "./errors.js";
import type { TaskRow } from "./tasks.js";

function escapeLike(raw: string): string {
  return raw.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export async function registerSearchRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/search", async (req, reply) => {
    const auth = authenticateRequest(req);
    if (!auth) return unauthorized(req, reply);
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const query = (q["q"] ?? "").trim();
    if (query === "") {
      // An empty query is not an error for the search sheet: no results.
      return reply.send({
        items: [],
        cursor: null,
        next: null,
        hasMore: false,
        tasks: [],
        nextCursor: null,
        serverTime: nowIso(),
      });
    }
    if (query.length > 500) {
      return badRequest(req, reply, "Query too long.", "invalid_query");
    }
    let limit = Number.parseInt(q["limit"] ?? "50", 10);
    if (!Number.isSafeInteger(limit)) limit = 50;
    limit = Math.min(100, Math.max(1, limit));
    let offset = 0;
    if (q["cursor"] !== undefined && q["cursor"] !== "") {
      offset = Number.parseInt(q["cursor"] as string, 10);
      if (!Number.isSafeInteger(offset) || offset < 0) {
        return badRequest(req, reply, "Invalid cursor.", "invalid_cursor");
      }
    }

    const like = `%${escapeLike(query)}%`;
    // Search already pushes matching, title-first ordering, and the page
    // window into SQL. The leading-wildcard LIKE cannot use a B-tree index,
    // so it scans only this user's non-deleted rows; adding a full-text index
    // is a separate migration, not needed at this data size.
    const rows = getDb()
      .prepare(
        `SELECT t.* FROM tasks t
          WHERE (${TASK_ACCESS_SQL}) AND t.deleted_at IS NULL
            AND (t.title LIKE ? ESCAPE '\\' OR t.notes LIKE ? ESCAPE '\\')
          ORDER BY
            CASE WHEN t.title LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END,
            t.updated_at DESC, t.id ASC
          LIMIT ? OFFSET ?`,
      )
      .all(
        auth.user.id,
        auth.user.id,
        auth.user.id,
        like,
        like,
        like,
        limit + 1,
        offset,
      ) as TaskRow[];

    const page = rows.slice(0, limit);
    const next = rows.length > limit ? String(offset + limit) : null;
    return reply.send({
      items: page,
      cursor: next,
      next,
      hasMore: next !== null,
      tasks: page,
      nextCursor: next,
      serverTime: nowIso(),
    });
  });
}
