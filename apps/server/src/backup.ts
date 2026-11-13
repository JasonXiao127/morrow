/**
 * Morrow JSON backup format — v0.3.
 *
 * Format:
 * {
 *   "format": "morrow.backup",
 *   "version": 1,
 *   "exportedAt": "2026-11-02T12:00:00.000Z",
 *   "appVersion": "0.3.0",
 *   "schemaVersion": 3,
 *   "sha256": "…",
 *   "hmac": "…",              // optional
 *   "data": {
 *     "lists": [], "listMembers": [], "tags": [], "tasks": [],
 *     "taskTags": [], "subtasks": [], "taskCompletions": [],
 *     "taskRecurrenceExceptions": [],
 *     "settings": {}, "conversations": [], "activity": []
 *   }
 * }
 *
 * v1/v2 documents (without later tables) still verify and import; missing
 * tables default to empty. When BACKUP_AGE_RECIPIENT is set the canonical
 * document is written as a real age envelope (`*.json.age`).
 *
 * Integrity:
 *  - `sha256` covers the exact UTF-8 bytes of the canonical payload:
 *    all document fields except `sha256`/`hmac`, serialized in a fixed order
 *    with no insignificant whitespace. `verifyBackupBytes` also requires the
 *    input bytes to equal the canonical serialization, so reformatting or any
 *    byte change fails.
 *  - `hmac` (optional) is HMAC-SHA256 over the same payload bytes using a key
 *    stored outside the backup directory. Without a key, SHA-256 detects
 *    corruption but not a deliberate re-sign; HMAC is the tamper resistance.
 *
 * Allowlist:
 *  - Only the tables/columns in BACKUP_TABLE_ALLOWLIST are written.
 *  - users (password hashes), sessions (tokens), push_subscriptions (push
 *    keys), capture_tokens, attachments (bytes and metadata), caldav_changes,
 *    operations, deliveries, agent_messages, proposals, backup_runs,
 *    scheduler_state, provider_credentials, VAPID private keys, HMAC keys,
 *    provider key files under SECRETS_DIR/providers, and setup/MCP/OpenCode
 *    credentials are excluded.
 *  - Settings are further limited to BACKUP_SETTINGS_ALLOWLIST and are
 *    canary-checked for secret-like keys.
 *
 * Restore processes a verified document into a temp DB, runs
 * integrity_check/foreign_key_check inside the transaction, atomically swaps
 * the live file, invalidates sessions/credentials, and clears leases and
 * in-flight deliveries. Duplicate per-collection UID/href identities are
 * rejected as an invalid backup rather than surfacing a raw SQLite error.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Decrypter, Encrypter } from "age-encryption";

export const BACKUP_FORMAT = "morrow.backup" as const;
export const BACKUP_VERSION = 1 as const;
export const BACKUP_SCHEMA_VERSION = 3 as const;
export const BACKUP_APP_VERSION = "0.3.0" as const;
export const BACKUP_MAX_BYTES = 25 * 1024 * 1024;
export const BACKUP_MAX_MB_DEFAULT = 25;
/**
 * The upload/restore cap is configurable for long-lived workspaces whose core
 * data legitimately exceeds the 25 MB default. Keep a sane ceiling so a typo
 * cannot ask Fastify to buffer an unbounded upload.
 */
export function resolveBackupMaxBytes(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env["BACKUP_MAX_MB"];
  if (raw === undefined || raw.trim() === "") return BACKUP_MAX_BYTES;
  const mb = Number(raw);
  if (!Number.isFinite(mb) || mb < 1 || mb > 128) return BACKUP_MAX_BYTES;
  return Math.floor(mb * 1024 * 1024);
}
/**
 * Activity is audit/undo history, not core reminder data. Keep the JSON
 * backup bounded so a long-lived workspace cannot grow past the restore cap
 * just because of old activity snapshots.
 */
export const BACKUP_ACTIVITY_LIMIT = 5_000;

export type BackupScalar = string | number | boolean | null;
export type BackupRow = Record<string, BackupScalar>;

/** Top-level data keys from §3. They map to physical tables via BACKUP_TABLE_ALLOWLIST. */
export type BackupTableKey =
  | "lists"
  | "listMembers"
  | "tags"
  | "tasks"
  | "taskTags"
  | "subtasks"
  | "taskCompletions"
  | "taskRecurrenceExceptions"
  | "conversations"
  | "activity";

export const BACKUP_TABLE_ALLOWLIST = {
  lists: [
    "id",
    "user_id",
    "name",
    "color",
    "icon",
    "sort_key",
    "is_inbox",
    "created_by",
    "updated_by",
    "rev",
    "created_at",
    "updated_at",
    "deleted_at",
  ],
  listMembers: ["list_id", "user_id", "role", "created_at"],
  tags: [
    "id",
    "user_id",
    "name",
    "color",
    "rev",
    "created_at",
    "updated_at",
    "deleted_at",
  ],
  tasks: [
    "id",
    "user_id",
    "list_id",
    "title",
    "notes",
    "ical_uid",
    "caldav_href",
    "status",
    "priority",
    "due_at",
    "due_date",
    "all_day",
    "timezone",
    "remind_at",
    "reminder_time_local",
    "remind_offset_minutes",
    "snoozed_until",
    "dtstart_local",
    "next_occurrence_at",
    "next_occurrence_local",
    "occurrence_seq",
    "rrule",
    "recurrence_until_utc",
    "recurrence_until_date",
    "recurrence_count",
    "wkst",
    "recurrence_mode",
    "clamp_policy",
    "series_ended_at",
    "missed_count",
    "completed_at",
    "sort_key",
    "created_by",
    "updated_by",
    "rev",
    "created_at",
    "updated_at",
    "deleted_at",
  ],
  taskTags: ["task_id", "tag_id", "created_at"],
  taskRecurrenceExceptions: [
    "id",
    "task_id",
    "user_id",
    "recurrence_id",
    "caldav_href",
    "patch_json",
    "status",
    "completed_at",
    "ical_extra_json",
    "rev",
    "created_at",
    "updated_at",
    "deleted_at",
  ],
  subtasks: [
    "id",
    "task_id",
    "user_id",
    "title",
    "done",
    "sort_key",
    "rev",
    "created_at",
    "updated_at",
    "deleted_at",
  ],
  taskCompletions: [
    "id",
    "task_id",
    "occurrence_key",
    "status",
    "completed_at",
    "source",
    "rev",
    "created_at",
    "deleted_at",
  ],
  conversations: [
    "id",
    "user_id",
    "opencode_session_id",
    "title",
    "status",
    "last_message_at",
    "rev",
    "created_at",
    "updated_at",
    "deleted_at",
  ],
  activity: [
    "seq",
    "batch_id",
    "op_id",
    "actor",
    "actor_id",
    "action",
    "entity_type",
    "entity_id",
    "before_json",
    "after_json",
    "summary",
    "created_at",
  ],
} as const satisfies Record<BackupTableKey, readonly string[]>;

/**
 * Settings are key/value JSON. Unknown keys are intentionally not exported
 * until they are reviewed; this is an allowlist, not a denylist.
 */
export const BACKUP_SETTINGS_ALLOWLIST = [
  "timezone",
  "locale",
  "week_start",
  "weekStart",
  "time_format",
  "timeFormat",
  "quiet_hours",
  "quietHours",
  "reminder_defaults",
  "reminderDefaults",
  "notification_defaults",
  "notificationDefaults",
  "backup",
  "agent",
  "ntfy",
  "digest",
  "theme",
  "vapid_public_key",
  "vapidPublicKey",
] as const;

export const BACKUP_EXCLUDED_TABLES = [
  "users", // password_hash
  "sessions", // session tokens
  "operations",
  "push_subscriptions", // p256dh/auth/push endpoints
  "deliveries",
  "agent_messages", // TODO(M3): define nested shape before backing up chat
  "proposals",
  "attachments", // binary files live under ATTACHMENTS_DIR; JSON keeps metadata-free backups
  "capture_tokens", // bearer tokens are secrets
  "backup_runs",
  "scheduler_state",
  "caldav_changes", // sync journal; a restore rotates the token epoch instead
  "provider_credentials", // M4.1: key fingerprint/last4 metadata + key refs
  "sqlite_sequence",
  "__drizzle_migrations",
] as const;

const SECRET_KEY_PATTERN =
  /(password|passwd|secret|token|private|p256dh|credential|api[-_]?key|provider[-_]?key|^auth$|hmac)/i;

/**
 * M4.1 backup canary markers. `provider_credentials` is excluded by allowlist;
 * these markers make an accidental future inclusion fail loudly in tests and
 * in the nightly export diagnostics. The key itself is checked separately by
 * `findBackupSecretLeaks` with the operator-supplied secret values.
 */
export const PROVIDER_BACKUP_CANARY_MARKERS = [
  "provider_credentials",
  "key_fingerprint",
  "key_last4",
] as const;

export interface BackupData {
  lists: BackupRow[];
  /** v0.2 list sharing. */
  listMembers?: BackupRow[];
  /** v0.2 labels. Optional so v1 backups still verify/import. */
  tags?: BackupRow[];
  tasks: BackupRow[];
  /** v0.2 task↔tag membership. */
  taskTags?: BackupRow[];
  /** v0.2 child checklists. */
  subtasks?: BackupRow[];
  taskCompletions: BackupRow[];
  /** v0.3 per-occurrence overrides. Optional for older backups. */
  taskRecurrenceExceptions?: BackupRow[];
  settings: Record<string, unknown>;
  conversations: BackupRow[];
  activity: BackupRow[];
}

export interface BackupPayload {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  exportedAt: string;
  appVersion: string;
  schemaVersion: number;
  data: BackupData;
}

export interface BackupDocument extends BackupPayload {
  sha256: string;
  hmac?: string;
}

export interface CreateBackupOptions {
  exportedAt?: string;
  appVersion?: string;
  schemaVersion?: number;
  /** Stored outside BACKUP_DIR by the deployment. */
  hmacKey?: string | Uint8Array;
}

export interface BackupVerification {
  ok: boolean;
  errors: string[];
  bytes: number;
  document?: BackupDocument;
  sha256?: string;
  hmac: "absent" | "valid" | "invalid" | "unchecked";
}

export class BackupVerificationError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(`invalid Morrow backup: ${errors.join("; ")}`);
    this.name = "BackupVerificationError";
    this.errors = errors;
  }
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

export function hmacSha256Hex(
  key: string | Uint8Array,
  input: string | Uint8Array,
): string {
  return createHmac("sha256", key).update(input).digest("hex");
}

function constantTimeHexEqual(a: string, b: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(a) || !/^[0-9a-f]{64}$/.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

// ---------------------------------------------------------------------------
// Canonical serialization
// ---------------------------------------------------------------------------

function orderedPayload(payload: BackupPayload): BackupPayload {
  return {
    format: payload.format,
    version: payload.version,
    exportedAt: payload.exportedAt,
    appVersion: payload.appVersion,
    schemaVersion: payload.schemaVersion,
    data: payload.data,
  };
}

/** Exact UTF-8 bytes covered by sha256/hmac. */
export function serializeBackupPayload(payload: BackupPayload): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(orderedPayload(payload)));
}

/**
 * Canonical document bytes. Integrity fields are a footer after `data`, which
 * keeps the hashed prefix byte-identical to the serialized payload.
 */
export function serializeBackupDocument(document: BackupDocument): Uint8Array {
  const payload = serializeBackupPayload(document);
  const text = new TextDecoder().decode(payload);
  const footer =
    `,"sha256":"${document.sha256}"` +
    (document.hmac ? `,"hmac":"${document.hmac}"` : "");
  return new TextEncoder().encode(`${text.slice(0, -1)}${footer}}`);
}

// ---------------------------------------------------------------------------
// Validation / sanitization
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScalar(value: unknown): value is BackupScalar {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function findForbiddenKeys(
  value: unknown,
  path: string,
  out: string[],
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, i) => findForbiddenKeys(entry, `${path}[${i}]`, out));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) out.push(`${path}.${key}`);
    findForbiddenKeys(entry, `${path}.${key}`, out);
  }
}

function validateTableRows(
  table: BackupTableKey,
  value: unknown,
  errors: string[],
): void {
  const columns = new Set<string>(BACKUP_TABLE_ALLOWLIST[table]);
  if (!Array.isArray(value)) {
    errors.push(`data.${table} must be an array`);
    return;
  }
  for (let i = 0; i < value.length; i += 1) {
    const row = value[i];
    if (!isRecord(row)) {
      errors.push(`data.${table}[${i}] must be an object`);
      continue;
    }
    for (const [key, entry] of Object.entries(row)) {
      if (!columns.has(key)) {
        errors.push(`data.${table}[${i}] has non-allowlisted column "${key}"`);
      }
      if (!isScalar(entry)) {
        errors.push(`data.${table}[${i}].${key} must be a scalar`);
      }
    }
  }
}

function validateBackupData(data: unknown, errors: string[]): void {
  if (!isRecord(data)) {
    errors.push("data must be an object");
    return;
  }

  const expected = new Set<string>([
    "lists",
    "listMembers",
    "tags",
    "tasks",
    "taskTags",
    "subtasks",
    "taskCompletions",
    "taskRecurrenceExceptions",
    "settings",
    "conversations",
    "activity",
  ]);
  for (const key of Object.keys(data)) {
    if (!expected.has(key)) errors.push(`data has unknown key "${key}"`);
  }

  validateTableRows("lists", data["lists"], errors);
  validateTableRows("tasks", data["tasks"], errors);
  validateTableRows("taskCompletions", data["taskCompletions"], errors);
  validateTableRows("conversations", data["conversations"], errors);
  validateTableRows("activity", data["activity"], errors);
  // v0.2/v0.3 tables are optional so older backups remain importable.
  for (const table of [
    "listMembers",
    "tags",
    "taskTags",
    "subtasks",
    "taskRecurrenceExceptions",
  ] as const) {
    if (data[table] !== undefined) {
      validateTableRows(table, data[table], errors);
    }
  }

  const settings = data["settings"];
  if (!isRecord(settings)) {
    errors.push("data.settings must be an object");
  } else {
    const allowed = new Set<string>(BACKUP_SETTINGS_ALLOWLIST);
    for (const key of Object.keys(settings)) {
      if (!allowed.has(key)) {
        errors.push(`data.settings has non-allowlisted key "${key}"`);
      }
      if (SECRET_KEY_PATTERN.test(key)) {
        errors.push(`data.settings contains secret-like key "${key}"`);
      }
    }
  }

  const forbidden: string[] = [];
  findForbiddenKeys(data, "data", forbidden);
  for (const path of forbidden) {
    errors.push(`${path} looks like secret material`);
  }
}

/**
 * Build a canonical, allowlisted, secret-free BackupData. Unknown row columns
 * are rejected (they indicate a schema mismatch); secret-like settings are
 * dropped before serialization.
 */
export function sanitizeBackupData(data: BackupData): BackupData {
  const pick = (table: BackupTableKey): BackupRow[] => {
    const columns = BACKUP_TABLE_ALLOWLIST[table];
    return (data[table] ?? []).map((row) => {
      const out: BackupRow = {};
      for (const column of columns) {
        if (Object.prototype.hasOwnProperty.call(row, column)) {
          out[column] = row[column] as BackupScalar;
        }
      }
      return out;
    });
  };

  // Settings are allowlisted before validation so a stray secret-like key is
  // omitted rather than making a nightly backup fail. Unknown row columns are
  // still rejected below: those indicate a schema mismatch, not a secret.
  const settings: Record<string, unknown> = {};
  for (const key of BACKUP_SETTINGS_ALLOWLIST) {
    if (!SECRET_KEY_PATTERN.test(key) &&
        Object.prototype.hasOwnProperty.call(data.settings, key)) {
      settings[key] = data.settings[key];
    }
  }

  const cleaned: BackupData = {
    lists: pick("lists"),
    listMembers: pick("listMembers"),
    tags: pick("tags"),
    tasks: pick("tasks"),
    taskTags: pick("taskTags"),
    subtasks: pick("subtasks"),
    taskCompletions: pick("taskCompletions"),
    taskRecurrenceExceptions: pick("taskRecurrenceExceptions"),
    settings,
    conversations: pick("conversations"),
    activity: pick("activity"),
  };

  const errors: string[] = [];
  validateBackupData(cleaned, errors);
  if (errors.length > 0) {
    throw new BackupVerificationError(errors);
  }
  return cleaned;
}

// ---------------------------------------------------------------------------
// Create / verify (pure format layer; export/import TODO below)
// ---------------------------------------------------------------------------

export function createBackupDocument(
  data: BackupData,
  options: CreateBackupOptions = {},
): { document: BackupDocument; bytes: Uint8Array } {
  const exportedAt = options.exportedAt ?? new Date().toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(exportedAt)) {
    throw new RangeError(
      "exportedAt must be UTC ISO with fixed milliseconds (YYYY-MM-DDTHH:MM:SS.sssZ)",
    );
  }

  const cleanup = sanitizeBackupData(data);
  const payload: BackupPayload = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt,
    appVersion: options.appVersion ?? BACKUP_APP_VERSION,
    schemaVersion: options.schemaVersion ?? BACKUP_SCHEMA_VERSION,
    data: cleanup,
  };

  const payloadBytes = serializeBackupPayload(payload);
  const sha256 = sha256Hex(payloadBytes);
  const hmac = options.hmacKey
    ? hmacSha256Hex(options.hmacKey, payloadBytes)
    : undefined;
  const document: BackupDocument = {
    ...payload,
    sha256,
    ...(hmac ? { hmac } : {}),
  };
  const bytes = serializeBackupDocument(document);
  return { document, bytes };
}

export interface VerifyBackupOptions {
  hmacKey?: string | Uint8Array;
  maxBytes?: number;
}

export function verifyBackupBytes(
  input: string | Uint8Array,
  options: VerifyBackupOptions = {},
): BackupVerification {
  const bytes =
    typeof input === "string" ? new TextEncoder().encode(input) : input;
  const maxBytes = options.maxBytes ?? resolveBackupMaxBytes();
  const errors: string[] = [];

  if (bytes.byteLength > maxBytes) {
    return {
      ok: false,
      errors: [`backup exceeds ${maxBytes} byte limit`],
      bytes: bytes.byteLength,
      hmac: "absent",
    };
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return {
      ok: false,
      errors: ["backup is not valid UTF-8"],
      bytes: bytes.byteLength,
      hmac: "absent",
    };
  }

  let parsed: unknown;
  try {
    // Same depth/node/string caps as the HTTP upload path; the exported
    // helper must not be a stack-overflow bypass for direct callers.
    parsed = parseJsonWithLimits(text);
  } catch (err) {
    return {
      ok: false,
      errors: [
        err instanceof BackupVerificationError
          ? err.message
          : `backup is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      ],
      bytes: bytes.byteLength,
      hmac: "absent",
    };
  }

  if (!isRecord(parsed)) {
    return {
      ok: false,
      errors: ["backup root must be an object"],
      bytes: bytes.byteLength,
      hmac: "absent",
    };
  }

  const topLevel = new Set([
    "format",
    "version",
    "exportedAt",
    "appVersion",
    "schemaVersion",
    "sha256",
    "hmac",
    "data",
  ]);
  for (const key of Object.keys(parsed)) {
    if (!topLevel.has(key)) errors.push(`unknown top-level field "${key}"`);
  }

  if (parsed["format"] !== BACKUP_FORMAT) {
    errors.push(`format must be "${BACKUP_FORMAT}"`);
  }
  if (parsed["version"] !== BACKUP_VERSION) {
    errors.push(`unsupported backup version (expected ${BACKUP_VERSION})`);
  }
  if (typeof parsed["exportedAt"] !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(parsed["exportedAt"])) {
    errors.push("exportedAt must be UTC ISO with fixed milliseconds");
  }
  if (typeof parsed["appVersion"] !== "string") {
    errors.push("appVersion must be a string");
  }
  if (
    typeof parsed["schemaVersion"] !== "number" ||
    !Number.isInteger(parsed["schemaVersion"])
  ) {
    errors.push("schemaVersion must be an integer");
  } else if (parsed["schemaVersion"] > BACKUP_SCHEMA_VERSION) {
    errors.push(
      `schemaVersion ${parsed["schemaVersion"]} is newer than this app (${BACKUP_SCHEMA_VERSION})`,
    );
  }
  if (typeof parsed["sha256"] !== "string" || !/^[0-9a-f]{64}$/.test(parsed["sha256"])) {
    errors.push("sha256 must be 64 lowercase hex characters");
  }
  if ("hmac" in parsed && (typeof parsed["hmac"] !== "string" || !/^[0-9a-f]{64}$/.test(parsed["hmac"]))) {
    errors.push("hmac must be 64 lowercase hex characters");
  }

  validateBackupData(parsed["data"], errors);

  if (errors.length > 0) {
    return {
      ok: false,
      errors,
      bytes: bytes.byteLength,
      hmac: "invalid",
    };
  }

  const document = parsed as unknown as BackupDocument;
  const payloadBytes = serializeBackupPayload(document);
  const expectedSha = sha256Hex(payloadBytes);

  let hmac: BackupVerification["hmac"] = "absent";
  if (document.hmac) {
    if (!options.hmacKey) {
      hmac = "unchecked";
    } else {
      const expectedHmac = hmacSha256Hex(options.hmacKey, payloadBytes);
      hmac = constantTimeHexEqual(expectedHmac, document.hmac)
        ? "valid"
        : "invalid";
      if (hmac === "invalid") errors.push("HMAC does not match");
    }
  }

  if (!constantTimeHexEqual(expectedSha, document.sha256)) {
    errors.push("sha256 does not match the exact payload bytes");
  }

  // Exact-byte rule: pretty-printing, reordering, or any other byte change is
  // rejected even when the JSON semantics are unchanged.
  const canonical = serializeBackupDocument(document);
  if (!Buffer.from(bytes).equals(Buffer.from(canonical))) {
    errors.push("backup is not in canonical byte form");
  }

  if (errors.length > 0) {
    return {
      ok: false,
      errors,
      bytes: bytes.byteLength,
      document,
      sha256: document.sha256,
      hmac,
    };
  }

  return {
    ok: true,
    errors: [],
    bytes: bytes.byteLength,
    document,
    sha256: document.sha256,
    hmac,
  };
}

export function decodeAndVerifyBackup(
  input: string | Uint8Array,
  options: VerifyBackupOptions = {},
): BackupDocument {
  const result = verifyBackupBytes(input, options);
  if (!result.ok || !result.document) {
    throw new BackupVerificationError(result.errors);
  }
  return result.document;
}

// ---------------------------------------------------------------------------
// DB layer — M3 (§3 allowlisted export, §5 routes, §8 caps, §9 ledger)
// ---------------------------------------------------------------------------

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getDb } from "@morrow/db";
import { newId } from "@morrow/shared";

/**
 * Structural better-sqlite3 surface. Tests pass isolated `openDatabase()`
 * handles; routes pass the `getDb()` singleton.
 */
export interface BackupDbStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  };
}

export interface BackupDb {
  prepare(sql: string): BackupDbStatement;
  pragma(query: string, options?: unknown): unknown;
  transaction<T>(fn: () => T): () => T;
}

/** Physical table behind each backup data key. */
const BACKUP_PHYSICAL_TABLE: Record<BackupTableKey, string> = {
  lists: "lists",
  listMembers: "list_members",
  tags: "tags",
  tasks: "tasks",
  taskTags: "task_tags",
  subtasks: "subtasks",
  taskCompletions: "task_completions",
  taskRecurrenceExceptions: "task_recurrence_exceptions",
  conversations: "agent_conversations",
  activity: "activity",
};

const BACKUP_ROW_ORDER: Record<BackupTableKey, string> = {
  lists: "id",
  listMembers: "list_id, user_id",
  tags: "id",
  tasks: "id",
  taskTags: "task_id, tag_id",
  subtasks: "task_id, sort_key, id",
  taskCompletions: "task_id, occurrence_key",
  taskRecurrenceExceptions: "task_id, recurrence_id",
  conversations: "id",
  activity: "seq",
};

/** Where JSON exports + pre-restore copies live (plan §10 BACKUP_DIR). */
export function resolveBackupDir(): string {
  const dir =
    process.env["BACKUP_DIR"] ?? path.join(process.cwd(), "data", "backups");
  return path.resolve(dir);
}

function resolveSecretsDir(): string {
  return (
    process.env["SECRETS_DIR"] ?? path.join(process.cwd(), "data", "secrets")
  );
}

/**
 * M4.1: provider key files live under SECRETS_DIR/providers. Refuse a backup
 * directory that overlaps the secret directory in either direction, so an
 * operator typo can never produce a backup archive that contains key material.
 */
export function assertBackupDirOutsideSecrets(
  backupDir: string = resolveBackupDir(),
  secretsDir: string = resolveSecretsDir(),
): void {
  const backup = path.resolve(backupDir);
  const secrets = path.resolve(secretsDir);
  const overlaps =
    backup === secrets ||
    backup.startsWith(secrets + path.sep) ||
    secrets.startsWith(backup + path.sep);
  if (overlaps) {
    throw new BackupVerificationError([
      "BACKUP_DIR must not overlap SECRETS_DIR (provider keys must never enter a backup)",
    ]);
  }
}

/**
 * Canary for tests and export diagnostics. Returns exact hits for the provider
 * credential table markers and any supplied secret values (e.g. a key read
 * from SECRETS_DIR). An empty array means the backup is clean.
 */
export function findBackupSecretLeaks(
  input: string | Uint8Array,
  secrets: readonly string[] = [],
): string[] {
  const text =
    typeof input === "string"
      ? input
      : new TextDecoder("utf-8", { fatal: false }).decode(input);
  const hits: string[] = [];
  for (const marker of PROVIDER_BACKUP_CANARY_MARKERS) {
    if (text.includes(marker)) hits.push(marker);
  }
  for (const secret of secrets) {
    // Short strings produce false positives in JSON metadata; only real key
    // material is long enough to search for.
    if (secret.length >= 8 && text.includes(secret)) {
      hits.push("provider-key-material");
    }
  }
  return [...new Set(hits)];
}

/**
 * HMAC key lives OUTSIDE the backup dir (§8): `SECRETS_DIR/backup_hmac_key`
 * (0600, written by deploy/init-env.sh or the operator) or BACKUP_HMAC_KEY
 * env. Returns null when unconfigured (exports are then SHA-256 only).
 */
export function resolveHmacKey(): string | null {
  const fromEnv = process.env["BACKUP_HMAC_KEY"];
  if (fromEnv && fromEnv.trim() !== "") return fromEnv.trim();
  try {
    const file = path.join(resolveSecretsDir(), "backup_hmac_key");
    if (!fs.existsSync(file)) return null;
    const resolvedFile = path.resolve(file);
    const resolvedBackupDir = resolveBackupDir();
    if (
      resolvedFile === resolvedBackupDir ||
      resolvedFile.startsWith(resolvedBackupDir + path.sep)
    ) {
      throw new Error(
        "refusing to load HMAC key from inside BACKUP_DIR (keep keys outside backups)",
      );
    }
    const value = fs.readFileSync(file, "utf8").trim();
    return value === "" ? null : value;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Age recipients: set BACKUP_AGE_RECIPIENT (age1…) or pass
 * `options.ageRecipient`. Exports are then written as a real age envelope
 * (`*.json.age`). Restores need BACKUP_AGE_IDENTITY (AGE-SECRET-KEY-1…) in
 * the environment or `SECRETS_DIR/backup_age_identity`; the plaintext never
 * touches disk when encryption is enabled.
 */
export function resolveAgeRecipient(explicit?: string | null): string | null {
  if (explicit && explicit.trim() !== "") return explicit.trim();
  const fromEnv = process.env["BACKUP_AGE_RECIPIENT"];
  return fromEnv && fromEnv.trim() !== "" ? fromEnv.trim() : null;
}

export function resolveAgeIdentity(): string | null {
  const fromEnv = process.env["BACKUP_AGE_IDENTITY"];
  if (fromEnv && fromEnv.trim() !== "") return fromEnv.trim();
  try {
    const file = path.join(resolveSecretsDir(), "backup_age_identity");
    if (!fs.existsSync(file)) return null;
    const resolvedFile = path.resolve(file);
    const resolvedBackupDir = resolveBackupDir();
    if (
      resolvedFile === resolvedBackupDir ||
      resolvedFile.startsWith(resolvedBackupDir + path.sep)
    ) {
      throw new Error(
        "refusing to load the age identity from inside BACKUP_DIR (keep keys outside backups)",
      );
    }
    const value = fs.readFileSync(file, "utf8").trim();
    return value === "" ? null : value;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw err;
  }
}

/** `morrow-20261102T120000000Z-a1b2c3.json[.age]` — generated, never input. */
export function backupFileStamp(exportedAt: string): string {
  return exportedAt.replaceAll("-", "").replaceAll(":", "").replace(".", "");
}

export function backupFileName(exportedAt: string, encrypted = false): string {
  const stamp = backupFileStamp(exportedAt);
  if (!/^\d{8}T\d{9}Z$/.test(stamp)) {
    throw new RangeError(`cannot build a backup filename from ${exportedAt}`);
  }
  return `morrow-${stamp}-${randomBytes(3).toString("hex")}.json${encrypted ? ".age" : ""}`;
}

const SAFE_BACKUP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,128}\.json(?:\.age)?$/;

function isAgeCiphertext(bytes: Uint8Array): boolean {
  return new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.slice(0, 64))
    .startsWith("age-encryption.org/v1");
}

/** Decrypt an age envelope when the server holds the matching identity. */
export async function decryptAgeBackup(
  bytes: Uint8Array,
  identity: string | null = resolveAgeIdentity(),
): Promise<Uint8Array> {
  if (!identity) {
    throw new BackupVerificationError([
      "backup is age-encrypted but BACKUP_AGE_IDENTITY is not configured",
    ]);
  }
  try {
    const decrypter = new Decrypter();
    decrypter.addIdentity(identity);
    return await decrypter.decrypt(bytes);
  } catch (err) {
    throw new BackupVerificationError([
      `age decryption failed: ${err instanceof Error ? err.message : String(err)}`,
    ]);
  }
}

function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`unsafe identifier: ${name}`);
  }
  return `"${name}"`;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** SELECT only the allowlisted columns, in a deterministic row order. */
export function readBackupDataFromDb(db: BackupDb): BackupData {
  const pick = (table: BackupTableKey): BackupRow[] => {
    const columns = BACKUP_TABLE_ALLOWLIST[table];
    const selected = columns.map(quoteIdent).join(", ");
    const physical = quoteIdent(BACKUP_PHYSICAL_TABLE[table]);
    const rows = (
      table === "activity"
        ? db
            .prepare(
              `SELECT ${selected} FROM ${physical} ORDER BY seq DESC LIMIT ?`,
            )
            .all(BACKUP_ACTIVITY_LIMIT)
        : db
            .prepare(
              `SELECT ${selected} FROM ${physical} ORDER BY ${BACKUP_ROW_ORDER[table]}`,
            )
            .all()
    ) as Array<Record<string, unknown>>;
    // The activity cap reads newest-first; restore the canonical ascending
    // order so backup bytes stay deterministic.
    if (table === "activity") rows.reverse();
    return rows.map((row) => {
      const out: BackupRow = {};
      for (const column of columns) {
        const value = row[column];
        out[column] =
          value === undefined
            ? null
            : (value as string | number | boolean | null);
      }
      return out;
    });
  };

  const settingsRows = db
    .prepare("SELECT key, value FROM settings")
    .all() as Array<{ key: string; value: string }>;
  const rawSettings: Record<string, unknown> = {};
  // Sorted keys keep the canonical export bytes deterministic.
  for (const row of settingsRows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))) {
    try {
      rawSettings[row.key] = JSON.parse(row.value);
    } catch {
      rawSettings[row.key] = row.value;
    }
  }

  return sanitizeBackupData({
    lists: pick("lists"),
    listMembers: pick("listMembers"),
    tags: pick("tags"),
    tasks: pick("tasks"),
    taskTags: pick("taskTags"),
    subtasks: pick("subtasks"),
    taskCompletions: pick("taskCompletions"),
    taskRecurrenceExceptions: pick("taskRecurrenceExceptions"),
    settings: rawSettings,
    conversations: pick("conversations"),
    activity: pick("activity"),
  });
}

/**
 * Export snapshot primitive: every allowlisted table + settings is read inside
 * one SQLite read transaction. In WAL mode that pins a single snapshot, so a
 * concurrent writer cannot produce a torn export (tasks from one revision,
 * activity from another). `exportBackup` uses this for manual and nightly runs.
 */
export function readBackupDataSnapshot(db: BackupDb): BackupData {
  const run = db.transaction(() => readBackupDataFromDb(db));
  return run();
}

// ---------------------------------------------------------------------------
// Upload parsing with JSON caps (§8: 25MB cap, depth/node/string caps)
// ---------------------------------------------------------------------------

export interface BackupJsonLimits {
  maxDepth?: number;
  maxNodes?: number;
  maxStringChars?: number;
}

export const BACKUP_JSON_LIMITS: Required<BackupJsonLimits> = {
  maxDepth: 64,
  maxNodes: 500_000,
  maxStringChars: 1_000_000,
};

/**
 * JSON.parse + structural caps. Depth covers nesting (a 10k-deep payload
 * must not blow the stack); node count covers object/array breadth; string
 * length covers a single giant notes/blob field.
 */
export function parseJsonWithLimits(
  text: string,
  limits: BackupJsonLimits = {},
): unknown {
  const { maxDepth, maxNodes, maxStringChars } = {
    ...BACKUP_JSON_LIMITS,
    ...limits,
  };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new BackupVerificationError([
      `backup is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    ]);
  }
  let nodes = 0;
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 1 }];
  while (stack.length > 0) {
    const { value: current, depth } = stack.pop() as {
      value: unknown;
      depth: number;
    };
    nodes += 1;
    if (nodes > maxNodes) {
      throw new BackupVerificationError([
        `backup exceeds JSON node limit (${maxNodes})`,
      ]);
    }
    if (depth > maxDepth) {
      throw new BackupVerificationError([
        `backup exceeds JSON depth limit (${maxDepth})`,
      ]);
    }
    if (typeof current === "string") {
      if (current.length > maxStringChars) {
        throw new BackupVerificationError([
          `backup string exceeds length limit (${maxStringChars} chars)`,
        ]);
      }
    } else if (Array.isArray(current)) {
      for (const entry of current) stack.push({ value: entry, depth: depth + 1 });
    } else if (current !== null && typeof current === "object") {
      for (const entry of Object.values(current)) {
        stack.push({ value: entry, depth: depth + 1 });
      }
    }
  }
  return value;
}

/**
 * Full upload gate for `POST /api/backup/import`: size cap → UTF-8 →
 * JSON caps → exact-byte + optional HMAC verification. Throws
 * BackupVerificationError (mapped to 400/413 by the route).
 */
export function verifyUploadBackup(
  input: string | Uint8Array,
  options: VerifyBackupOptions & BackupJsonLimits = {},
): BackupDocument {
  const bytes =
    typeof input === "string" ? new TextEncoder().encode(input) : input;
  if (isAgeCiphertext(bytes)) {
    throw new BackupVerificationError([
      "backup is age-encrypted; use the async restore path so the server can decrypt it",
    ]);
  }
  const maxBytes = options.maxBytes ?? resolveBackupMaxBytes();
  if (bytes.byteLength > maxBytes) {
    throw new BackupVerificationError([
      `backup exceeds ${maxBytes} byte limit`,
    ]);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new BackupVerificationError(["backup is not valid UTF-8"]);
  }
  parseJsonWithLimits(text, options);
  const hmacKey = options.hmacKey ?? resolveHmacKey() ?? undefined;
  return decodeAndVerifyBackup(bytes, { ...options, hmacKey });
}

/**
 * Async upload gate used by REST/restore: transparently decrypts age
 * envelopes with BACKUP_AGE_IDENTITY, then applies the same exact-byte
 * checks. The sync variant remains for tests and callers that only accept
 * plaintext.
 */
export async function verifyUploadBackupAsync(
  input: string | Uint8Array,
  options: VerifyBackupOptions & BackupJsonLimits = {},
): Promise<BackupDocument> {
  const bytes =
    typeof input === "string" ? new TextEncoder().encode(input) : input;
  const plaintext = isAgeCiphertext(bytes)
    ? await decryptAgeBackup(bytes)
    : bytes;
  return verifyUploadBackup(plaintext, options);
}

// ---------------------------------------------------------------------------
// Export: DB → canonical JSON file + backup_runs ledger
// ---------------------------------------------------------------------------

export interface ExportBackupOptions extends CreateBackupOptions {
  backupDir?: string;
  /** backup_runs.status: 'manual' | 'nightly' | 'pre-restore'. */
  status?: string;
  /** age1… recipient; exports become `.json.age`. */
  ageRecipient?: string | null;
}

export interface BackupExportResult {
  document: BackupDocument;
  /** Ciphertext when age is enabled, otherwise canonical JSON. */
  bytes: Uint8Array;
  path: string;
  name: string;
  sha256: string;
  bytesWritten: number;
  backupRunId: string;
  encrypted: boolean;
  age: { enabled: boolean; recipient: string | null } | null;
}

/** Best-effort fsync of a freshly written backup file. */
function fsyncFile(filePath: string): void {
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Fsync is durability best-effort (e.g. :memory: test doubles never land here).
  }
}

export function recordBackupRun(
  db: BackupDb,
  entry: {
    path: string;
    sha256: string;
    bytes: number;
    schemaVersion?: number;
    createdAt?: string;
    status?: string;
  },
): string {
  const id = newId();
  db.prepare(
    `INSERT INTO backup_runs (id, path, sha256, bytes, schema_version, created_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    entry.path,
    entry.sha256,
    entry.bytes,
    entry.schemaVersion ?? BACKUP_SCHEMA_VERSION,
    entry.createdAt ?? new Date().toISOString(),
    entry.status ?? "manual",
  );
  return id;
}

/**
 * Read the allowlisted tables, build the canonical document (§3), write it
 * to `${BACKUP_DIR}/morrow-<stamp>-<rand>.json` (0600, fsynced), and record
 * a `backup_runs` row. Never exports users/sessions/push/scheduler state —
 * see BACKUP_TABLE_ALLOWLIST.
 */
export async function exportBackup(
  db?: BackupDb | ExportBackupOptions,
  options: ExportBackupOptions = {},
): Promise<BackupExportResult> {
  const { handle, opts } = normalizeDbArg(db, options);
  const sqlite = handle ?? getSingletonDb();
  // One read transaction pins a consistent WAL snapshot; a concurrent write
  // can no longer make the exported tables disagree with each other.
  const data = readBackupDataSnapshot(sqlite);
  const hmacKey = opts.hmacKey ?? resolveHmacKey() ?? undefined;
  const ageRecipient = resolveAgeRecipient(opts.ageRecipient);
  const { document, bytes: plaintext } = createBackupDocument(data, {
    exportedAt: opts.exportedAt,
    appVersion: opts.appVersion,
    schemaVersion: opts.schemaVersion,
    hmacKey,
  });
  let bytes = plaintext;
  if (ageRecipient) {
    const encrypter = new Encrypter();
    encrypter.addRecipient(ageRecipient);
    bytes = await encrypter.encrypt(plaintext);
  }
  const fileSha256 = sha256Hex(bytes);

  const backupDir = path.resolve(opts.backupDir ?? resolveBackupDir());
  // M4.1: provider key files live under SECRETS_DIR; never let BACKUP_DIR
  // overlap it (or a future directory walk would copy key material).
  assertBackupDirOutsideSecrets(backupDir);
  fs.mkdirSync(backupDir, { recursive: true });
  const name = backupFileName(document.exportedAt, Boolean(ageRecipient));
  if (!SAFE_BACKUP_NAME.test(name)) {
    throw new Error(`generated unsafe backup filename: ${name}`);
  }
  const fullPath = path.join(backupDir, name);
  fs.writeFileSync(fullPath, Buffer.from(bytes), { mode: 0o600 });
  fs.chmodSync(fullPath, 0o600);
  fsyncFile(fullPath);

  const backupRunId = recordBackupRun(sqlite, {
    path: fullPath,
    sha256: fileSha256,
    bytes: bytes.byteLength,
    status: opts.status ?? "manual",
  });

  return {
    document,
    bytes,
    path: fullPath,
    name,
    sha256: fileSha256,
    bytesWritten: bytes.byteLength,
    backupRunId,
    encrypted: Boolean(ageRecipient),
    age: ageRecipient
      ? { enabled: true, recipient: ageRecipient }
      : null,
  };
}

function normalizeDbArg(
  db: BackupDb | ExportBackupOptions | undefined,
  options: ExportBackupOptions,
): { handle: BackupDb | null; opts: ExportBackupOptions } {
  if (db && typeof (db as BackupDb).prepare === "function") {
    return { handle: db as BackupDb, opts: options };
  }
  return { handle: null, opts: (db as ExportBackupOptions | undefined) ?? options };
}

function getSingletonDb(): BackupDb {
  return getDb() as unknown as BackupDb;
}

// ---------------------------------------------------------------------------
// backup_runs ledger + retention (14 daily / 8 weekly / 6 monthly)
// ---------------------------------------------------------------------------

export interface BackupRunEntry {
  id: string;
  /** Absolute file path (never served raw; download resolves + contains). */
  path: string;
  name: string;
  sha256: string;
  bytes: number;
  schemaVersion: number;
  createdAt: string;
  status: string;
  fileExists: boolean;
}

export function listBackupRuns(
  db?: BackupDb,
  options: { limit?: number; includePruned?: boolean } = {},
): BackupRunEntry[] {
  const sqlite = db ?? getSingletonDb();
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 1000);
  const rows = sqlite
    .prepare("SELECT * FROM backup_runs ORDER BY created_at DESC LIMIT ?")
    .all(limit) as Array<{
    id: string;
    path: string;
    sha256: string;
    bytes: number;
    schema_version: number;
    created_at: string;
    status: string;
  }>;
  const out: BackupRunEntry[] = [];
  for (const row of rows) {
    if (row.status === "pruned" && !options.includePruned) continue;
    out.push({
      id: row.id,
      path: row.path,
      name: path.basename(row.path),
      sha256: row.sha256,
      bytes: row.bytes,
      schemaVersion: row.schema_version,
      createdAt: row.created_at,
      status: row.status,
      fileExists: (() => {
        try {
          return fs.existsSync(row.path);
        } catch {
          return false;
        }
      })(),
    });
  }
  return out;
}

export function getBackupRun(
  db: BackupDb | undefined,
  id: string,
): BackupRunEntry | null {
  if (!id || typeof id !== "string" || id.length > 64 || !/^[A-Za-z0-9_-]+$/.test(id)) {
    return null;
  }
  const sqlite = db ?? getSingletonDb();
  const row = sqlite.prepare("SELECT * FROM backup_runs WHERE id = ?").get(id) as {
    id: string;
    path: string;
    sha256: string;
    bytes: number;
    schema_version: number;
    created_at: string;
    status: string;
  } | undefined;
  if (!row || row.status === "pruned") return null;
  let fileExists = false;
  try {
    fileExists = fs.existsSync(row.path);
  } catch {
    fileExists = false;
  }
  return {
    id: row.id,
    path: row.path,
    name: path.basename(row.path),
    sha256: row.sha256,
    bytes: row.bytes,
    schemaVersion: row.schema_version,
    createdAt: row.created_at,
    status: row.status,
    fileExists,
  };
}

/** Read a run's file after containing it inside the backup dir. */
export function readBackupRunFile(
  db: BackupDb | undefined,
  id: string,
  backupDir?: string,
): { entry: BackupRunEntry; bytes: Buffer } {
  const entry = getBackupRun(db, id);
  if (!entry) {
    throw new BackupVerificationError([`unknown backup run: ${id}`]);
  }
  const dir = path.resolve(backupDir ?? resolveBackupDir());
  const resolved = path.resolve(entry.path);
  if (resolved !== dir && !resolved.startsWith(dir + path.sep)) {
    throw new BackupVerificationError(["backup run path escapes BACKUP_DIR"]);
  }
  if (!SAFE_BACKUP_NAME.test(path.basename(resolved))) {
    throw new BackupVerificationError(["backup run has an unsafe filename"]);
  }
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(resolved);
  } catch {
    throw new BackupVerificationError(["backup file is missing from disk"]);
  }
  return { entry, bytes };
}

export interface RetentionEntry {
  id: string;
  createdAt: string;
}

export const RETENTION_DAILY_DAYS = 14;
export const RETENTION_WEEKLY_WEEKS = 8;
export const RETENTION_MONTHLY_MONTHS = 6;

const DAY_MS = 86_400_000;

function isoWeekKey(when: Date): string {
  const t = new Date(Date.UTC(when.getUTCFullYear(), when.getUTCMonth(), when.getUTCDate()));
  const day = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - day + 3);
  const first = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const firstDay = (first.getUTCDay() + 6) % 7;
  first.setUTCDate(first.getUTCDate() - firstDay + 3);
  const week = 1 + Math.round((t.getTime() - first.getTime()) / (7 * DAY_MS));
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * Pure retention selector (14 daily + 8 weekly + 6 monthly): newest backup
 * per day inside 14d, per ISO week inside the next 8w, per month inside the
 * next 6mo; everything older or redundant is pruned.
 */
export function selectBackupsToRetain(
  entries: RetentionEntry[],
  nowMs: number = Date.now(),
): { keep: string[]; prune: string[] } {
  const sorted = [...entries].sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
  );
  const dailyWindowMs = RETENTION_DAILY_DAYS * DAY_MS;
  const weeklyWindowMs = dailyWindowMs + RETENTION_WEEKLY_WEEKS * 7 * DAY_MS;
  const monthlyWindowMs = weeklyWindowMs + RETENTION_MONTHLY_MONTHS * 30 * DAY_MS;
  const seenDaily = new Set<string>();
  const seenWeekly = new Set<string>();
  const seenMonthly = new Set<string>();
  const keep: string[] = [];
  const prune: string[] = [];
  for (const entry of sorted) {
    const ms = Date.parse(entry.createdAt);
    if (!Number.isFinite(ms)) {
      prune.push(entry.id);
      continue;
    }
    const age = nowMs - ms;
    if (age < 0) {
      keep.push(entry.id); // future-dated: keep, never prune blindly
      continue;
    }
    const when = new Date(ms);
    if (age <= dailyWindowMs) {
      const key = `d:${entry.createdAt.slice(0, 10)}`;
      if (seenDaily.has(key)) prune.push(entry.id);
      else {
        seenDaily.add(key);
        keep.push(entry.id);
      }
    } else if (age <= weeklyWindowMs) {
      const key = `w:${isoWeekKey(when)}`;
      if (seenWeekly.has(key)) prune.push(entry.id);
      else {
        seenWeekly.add(key);
        keep.push(entry.id);
      }
    } else if (age <= monthlyWindowMs) {
      const key = `m:${entry.createdAt.slice(0, 7)}`;
      if (seenMonthly.has(key)) prune.push(entry.id);
      else {
        seenMonthly.add(key);
        keep.push(entry.id);
      }
    } else {
      prune.push(entry.id);
    }
  }
  return { keep, prune };
}

export interface PruneResult {
  kept: string[];
  pruned: Array<{ id: string; path: string }>;
}

/** Delete pruned files + their `backup_runs` rows. Returns both lists. */
export function pruneBackups(
  db?: BackupDb,
  backupDir?: string,
  nowMs: number = Date.now(),
): PruneResult {
  const sqlite = db ?? getSingletonDb();
  const dir = path.resolve(backupDir ?? resolveBackupDir());
  let rows: Array<{ id: string; path: string; created_at: string; status: string }> = [];
  try {
    rows = sqlite
      .prepare("SELECT id, path, created_at, status FROM backup_runs WHERE status != 'pruned'")
      .all() as Array<{ id: string; path: string; created_at: string; status: string }>;
  } catch {
    return { kept: [], pruned: [] };
  }
  // Safety net: a pre-restore snapshot is the undo button for a restore.
  // Never prune one inside its first 7 days, even on a crowded same-day.
  const protectedIds = new Set(
    rows
      .filter((r) => r.status === "pre-restore" && nowMs - Date.parse(r.created_at) < 7 * DAY_MS)
      .map((r) => r.id),
  );
  const { keep, prune } = selectBackupsToRetain(rows.map((r) => ({ id: r.id, createdAt: r.created_at })), nowMs);
  const kept = [...keep, ...[...protectedIds].filter((id) => !keep.includes(id))];
  const pruneFinal = prune.filter((id) => !protectedIds.has(id));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const pruned: Array<{ id: string; path: string }> = [];
  const tx = sqlite.transaction(() => {
    for (const id of pruneFinal) {
      const row = byId.get(id);
      if (!row) continue;
      const resolved = path.resolve(row.path);
      if (resolved === dir || resolved.startsWith(dir + path.sep)) {
        try {
          fs.unlinkSync(resolved);
        } catch {
          // Missing file: still drop the ledger row.
        }
      }
      sqlite.prepare("DELETE FROM backup_runs WHERE id = ?").run(id);
      pruned.push({ id, path: row.path });
    }
  });
  tx();
  return { kept, pruned };
}

/** Manual/nightly snapshot: export + enforce retention. */
export async function runBackupNow(
  db?: BackupDb,
  options: ExportBackupOptions = {},
): Promise<{ run: BackupRunEntry; pruned: Array<{ id: string; path: string }> }> {
  const sqlite = (db as BackupDb | undefined) ?? getSingletonDb();
  const exported = await exportBackup(sqlite, {
    ...options,
    status: options.status ?? "nightly",
  });
  const { pruned } = pruneBackups(sqlite, options.backupDir);
  const run = getBackupRun(sqlite, exported.backupRunId) as BackupRunEntry;
  // `/api/backup/run` exposes this list. The id is the download handle; the
  // path is informational only, so return a basename instead of leaking the
  // server's BACKUP_DIR layout to the client.
  return {
    run,
    pruned: pruned.map((entry) => ({
      id: entry.id,
      path: path.basename(entry.path),
    })),
  };
}

// ---------------------------------------------------------------------------
// Import: verify → counts (dryRun) or apply to a DB handle
// ---------------------------------------------------------------------------

export interface ImportBackupOptions extends VerifyBackupOptions {
  dryRun?: boolean;
  /** DB handle to apply into when dryRun is false (tests, temp-DB flow). */
  db?: BackupDb;
}

/** Kept compatible with the M0 stub: verify always, apply only on demand. */
export interface ImportBackupResult {
  dryRun: boolean;
  verification: BackupVerification;
  counts: Record<BackupTableKey | "settings", number>;
  applied?: { tables: BackupTableKey[]; settingsKeys: number };
}

/**
 * Verify an upload. `dryRun` (default true) returns counts only — the live
 * DB is never touched. `dryRun: false` requires `options.db` and replaces
 * that handle's allowlisted tables in one transaction (with
 * integrity_check + foreign_key_check inside the transaction, so a corrupt
 * payload rolls back instead of landing). Live-file swap, pre-restore
 * backup, and session revocation live in restore.ts.
 */
export async function importBackup(
  input: string | Uint8Array,
  options: ImportBackupOptions = {},
): Promise<ImportBackupResult> {
  const hmacKey = options.hmacKey ?? resolveHmacKey() ?? undefined;
  const verification = verifyBackupBytes(input, { ...options, hmacKey });
  if (!verification.ok || !verification.document) {
    throw new BackupVerificationError(verification.errors);
  }
  const document = verification.document;
  const counts: Record<BackupTableKey | "settings", number> = {
    lists: document.data.lists.length,
    listMembers: (document.data.listMembers ?? []).length,
    tags: (document.data.tags ?? []).length,
    tasks: document.data.tasks.length,
    taskTags: (document.data.taskTags ?? []).length,
    subtasks: (document.data.subtasks ?? []).length,
    taskCompletions: document.data.taskCompletions.length,
    taskRecurrenceExceptions: (
      document.data.taskRecurrenceExceptions ?? []
    ).length,
    settings: Object.keys(document.data.settings).length,
    conversations: document.data.conversations.length,
    activity: document.data.activity.length,
  };
  if (options.dryRun ?? true) {
    return { dryRun: true, verification, counts };
  }
  if (!options.db) {
    throw new Error(
      "importBackup with dryRun:false requires options.db; live restores go through restore.ts",
    );
  }
  applyBackupDocument(options.db, document);
  return {
    dryRun: false,
    verification,
    counts,
    applied: {
      tables: [
        "lists",
        "listMembers",
        "tags",
        "tasks",
        "taskTags",
        "subtasks",
        "taskCompletions",
        "taskRecurrenceExceptions",
        "conversations",
        "activity",
      ],
      settingsKeys: counts.settings,
    },
  };
}

function pragmaRows(db: BackupDb, name: string): unknown[] {
  const out = db.pragma(name) as unknown;
  if (Array.isArray(out)) return out;
  return [];
}

/**
 * Users are excluded from backups (password hashes must never export), but
 * lists/tasks/conversations reference `users.id`. Collect every referenced
 * user id and INSERT a stub for the missing ones: unique username, an
 * UNUSABLE password hash (never valid argon2 → login impossible), timezone
 * from the backup settings. A live restore additionally sets the
 * `login_reset_required` flag (restore.ts) — the operator completes the
 * loop with `reset-password` (CLI), which is the §8 password-reset path.
 */
function ensureBackupUsers(db: BackupDb, data: BackupData): void {
  const ids = new Set<string>();
  for (const row of data.lists) {
    if (typeof row["user_id"] === "string") ids.add(row["user_id"]);
  }
  for (const row of data.tasks) {
    if (typeof row["user_id"] === "string") ids.add(row["user_id"]);
  }
  for (const row of data.conversations) {
    if (typeof row["user_id"] === "string") ids.add(row["user_id"]);
  }
  for (const row of data.listMembers ?? []) {
    if (typeof row["user_id"] === "string") ids.add(row["user_id"]);
  }
  for (const row of data.tags ?? []) {
    if (typeof row["user_id"] === "string") ids.add(row["user_id"]);
  }
  for (const row of data.subtasks ?? []) {
    if (typeof row["user_id"] === "string") ids.add(row["user_id"]);
  }
  if (ids.size === 0) return;
  const settingsTz = data.settings["timezone"];
  const timezone = typeof settingsTz === "string" ? settingsTz : "UTC";
  const now = new Date().toISOString();
  for (const id of [...ids].sort()) {
    const existing = db.prepare("SELECT id FROM users WHERE id = ?").get(id);
    if (existing) continue;
    const ownerTaken = db
      .prepare("SELECT id FROM users WHERE username = 'owner'")
      .get();
    const username = ownerTaken
      ? `restored-${id.replaceAll("-", "").slice(0, 8)}`
      : "owner";
    db.prepare(
      `INSERT INTO users (id, username, password_hash, timezone, rev, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      id,
      username,
      `UNUSABLE-RESTORED-${randomBytes(16).toString("hex")}`,
      timezone,
      now,
      now,
    );
  }
}

/**
 * Replace a handle's allowlisted tables with a verified backup document.
 * Users/sessions/push/deliveries/scheduler state are preserved (excluded
 * from the format); settings are replaced key-by-key for allowlisted keys
 * only. integrity_check + foreign_key_check run INSIDE the transaction.
 */
export function applyBackupDocument(db: BackupDb, document: BackupDocument): void {
  const data = sanitizeBackupData(document.data);
  const tx = db.transaction(() => {
    // Users are excluded from the payload; stub the referenced ones first so
    // the inserts below satisfy `users.id` foreign keys (fresh restores).
    ensureBackupUsers(db, data);
    // Deliveries are operational, not backed up: drop history for the tasks
    // being replaced (leases/sending are cleared again in restore.ts).
    try {
      db.prepare("DELETE FROM deliveries").run();
    } catch {
      // deliveries may not exist on very old handles; non-fatal.
    }
    // Children first (task_completions → tasks → lists; messages cascade
    // from conversations, which §3 deliberately leaves unbacked-up).
    for (const table of [
      "subtasks",
      "task_tags",
      "task_completions",
      "task_recurrence_exceptions",
      "tasks",
      "tags",
      "list_members",
      "lists",
      "agent_conversations",
      "activity",
    ] as const) {
      db.prepare(`DELETE FROM ${quoteIdent(table)}`).run();
    }

    const insertRows = (table: BackupTableKey, rows: BackupRow[]): void => {
      const physical = BACKUP_PHYSICAL_TABLE[table];
      const columns = BACKUP_TABLE_ALLOWLIST[table];
      for (const row of rows) {
        const present = columns.filter((c) =>
          Object.prototype.hasOwnProperty.call(row, c),
        );
        if (present.length === 0) continue;
        db.prepare(
          `INSERT INTO ${quoteIdent(physical)} (${present.map(quoteIdent).join(", ")}) VALUES (${present.map(() => "?").join(", ")})`,
        ).run(...present.map((c) => (row[c] ?? null) as unknown));
      }
    };

    insertRows("lists", data.lists);
    insertRows("listMembers", data.listMembers ?? []);
    insertRows("tags", data.tags ?? []);
    insertRows("tasks", data.tasks);
    insertRows("taskTags", data.taskTags ?? []);
    insertRows("subtasks", data.subtasks ?? []);
    insertRows("taskCompletions", data.taskCompletions);
    insertRows(
      "taskRecurrenceExceptions",
      data.taskRecurrenceExceptions ?? [],
    );
    insertRows("conversations", data.conversations);
    insertRows("activity", data.activity);

    // Keep AUTOINCREMENT cursors above the re-inserted explicit seq values.
    try {
      db.prepare(
        `UPDATE sqlite_sequence SET seq = (SELECT COALESCE(MAX(seq), 0) FROM activity) WHERE name = 'activity'`,
      ).run();
    } catch {
      // sqlite_sequence may not exist on some handles; MAX(seq)+1 still works.
    }

    // Settings: replace allowlisted keys, preserve everything else (secrets).
    for (const key of BACKUP_SETTINGS_ALLOWLIST) {
      db.prepare("DELETE FROM settings WHERE key = ?").run(key);
    }
    const now = new Date().toISOString();
    for (const [key, value] of Object.entries(data.settings)) {
      db.prepare(
        `INSERT INTO settings (key, value, rev, updated_at) VALUES (?, ?, 1, ?)`,
      ).run(key, typeof value === "string" ? value : JSON.stringify(value), now);
    }

    const integrity = pragmaRows(db, "integrity_check") as Array<{
      integrity_check?: string;
    }>;
    const integrityOk =
      integrity.length === 1 && integrity[0]?.["integrity_check"] === "ok";
    if (!integrityOk) {
      throw new BackupVerificationError([
        `restored DB failed integrity_check: ${JSON.stringify(integrity).slice(0, 200)}`,
      ]);
    }
    const foreignKeys = pragmaRows(db, "foreign_key_check");
    if (foreignKeys.length > 0) {
      throw new BackupVerificationError([
        `restored DB failed foreign_key_check (${foreignKeys.length} violation(s))`,
      ]);
    }
  });
  try {
    tx();
  } catch (err) {
    if (err instanceof BackupVerificationError) throw err;
    if (err instanceof Error && /UNIQUE constraint failed/.test(err.message)) {
      const collectionIdentity =
        /UNIQUE constraint failed: .*(tasks\.(ical_uid|caldav_href)|tasks_collection_(ical_uid|caldav_href)_unique|task_recurrence_exceptions)/.test(
          err.message,
        );
      throw new BackupVerificationError([
        collectionIdentity
          ? `backup contains a duplicate collection identity: ${err.message}`
          : `backup contains conflicting unique values: ${err.message}`,
      ]);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Non-secret settings surface (GET/PATCH /api/settings)
// ---------------------------------------------------------------------------

/** True for secret-like keys that must never cross the settings API. */
export function isSecretLikeKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

/** Drop secret-like keys from a settings object (defense in depth). */
export function stripSecretSettings(
  settings: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (!SECRET_KEY_PATTERN.test(key)) out[key] = value;
  }
  return out;
}

