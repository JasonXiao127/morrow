/**
 * @morrow/shared — zod contracts, IDs, time helpers, recurrence engine.
 *
 * This file intentionally keeps the small auth/ETag/SSE shims created by the
 * app-server skeleton. The db/shared track extends them; it does not narrow
 * existing exports.
 */
import { z } from "zod";
import {
  DEFAULT_ALL_DAY_REMINDER_TIME,
  isOccurrenceKey,
  isUtcIso,
  isValidTimeZone,
  isWallDate,
  isWallDateTime,
  isWallTime,
  nowUtcIso,
} from "./time.js";
import type { ClampPolicy, RecurrenceMode } from "./recurrence.js";

export * from "./time.js";
export * from "./recurrence.js";
export * from "./reminders.js";

// ---------------------------------------------------------------------------
// IDs / timestamps (§3 conventions)
// ---------------------------------------------------------------------------

export const UUID_V7_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let lastUuidMs = -1;
let uuidSequence = 0;

function randomSequence(): number {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return buf[0] % 0x1000;
}

/**
 * Generate a UUIDv7 text ID. Within the same millisecond IDs are monotonic
 * (12-bit counter), so lexicographic order matches creation order in the
 * common case. Node 22 has `globalThis.crypto.getRandomValues`.
 */
export function uuidv7(now: number = Date.now()): string {
  let ms = Math.floor(now);
  if (!Number.isSafeInteger(ms) || ms < 0) {
    throw new RangeError("uuidv7 timestamp must be non-negative epoch ms");
  }

  if (ms > lastUuidMs) {
    lastUuidMs = ms;
    uuidSequence = randomSequence();
  } else {
    ms = lastUuidMs;
    uuidSequence += 1;
    if (uuidSequence > 0xfff) {
      // Counter exhausted for this millisecond: borrow the next millisecond.
      lastUuidMs += 1;
      ms = lastUuidMs;
      uuidSequence = 0;
    }
  }

  const random = new Uint8Array(10);
  globalThis.crypto.getRandomValues(random);
  const randomHex = [...random]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  const timeHex = ms.toString(16).padStart(12, "0");
  const seqHex = uuidSequence.toString(16).padStart(3, "0");
  // rand_a = 12 bits (counter), rand_b = 62 random bits, variant = 10xx.
  const variant = ((Number.parseInt(randomHex[0], 16) & 0x3) | 0x8).toString(16);
  const randB = randomHex.slice(1, 16);
  const hex = `${timeHex}7${seqHex}${variant}${randB}`;

  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20)}`
  );
}

/** Backwards-compatible alias used by the app-server skeleton. */
export const newId = uuidv7;

/** UTC ISO timestamp with fixed milliseconds (§3). */
export function nowIso(): string {
  return nowUtcIso();
}

// ---------------------------------------------------------------------------
// Fractional sort keys (§3 manual order)
// ---------------------------------------------------------------------------

/**
 * Fixed-width base62 keys. The alphabet is in ASCII order (0-9 < A-Z < a-z),
 * so SQLite's default BINARY collation sorts these correctly. Fixed width
 * means a plain lexicographic comparison is a numeric comparison.
 *
 * 62^16 ≈ 4.8e28 => ~95 midpoint splits from the full range before a
 * rebalance is needed. `sortKeyBetween` throws rather than silently producing
 * a duplicate when the gap is exhausted.
 */
export const SORT_KEY_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export const SORT_KEY_LENGTH = 16;

const SORT_BASE = 62n;
const SORT_ZERO = 0n;
const SORT_MAX = SORT_BASE ** BigInt(SORT_KEY_LENGTH) - 1n;

function encodeSortKey(value: bigint): string {
  if (value < SORT_ZERO || value > SORT_MAX) {
    throw new RangeError("sort key out of range");
  }
  let remaining = value;
  let out = "";
  for (let i = 0; i < SORT_KEY_LENGTH; i += 1) {
    const digit = Number(remaining % SORT_BASE);
    out = SORT_KEY_ALPHABET[digit] + out;
    remaining /= SORT_BASE;
  }
  return out;
}

function decodeSortKey(key: string): bigint {
  if (
    key.length !== SORT_KEY_LENGTH ||
    [...key].some((char) => !SORT_KEY_ALPHABET.includes(char))
  ) {
    throw new RangeError(`invalid sort key: ${key}`);
  }
  let value = SORT_ZERO;
  for (const char of key) {
    value = value * SORT_BASE + BigInt(SORT_KEY_ALPHABET.indexOf(char));
  }
  return value;
}

export function isSortKey(value: string): boolean {
  return (
    value.length === SORT_KEY_LENGTH &&
    [...value].every((char) => SORT_KEY_ALPHABET.includes(char))
  );
}

/** Middle of the whole key space. */
export function initialSortKey(): string {
  return encodeSortKey(SORT_MAX / 2n);
}

/**
 * Key strictly between two existing keys. `null` means unbounded on that
 * side. Throws when the gap has no integer left; the caller should rebalance.
 */
export function sortKeyBetween(
  left: string | null | undefined,
  right: string | null | undefined,
): string {
  const lo = left == null || left === "" ? SORT_ZERO : decodeSortKey(left);
  const hi =
    right == null || right === "" ? SORT_MAX : decodeSortKey(right);
  if (lo >= hi) {
    throw new RangeError("sort key bounds are not increasing");
  }
  if (hi - lo <= 1n) {
    throw new RangeError("sort key space exhausted; rebalance the list");
  }
  return encodeSortKey((lo + hi) / 2n);
}

export function sortKeyAfter(last: string | null | undefined): string {
  return sortKeyBetween(last, null);
}

export function sortKeyBefore(first: string | null | undefined): string {
  return sortKeyBetween(null, first);
}

// ---------------------------------------------------------------------------
// Shared zod primitives
// ---------------------------------------------------------------------------

export const uuidSchema = z
  .string()
  .regex(UUID_V7_RE, "expected a lowercase UUIDv7");

export const utcIsoSchema = z
  .string()
  .refine(isUtcIso, "expected UTC ISO with fixed milliseconds (…sssZ)");

export const wallDateSchema = z
  .string()
  .refine(isWallDate, "expected a valid wall date (YYYY-MM-DD)");

export const wallTimeSchema = z
  .string()
  .refine(isWallTime, "expected a valid wall time (HH:mm[:ss])");

export const wallDateTimeSchema = z
  .string()
  .refine(
    isWallDateTime,
    "expected a valid wall datetime (YYYY-MM-DDTHH:mm:ss)",
  );

export const wallDateOrDateTimeSchema = z
  .string()
  .refine(
    (value) => isWallDate(value) || isWallDateTime(value),
    "expected a wall date or wall datetime",
  );

export const timezoneSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(isValidTimeZone, "expected an IANA timezone");

/** Timed: UTC instant with millis. All-day: YYYY-MM-DD. */
export const occurrenceKeySchema = z
  .string()
  .refine(isOccurrenceKey, "expected a UTC instant or all-day date");

export const clampPolicySchema = z.enum(["skip", "last-day"]);
export const recurrenceModeSchema = z.enum(["schedule", "completion"]);
export const weekdaySchema = z.enum(["MO", "TU", "WE", "TH", "FR", "SA", "SU"]);
export const taskStatusSchema = z.enum(["open", "done", "cancelled"]);
export const completionStatusSchema = z.enum([
  "completed",
  "missed",
  "skipped",
]);
export const completionSourceSchema = z.enum(["user", "scheduler", "import"]);
export const actorSchema = z.enum(["user", "agent", "scheduler", "system"]);

export const reminderTimeSchema = wallTimeSchema.default(
  DEFAULT_ALL_DAY_REMINDER_TIME,
);

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

export const listSchema = z.object({
  id: uuidSchema,
  userId: uuidSchema,
  name: z.string().trim().min(1).max(200),
  color: z.string().max(32).nullable(),
  icon: z.string().max(64).nullable(),
  sortKey: z.string().min(1).max(64),
  isInbox: z.boolean(),
  createdBy: z.string().max(64).nullable(),
  updatedBy: z.string().max(64).nullable(),
  rev: z.number().int().positive(),
  createdAt: utcIsoSchema,
  updatedAt: utcIsoSchema,
  deletedAt: utcIsoSchema.nullable(),
});

export const listCreateSchema = z.object({
  id: uuidSchema.optional(),
  name: z.string().trim().min(1).max(200),
  color: z.string().max(32).nullable().optional(),
  icon: z.string().max(64).nullable().optional(),
  sortKey: z.string().min(1).max(64).optional(),
  isInbox: z.boolean().optional(),
});

export const listUpdateSchema = listCreateSchema
  .partial()
  .extend({ baseRev: z.number().int().positive().optional() });

export type List = z.infer<typeof listSchema>;
export type ListCreate = z.infer<typeof listCreateSchema>;
export type ListUpdate = z.infer<typeof listUpdateSchema>;

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

const taskWritableFields = {
  title: z.string().trim().min(1).max(1000),
  notes: z.string().max(100_000).nullable().optional(),
  status: taskStatusSchema.optional(),
  priority: z.number().int().min(0).max(4).optional(),
  listId: uuidSchema.nullable().optional(),
  dueAt: utcIsoSchema.nullable().optional(),
  dueDate: wallDateSchema.nullable().optional(),
  allDay: z.boolean().optional(),
  timezone: timezoneSchema.nullable().optional(),
  remindAt: utcIsoSchema.nullable().optional(),
  reminderTimeLocal: wallTimeSchema.nullable().optional(),
  remindOffsetMinutes: z.number().int().min(-43_200).max(43_200).nullable().optional(),
  snoozedUntil: utcIsoSchema.nullable().optional(),
  dtstartLocal: wallDateOrDateTimeSchema.nullable().optional(),
  nextOccurrenceAt: utcIsoSchema.nullable().optional(),
  nextOccurrenceLocal: wallDateOrDateTimeSchema.nullable().optional(),
  occurrenceSeq: z.number().int().min(0).optional(),
  rrule: z.string().trim().min(1).max(2000).nullable().optional(),
  recurrenceUntilUtc: utcIsoSchema.nullable().optional(),
  recurrenceUntilDate: wallDateSchema.nullable().optional(),
  recurrenceCount: z.number().int().min(1).max(100_000).nullable().optional(),
  wkst: weekdaySchema.nullable().optional(),
  recurrenceMode: recurrenceModeSchema.optional(),
  clampPolicy: clampPolicySchema.optional(),
  seriesEndedAt: utcIsoSchema.nullable().optional(),
  missedCount: z.number().int().min(0).optional(),
  completedAt: utcIsoSchema.nullable().optional(),
  sortKey: z.string().min(1).max(64).optional(),
} as const;

function refineTaskFields(
  value: {
    recurrenceCount?: number | null;
    recurrenceUntilUtc?: string | null;
    recurrenceUntilDate?: string | null;
    allDay?: boolean;
    dueDate?: string | null;
    dueAt?: string | null;
    dtstartLocal?: string | null;
    rrule?: string | null;
    timezone?: string | null;
  },
  ctx: z.RefinementCtx,
): void {
  const hasUntil =
    value.recurrenceUntilUtc != null || value.recurrenceUntilDate != null;
  if (value.recurrenceCount != null && hasUntil) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["recurrenceCount"],
      message: "recurrence COUNT and UNTIL are mutually exclusive",
    });
  }
  if (value.recurrenceUntilUtc != null && value.recurrenceUntilDate != null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["recurrenceUntilUtc"],
      message: "recurrenceUntilUtc and recurrenceUntilDate are mutually exclusive",
    });
  }
  if (value.allDay === true && value.dueAt != null && value.dueDate == null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["dueDate"],
      message: "all-day tasks require dueDate (no UTC-midnight dueAt)",
    });
  }
  if (value.rrule != null && value.dtstartLocal == null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["dtstartLocal"],
      message: "recurring tasks require dtstartLocal",
    });
  }
}

export const taskCreateSchema = z
  .object({
    id: uuidSchema.optional(),
    ...taskWritableFields,
  })
  .superRefine(refineTaskFields);

export const taskUpdateSchema = z
  .object({
    ...taskWritableFields,
    title: taskWritableFields.title.optional(),
    baseRev: z.number().int().positive().optional(),
    nextOccurrenceAt: utcIsoSchema.nullable().optional(),
    nextOccurrenceLocal: wallDateOrDateTimeSchema.nullable().optional(),
    occurrenceSeq: z.number().int().min(0).optional(),
    seriesEndedAt: utcIsoSchema.nullable().optional(),
    missedCount: z.number().int().min(0).optional(),
    completedAt: utcIsoSchema.nullable().optional(),
  })
  .partial()
  .superRefine(refineTaskFields);

/** Full persisted task representation (server responses/backup restore). */
export const taskSchema = z.object({
  id: uuidSchema,
  userId: uuidSchema,
  listId: uuidSchema.nullable(),
  title: z.string().min(1).max(1000),
  notes: z.string().max(100_000).nullable(),
  status: taskStatusSchema,
  priority: z.number().int().min(0).max(4),
  dueAt: utcIsoSchema.nullable(),
  dueDate: wallDateSchema.nullable(),
  allDay: z.boolean(),
  timezone: timezoneSchema.nullable(),
  remindAt: utcIsoSchema.nullable(),
  reminderTimeLocal: wallTimeSchema.nullable(),
  remindOffsetMinutes: z.number().int().nullable(),
  snoozedUntil: utcIsoSchema.nullable(),
  dtstartLocal: wallDateOrDateTimeSchema.nullable(),
  nextOccurrenceAt: utcIsoSchema.nullable(),
  nextOccurrenceLocal: wallDateOrDateTimeSchema.nullable(),
  occurrenceSeq: z.number().int().min(0),
  rrule: z.string().nullable(),
  recurrenceUntilUtc: utcIsoSchema.nullable(),
  recurrenceUntilDate: wallDateSchema.nullable(),
  recurrenceCount: z.number().int().min(1).nullable(),
  wkst: weekdaySchema.nullable(),
  recurrenceMode: recurrenceModeSchema,
  clampPolicy: clampPolicySchema,
  seriesEndedAt: utcIsoSchema.nullable(),
  missedCount: z.number().int().min(0),
  completedAt: utcIsoSchema.nullable(),
  sortKey: z.string(),
  createdBy: z.string().max(64).nullable(),
  updatedBy: z.string().max(64).nullable(),
  rev: z.number().int().positive(),
  createdAt: utcIsoSchema,
  updatedAt: utcIsoSchema,
  deletedAt: utcIsoSchema.nullable(),
});

export type Task = z.infer<typeof taskSchema>;
export type TaskCreate = z.infer<typeof taskCreateSchema>;
export type TaskUpdate = z.infer<typeof taskUpdateSchema>;
export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type RecurrenceModeValue = RecurrenceMode;
export type ClampPolicyValue = ClampPolicy;

// ---------------------------------------------------------------------------
// Completion / snooze / skip payloads
// ---------------------------------------------------------------------------

export const taskCompletionSchema = z.object({
  id: uuidSchema,
  taskId: uuidSchema,
  occurrenceKey: occurrenceKeySchema,
  status: completionStatusSchema,
  completedAt: utcIsoSchema.nullable(),
  source: completionSourceSchema,
  rev: z.number().int().positive(),
  createdAt: utcIsoSchema,
  deletedAt: utcIsoSchema.nullable(),
});

export const completeTaskSchema = z.object({
  occurrenceKey: occurrenceKeySchema.optional(),
  completedAt: utcIsoSchema.optional(),
  source: completionSourceSchema.optional(),
});

export const snoozeTaskSchema = z.object({
  until: utcIsoSchema,
});

export const skipOccurrenceSchema = z.object({
  occurrenceKey: occurrenceKeySchema.optional(),
});

export type TaskCompletion = z.infer<typeof taskCompletionSchema>;
export type CompleteTask = z.infer<typeof completeTaskSchema>;
export type SnoozeTask = z.infer<typeof snoozeTaskSchema>;

// ---------------------------------------------------------------------------
// Auth / setup schemas (kept from the app-server skeleton)
// ---------------------------------------------------------------------------

export const setupRequestSchema = z.object({
  // Required only when the server runs with SETUP_MODE=token. Open first-run
  // (the default) lets the first visitor claim the owner account.
  token: z.string().max(512).optional(),
  password: z.string().min(12).max(256),
  timezone: timezoneSchema.optional(),
});

export type SetupRequest = z.infer<typeof setupRequestSchema>;

export const loginRequestSchema = z.object({
  username: z.string().min(1).max(64).optional(),
  password: z.string().min(1).max(256),
});

export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const stepUpRequestSchema = z.object({
  password: z.string().min(1).max(256),
});

export type StepUpRequest = z.infer<typeof stepUpRequestSchema>;

// ---------------------------------------------------------------------------
// problem+json (§5)
// ---------------------------------------------------------------------------

export interface ProblemDetail {
  type: string;
  title: string;
  status: number;
  detail?: string;
  code?: string;
  traceId?: string;
}

export function problem(
  status: number,
  title: string,
  opts: { type?: string; detail?: string; code?: string; traceId?: string } = {},
): ProblemDetail {
  return {
    type: opts.type ?? `https://morrow.local/problems/${status}`,
    title,
    status,
    ...(opts.detail !== undefined ? { detail: opts.detail } : {}),
    ...(opts.code !== undefined ? { code: opts.code } : {}),
    ...(opts.traceId !== undefined ? { traceId: opts.traceId } : {}),
  };
}

// ---------------------------------------------------------------------------
// ETag / concurrency (§5)
// ---------------------------------------------------------------------------

/** Strong ETag for a revision: `"rev-N"` (including quotes). */
export function etagForRev(rev: number): string {
  return `"rev-${rev}"`;
}

/** Parse `If-Match: "rev-N"` → N, or null when missing/malformed. */
export function parseIfMatch(
  header: string | string[] | undefined,
): number | null {
  if (!header) return null;
  const v = Array.isArray(header) ? header[0] : header;
  if (!v || v.trim() === "*") return null;
  const m = /^\s*"rev-(\d+)"\s*$/.exec(v);
  if (!m) return null;
  return Number.parseInt(m[1], 10);
}

// ---------------------------------------------------------------------------
// Bootstrap shape (§5 GET /api/bootstrap)
// ---------------------------------------------------------------------------

export interface BootstrapResponse {
  user: {
    id: string;
    username: string;
    role: "owner" | "member";
    timezone: string;
    createdAt: string;
  };
  settings: Record<string, unknown>;
  lists: Array<Record<string, unknown>>;
  tasks: Array<Record<string, unknown>>;
  serverTime: string;
  maxRev: number;
  cursor: number;
  vapidPublicKey: string | null;
  agent: { enabled: boolean; connected: boolean };
}

// ---------------------------------------------------------------------------
// SSE envelope (§5)
// ---------------------------------------------------------------------------

export interface SseEnvelope<T = unknown> {
  v: 1;
  id: string;
  type: string;
  at: string;
  entity: { kind: string; id: string; rev: number };
  data: T;
}
