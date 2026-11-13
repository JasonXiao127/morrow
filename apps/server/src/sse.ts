/**
 * Server-Sent Events for the activity feed (§5 / §7).
 *
 * Wire contract:
 *   data: {"v":1,"id":"123","type":"reminder.enqueued","at":"…",
 *          "entity":{"kind":"task","id":"…","rev":4},"data":{…}}
 *
 * - `reply.hijack()` + `text/event-stream`, `Cache-Control: no-cache,
 *   no-transform`, `X-Accel-Buffering: no` (Caddy needs `flush_interval -1`
 *   and compression excluded for this content type).
 * - Heartbeat comment every 20s (inside the plan's 15–25s window).
 * - `Last-Event-ID` (or `?lastEventId=`) replays `activity` rows in seq order;
 *   without it we start at the current MAX(seq) and send only a hello cursor.
 * - A 1s DB catch-up poll runs alongside the in-process publish bus. The bus
 *   gives immediate delivery for scheduler writes; the poll guarantees that
 *   activity written by other code (including future M1 routes) reaches
 *   clients even when it does not know about the bus. `lastSeq` dedupes both.
 * - Writes go through `reply.raw.write()` so Node frames chunked encoding
 *   itself. Never write to the socket directly.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ServerResponse } from "node:http";
import { getDb } from "@morrow/db";
import { nowIso } from "@morrow/shared";
import { sendProblem } from "./errors.js";
import { TASK_ACCESS_SQL } from "./access.js";

const HEARTBEAT_MS = 20_000;
const POLL_MS = 1_000;
const REPLAY_BATCH = 200;
const REPLAY_MAX = 5_000;

export interface ActivityEventRow {
  seq: number;
  batch_id?: string | null;
  actor?: string | null;
  actor_id?: string | null;
  action: string;
  entity_type?: string | null;
  entity_id?: string | null;
  before_json?: string | null;
  after_json?: string | null;
  summary?: string | null;
  created_at: string;
}

interface SseEnvelope {
  v: 1;
  id: string;
  type: string;
  at: string;
  entity: { kind: string; id: string; rev: number };
  data: unknown;
}

interface SseClient {
  lastSeq: number;
  userId: string | null;
  send: (row: ActivityEventRow) => void;
  close: () => void;
}

/**
 * Multi-account isolation. Activity rows do not carry a target user, so the
 * stream scopes user actions by actor_id and scheduler/system actions by the
 * entity they touched. A row that cannot be attributed is not broadcast.
 */
function activityVisibleTo(row: ActivityEventRow, userId: string): boolean {
  if (row.actor_id === userId) return true;
  const db = getDb();
  try {
    if (row.entity_type === "task" && row.entity_id) {
      const task = db
        .prepare(
          `SELECT 1 AS ok FROM tasks t
            WHERE t.id = ? AND (${TASK_ACCESS_SQL})`,
        )
        .get(row.entity_id, userId, userId, userId) as
        | { ok: number }
        | undefined;
      return Boolean(task);
    }
    if (row.entity_type === "list" && row.entity_id) {
      const list = db
        .prepare(
          `SELECT 1 AS ok FROM lists l
            WHERE l.id = ? AND (l.user_id = ? OR EXISTS (
              SELECT 1 FROM list_members lm
               WHERE lm.list_id = l.id AND lm.user_id = ?
            ))`,
        )
        .get(row.entity_id, userId, userId) as { ok: number } | undefined;
      return Boolean(list);
    }
    if (row.entity_type === "delivery" && row.entity_id) {
      const delivery = db
        .prepare(
          `SELECT 1 AS ok FROM deliveries d
             JOIN tasks t ON t.id = d.task_id
            WHERE d.id = ? AND (${TASK_ACCESS_SQL})`,
        )
        .get(row.entity_id, userId, userId, userId) as
        | { ok: number }
        | undefined;
      return Boolean(delivery);
    }
    if (row.entity_type === "subtask" && row.entity_id) {
      const subtask = db
        .prepare(
          `SELECT 1 AS ok FROM subtasks s
             JOIN tasks t ON t.id = s.task_id
            WHERE s.id = ? AND (${TASK_ACCESS_SQL})`,
        )
        .get(row.entity_id, userId, userId, userId) as
        | { ok: number }
        | undefined;
      return Boolean(subtask);
    }
    if (row.entity_type === "attachment" && row.entity_id) {
      const attachment = db
        .prepare(
          `SELECT 1 AS ok FROM attachments a
             JOIN tasks t ON t.id = a.task_id
            WHERE a.id = ? AND (${TASK_ACCESS_SQL})`,
        )
        .get(row.entity_id, userId, userId, userId) as
        | { ok: number }
        | undefined;
      return Boolean(attachment);
    }
    if (row.entity_type === "tag" && row.entity_id) {
      const tag = db
        .prepare("SELECT 1 AS ok FROM tags WHERE id = ? AND user_id = ?")
        .get(row.entity_id, userId) as { ok: number } | undefined;
      return Boolean(tag);
    }
    if (row.entity_type === "brief") {
      return row.actor_id === userId;
    }
  } catch {
    return false;
  }
  return false;
}

const clients = new Set<SseClient>();

function parseJson(value: string | null | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function numericRev(value: unknown): number {
  if (value && typeof value === "object" && "rev" in value) {
    const rev = (value as { rev?: unknown }).rev;
    if (typeof rev === "number" && Number.isFinite(rev)) return Math.max(0, rev);
  }
  return 0;
}

/** SSE envelope for one `activity` row (§5). */
export function activityEnvelope(row: ActivityEventRow): SseEnvelope {
  const after = parseJson(row.after_json);
  const before = parseJson(row.before_json);
  return {
    v: 1,
    id: String(row.seq),
    type: row.action,
    at: row.created_at,
    entity: {
      kind: row.entity_type ?? "activity",
      id: row.entity_id ?? String(row.seq),
      rev: numericRev(after),
    },
    data: {
      ...(row.actor ? { actor: row.actor } : {}),
      ...(row.summary ? { summary: row.summary } : {}),
      before,
      after,
    },
  };
}

/**
 * Publish rows committed by the scheduler (or any other in-process writer).
 * Rows are silently ignored for clients that already received them from the
 * catch-up poll, which keeps the at-least-once bus harmless.
 */
export function publishActivity(rows: ActivityEventRow[]): void {
  if (rows.length === 0) return;
  for (const client of clients) {
    for (const row of rows) {
      if (row.seq <= client.lastSeq) continue;
      if (client.userId && !activityVisibleTo(row, client.userId)) continue;
      try {
        client.send(row);
        client.lastSeq = row.seq;
      } catch {
        // A dead socket will be cleaned up by its close handler.
      }
    }
  }
}

export function connectedSseClients(): number {
  return clients.size;
}

/**
 * After a restore the activity seq space can jump backwards or be wholly
 * replaced. Existing streams hold a `Last-Event-ID` from the old database, so
 * close them: clients reconnect without a stale cursor and bootstrap against
 * the new DB. This is deliberately a hard close rather than a synthetic event
 * (the old cursor is no longer meaningful).
 */
export function invalidateSseClients(): number {
  const count = clients.size;
  for (const client of [...clients]) {
    try {
      client.close();
    } catch {
      clients.delete(client);
    }
  }
  clients.clear();
  sseUserCounts.clear();
  return count;
}

/**
 * SSE connection caps (DoS hardening). Streams are long-lived: without a
 * ceiling, one account (or a botnet of sessions) can pin the event loop and
 * starve the scheduler tick. The per-user cap returns 429 (the caller holds
 * its fair share); a saturated server returns 503 (transient, retryable).
 *
 * Tunables: SSE_MAX_CONNECTIONS (global, default 100),
 * SSE_MAX_CONNECTIONS_PER_USER (default 10). Zero disables that class
 * entirely (useful for tests that force the full path).
 */
export function sseConnectionLimits(
  env: NodeJS.ProcessEnv = process.env,
): { maxTotal: number; maxPerUser: number } {
  const parse = (raw: string | undefined, fallback: number): number => {
    if (raw === undefined || raw.trim() === "") return fallback;
    const n = Number.parseInt(raw.trim(), 10);
    return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
  };
  return {
    maxTotal: parse(env["SSE_MAX_CONNECTIONS"], 100),
    maxPerUser: parse(env["SSE_MAX_CONNECTIONS_PER_USER"], 10),
  };
}

const sseUserCounts = new Map<string, number>();

export function sseUserConnectionCount(userId: string): number {
  return sseUserCounts.get(userId) ?? 0;
}

export function tryAcquireSseSlot(
  userId: string,
  env: NodeJS.ProcessEnv = process.env,
): { ok: true } | { ok: false; code: "user_full" | "global_full" } {
  const { maxTotal, maxPerUser } = sseConnectionLimits(env);
  if (sseUserConnectionCount(userId) >= maxPerUser) {
    return { ok: false, code: "user_full" };
  }
  if (clients.size >= maxTotal) {
    return { ok: false, code: "global_full" };
  }
  sseUserCounts.set(userId, sseUserConnectionCount(userId) + 1);
  return { ok: true };
}

export function releaseSseSlot(userId: string): void {
  const current = sseUserConnectionCount(userId);
  if (current <= 1) sseUserCounts.delete(userId);
  else sseUserCounts.set(userId, current - 1);
}

/** Test hook: drop all slot bookkeeping (clients are tracked per-socket). */
export function resetSseSlots(): void {
  sseUserCounts.clear();
}

function writeRaw(res: ServerResponse, chunk: string): void {
  res.write(chunk);
}

function formatActivity(row: ActivityEventRow): string {
  // No `event:` line: EventSource's default `message` listener receives every
  // activity envelope. `hello` uses a named event so it is easy to ignore.
  return `id: ${row.seq}\ndata: ${JSON.stringify(activityEnvelope(row))}\n\n`;
}

function formatHello(cursor: number): string {
  // The `id:` line makes EventSource remember the cursor even when no actual
  // activity arrived before a reconnect, so the next automatic reconnect
  // sends Last-Event-ID and cannot skip events created during the gap.
  return `id: ${cursor}\nevent: hello\ndata: ${JSON.stringify({
    v: 1,
    at: nowIso(),
    cursor,
    heartbeatMs: HEARTBEAT_MS,
  })}\n\n`;
}

function readLastEventId(req: FastifyRequest): number | null {
  const header = req.headers["last-event-id"];
  const rawHeader = Array.isArray(header) ? header[0] : header;
  const query = (req.query as { lastEventId?: unknown } | undefined)
    ?.lastEventId;
  const raw = rawHeader ?? (typeof query === "string" ? query : undefined);
  if (!raw) return null;
  const value = Number.parseInt(String(raw), 10);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function loadActivityRows(
  since: number,
  limit = REPLAY_BATCH,
): ActivityEventRow[] {
  return getDb()
    .prepare(
      `SELECT seq, batch_id, actor, actor_id, action, entity_type, entity_id,
              before_json, after_json, summary, created_at
       FROM activity WHERE seq > ? ORDER BY seq ASC LIMIT ?`,
    )
    .all(since, limit) as ActivityEventRow[];
}

function maxActivitySeq(): number {
  try {
    const row = getDb()
      .prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM activity")
      .get() as { m: number };
    return row?.m ?? 0;
  } catch {
    return 0;
  }
}

export async function sseHandler(
  req: FastifyRequest,
  reply: FastifyReply,
  options: { userId?: string } = {},
): Promise<void> {
  const slotUser = options.userId ?? "anonymous";
  const acquired = tryAcquireSseSlot(slotUser);
  if (!acquired.ok) {
    // No hijack: answer with problem+json before the stream starts.
    if (acquired.code === "user_full") {
      sendProblem(req, reply, 429, "Too Many Requests", {
        detail: "Too many live event streams for this account. Close a tab and retry.",
        code: "rate_limited",
      });
      return;
    }
    reply.header("retry-after", "30");
    sendProblem(req, reply, 503, "Service Unavailable", {
      detail: "The event stream is saturated. Retry shortly.",
      code: "server_busy",
    });
    return;
  }
  reply.hijack();
  const res = reply.raw;

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    // Caddy/compression must not buffer this stream. `identity` is a harmless
    // belt-and-braces hint if an upstream proxy honours it.
    "content-encoding": "identity",
  });
  try {
    res.flushHeaders?.();
  } catch {
    // ignore
  }
  try {
    req.raw.socket?.setNoDelay(true);
    req.raw.socket?.setTimeout(0);
  } catch {
    // Best-effort socket tuning.
  }

  let closed = false;
  let lastSeq = 0;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;

  const client: SseClient = {
    lastSeq: 0,
    userId: options.userId ?? null,
    send: (row) => {
      if (closed) return;
      try {
        writeRaw(res, formatActivity(row));
        // Keep the poll cursor in sync with the publish bus; otherwise the
        // 1s catch-up poll would emit the same row a second time.
        lastSeq = Math.max(lastSeq, row.seq);
      } catch {
        close();
      }
    },
    close: () => close(),
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    if (poll) clearInterval(poll);
    clients.delete(client);
    releaseSseSlot(slotUser);
    try {
      res.end();
    } catch {
      // already closed
    }
  };

  const onClose = (): void => close();
  // IncomingMessage 'close' fires when the request stream completes (right
  // after headers for a GET), not when the connection drops. Listen on the
  // socket and the response instead so the stream stays open.
  const socket = req.raw.socket;
  socket?.on("close", onClose);
  socket?.on("error", onClose);
  res.on("close", onClose);
  res.on("error", onClose);

  res.write("retry: 3000\n\n");

  // Replay after Last-Event-ID, or start at the current cursor on a fresh
  // connection (bootstrap already fetched the full snapshot).
  const requested = readLastEventId(req);
  lastSeq = requested ?? maxActivitySeq();
  client.lastSeq = lastSeq;
  writeRaw(res, formatHello(lastSeq));

  if (requested !== null) {
    let replayed = 0;
    try {
      let rows = loadActivityRows(lastSeq);
      while (!closed && rows.length > 0 && replayed < REPLAY_MAX) {
        for (const row of rows) {
          if (closed) break;
          if (row.seq <= lastSeq) continue;
          if (client.userId && !activityVisibleTo(row, client.userId)) {
            lastSeq = row.seq;
            client.lastSeq = row.seq;
            continue;
          }
          writeRaw(res, formatActivity(row));
          lastSeq = row.seq;
          client.lastSeq = row.seq;
          replayed += 1;
        }
        if (rows.length < REPLAY_BATCH) break;
        rows = loadActivityRows(lastSeq);
      }
    } catch {
      // Replay is best-effort; the poll catches up below.
    }
  }

  clients.add(client);

  heartbeat = setInterval(() => {
    if (closed) return;
    try {
      writeRaw(res, `: heartbeat ${nowIso()}\n\n`);
    } catch {
      close();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  // Immediate bus publish covers the common path; the poll closes the gap for
  // activity written without the bus and after a transient publish failure.
  poll = setInterval(() => {
    if (closed) return;
    let rows: ActivityEventRow[];
    try {
      rows = loadActivityRows(lastSeq, REPLAY_BATCH);
    } catch {
      return;
    }
    for (const row of rows) {
      if (closed) break;
      if (row.seq <= lastSeq) continue;
      if (client.userId && !activityVisibleTo(row, client.userId)) {
        lastSeq = row.seq;
        client.lastSeq = row.seq;
        continue;
      }
      try {
        writeRaw(res, formatActivity(row));
        lastSeq = row.seq;
        client.lastSeq = row.seq;
      } catch {
        close();
        return;
      }
    }
  }, POLL_MS);
  poll.unref?.();
}
