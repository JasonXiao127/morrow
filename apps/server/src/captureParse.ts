/**
 * M1 deterministic capture parser (§5 `POST /api/capture/parse`, §11 M1).
 *
 * Pure function of (text, timezone, now): no network, no model, no secrets.
 * Handles the v0.1 capture surface:
 *
 *   - dates: `today`, `tonight` (21:00), `tomorrow`, `next week`,
 *     weekday names (`Fri`, `Friday`, `next Mon`), ISO `YYYY-MM-DD`,
 *     relative `in 2h` / `in 30m` / `in 3 days`
 *   - times: `9am`, `9:30pm`, `14:00`, `noon`, `midnight`
 *   - recurrence: `everyday` / `every day|week|month|year`,
 *     `every Mon` (→ `FREQ=WEEKLY;BYDAY=MO`)
 *   - priorities `#p1`…`#p4` (p1 = most urgent = 4), lists `@name`
 *
 * Returns camelCase fields matching the PWA `ParsedCapture` shape plus a
 * 0–1 `confidence`. Anything with `ai: true` gets a 503 with the M4 flag —
 * the one-shot LLM fallback is an M4 track and must never silently run here.
 */
import type { FastifyInstance } from "fastify";
import {
  addWallDays,
  isValidTimeZone,
  isWallDate,
  nowIso,
  resolveWallTime,
} from "@morrow/shared";
import { authenticateRequest } from "./auth.js";
import { badRequest, sendProblem, unauthorized } from "./errors.js";
import { todayKeyInTz } from "./tasks.js";

interface CaptureResult {
  title: string;
  dueAt: string | null;
  dueDate: string | null;
  allDay: boolean;
  remindAt: string | null;
  reminderTimeLocal: string | null;
  rrule: string | null;
  dtstartLocal: string | null;
  priority: number;
  listName: string | null;
  confidence: number;
}

const WEEKDAY_ALIASES: Array<{ names: string[]; idx: number; byday: string }> = [
  { names: ["sun", "sunday"], idx: 0, byday: "SU" },
  { names: ["mon", "monday"], idx: 1, byday: "MO" },
  { names: ["tue", "tues", "tuesday"], idx: 2, byday: "TU" },
  { names: ["wed", "wednesday"], idx: 3, byday: "WE" },
  { names: ["thu", "thur", "thurs", "thursday"], idx: 4, byday: "TH" },
  { names: ["fri", "friday"], idx: 5, byday: "FR" },
  { names: ["sat", "saturday"], idx: 6, byday: "SA" },
];

const WEEKDAY_PATTERN = "sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r?s?(?:day)?)?|fri(?:day)?|sat(?:urday)?";

function weekdayIndex(name: string): { idx: number; byday: string } | null {
  const lower = name.toLowerCase();
  for (const day of WEEKDAY_ALIASES) {
    if (day.names.includes(lower)) return { idx: day.idx, byday: day.byday };
  }
  return null;
}

/** 0=Sunday..6=Saturday for the wall date in `tz`. */
function weekdayIndexInTz(now: Date, tz: string): number {
  try {
    const short = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
    }).format(now);
    const found = weekdayIndex(short);
    if (found) return found.idx;
  } catch {
    // fall through to UTC
  }
  return now.getUTCDay();
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

interface TimeOfDay {
  hour: number;
  minute: number;
  token: string;
}

/** Find a time expression; returns clock time + the matched source text. */
function findTime(lower: string): TimeOfDay | null {
  const ampm =
    /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/.exec(lower);
  if (ampm) {
    let hour = Number.parseInt(ampm[1] as string, 10);
    const minute = ampm[2] !== undefined ? Number.parseInt(ampm[2], 10) : 0;
    const meridiem = ampm[3] as string;
    if (hour < 1 || hour > 12 || minute > 59) return null;
    if (meridiem === "am") {
      if (hour === 12) hour = 0;
    } else if (hour !== 12) {
      hour += 12;
    }
    return { hour, minute, token: ampm[0] };
  }
  const h24 = /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(lower);
  if (h24) {
    return {
      hour: Number.parseInt(h24[1] as string, 10),
      minute: Number.parseInt(h24[2] as string, 10),
      token: h24[0],
    };
  }
  if (/\bnoon\b/.test(lower)) return { hour: 12, minute: 0, token: "noon" };
  if (/\bmidnight\b/.test(lower)) return { hour: 0, minute: 0, token: "midnight" };
  return null;
}

function removeTokenOnce(haystack: string, token: string): string {
  const idx = haystack.toLowerCase().indexOf(token.toLowerCase());
  if (idx < 0) return haystack;
  return (haystack.slice(0, idx) + " " + haystack.slice(idx + token.length));
}

function cleanTitle(rest: string, fallback: string): string {
  const collapsed = rest.replace(/[\s,;]+/g, " ").trim();
  if (collapsed.replace(/[\s,;.!\-]+/g, "") === "") return fallback;
  return collapsed.replace(/^[,;\s]+|[,;\s]+$/g, "");
}

export function parseCapture(
  text: string,
  timezone: string,
  now: Date = new Date(),
): CaptureResult {
  let rest = ` ${text.trim()} `;
  let priority = 0;
  let listName: string | null = null;
  let rrule: string | null = null;
  let dateWall: string | null = null;
  let time: TimeOfDay | null = null;
  let relativeMs: number | null = null;
  let relativeAllDay: string | null = null;
  let sawDate = false;
  let sawTime = false;
  let sawRecurrence = false;

  // Priority + list first (orthogonal tokens).
  const pri = /(?:^|\s)#p([1-4])\b/i.exec(rest);
  if (pri) {
    const level = Number.parseInt(pri[1] as string, 10);
    priority = 5 - level; // #p1 (most urgent) → 4 … #p4 → 1
    rest = removeTokenOnce(rest, pri[0].trim());
  }
  const list = /(?:^|\s)@([\p{L}\p{N}][\p{L}\p{N}_-]*)/u.exec(rest);
  if (list) {
    listName = list[1] as string;
    rest = removeTokenOnce(rest, list[0].trim());
  }

  const lower0 = rest.toLowerCase();

  // Recurrence.
  if (/\bevery\s*day\b|\beveryday\b/.test(lower0)) {
    rrule = "RRULE:FREQ=DAILY";
    sawRecurrence = true;
    rest = rest.replace(/\bevery\s*day\b|\beveryday\b/i, " ");
  } else {
    const everyWeekday = new RegExp(
      `\\bevery\\s+(${WEEKDAY_PATTERN})s?\\b`,
      "i",
    ).exec(rest);
    if (everyWeekday) {
      const day = weekdayIndex(everyWeekday[1] as string);
      if (day) {
        rrule = `RRULE:FREQ=WEEKLY;BYDAY=${day.byday}`;
        sawRecurrence = true;
        // Anchor the first occurrence on the named weekday, not today. The
        // recurrence engine treats DTSTART as the first instance.
        const todayWall = todayKeyInTz(timezone, now);
        const todayIdx = weekdayIndexInTz(now, timezone);
        const delta = (day.idx - todayIdx + 7) % 7;
        dateWall = addWallDays(todayWall, delta);
        sawDate = true;
        rest = removeTokenOnce(rest, everyWeekday[0]);
      }
    } else if (/\bevery\s+week\b/i.test(rest)) {
      rrule = "RRULE:FREQ=WEEKLY";
      sawRecurrence = true;
      rest = rest.replace(/\bevery\s+week\b/i, " ");
    } else if (/\bevery\s+month\b/i.test(rest)) {
      rrule = "RRULE:FREQ=MONTHLY";
      sawRecurrence = true;
      rest = rest.replace(/\bevery\s+month\b/i, " ");
    } else if (/\bevery\s+year\b/i.test(rest)) {
      rrule = "RRULE:FREQ=YEARLY";
      sawRecurrence = true;
      rest = rest.replace(/\bevery\s+year\b/i, " ");
    }
  }

  // Relative `in N <unit>` — minutes/hours are timed, days/weeks are dates.
  const rel = /\bin\s+(\d+)\s*(minutes?|mins?|m|hours?|hrs?|hr|h|days?|d|weeks?|w)\b/i.exec(rest);
  if (rel) {
    const n = Number.parseInt(rel[1] as string, 10);
    const unit = (rel[2] as string).toLowerCase();
    const todayWall = todayKeyInTz(timezone, now);
    if (unit[0] === "m" || unit[0] === "h") {
      const ms = unit[0] === "m" ? n * 60_000 : n * 3_600_000;
      relativeMs = now.getTime() + ms;
      sawDate = true;
    } else if (unit[0] === "d") {
      relativeAllDay = addWallDays(todayWall, n);
      sawDate = true;
    } else {
      relativeAllDay = addWallDays(todayWall, n * 7);
      sawDate = true;
    }
    rest = removeTokenOnce(rest, rel[0]);
  }

  // Explicit ISO date.
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(rest);
  if (iso && !dateWall && relativeAllDay === null) {
    const candidate = `${iso[1]}-${iso[2]}-${iso[3]}`;
    if (isWallDate(candidate)) {
      dateWall = candidate;
      sawDate = true;
      rest = removeTokenOnce(rest, iso[0]);
    }
  }

  // Weekday names (“Fri”, “next Mon”).
  if (!dateWall && relativeAllDay === null) {
    const named = new RegExp(`\\b(next\\s+)?(${WEEKDAY_PATTERN})\\b`, "i").exec(rest);
    if (named) {
      const day = weekdayIndex(named[2] as string);
      if (day) {
        const todayWall = todayKeyInTz(timezone, now);
        const todayIdx = weekdayIndexInTz(now, timezone);
        const isNext = /\bnext\s+/i.test(named[1] ?? "");
        let delta = (day.idx - todayIdx + 7) % 7;
        if (delta === 0 && isNext) delta = 7;
        if (isNext) delta += 7;
        dateWall = addWallDays(todayWall, delta);
        sawDate = true;
        rest = removeTokenOnce(rest, named[0]);
      }
    }
  }

  // Named days.
  if (!dateWall && relativeAllDay === null) {
    const todayWall = todayKeyInTz(timezone, now);
    const lower = rest.toLowerCase();
    if (/\btonight\b/.test(lower)) {
      dateWall = todayWall;
      time = { hour: 21, minute: 0, token: "tonight" };
      sawDate = true;
      sawTime = true;
      rest = rest.replace(/\btonight\b/i, " ");
    } else if (/\btomorrow\b/.test(lower)) {
      dateWall = addWallDays(todayWall, 1);
      sawDate = true;
      rest = rest.replace(/\btomorrow\b/i, " ");
    } else if (/\bnext\s+week\b/.test(lower)) {
      dateWall = addWallDays(todayWall, 7);
      sawDate = true;
      rest = rest.replace(/\bnext\s+week\b/i, " ");
    } else if (/\btoday\b/.test(lower)) {
      dateWall = todayWall;
      sawDate = true;
      rest = rest.replace(/\btoday\b/i, " ");
    }
  }

  // Time of day (after dates so “tomorrow 9am” composes).
  if (!time) {
    const found = findTime(rest.toLowerCase());
    if (found) {
      time = found;
      sawTime = true;
      rest = removeTokenOnce(rest, found.token);
    }
  } else {
    // “tonight” consumed the time token already.
    sawTime = true;
  }

  // Compose timed vs all-day.
  let dueAt: string | null = null;
  let dueDate: string | null = null;
  let allDay = false;
  let remindAt: string | null = null;
  let reminderTimeLocal: string | null = null;
  let dtstartLocal: string | null = null;

  if (relativeMs !== null) {
    dueAt = new Date(relativeMs).toISOString();
    remindAt = dueAt;
  } else {
    const baseDate = dateWall ?? relativeAllDay;
    if (baseDate && time) {
      const wall = `${baseDate}T${pad2(time.hour)}:${pad2(time.minute)}:00`;
      try {
        const resolved = resolveWallTime(wall, timezone);
        dueAt = resolved.instantIso;
        remindAt = dueAt;
      } catch {
        dueDate = baseDate;
        allDay = true;
      }
    } else if (baseDate) {
      dueDate = baseDate;
      allDay = true;
      reminderTimeLocal = "09:00:00";
    } else if (time) {
      // Time without a date: today if still ahead, else tomorrow.
      const todayWall = todayKeyInTz(timezone, now);
      const wallToday = `${todayWall}T${pad2(time.hour)}:${pad2(time.minute)}:00`;
      try {
        const resolved = resolveWallTime(wallToday, timezone);
        if (Date.parse(resolved.instantIso) > now.getTime()) {
          dueAt = resolved.instantIso;
        } else {
          const tomorrow = addWallDays(todayWall, 1);
          dueAt = resolveWallTime(
            `${tomorrow}T${pad2(time.hour)}:${pad2(time.minute)}:00`,
            timezone,
          ).instantIso;
        }
        remindAt = dueAt;
      } catch {
        // Unresolvable wall time: leave undated rather than guessing.
      }
    }
  }

  // Recurring series anchor on the resolved (date, time).
  if (rrule) {
    const anchorDate =
      dueDate ?? (dueAt ? todayKeyInTz(timezone, new Date(dueAt)) : null);
    if (dueAt || dueDate) {
      if (dueAt) {
        const wall = resolveWallTimeToLocal(dueAt, timezone);
        dtstartLocal = wall ?? `${anchorDate}T${time ? `${pad2(time.hour)}:${pad2(time.minute)}:00` : "09:00:00"}`;
      } else {
        dtstartLocal = `${anchorDate}T${time ? `${pad2(time.hour)}:${pad2(time.minute)}:00` : "09:00:00"}`;
      }
    } else {
      const todayWall = todayKeyInTz(timezone, now);
      const clock = time
        ? `${pad2(time.hour)}:${pad2(time.minute)}:00`
        : "09:00:00";
      dtstartLocal = `${todayWall}T${clock}`;
      try {
        const resolved = resolveWallTime(dtstartLocal, timezone);
        if (time) {
          dueAt = resolved.instantIso;
          remindAt = dueAt;
        } else {
          dueDate = todayWall;
          allDay = true;
          reminderTimeLocal = "09:00:00";
        }
      } catch {
        // leave undated
      }
    }
  }

  const title = cleanTitle(rest, text.trim());

  let confidence = 0.45;
  if (sawDate) confidence += 0.15;
  if (sawTime) confidence += 0.1;
  if (sawRecurrence) confidence += 0.1;
  if (priority > 0) confidence += 0.05;
  if (listName) confidence += 0.05;
  confidence = Math.min(0.95, Math.round(confidence * 100) / 100);

  return {
    title,
    dueAt,
    dueDate,
    allDay,
    remindAt,
    reminderTimeLocal,
    rrule,
    dtstartLocal,
    priority,
    listName,
    confidence,
  };
}

/** Best-effort wall representation of a UTC instant in `tz` (YYYY-MM-DDTHH:mm:ss). */
function resolveWallTimeToLocal(instantIso: string, tz: string): string | null {
  try {
    const ms = Date.parse(instantIso);
    if (Number.isNaN(ms)) return null;
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(ms));
    const get = (type: string): string =>
      parts.find((p) => p.type === type)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
  } catch {
    return null;
  }
}

export async function registerCaptureRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/capture/parse", async (req, reply) => {
    const auth = authenticateRequest(req);
    if (!auth) return unauthorized(req, reply);
    const body =
      req.body !== null && typeof req.body === "object"
        ? (req.body as Record<string, unknown>)
        : null;
    if (!body) return badRequest(req, reply, "Invalid capture payload.");

    // The one-shot LLM fallback is an M4 track: never run a model here.
    if (body["ai"] === true) {
      reply.header("x-morrow-m4", "capture-ai");
      return sendProblem(req, reply, 503, "Service Unavailable", {
        detail:
          "AI-assisted capture arrives with M4. The deterministic parser remains available with ai:false.",
        code: "ai_unavailable",
      });
    }

    const text = typeof body["text"] === "string" ? body["text"].trim() : "";
    if (text.length < 1 || text.length > 2000) {
      return badRequest(req, reply, "text must be 1–2000 characters.");
    }
    const tzRaw =
      typeof body["timezone"] === "string" && body["timezone"] !== ""
        ? body["timezone"]
        : (auth.user.timezone ?? "UTC");
    if (!isValidTimeZone(tzRaw)) {
      return badRequest(req, reply, "Unknown timezone.", "invalid_timezone");
    }

    const parsed = parseCapture(text, tzRaw);
    return reply.send({ ...parsed, serverTime: nowIso() });
  });
}
