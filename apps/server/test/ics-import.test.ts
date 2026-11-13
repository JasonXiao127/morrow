/**
 * ICS file import: partial success, UID adoption, sequence discipline,
 * export→import round-trip, and malicious fixtures. See docs/CALDAV.md.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { closeDb, getDb } from "@morrow/db";
import { newId } from "@morrow/shared";
import { resetConfigCache } from "../src/config.js";
import { buildApp } from "../src/index.js";

const PASSWORD = "correct-horse-battery-staple-import";
const SETUP_TOKEN = "test-setup-token-import-01";

let dir = "";
let app: FastifyInstance;
let cookie = "";
let caldavToken = "";
const savedEnv: Record<string, string | undefined> = {};

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const first = Array.isArray(raw) ? raw[0] : raw;
  return String(first).split(";")[0] as string;
}

async function api(
  method: string,
  url: string,
  opts: {
    payload?: unknown;
    headers?: Record<string, string>;
  } = {},
) {
  return app.inject({
    method: method as "GET",
    url,
    headers: { cookie, ...(opts.headers ?? {}) },
    payload: opts.payload,
  });
}

async function importRaw(
  ics: string,
  listId?: string,
  headers: Record<string, string> = {},
) {
  const query = listId ? `?listId=${encodeURIComponent(listId)}` : "";
  return app.inject({
    method: "POST",
    url: `/api/import/ics${query}`,
    headers: {
      cookie,
      "content-type": "text/calendar; charset=utf-8",
      ...headers,
    },
    payload: ics,
  });
}

function ics(...components: string[]): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Import fixture//EN",
    ...components,
    "END:VCALENDAR",
  ].join("\r\n");
}

function vtodo(lines: string[]): string {
  return ["BEGIN:VTODO", ...lines, "END:VTODO"].join("\r\n");
}

function taskByUid(uid: string, listId?: string | null) {
  return getDb()
    .prepare(
      `SELECT id, title, notes, ical_uid, status, due_at, due_date, all_day,
              priority, rrule, dtstart_local, rev, list_id, remind_offset_minutes,
              completed_at
         FROM tasks
        WHERE ical_uid = ? AND deleted_at IS NULL
          ${listId === undefined ? "" : listId === null ? "AND list_id IS NULL" : "AND list_id = ?"}
        LIMIT 1`,
    )
    .get(...(listId === undefined || listId === null ? [uid] : [uid, listId])) as
    | Record<string, unknown>
    | undefined;
}

function taskCount(): number {
  return (
    getDb()
      .prepare("SELECT COUNT(*) AS n FROM tasks WHERE deleted_at IS NULL")
      .get() as { n: number }
  ).n;
}

beforeAll(async () => {
  for (const k of ["DATABASE_PATH", "SETUP_TOKEN", "APP_URL", "SECRETS_DIR"]) {
    savedEnv[k] = process.env[k];
  }
  dir = mkdtempSync(join(tmpdir(), "morrow-import-"));
  process.env["DATABASE_PATH"] = join(dir, "morrow.db");
  process.env["SETUP_TOKEN"] = SETUP_TOKEN;
  process.env["APP_URL"] = "http://localhost:3000";
  process.env["SECRETS_DIR"] = join(dir, "secrets");
  resetConfigCache();
  closeDb();
  app = await buildApp();
  const setup = await app.inject({
    method: "POST",
    url: "/api/setup",
    payload: { token: SETUP_TOKEN, password: PASSWORD, timezone: "UTC" },
  });
  expect(setup.statusCode).toBe(201);
  cookie = cookieOf(setup);
  const token = await app.inject({
    method: "POST",
    url: "/api/capture/tokens",
    headers: { cookie },
    payload: { name: "Import CalDAV", kind: "caldav" },
  });
  expect(token.statusCode).toBe(201);
  caldavToken = (token.json() as { token: string }).token;
});

afterAll(async () => {
  await app.close();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetConfigCache();
});

describe("POST /api/import/ics", () => {
  it("requires authentication", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/import/ics",
      headers: { "content-type": "text/calendar" },
      payload: ics(vtodo(["UID:auth@test", "SUMMARY:Auth"])),
    });
    expect(res.statusCode).toBe(401);
  });

  it("imports VTODO and VEVENT, reports a bad component, and stays VTODO-only", async () => {
    const list = await api("POST", "/api/lists", {
      payload: { id: newId(), name: "Imported mix" },
    });
    expect(list.statusCode).toBe(201);
    const listId = (list.json() as { id: string }).id;

    const body = ics(
      vtodo([
        "UID:mixed-vtodo@test",
        "SUMMARY:Vtodo import",
        "DUE;VALUE=DATE:20261110",
        "PRIORITY:1",
        "CATEGORIES:Home,Work",
      ]),
      [
        "BEGIN:VEVENT",
        "UID:mixed-event@test",
        "SUMMARY:Event import",
        "DTSTART:20261111T090000Z",
        "DTEND:20261111T103000Z",
        "DESCRIPTION:From an event",
        "END:VEVENT",
      ].join("\r\n"),
      vtodo([
        "UID:bad@test",
        "SUMMARY:Bad component",
        "DUE:20261112T090000Z",
        "DURATION:PT1H",
      ]),
    );
    const res = await importRaw(body, listId);
    expect(res.statusCode).toBe(200);
    const json = res.json() as {
      ok: boolean;
      totals: Record<string, number>;
      failures: Array<{ index: number; code: string }>;
    };
    expect(json.ok).toBe(false);
    expect(json.totals["imported"]).toBe(2);
    expect(json.totals["failed"]).toBe(1);
    expect(json.failures[0]?.code).toBe("due_and_duration");

    const todo = taskByUid("mixed-vtodo@test", listId);
    expect(todo?.["title"]).toBe("Vtodo import");
    expect(todo?.["due_date"]).toBe("2026-11-10");
    expect(todo?.["all_day"]).toBe(1);
    // iCalendar PRIORITY 1 → Morrow highest (4), per the documented mapping.
    expect(todo?.["priority"]).toBe(4);

    // VEVENT is converted to a task deadlines, never stored as an event.
    const event = taskByUid("mixed-event@test", listId);
    expect(event?.["title"]).toBe("Event import");
    expect(event?.["due_at"]).toBe("2026-11-11T10:30:00.000Z");
    expect(event?.["notes"]).toBe("From an event");

    const feed = await app.inject({
      method: "GET",
      url: `/api/tasks.ics?token=${encodeURIComponent(caldavToken)}`,
    });
    expect(feed.statusCode).toBe(200);
    expect(feed.body).toContain("BEGIN:VTODO");
    expect(feed.body).not.toContain("BEGIN:VEVENT");
    expect(feed.body).toContain("UID:mixed-event@test");
  });

  it("adopts a foreign UID and mints a native UID when one is absent", async () => {
    const list = await api("POST", "/api/lists", {
      payload: { id: newId(), name: "UID adoption" },
    });
    const listId = (list.json() as { id: string }).id;
    const res = await importRaw(
      ics(
        vtodo(["UID:foreign-adopted@test", "SUMMARY:Adopted"]),
        vtodo(["SUMMARY:No uid supplied"]),
      ),
      listId,
    );
    expect(res.statusCode).toBe(200);
    expect((res.json() as { totals: { imported: number } }).totals.imported).toBe(2);
    expect(taskByUid("foreign-adopted@test", listId)).toBeTruthy();

    const minted = getDb()
      .prepare(
        "SELECT id, ical_uid FROM tasks WHERE title = 'No uid supplied' AND deleted_at IS NULL",
      )
      .get() as { id: string; ical_uid: string } | undefined;
    expect(minted).toBeTruthy();
    expect(minted?.ical_uid).toBe(`${minted?.id}@morrow`);
  });

  it("is idempotent at equal SEQUENCE and reports conflicts instead of duplicating", async () => {
    const list = await api("POST", "/api/lists", {
      payload: { id: newId(), name: "Sequence discipline" },
    });
    const listId = (list.json() as { id: string }).id;
    const first = ics(
      vtodo([
        "UID:sequence@test",
        "SUMMARY:First version",
        "SEQUENCE:1",
        "DUE;VALUE=DATE:20261115",
      ]),
    );
    const created = await importRaw(first, listId);
    expect((created.json() as { totals: { imported: number } }).totals.imported).toBe(1);
    const row = taskByUid("sequence@test", listId);
    const rev = row?.["rev"] as number;
    const before = taskCount();

    const again = await importRaw(first, listId);
    const againJson = again.json() as {
      ok: boolean;
      totals: { imported: number; unchanged: number; updated: number };
    };
    expect(again.statusCode).toBe(200);
    expect(againJson.ok).toBe(true);
    expect(againJson.totals.unchanged).toBe(1);
    expect(againJson.totals.imported).toBe(0);
    expect(againJson.totals.updated).toBe(0);
    expect(taskCount()).toBe(before);
    expect(taskByUid("sequence@test", listId)?.["rev"]).toBe(rev);

    // Equal SEQUENCE with different content is a conflict, not a duplicate.
    const equalDifferent = await importRaw(
      ics(
        vtodo([
          "UID:sequence@test",
          "SUMMARY:Changed without bumping sequence",
          "SEQUENCE:1",
          "DUE;VALUE=DATE:20261115",
        ]),
      ),
      listId,
    );
    const conflictJson = equalDifferent.json() as {
      ok: boolean;
      totals: { conflict: number };
    };
    expect(conflictJson.ok).toBe(false);
    expect(conflictJson.totals.conflict).toBe(1);
    expect(taskByUid("sequence@test", listId)?.["title"]).toBe("First version");
    expect(taskCount()).toBe(before);

    // A lower SEQUENCE is stale and cannot overwrite.
    const stale = await importRaw(
      ics(
        vtodo([
          "UID:sequence@test",
          "SUMMARY:Older version",
          "SEQUENCE:0",
          "DUE;VALUE=DATE:20261115",
        ]),
      ),
      listId,
    );
    expect((stale.json() as { totals: { stale: number } }).totals.stale).toBe(1);
    expect(taskByUid("sequence@test", listId)?.["title"]).toBe("First version");

    // A higher SEQUENCE wins.
    const newer = await importRaw(
      ics(
        vtodo([
          "UID:sequence@test",
          "SUMMARY:Second version",
          "SEQUENCE:2",
          "DUE;VALUE=DATE:20261116",
        ]),
      ),
      listId,
    );
    expect((newer.json() as { totals: { updated: number } }).totals.updated).toBe(1);
    expect(taskByUid("sequence@test", listId)?.["title"]).toBe("Second version");
    expect(taskByUid("sequence@test", listId)?.["due_date"]).toBe("2026-11-16");
  });

  it("round-trips an exported VTODO feed into another list", async () => {
    const source = await api("POST", "/api/lists", {
      payload: { id: newId(), name: "Round-trip source" },
    });
    const sourceId = (source.json() as { id: string }).id;
    const created = await api("POST", "/api/tasks", {
      payload: {
        id: newId(),
        title: "Round-trip task",
        notes: "Line one\nLine two",
        listId: sourceId,
        dueDate: "2026-12-01",
        priority: 3,
        status: "open",
      },
    });
    expect(created.statusCode).toBe(201);

    const exportFeed = await app.inject({
      method: "GET",
      url: `/api/tasks.ics?token=${encodeURIComponent(caldavToken)}`,
    });
    expect(exportFeed.statusCode).toBe(200);
    expect(exportFeed.body).toContain("Round-trip task");

    const destination = await api("POST", "/api/lists", {
      payload: { id: newId(), name: "Round-trip destination" },
    });
    const destinationId = (destination.json() as { id: string }).id;
    const imported = await importRaw(exportFeed.body, destinationId);
    const json = imported.json() as {
      ok: boolean;
      totals: { imported: number; failed: number; conflict: number };
    };
    expect(json.totals.imported).toBeGreaterThanOrEqual(1);
    expect(json.totals.failed).toBe(0);
    expect(json.totals.conflict).toBe(0);

    const roundTripped = getDb()
      .prepare(
        `SELECT title, notes, due_date, priority, status FROM tasks
          WHERE list_id = ? AND deleted_at IS NULL AND title = 'Round-trip task'`,
      )
      .get(destinationId) as
      | {
          title: string;
          notes: string;
          due_date: string;
          priority: number;
          status: string;
        }
      | undefined;
    expect(roundTripped).toMatchObject({
      title: "Round-trip task",
      notes: "Line one\nLine two",
      due_date: "2026-12-01",
      priority: 3,
      status: "open",
    });
  });

  it("strips HTML from X-ALT-DESC and never fetches or stores ATTACH", async () => {
    const list = await api("POST", "/api/lists", {
      payload: { id: newId(), name: "Malicious fixture" },
    });
    const listId = (list.json() as { id: string }).id;
    const body = ics(
      vtodo([
        "UID:html@test",
        "SUMMARY:HTML fallback",
        "X-ALT-DESC;FMTTYPE=text/html:<html><body><script>alert(1)</script><p>Hello <b>world</b></p></body></html>",
        "ATTACH:https://127.0.0.1:1/private",
      ]),
    );
    const res = await importRaw(body, listId);
    expect(res.statusCode).toBe(200);
    const json = res.json() as { results: Array<{ status: string }> };
    expect(json.results[0]?.status).toBe("imported");
    const row = taskByUid("html@test", listId);
    expect(row?.["notes"]).toBe("Hello world");
    expect(String(row?.["notes"] ?? "")).not.toContain("<");
    const attachments = getDb()
      .prepare("SELECT COUNT(*) AS n FROM attachments")
      .get() as { n: number };
    expect(attachments.n).toBe(0);
  });

  it("rejects an oversized file and fails only an oversized component", async () => {
    const list = await api("POST", "/api/lists", {
      payload: { id: newId(), name: "Size limits" },
    });
    const listId = (list.json() as { id: string }).id;

    const huge = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTODO\r\nUID:huge@test\r\nSUMMARY:${"x".repeat(1024 * 1024 + 10)}\r\nEND:VTODO\r\nEND:VCALENDAR`;
    const tooLarge = await importRaw(huge, listId);
    expect(tooLarge.statusCode).toBe(413);

    const withOversizedLine = ics(
      vtodo(["UID:ok-beside-bad@test", "SUMMARY:Good neighbour"]),
      vtodo([
        "UID:oversized@test",
        `SUMMARY:${"y".repeat(9000)}`,
      ]),
    );
    const partial = await importRaw(withOversizedLine, listId);
    expect(partial.statusCode).toBe(200);
    const json = partial.json() as {
      totals: { imported: number; failed: number };
      failures: Array<{ code: string }>;
    };
    expect(json.totals.imported).toBe(1);
    expect(json.totals.failed).toBe(1);
    expect(json.failures[0]?.code).toBe("oversized_line");
    expect(taskByUid("ok-beside-bad@test", listId)).toBeTruthy();
    expect(taskByUid("oversized@test", listId)).toBeFalsy();
  });

  it("rejects RECURRENCE-ID and EXDATE components instead of dropping them", async () => {
    const series = vtodo([
      "UID:import-series@test",
      "SUMMARY:Imported series",
      "DTSTART:20260115T090000Z",
      "DUE:20260115T093000Z",
      "RRULE:FREQ=DAILY;COUNT=3",
    ]);
    const exception = vtodo([
      "UID:import-series@test",
      "RECURRENCE-ID:20260116T090000Z",
      "SUMMARY:Moved occurrence",
      "DUE:20260116T113000Z",
    ]);
    const excluded = vtodo([
      "UID:import-exdate@test",
      "SUMMARY:Excluded occurrence",
      "DTSTART:20260115T090000Z",
      "RRULE:FREQ=DAILY;COUNT=3",
      "EXDATE:20260115T090000Z",
    ]);
    const eventExcluded = [
      "BEGIN:VEVENT",
      "UID:import-event-exdate@test",
      "SUMMARY:Excluded event occurrence",
      "DTSTART:20260115T090000Z",
      "DTEND:20260115T100000Z",
      "RRULE:FREQ=DAILY;COUNT=3",
      "EXDATE:20260116T090000Z",
      "END:VEVENT",
    ].join("\r\n");
    const res = await importRaw(
      ics(series, exception, excluded, eventExcluded),
    );
    expect(res.statusCode).toBe(200);
    const json = res.json() as {
      totals: { imported: number; failed: number };
      failures: Array<{ code: string; uid: string | null }>;
    };
    expect(json.totals.imported).toBe(1);
    expect(json.totals.failed).toBe(3);
    expect(json.failures.map((failure) => failure.code)).toEqual([
      "recurrence_unsupported",
      "recurrence_unsupported",
      "recurrence_unsupported",
    ]);
    expect(json.failures.map((failure) => failure.uid)).toEqual([
      "import-series@test",
      "import-exdate@test",
      "import-event-exdate@test",
    ]);
    expect(taskByUid("import-series@test")).toBeTruthy();
    expect(taskByUid("import-exdate@test")).toBeFalsy();
  });

  it("defaults to Inbox, accepts JSON bodies, and rejects an inaccessible list", async () => {
    const jsonImport = await app.inject({
      method: "POST",
      url: "/api/import/ics",
      headers: { cookie, "content-type": "application/json" },
      payload: {
        ics: ics(vtodo(["UID:json@test", "SUMMARY:JSON import"])),
      },
    });
    expect(jsonImport.statusCode).toBe(200);
    const inboxTask = getDb()
      .prepare(
        "SELECT id, list_id, ical_uid FROM tasks WHERE ical_uid = 'json@test' AND deleted_at IS NULL",
      )
      .get() as { id: string; list_id: string | null } | undefined;
    expect(inboxTask).toBeTruthy();

    const missing = await importRaw(
      ics(vtodo(["UID:missing-list@test", "SUMMARY:Nope"])),
      "does-not-exist",
    );
    expect(missing.statusCode).toBe(404);
  });
});
