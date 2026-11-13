/**
 * Attachments (v0.2): files attached to a task.
 *
 * Files are stored outside SQLite under ATTACHMENTS_DIR (default
 * `data/attachments`) with generated names and mode 0600. The database keeps
 * only metadata + SHA-256. Downloads always require the session cookie and
 * ownership is re-checked before the file is streamed, so a guessed id cannot
 * cross accounts. JSON backups intentionally exclude attachment bytes.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getDb } from "@morrow/db";
import { newId, nowIso } from "@morrow/shared";
import { canAccessTask } from "./access.js";
import { authenticateRequest } from "./auth.js";
import {
  badRequest,
  notFound,
  sendProblem,
  unauthorized,
} from "./errors.js";

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_TASK = 20;

export interface AttachmentRow {
  id: string;
  task_id: string;
  user_id: string;
  filename: string;
  mime_type: string;
  bytes: number;
  sha256: string;
  storage_path: string;
  rev: number;
  created_at: string;
  deleted_at: string | null;
}

export function resolveAttachmentsDir(): string {
  if (process.env["ATTACHMENTS_DIR"]) {
    return path.resolve(process.env["ATTACHMENTS_DIR"]);
  }
  // Keep attachment bytes on the same persistent volume as the database.
  const databasePath =
    process.env["DATABASE_PATH"] ??
    path.join(process.cwd(), "data", "morrow.db");
  return path.resolve(path.dirname(databasePath), "attachments");
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

function getAttachment(userId: string, id: string): AttachmentRow | null {
  const row = getDb()
    .prepare("SELECT * FROM attachments WHERE id = ?")
    .get(id) as AttachmentRow | undefined;
  if (!row) return null;
  return canAccessTask(userId, row.task_id) ? row : null;
}

/** Metadata lookup for the CalDAV-authenticated download route. */
export function attachmentRowById(id: string): AttachmentRow | null {
  try {
    const row = getDb()
      .prepare("SELECT * FROM attachments WHERE id = ?")
      .get(id) as AttachmentRow | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

function publicAttachment(row: AttachmentRow): Record<string, unknown> {
  return {
    id: row.id,
    taskId: row.task_id,
    filename: row.filename,
    mimeType: row.mime_type,
    bytes: row.bytes,
    sha256: row.sha256,
    rev: row.rev,
    createdAt: row.created_at,
    url: `/api/attachments/${row.id}/download`,
  };
}

function safeFilename(raw: string): string {
  const base = path.basename(raw || "attachment");
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/["\\/]/g, "_")
    .trim()
    .slice(0, 200);
  return cleaned || "attachment";
}

/**
 * Resolve an attachment path only when both the lexical path and its realpath
 * stay inside ATTACHMENTS_DIR. This blocks a symlink planted inside the dir
 * from turning a download/delete into arbitrary filesystem access.
 */
export function safeAttachmentPath(storagePath: string): string | null {
  try {
    const dir = fs.realpathSync(resolveAttachmentsDir());
    const file = fs.realpathSync(path.resolve(storagePath));
    if (file === dir || !file.startsWith(dir + path.sep)) return null;
    return file;
  } catch {
    return null;
  }
}

export function contentDispositionFilename(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "_");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function audit(
  userId: string,
  action: string,
  id: string,
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
         VALUES ('user', ?, ?, 'attachment', ?, ?, ?, ?, ?)`,
      )
      .run(
        userId,
        action,
        id,
        JSON.stringify(before ?? null),
        JSON.stringify(after ?? null),
        summary,
        nowIso(),
      );
  } catch {
    // Audit is best-effort.
  }
}

export async function registerAttachmentRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get("/api/tasks/:id/attachments", async (req, reply) => {
    const auth = authed(req, reply);
    if (!auth) return reply;
    const taskId = (req.params as { id?: string }).id ?? "";
    if (!liveTask(auth.user.id, taskId)) return notFound(req, reply);
    const rows = getDb()
      .prepare(
        `SELECT * FROM attachments
          WHERE task_id = ? AND deleted_at IS NULL
          ORDER BY created_at ASC`,
      )
      .all(taskId) as AttachmentRow[];
    return reply.send({ attachments: rows.map(publicAttachment) });
  });

  app.post(
    "/api/tasks/:id/attachments",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const auth = authed(req, reply);
      if (!auth) return reply;
      const taskId = (req.params as { id?: string }).id ?? "";
      if (!liveTask(auth.user.id, taskId)) return notFound(req, reply);
      if (!req.isMultipart()) {
        return badRequest(
          req,
          reply,
          "Send multipart/form-data with the file in field 'file'.",
          "multipart_required",
        );
      }
      const count = getDb()
        .prepare(
          `SELECT COUNT(*) AS n FROM attachments
            WHERE task_id = ? AND deleted_at IS NULL`,
        )
        .get(taskId) as { n: number };
      if (count.n >= MAX_ATTACHMENTS_PER_TASK) {
        return badRequest(
          req,
          reply,
          `A task can have at most ${MAX_ATTACHMENTS_PER_TASK} attachments.`,
          "too_many_attachments",
        );
      }

      let filePart:
        | {
            filename: string;
            mimeType: string;
            buffer: Buffer;
          }
        | null = null;
      for await (const part of req.parts()) {
        if (part.type !== "file") continue;
        if (filePart) {
          // Drain unexpected extra files rather than failing a partially
          // uploaded request.
          part.file.resume();
          continue;
        }
        if (part.file.truncated) {
          return sendProblem(req, reply, 413, "Payload Too Large", {
            detail: `Attachments are limited to ${MAX_ATTACHMENT_BYTES} bytes.`,
            code: "attachment_too_large",
          });
        }
        const buffer = await part.toBuffer();
        if (buffer.byteLength > MAX_ATTACHMENT_BYTES) {
          return sendProblem(req, reply, 413, "Payload Too Large", {
            detail: `Attachments are limited to ${MAX_ATTACHMENT_BYTES} bytes.`,
            code: "attachment_too_large",
          });
        }
        filePart = {
          filename: safeFilename(part.filename ?? "attachment"),
          mimeType: (part.mimetype || "application/octet-stream").slice(0, 200),
          buffer,
        };
      }
      if (!filePart) {
        return badRequest(req, reply, "No file was uploaded.", "missing_file");
      }

      const dir = resolveAttachmentsDir();
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const id = newId();
      const storagePath = path.join(dir, id);
      const sha256 = crypto
        .createHash("sha256")
        .update(filePart.buffer)
        .digest("hex");
      fs.writeFileSync(storagePath, filePart.buffer, { mode: 0o600 });
      try {
        fs.chmodSync(storagePath, 0o600);
      } catch {
        // Best-effort on filesystems without POSIX modes.
      }
      const now = nowIso();
      try {
        getDb()
          .prepare(
            `INSERT INTO attachments
               (id, task_id, user_id, filename, mime_type, bytes, sha256,
                storage_path, rev, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
          )
          .run(
            id,
            taskId,
            auth.user.id,
            filePart.filename,
            filePart.mimeType,
            filePart.buffer.byteLength,
            sha256,
            storagePath,
            now,
          );
      } catch (err) {
        try {
          fs.unlinkSync(storagePath);
        } catch {
          // best-effort cleanup
        }
        throw err;
      }
      const row = getAttachment(auth.user.id, id) as AttachmentRow;
      audit(
        auth.user.id,
        "attachment.create",
        id,
        null,
        publicAttachment(row),
        `attached "${row.filename}"`,
      );
      return reply.code(201).send(publicAttachment(row));
    },
  );

  app.get("/api/attachments/:id/download", async (req, reply) => {
    const auth = authed(req, reply);
    if (!auth) return reply;
    const id = (req.params as { id?: string }).id ?? "";
    const row = getAttachment(auth.user.id, id);
    if (!row || row.deleted_at !== null) return notFound(req, reply);
    const filePath = safeAttachmentPath(row.storage_path);
    if (!filePath) return notFound(req, reply);
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) return notFound(req, reply);
    } catch {
      return notFound(req, reply);
    }
    return reply
      .header("content-type", row.mime_type || "application/octet-stream")
      .header("content-length", String(row.bytes))
      .header("content-disposition", contentDispositionFilename(row.filename))
      .header("x-content-type-options", "nosniff")
      .send(fs.createReadStream(filePath));
  });

  app.delete("/api/attachments/:id", async (req, reply) => {
    const auth = authed(req, reply);
    if (!auth) return reply;
    const id = (req.params as { id?: string }).id ?? "";
    const row = getAttachment(auth.user.id, id);
    if (!row || row.deleted_at !== null) return notFound(req, reply);
    const now = nowIso();
    getDb()
      .prepare(
        `UPDATE attachments
            SET deleted_at = ?, rev = rev + 1
          WHERE id = ?`,
      )
      .run(now, id);
    try {
      const filePath = safeAttachmentPath(row.storage_path);
      if (filePath) fs.unlinkSync(filePath);
    } catch {
      // Missing file is already effectively deleted.
    }
    audit(
      auth.user.id,
      "attachment.delete",
      id,
      publicAttachment(row),
      null,
      `removed "${row.filename}"`,
    );
    return reply.send({ ok: true, id });
  });
}
