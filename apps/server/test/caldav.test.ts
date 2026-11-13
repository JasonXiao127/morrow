/**
 * Round 4 CalDAV VTODO route tests: client hrefs/UIDs, conditional writes,
 * resource PROPFIND, calendar-query/multiget, dynamic ctag, and the separate
 * VTODO feed. The existing VEVENT feed stays separate.
 */
import crypto from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { closeDb, getDb } from "@morrow/db";
import { newId } from "@morrow/shared";
import { resetConfigCache } from "../src/config.js";
import { invalidateCalDavSync } from "../src/caldavSync.js";
import { buildApp } from "../src/index.js";

const PASSWORD = "correct-horse-battery-staple-caldav";
const SETUP_TOKEN = "test-setup-token-caldav-01";

let dir = "";
let app: FastifyInstance;
let cookie = "";
let caldavToken = "";
let basic = "";
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
    cookie?: string;
  } = {},
) {
  return app.inject({
    method: method as "GET",
    url,
    headers: { cookie: opts.cookie ?? cookie, ...(opts.headers ?? {}) },
    payload: opts.payload,
  });
}

async function dav(
  method: string,
  path: string,
  opts: {
    body?: string;
    headers?: Record<string, string>;
    token?: string;
  } = {},
) {
  return app.inject({
    method: method as "GET",
    url: `/caldav${path}`,
    headers: {
      authorization: `Basic ${Buffer.from(`owner:${opts.token ?? caldavToken}`).toString("base64")}`,
      ...(opts.body !== undefined
        ? { "content-type": "text/calendar; charset=utf-8" }
        : {}),
      ...(opts.headers ?? {}),
    },
    payload: opts.body,
  });
}

function vtodo(
  uid: string,
  summary: string,
  extra: string[] = [],
): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Morrow test//EN",
    "BEGIN:VTODO",
    `UID:${uid}`,
    `SUMMARY:${summary}`,
    ...extra,
    "END:VTODO",
    "END:VCALENDAR",
  ].join("\r\n");
}

function taskIdForUid(uid: string): string {
  const row = getDb()
    .prepare("SELECT id FROM tasks WHERE ical_uid = ? AND deleted_at IS NULL")
    .get(uid) as { id: string } | undefined;
  if (!row) throw new Error(`no task for UID ${uid}`);
  return row.id;
}

function ctagOf(body: string): string {
  return /<cs:getctag>([^<]+)<\/cs:getctag>/.exec(body)?.[1] ?? "";
}

function syncBody(token: string, level = "1"): string {
  return `<?xml version="1.0"?><d:sync-collection xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav"><d:sync-token>${token}</d:sync-token><d:sync-level>${level}</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>`;
}

function syncTokenOf(body: string): string {
  return /<d:sync-token>([^<]+)<\/d:sync-token>/.exec(body)?.[1] ?? "";
}

const PROPFIND_BODY =
  '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/"><d:prop><d:resourcetype/><cal:supported-calendar-component-set/><d:supported-report-set/><cs:getctag/></d:prop></d:propfind>';

beforeAll(async () => {
  for (const k of ["DATABASE_PATH", "SETUP_TOKEN", "APP_URL", "SECRETS_DIR"]) {
    savedEnv[k] = process.env[k];
  }
  dir = mkdtempSync(join(tmpdir(), "morrow-caldav-"));
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
  const token = await api("POST", "/api/capture/tokens", {
    payload: { name: "CalDAV", kind: "caldav" },
  });
  expect(token.statusCode).toBe(201);
  caldavToken = (token.json() as { token: string }).token;
  basic = Buffer.from(`owner:${caldavToken}`).toString("base64");
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

describe("CalDAV VTODO discovery", () => {
  it("advertises VTODO, reports, and a dynamic ctag (not VEVENT)", async () => {
    const res = await dav("PROPFIND", "/calendars/inbox/", {
      body: PROPFIND_BODY,
      headers: { depth: "0" },
    });
    expect(res.statusCode).toBe(207);
    expect(res.headers["dav"]).toBe("1, calendar-access");
    expect(res.body).toContain('<cal:comp name="VTODO"/>');
    expect(res.body).not.toContain('<cal:comp name="VEVENT"/>');
    expect(res.body).toContain("<cal:calendar-query/>");
    expect(res.body).toContain("<cal:calendar-multiget/>");
    expect(res.body).toContain("<d:sync-collection/>");
    expect(res.body).toContain("<d:sync-token>urn:morrow:sync:");
    expect(ctagOf(res.body)).not.toBe("");
  });

  it("redirects GET and PROPFIND from the RFC 6764 well-known URI", async () => {
    for (const method of ["GET", "PROPFIND"] as const) {
      const res = await app.inject({ method, url: "/.well-known/caldav" });
      expect(res.statusCode).toBe(301);
      expect(res.headers["location"]).toBe("/caldav/");
    }
  });

  it("authenticates with a CalDAV token and rejects no token", async () => {
    const unauthorized = await app.inject({
      method: "GET",
      url: "/caldav/calendars/inbox/nope.ics",
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.headers["www-authenticate"]).toContain("Basic");
  });
});

describe("VTODO PUT/GET/DELETE round-trip", () => {
  it("accepts a client-chosen non-UUID href and preserves the client UID", async () => {
    const uid = "client-uid-roundtrip@example.test";
    const href = "client-picked-name.ics";
    const put = await dav("PUT", `/calendars/inbox/${href}`, {
      body: vtodo(uid, "Client chosen task", [
        "DESCRIPTION:Brought by Thunderbird",
        "DTSTART:20261110T090000Z",
        "DUE:20261110T093000Z",
        "PRIORITY:5",
        "CATEGORIES:Work,Errands",
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        "TRIGGER:-PT10M",
        "END:VALARM",
      ]),
    });
    expect(put.statusCode).toBe(201);
    expect(String(put.headers["etag"])).toMatch(/^".+"$/);

    const get = await dav("GET", `/calendars/inbox/${href}`);
    expect(get.statusCode).toBe(200);
    expect(get.headers["etag"]).toBe(put.headers["etag"]);
    expect(get.body).toContain("BEGIN:VTODO");
    expect(get.body).toContain(`UID:${uid}`);
    expect(get.body).toContain("SUMMARY:Client chosen task");
    expect(get.body).toContain("DTSTART:20261110T090000Z");
    expect(get.body).toContain("DUE:20261110T093000Z");
    expect(get.body).toContain("STATUS:NEEDS-ACTION");
    expect(get.body).toContain("PRIORITY:5");
    expect(get.body).toContain("CATEGORIES:");
    expect(get.body).toContain("TRIGGER:-PT10M");
    expect(get.body).not.toContain("DTEND");
    expect(get.body).not.toContain("METHOD:");

    const id = taskIdForUid(uid);
    const stored = getDb()
      .prepare("SELECT ical_uid, caldav_href FROM tasks WHERE id = ?")
      .get(id) as { ical_uid: string; caldav_href: string };
    expect(stored.ical_uid).toBe(uid);
    expect(stored.caldav_href).toBe(href);

    // Update by the same href keeps the client UID rather than replacing it.
    const updated = await dav("PUT", `/calendars/inbox/${href}`, {
      body: vtodo(uid, "Client chosen task v2", [
        "DUE:20261111T093000Z",
        "STATUS:IN-PROCESS",
      ]),
    });
    expect(updated.statusCode).toBe(204);
    const storedAgain = getDb()
      .prepare("SELECT ical_uid FROM tasks WHERE id = ?")
      .get(id) as { ical_uid: string };
    expect(storedAgain.ical_uid).toBe(uid);
    const getAgain = await dav("GET", `/calendars/inbox/${href}`);
    expect(getAgain.body).toContain("SUMMARY:Client chosen task v2");
    expect(getAgain.body).toContain("STATUS:NEEDS-ACTION");
  });

  it("serves REST-created tasks through the id fallback UID/href", async () => {
    const created = await api("POST", "/api/tasks", {
      payload: {
        title: "REST created, CalDAV readable",
        dueAt: "2026-11-15T12:00:00.000Z",
      },
    });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as { id: string }).id;

    const get = await dav("GET", `/calendars/inbox/${id}.ics`);
    expect(get.statusCode).toBe(200);
    expect(get.body).toContain(`UID:${id}@morrow`);
    expect(get.body).toContain("DUE:20261115T120000Z");

    const update = await dav("PUT", `/calendars/inbox/${id}.ics`, {
      body: vtodo(`${id}@morrow`, "REST task updated via CalDAV"),
    });
    expect(update.statusCode).toBe(204);
    const stored = getDb()
      .prepare("SELECT ical_uid, caldav_href FROM tasks WHERE id = ?")
      .get(id) as { ical_uid: string; caldav_href: string };
    expect(stored.ical_uid).toBe(`${id}@morrow`);
    expect(stored.caldav_href).toBe(`${id}.ics`);
  });

  it("soft-deletes and then returns 404", async () => {
    const href = "delete-me.ics";
    const put = await dav("PUT", `/calendars/inbox/${href}`, {
      body: vtodo("delete-me@example.test", "Delete me", [
        "DUE:20261110T090000Z",
      ]),
    });
    expect(put.statusCode).toBe(201);
    const del = await dav("DELETE", `/calendars/inbox/${href}`, {
      headers: { "if-match": String(put.headers["etag"]) },
    });
    expect(del.statusCode).toBe(204);
    const get = await dav("GET", `/calendars/inbox/${href}`);
    expect(get.statusCode).toBe(404);
    const deleted = getDb()
      .prepare("SELECT deleted_at FROM tasks WHERE ical_uid = ?")
      .get("delete-me@example.test") as { deleted_at: string | null };
    expect(deleted.deleted_at).not.toBeNull();
  });

  it("rejects href/UID mismatch with 409", async () => {
    const href = "mismatch.ics";
    const first = await dav("PUT", `/calendars/inbox/${href}`, {
      body: vtodo("mismatch-a@example.test", "First owner"),
    });
    expect(first.statusCode).toBe(201);
    const second = await dav("PUT", `/calendars/inbox/${href}`, {
      body: vtodo("mismatch-b@example.test", "Different UID"),
    });
    expect(second.statusCode).toBe(409);
    const get = await dav("GET", `/calendars/inbox/${href}`);
    expect(get.body).toContain("SUMMARY:First owner");
  });

  it("rejects duplicate UID under another href with 409 and the existing href", async () => {
    const uid = "duplicate-uid@example.test";
    const first = await dav("PUT", "/calendars/inbox/uid-one.ics", {
      body: vtodo(uid, "UID one"),
    });
    expect(first.statusCode).toBe(201);
    const second = await dav("PUT", "/calendars/inbox/uid-two.ics", {
      body: vtodo(uid, "UID two"),
    });
    expect(second.statusCode).toBe(409);
    expect(String(second.headers["location"])).toContain(
      "/caldav/calendars/inbox/uid-one.ics",
    );
    expect(second.body).toContain("no-uid-conflict");
    const get = await dav("GET", "/calendars/inbox/uid-two.ics");
    expect(get.statusCode).toBe(404);
  });

  it("computes DUE from DTSTART+DURATION and rejects malformed RRULEs", async () => {
    const duration = await dav("PUT", "/calendars/inbox/duration.ics", {
      body: vtodo("duration@example.test", "One hour", [
        "DTSTART:20261110T090000Z",
        "DURATION:PT1H",
      ]),
    });
    expect(duration.statusCode).toBe(201);
    const stored = await dav("GET", "/calendars/inbox/duration.ics");
    expect(stored.statusCode).toBe(200);
    expect(stored.body).toContain("DUE:20261110T100000Z");

    const badRule = await dav("PUT", "/calendars/inbox/bad-rrule.ics", {
      body: vtodo("bad-rrule@example.test", "Never", [
        "DTSTART:20261110T090000Z",
        "RRULE:FREQ=BOGUS",
      ]),
    });
    expect(badRule.statusCode).toBe(400);
    expect(badRule.body).toContain("valid-calendar-data");
  });

  it("rejects VEVENT, METHOD, missing UID, DUE+DURATION, and unknown TZID", async () => {
    const event = await dav("PUT", "/calendars/inbox/not-an-event.ics", {
      body: [
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT",
        "UID:event@example.test",
        "DTSTART:20261110T090000Z",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n"),
    });
    expect(event.statusCode).toBe(403);
    expect(event.body).toContain("supported-calendar-component");

    const method = await dav("PUT", "/calendars/inbox/method.ics", {
      body: [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "METHOD:REQUEST",
        "BEGIN:VTODO",
        "UID:method@example.test",
        "SUMMARY:Invitation-shaped VTODO",
        "END:VTODO",
        "END:VCALENDAR",
      ].join("\r\n"),
    });
    expect(method.statusCode).toBe(400);
    expect(method.body).toContain("valid-calendar-data");
    const storedMethod = await dav("GET", "/calendars/inbox/method.ics");
    expect(storedMethod.statusCode).toBe(404);

    const noUid = await dav("PUT", "/calendars/inbox/no-uid.ics", {
      body: [
        "BEGIN:VCALENDAR",
        "BEGIN:VTODO",
        "SUMMARY:No UID",
        "END:VTODO",
        "END:VCALENDAR",
      ].join("\r\n"),
    });
    expect(noUid.statusCode).toBe(400);
    expect(noUid.body).toContain("valid-calendar-data");

    const dueDuration = await dav("PUT", "/calendars/inbox/due-duration.ics", {
      body: vtodo("due-duration@example.test", "Both", [
        "DUE:20261110T090000Z",
        "DURATION:PT1H",
      ]),
    });
    expect(dueDuration.statusCode).toBe(400);
    expect(dueDuration.body).toContain("valid-calendar-data");

    const badTzid = await dav("PUT", "/calendars/inbox/bad-tzid.ics", {
      body: vtodo("bad-tzid@example.test", "Local time", [
        "DUE;TZID=Mars/Olympus:20261110T090000",
      ]),
    });
    expect(badTzid.statusCode).toBe(400);
    expect(badTzid.body).toContain("valid-calendar-data");
  });

  it("accepts an IANA TZID and stores the resolved UTC instant", async () => {
    const href = "tzid-new-york.ics";
    const put = await dav("PUT", `/calendars/inbox/${href}`, {
      body: vtodo("tzid-new-york@example.test", "New York wall time", [
        "DUE;TZID=America/New_York:20261110T090000",
      ]),
    });
    expect(put.statusCode).toBe(201);
    const row = getDb()
      .prepare("SELECT due_at FROM tasks WHERE ical_uid = ?")
      .get("tzid-new-york@example.test") as { due_at: string };
    expect(row.due_at).toBe("2026-11-10T14:00:00.000Z");

    const get = await dav("GET", `/calendars/inbox/${href}`);
    expect(get.statusCode).toBe(200);
    // The instant remains the authority in storage, but the representation now
    // preserves the client zone as TZID with a matching VTIMEZONE.
    expect(get.body).toContain("BEGIN:VTIMEZONE");
    expect(get.body).toContain("TZID:America/New_York");
    expect(get.body).toContain("DUE;TZID=America/New_York:20261110T090000");
  });
});

describe("CalDAV conditional writes", () => {
  it("enforces current/stale If-Match and If-None-Match without mutation", async () => {
    const href = "etag-matrix.ics";
    const create = await dav("PUT", `/calendars/inbox/${href}`, {
      body: vtodo("etag-matrix@example.test", "ETag v1", [
        "DUE:20261110T090000Z",
      ]),
    });
    expect(create.statusCode).toBe(201);
    const etag1 = String(create.headers["etag"]);

    const get = await dav("GET", `/calendars/inbox/${href}`);
    expect(get.headers["etag"]).toBe(etag1);

    const update = await dav("PUT", `/calendars/inbox/${href}`, {
      body: vtodo("etag-matrix@example.test", "ETag v2", [
        "DUE:20261110T090000Z",
      ]),
      headers: { "if-match": etag1 },
    });
    expect(update.statusCode).toBe(204);
    const etag2 = String(update.headers["etag"]);
    expect(etag2).not.toBe(etag1);

    const stale = await dav("PUT", `/calendars/inbox/${href}`, {
      body: vtodo("etag-matrix@example.test", "Should not land", [
        "DUE:20261110T090000Z",
      ]),
      headers: { "if-match": etag1 },
    });
    expect(stale.statusCode).toBe(412);
    expect(stale.headers["etag"]).toBe(etag2);
    const afterStale = await dav("GET", `/calendars/inbox/${href}`);
    expect(afterStale.body).toContain("SUMMARY:ETag v2");
    expect(afterStale.body).not.toContain("Should not land");

    const wildcard = await dav("PUT", `/calendars/inbox/${href}`, {
      body: vtodo("etag-matrix@example.test", "ETag v3", [
        "DUE:20261110T090000Z",
      ]),
      headers: { "if-match": "*" },
    });
    expect(wildcard.statusCode).toBe(204);
  });

  it("honours a higher client SEQUENCE and never decreases it", async () => {
    const href = "sequence.ics";
    const create = await dav("PUT", `/calendars/inbox/${href}`, {
      body: vtodo("sequence@example.test", "Sequence v1", ["SEQUENCE:7"]),
    });
    expect(create.statusCode).toBe(201);
    const get1 = await dav("GET", `/calendars/inbox/${href}`);
    expect(get1.body).toContain("SEQUENCE:7");

    const update = await dav("PUT", `/calendars/inbox/${href}`, {
      body: vtodo("sequence@example.test", "Sequence v2", ["SEQUENCE:3"]),
      headers: { "if-match": String(create.headers["etag"]) },
    });
    expect(update.statusCode).toBe(204);
    const get2 = await dav("GET", `/calendars/inbox/${href}`);
    expect(get2.body).toContain("SEQUENCE:8");
  });

  it("enforces If-None-Match: * on create", async () => {
    const href = "if-none.ics";
    const create = await dav("PUT", `/calendars/inbox/${href}`, {
      body: vtodo("if-none@example.test", "Created once"),
      headers: { "if-none-match": "*" },
    });
    expect(create.statusCode).toBe(201);

    const overwrite = await dav("PUT", `/calendars/inbox/${href}`, {
      body: vtodo("if-none@example.test", "Must not overwrite"),
      headers: { "if-none-match": "*" },
    });
    expect(overwrite.statusCode).toBe(412);
    const get = await dav("GET", `/calendars/inbox/${href}`);
    expect(get.body).toContain("SUMMARY:Created once");
    expect(get.body).not.toContain("Must not overwrite");
  });

  it("enforces If-Match on DELETE (stale 412, no mutation)", async () => {
    const href = "delete-etag.ics";
    const create = await dav("PUT", `/calendars/inbox/${href}`, {
      body: vtodo("delete-etag@example.test", "Delete with ETag"),
    });
    expect(create.statusCode).toBe(201);
    const etag = String(create.headers["etag"]);
    const update = await dav("PUT", `/calendars/inbox/${href}`, {
      body: vtodo("delete-etag@example.test", "Delete with ETag v2"),
      headers: { "if-match": etag },
    });
    expect(update.statusCode).toBe(204);
    const stale = await dav("DELETE", `/calendars/inbox/${href}`, {
      headers: { "if-match": etag },
    });
    expect(stale.statusCode).toBe(412);
    const stillThere = await dav("GET", `/calendars/inbox/${href}`);
    expect(stillThere.statusCode).toBe(200);
    const del = await dav("DELETE", `/calendars/inbox/${href}`, {
      headers: { "if-match": String(update.headers["etag"]) },
    });
    expect(del.statusCode).toBe(204);
  });

  it("changes the ETag when CATEGORIES/tags change outside CalDAV", async () => {
    const href = "tag-etag.ics";
    const uid = "tag-etag@example.test";
    const create = await dav("PUT", `/calendars/inbox/${href}`, {
      body: vtodo(uid, "Tag ETag", ["CATEGORIES:Initial"]),
    });
    expect(create.statusCode).toBe(201);
    const etag1 = String(create.headers["etag"]);

    const tag = await api("POST", "/api/tags", {
      payload: { name: "CalDavTag" },
    });
    expect(tag.statusCode).toBe(201);
    const tagId = (tag.json() as { id: string }).id;
    const taskId = taskIdForUid(uid);
    const putTags = await api("PUT", `/api/tasks/${taskId}/tags`, {
      payload: { tagIds: [tagId] },
    });
    expect(putTags.statusCode).toBe(200);

    const get = await dav("GET", `/calendars/inbox/${href}`);
    expect(get.statusCode).toBe(200);
    expect(String(get.headers["etag"])).not.toBe(etag1);
    expect(get.body).toContain("CATEGORIES:CalDavTag");
  });
});

describe("CalDAV sync-collection", () => {
  it("returns incremental changes, tag updates, and delete tombstones", async () => {
    const initial = await dav("REPORT", "/calendars/inbox/", {
      body: syncBody(""),
    });
    expect(initial.statusCode).toBe(207);
    const token1 = syncTokenOf(initial.body);
    expect(token1).toMatch(/^urn:morrow:sync:\d+:inbox:\d+$/);

    const aId = newId();
    const bId = newId();
    const a = await api("POST", "/api/tasks", {
      payload: { id: aId, title: "Sync task A" },
    });
    expect(a.statusCode).toBe(201);
    const b = await api("POST", "/api/tasks", {
      payload: { id: bId, title: "Sync task B" },
    });
    expect(b.statusCode).toBe(201);
    const updateA = await api("PATCH", `/api/tasks/${aId}`, {
      headers: { "if-match": '"rev-1"' },
      payload: { title: "Sync task A v2" },
    });
    expect(updateA.statusCode).toBe(200);

    const incremental = await dav("REPORT", "/calendars/inbox/", {
      body: syncBody(token1),
    });
    expect(incremental.statusCode).toBe(207);
    expect(incremental.body).toContain(`/caldav/calendars/inbox/${aId}.ics`);
    expect(incremental.body).toContain(`/caldav/calendars/inbox/${bId}.ics`);
    const token2 = syncTokenOf(incremental.body);
    expect(token2).not.toBe(token1);

    // Nothing changed since token2 → only the new token comes back.
    const quiet = await dav("REPORT", "/calendars/inbox/", {
      body: syncBody(token2),
    });
    expect(quiet.statusCode).toBe(207);
    expect(quiet.body).not.toContain("<d:response>");

    // A tag change changes the VTODO representation, so it must be journaled.
    const tag = await api("POST", "/api/tags", {
      payload: { name: "SyncTag" },
    });
    expect(tag.statusCode).toBe(201);
    const tagId = (tag.json() as { id: string }).id;
    const attach = await api("PUT", `/api/tasks/${aId}/tags`, {
      payload: { tagIds: [tagId] },
    });
    expect(attach.statusCode).toBe(200);
    const tagged = await dav("REPORT", "/calendars/inbox/", {
      body: syncBody(token2),
    });
    expect(tagged.statusCode).toBe(207);
    expect(tagged.body).toContain(`/caldav/calendars/inbox/${aId}.ics`);
    const token3 = syncTokenOf(tagged.body);

    // Renaming the tag changes CATEGORIES in the resource; it must journal
    // every linked task, not just the tag row.
    const rename = await api("PATCH", `/api/tags/${tagId}`, {
      headers: { "if-match": '"rev-1"' },
      payload: { name: "SyncTagRenamed" },
    });
    expect(rename.statusCode).toBe(200);
    const renamed = await dav("REPORT", "/calendars/inbox/", {
      body: syncBody(token3),
    });
    expect(renamed.statusCode).toBe(207);
    expect(renamed.body).toContain(`/caldav/calendars/inbox/${aId}.ics`);
    const token4 = syncTokenOf(renamed.body);

    const del = await dav("DELETE", `/calendars/inbox/${bId}.ics`);
    expect(del.statusCode).toBe(204);
    const deleted = await dav("REPORT", "/calendars/inbox/", {
      body: syncBody(token4),
    });
    expect(deleted.statusCode).toBe(207);
    expect(deleted.body).toContain(`/caldav/calendars/inbox/${bId}.ics`);
    expect(deleted.body).toContain("HTTP/1.1 404 Not Found");
    expect(deleted.body).not.toContain(`/caldav/calendars/inbox/${aId}.ics`);
  });

  it("rejects malformed and unknown sync tokens with valid-sync-token", async () => {
    const malformed = await dav("REPORT", "/calendars/inbox/", {
      body: syncBody("not-a-token"),
    });
    expect(malformed.statusCode).toBe(403);
    expect(malformed.body).toContain("valid-sync-token");

    const wrongEpoch = await dav("REPORT", "/calendars/inbox/", {
      body: syncBody("urn:morrow:sync:999:1"),
    });
    expect(wrongEpoch.statusCode).toBe(403);
    expect(wrongEpoch.body).toContain("valid-sync-token");

    const unsupportedLevel = await dav("REPORT", "/calendars/inbox/", {
      body: syncBody("", "2"),
    });
    expect(unsupportedLevel.statusCode).toBe(403);
    expect(unsupportedLevel.body).toContain("supported-sync-level");
  });

  it("turns a tombstone back into an update when a delete is undone", async () => {
    const id = newId();
    const create = await api("POST", "/api/tasks", {
      payload: { id, title: "Sync undo task" },
    });
    expect(create.statusCode).toBe(201);
    const initial = await dav("REPORT", "/calendars/inbox/", {
      body: syncBody(""),
    });
    const token = syncTokenOf(initial.body);

    const del = await dav("DELETE", `/calendars/inbox/${id}.ics`);
    expect(del.statusCode).toBe(204);
    const tombstone = await dav("REPORT", "/calendars/inbox/", {
      body: syncBody(token),
    });
    expect(tombstone.body).toContain("HTTP/1.1 404 Not Found");
    const tombstoneToken = syncTokenOf(tombstone.body);

    // Simulate the undo path restoring the soft-deleted row.
    const now = new Date().toISOString();
    getDb()
      .prepare(
        `UPDATE tasks SET deleted_at = NULL, rev = rev + 1, updated_at = ?
          WHERE id = ?`,
      )
      .run(now, id);

    const restored = await dav("REPORT", "/calendars/inbox/", {
      body: syncBody(tombstoneToken),
    });
    expect(restored.statusCode).toBe(207);
    expect(restored.body).toContain(`/caldav/calendars/inbox/${id}.ics`);
    expect(restored.body).not.toContain("HTTP/1.1 404 Not Found");
  });

  it("accepts a still-current legacy three-part token for morrow", async () => {
    const initial = await dav("REPORT", "/calendars/morrow/", {
      body: syncBody(""),
    });
    const current = syncTokenOf(initial.body);
    const match = /^urn:morrow:sync:(\d+):morrow:(\d+)$/.exec(current);
    expect(match).not.toBeNull();
    const legacy = `urn:morrow:sync:${match![1]}:${match![2]}`;

    const id = newId();
    expect(
      (
        await api("POST", "/api/tasks", {
          payload: { id, title: "Legacy token task" },
        })
      ).statusCode,
    ).toBe(201);
    const delta = await dav("REPORT", "/calendars/morrow/", {
      body: syncBody(legacy),
    });
    expect(delta.statusCode).toBe(207);
    expect(delta.body).toContain(`/caldav/calendars/morrow/${id}.ics`);
  });

  it("invalidates issued tokens after a restore epoch bump", async () => {
    const initial = await dav("REPORT", "/calendars/inbox/", {
      body: syncBody(""),
    });
    const token = syncTokenOf(initial.body);
    expect(token).not.toBe("");
    const ctagBefore = ctagOf(
      (
        await dav("PROPFIND", "/calendars/inbox/", {
          body: PROPFIND_BODY,
          headers: { depth: "0" },
        })
      ).body,
    );
    expect(ctagBefore).toMatch(/^ctag-\d+-\d+$/);

    invalidateCalDavSync(getDb());

    const ctagAfter = ctagOf(
      (
        await dav("PROPFIND", "/calendars/inbox/", {
          body: PROPFIND_BODY,
          headers: { depth: "0" },
        })
      ).body,
    );
    expect(ctagAfter).not.toBe(ctagBefore);

    const afterRestore = await dav("REPORT", "/calendars/inbox/", {
      body: syncBody(token),
    });
    expect(afterRestore.statusCode).toBe(403);
    expect(afterRestore.body).toContain("valid-sync-token");
  });
});

describe("CalDAV PROPFIND/REPORT", () => {
  it("returns resource getetag/getcontenttype/resourcetype", async () => {
    const href = "propfind-resource.ics";
    const put = await dav("PUT", `/calendars/inbox/${href}`, {
      body: vtodo("propfind-resource@example.test", "Propfind resource"),
    });
    expect(put.statusCode).toBe(201);
    const res = await dav("PROPFIND", `/calendars/inbox/${href}`, {
      body: PROPFIND_BODY,
      headers: { depth: "0" },
    });
    expect(res.statusCode).toBe(207);
    expect(res.body).toContain("/caldav/calendars/inbox/propfind-resource.ics");
    expect(res.body).toContain("<d:getetag>");
    expect(res.body).toContain("<d:getcontenttype>text/calendar");
    expect(res.body).toContain("<d:resourcetype/>");
  });

  it("calendar-multiget returns only requested hrefs and 404 entries", async () => {
    const a = "multi-a.ics";
    const b = "multi-b.ics";
    expect(
      (
        await dav("PUT", `/calendars/inbox/${a}`, {
          body: vtodo("multi-a@example.test", "Multi A"),
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await dav("PUT", `/calendars/inbox/${b}`, {
          body: vtodo("multi-b@example.test", "Multi B"),
        })
      ).statusCode,
    ).toBe(201);

    const report = await dav("REPORT", "/calendars/inbox/", {
      body: [
        '<?xml version="1.0"?>',
        '<cal:calendar-multiget xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">',
        "<d:prop><d:getetag/><cal:calendar-data/></d:prop>",
        `<d:href>/caldav/calendars/inbox/${a}</d:href>`,
        "<d:href>/caldav/calendars/inbox/multi-missing.ics</d:href>",
        "</cal:calendar-multiget>",
      ].join(""),
      headers: { "content-type": "application/xml" },
    });
    expect(report.statusCode).toBe(207);
    expect(report.body).toContain("/caldav/calendars/inbox/multi-a.ics");
    expect(report.body).toContain("SUMMARY:Multi A");
    expect(report.body).toContain("/caldav/calendars/inbox/multi-missing.ics");
    expect(report.body).toContain("HTTP/1.1 404 Not Found");
    expect(report.body).not.toContain("/caldav/calendars/inbox/multi-b.ics");
    expect(report.body).not.toContain("SUMMARY:Multi B");
  });

  it("calendar-query VCALENDAR/VTODO returns VTODO data", async () => {
    const report = await dav("REPORT", "/calendars/inbox/", {
      body: [
        '<?xml version="1.0"?>',
        '<cal:calendar-query xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">',
        "<d:prop><d:getetag/><cal:calendar-data/></d:prop>",
        '<cal:filter><cal:comp-filter name="VCALENDAR"><cal:comp-filter name="VTODO"/></cal:comp-filter></cal:filter>',
        "</cal:calendar-query>",
      ].join(""),
      headers: { "content-type": "application/xml" },
    });
    expect(report.statusCode).toBe(207);
    expect(report.body).toContain("BEGIN:VTODO");
    expect(report.body).toContain("SUMMARY:Multi A");
    expect(report.body).not.toContain("BEGIN:VEVENT");
  });

  it("rejects unsupported filters/components with an explicit precondition", async () => {
    const timeRange = await dav("REPORT", "/calendars/inbox/", {
      body: [
        '<cal:calendar-query xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">',
        '<cal:filter><cal:comp-filter name="VCALENDAR"><cal:comp-filter name="VTODO"><cal:time-range start="20260101T000000Z"/></cal:comp-filter></cal:comp-filter></cal:filter>',
        "</cal:calendar-query>",
      ].join(""),
      headers: { "content-type": "application/xml" },
    });
    expect(timeRange.statusCode).toBe(403);
    expect(timeRange.body).toContain("supported-filter");

    const eventQuery = await dav("REPORT", "/calendars/inbox/", {
      body: [
        '<cal:calendar-query xmlns:cal="urn:ietf:params:xml:ns:caldav">',
        '<cal:filter><cal:comp-filter name="VCALENDAR"><cal:comp-filter name="VEVENT"/></cal:comp-filter></cal:filter>',
        "</cal:calendar-query>",
      ].join(""),
      headers: { "content-type": "application/xml" },
    });
    expect(eventQuery.statusCode).toBe(403);
    expect(eventQuery.body).toContain("supported-calendar-component");
  });

  it("changes getctag after a task update", async () => {
    const href = "ctag.ics";
    const put = await dav("PUT", `/calendars/inbox/${href}`, {
      body: vtodo("ctag@example.test", "Ctag v1"),
    });
    expect(put.statusCode).toBe(201);
    const before = await dav("PROPFIND", "/calendars/inbox/", {
      body: PROPFIND_BODY,
      headers: { depth: "0" },
    });
    const ctag1 = ctagOf(before.body);
    expect(ctag1).not.toBe("");
    expect(ctag1).not.toBe("morrow");

    const update = await dav("PUT", `/calendars/inbox/${href}`, {
      body: vtodo("ctag@example.test", "Ctag v2"),
      headers: { "if-match": String(put.headers["etag"]) },
    });
    expect(update.statusCode).toBe(204);
    const after = await dav("PROPFIND", "/calendars/inbox/", {
      body: PROPFIND_BODY,
      headers: { depth: "0" },
    });
    expect(ctagOf(after.body)).not.toBe(ctag1);
  });
});

describe("calendar feeds stay separate", () => {
  it("serves a VTODO feed at /api/tasks.ics", async () => {
    const feed = await app.inject({
      method: "GET",
      url: `/api/tasks.ics?token=${encodeURIComponent(caldavToken)}`,
    });
    expect(feed.statusCode).toBe(200);
    expect(feed.headers["content-type"]).toContain("text/calendar");
    expect(feed.body).toContain("BEGIN:VTODO");
    expect(feed.body).toContain("SUMMARY:Client chosen task v2");
    expect(feed.body).not.toContain("BEGIN:VEVENT");
  });

  it("keeps the existing VEVENT feed unchanged and event-shaped", async () => {
    const feed = await app.inject({
      method: "GET",
      url: `/api/calendar.ics?token=${encodeURIComponent(caldavToken)}`,
    });
    expect(feed.statusCode).toBe(200);
    expect(feed.body).toContain("METHOD:PUBLISH");
    expect(feed.body).toContain("BEGIN:VEVENT");
    expect(feed.body).toContain("DTEND");
    expect(feed.body).not.toContain("BEGIN:VTODO");
  });
});

describe("CalDAV collection management", () => {
  it("creates and updates a list collection with MKCALENDAR/PROPPATCH", async () => {
    const key = "caldav-created-list";
    const mk = await dav("MKCALENDAR", `/calendars/${key}/`, {
      body: [
        '<d:mkcalendar xmlns:d="DAV:" xmlns:ical="http://apple.com/ns/ical/">',
        "<d:set><d:prop>",
        "<d:displayname>CalDAV Created</d:displayname>",
        "<ical:calendar-color>#ff8800</ical:calendar-color>",
        "</d:prop></d:set>",
        "</d:mkcalendar>",
      ].join(""),
    });
    expect(mk.statusCode).toBe(201);

    const lists = await api("GET", "/api/lists");
    expect(
      (lists.json() as { lists: Array<{ id: string; name: string }> }).lists,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: key, name: "CalDAV Created" }),
      ]),
    );

    const home = await dav("PROPFIND", "/calendars/", {
      headers: { depth: "1" },
    });
    expect(home.body).toContain(`/caldav/calendars/${key}/`);
    expect(home.body).toContain("CalDAV Created");
    expect(home.body).toContain("#ff8800");

    const duplicate = await dav("MKCALENDAR", `/calendars/${key}/`);
    expect(duplicate.statusCode).toBe(405);

    const proppatch = await dav("PROPPATCH", `/calendars/${key}/`, {
      body: [
        '<d:propertyupdate xmlns:d="DAV:" xmlns:ical="http://apple.com/ns/ical/">',
        "<d:set><d:prop>",
        "<d:displayname>CalDAV Renamed</d:displayname>",
        "<ical:calendar-color>#112233</ical:calendar-color>",
        "</d:prop></d:set>",
        "</d:propertyupdate>",
      ].join(""),
    });
    expect(proppatch.statusCode).toBe(207);
    const renamed = await dav("PROPFIND", `/calendars/${key}/`, {
      headers: { depth: "0" },
    });
    expect(renamed.body).toContain("CalDAV Renamed");
    expect(renamed.body).toContain("#112233");
  });

  it("deletes a collection and moves its tasks to Inbox", async () => {
    const list = await api("POST", "/api/lists", {
      payload: { id: newId(), name: "Delete via CalDAV" },
    });
    const listId = (list.json() as { id: string }).id;
    const taskId = newId();
    expect(
      (
        await api("POST", "/api/tasks", {
          payload: { id: taskId, title: "Survives collection delete", listId },
        })
      ).statusCode,
    ).toBe(201);

    const del = await dav("DELETE", `/calendars/${listId}/`);
    expect(del.statusCode).toBe(204);
    const gone = await dav("PROPFIND", `/calendars/${listId}/`, {
      headers: { depth: "0" },
    });
    expect(gone.statusCode).toBe(404);

    const stored = getDb()
      .prepare("SELECT list_id, deleted_at FROM tasks WHERE id = ?")
      .get(taskId) as { list_id: string | null; deleted_at: string | null };
    expect(stored.list_id).toBeNull();
    expect(stored.deleted_at).toBeNull();
    const inbox = await dav("GET", `/calendars/inbox/${taskId}.ics`);
    expect(inbox.statusCode).toBe(200);

    // The collection delete is activity-backed, so the normal undo path can
    // restore the list and its task membership.
    const activity = await api("GET", "/api/activity?cursor=0&limit=500");
    const rows = (activity.json() as {
      activities: Array<{ seq: number; action: string; entityId: string }>;
    }).activities;
    const seq = rows
      .filter(
        (row) => row.action === "list.delete" && row.entityId === listId,
      )
      .sort((a, b) => b.seq - a.seq)[0]?.seq;
    expect(seq).toBeDefined();
    const undo = await api("POST", `/api/activity/${seq}/undo`);
    expect(undo.statusCode).toBe(200);
    const restored = getDb()
      .prepare("SELECT list_id FROM tasks WHERE id = ?")
      .get(taskId) as { list_id: string | null };
    expect(restored.list_id).toBe(listId);
  });

  it("refuses collection DELETE when a member task would collide in the Inbox", async () => {
    const list = await api("POST", "/api/lists", {
      payload: { id: newId(), name: "Collision via CalDAV" },
    });
    const listId = (list.json() as { id: string }).id;
    const uid = "collection-delete-collision@example.test";
    const href = "collection-delete-collision.ics";
    expect(
      (
        await dav("PUT", `/calendars/${listId}/${href}`, {
          body: vtodo(uid, "List copy"),
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await dav("PUT", `/calendars/inbox/${href}`, {
          body: vtodo(uid, "Inbox copy"),
        })
      ).statusCode,
    ).toBe(201);

    const deleted = await dav("DELETE", `/calendars/${listId}/`);
    expect(deleted.statusCode).toBe(409);
    expect(deleted.body).toContain("no-uid-conflict");

    // The failed delete changes nothing: the collection and membership stay.
    expect(
      (await dav("PROPFIND", `/calendars/${listId}/`, {
        headers: { depth: "1" },
      })).statusCode,
    ).toBe(207);
    const stored = getDb()
      .prepare("SELECT list_id FROM tasks WHERE ical_uid = ? AND list_id = ?")
      .get(uid, listId) as { list_id: string | null };
    expect(stored.list_id).toBe(listId);
  });

  it("moves a task between collections with MOVE and journals both sides", async () => {    const listA = await api("POST", "/api/lists", {
      payload: { id: newId(), name: "Move source" },
    });
    const listAId = (listA.json() as { id: string }).id;
    const listB = await api("POST", "/api/lists", {
      payload: { id: newId(), name: "Move target" },
    });
    const listBId = (listB.json() as { id: string }).id;
    const taskId = newId();
    expect(
      (
        await api("POST", "/api/tasks", {
          payload: { id: taskId, title: "Move me", listId: listAId },
        })
      ).statusCode,
    ).toBe(201);

    const tokenA = syncTokenOf(
      (await dav("REPORT", `/calendars/${listAId}/`, { body: syncBody("") }))
        .body,
    );
    const tokenB = syncTokenOf(
      (await dav("REPORT", `/calendars/${listBId}/`, { body: syncBody("") }))
        .body,
    );

    const moved = await dav("MOVE", `/calendars/${listAId}/${taskId}.ics`, {
      headers: {
        destination: `/caldav/calendars/${listBId}/${taskId}-moved.ics`,
      },
    });
    expect(moved.statusCode).toBe(204);

    const oldSide = await dav("GET", `/calendars/${listAId}/${taskId}.ics`);
    expect(oldSide.statusCode).toBe(404);
    const newSide = await dav(
      "GET",
      `/calendars/${listBId}/${taskId}-moved.ics`,
    );
    expect(newSide.statusCode).toBe(200);
    const stored = getDb()
      .prepare("SELECT list_id, caldav_href FROM tasks WHERE id = ?")
      .get(taskId) as { list_id: string; caldav_href: string };
    expect(stored.list_id).toBe(listBId);
    expect(stored.caldav_href).toBe(`${taskId}-moved.ics`);

    const oldDelta = await dav("REPORT", `/calendars/${listAId}/`, {
      body: syncBody(tokenA),
    });
    expect(oldDelta.body).toContain(
      `/caldav/calendars/${listAId}/${taskId}.ics`,
    );
    expect(oldDelta.body).toContain("HTTP/1.1 404 Not Found");
    const newDelta = await dav("REPORT", `/calendars/${listBId}/`, {
      body: syncBody(tokenB),
    });
    expect(newDelta.body).toContain(
      `/caldav/calendars/${listBId}/${taskId}-moved.ics`,
    );
    expect(newDelta.body).not.toContain("HTTP/1.1 404 Not Found");

    const toInbox = await dav(
      "MOVE",
      `/calendars/${listBId}/${taskId}-moved.ics`,
      { headers: { destination: `/caldav/calendars/inbox/${taskId}-inbox.ics` } },
    );
    expect(toInbox.statusCode).toBe(204);
    const inboxSide = await dav(
      "GET",
      `/calendars/inbox/${taskId}-inbox.ics`,
    );
    expect(inboxSide.statusCode).toBe(200);
  });

  it("tombstones the old href on a same-collection rename", async () => {
    const list = await api("POST", "/api/lists", {
      payload: { id: newId(), name: "Rename collection" },
    });
    const listId = (list.json() as { id: string }).id;
    const taskId = newId();
    expect(
      (
        await api("POST", "/api/tasks", {
          payload: { id: taskId, title: "Rename me", listId },
        })
      ).statusCode,
    ).toBe(201);
    const token = syncTokenOf(
      (await dav("REPORT", `/calendars/${listId}/`, { body: syncBody("") }))
        .body,
    );

    const renamed = await dav("MOVE", `/calendars/${listId}/${taskId}.ics`, {
      headers: {
        destination: `/caldav/calendars/${listId}/${taskId}-renamed.ics`,
      },
    });
    expect(renamed.statusCode).toBe(204);

    const delta = await dav("REPORT", `/calendars/${listId}/`, {
      body: syncBody(token),
    });
    expect(delta.statusCode).toBe(207);
    expect(delta.body).toContain(
      `/caldav/calendars/${listId}/${taskId}.ics`,
    );
    expect(delta.body).toContain("HTTP/1.1 404 Not Found");
    expect(delta.body).toContain(
      `/caldav/calendars/${listId}/${taskId}-renamed.ics`,
    );

    expect(
      (await dav("GET", `/calendars/${listId}/${taskId}.ics`)).statusCode,
    ).toBe(404);
    expect(
      (await dav("GET", `/calendars/${listId}/${taskId}-renamed.ics`))
        .statusCode,
    ).toBe(200);
  });

  it("does not journal exception resources on a same-collection rename", async () => {
    const list = await api("POST", "/api/lists", {
      payload: { id: newId(), name: "Rename with exceptions" },
    });
    const listId = (list.json() as { id: string }).id;
    const uid = "rename-exceptions@example.test";
    expect(
      (
        await dav("PUT", `/calendars/${listId}/rename-series.ics`, {
          body: vtodo(uid, "Rename series", [
            "DTSTART:20260115T090000Z",
            "DUE:20260115T093000Z",
            "RRULE:FREQ=DAILY;COUNT=3",
          ]),
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await dav("PUT", `/calendars/${listId}/rename-exception.ics`, {
          body: vtodo(uid, "Rename occurrence", [
            "RECURRENCE-ID:20260116T090000Z",
            "DUE:20260116T113000Z",
          ]),
        })
      ).statusCode,
    ).toBe(201);
    const token = syncTokenOf(
      (await dav("REPORT", `/calendars/${listId}/`, { body: syncBody("") }))
        .body,
    );

    expect(
      (
        await dav("MOVE", `/calendars/${listId}/rename-series.ics`, {
          headers: {
            destination: `/caldav/calendars/${listId}/rename-series-v2.ics`,
          },
        })
      ).statusCode,
    ).toBe(204);
    const delta = await dav("REPORT", `/calendars/${listId}/`, {
      body: syncBody(token),
    });
    expect(delta.statusCode).toBe(207);
    expect(delta.body).toContain(
      `/caldav/calendars/${listId}/rename-series.ics`,
    );
    expect(delta.body).toContain(
      `/caldav/calendars/${listId}/rename-series-v2.ics`,
    );
    expect(delta.body).not.toContain(
      `/caldav/calendars/${listId}/rename-exception.ics`,
    );
  });

  it("enforces MOVE preconditions, occupancy, UID conflicts, and protected targets", async () => {
    const listA = await api("POST", "/api/lists", {
      payload: { id: newId(), name: "MOVE edge A" },
    });
    const listAId = (listA.json() as { id: string }).id;
    const listB = await api("POST", "/api/lists", {
      payload: { id: newId(), name: "MOVE edge B" },
    });
    const listBId = (listB.json() as { id: string }).id;
    const uid = "move-conflict@example.test";
    expect(
      (
        await dav("PUT", `/calendars/${listAId}/a.ics`, {
          body: vtodo(uid, "MOVE edge A"),
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await dav("PUT", `/calendars/${listBId}/b.ics`, {
          body: vtodo(uid, "MOVE edge B"),
        })
      ).statusCode,
    ).toBe(201);

    const occupied = await dav("MOVE", `/calendars/${listAId}/a.ics`, {
      headers: { destination: `/caldav/calendars/${listBId}/b.ics` },
    });
    expect(occupied.statusCode).toBe(412);

    const uidConflictMove = await dav(
      "MOVE",
      `/calendars/${listAId}/a.ics`,
      {
        headers: {
          destination: `/caldav/calendars/${listBId}/other.ics`,
        },
      },
    );
    expect(uidConflictMove.statusCode).toBe(409);

    const legacyTarget = await dav("MOVE", `/calendars/${listAId}/a.ics`, {
      headers: {
        destination: `/caldav/calendars/morrow/legacy.ics`,
      },
    });
    expect(legacyTarget.statusCode).toBe(403);

    const stale = await dav("MOVE", `/calendars/${listAId}/a.ics`, {
      headers: {
        "if-match": '"not-the-current-etag"',
        destination: `/caldav/calendars/${listBId}/fresh.ics`,
      },
    });
    expect(stale.statusCode).toBe(412);
  });

  it("journals recurrence exceptions on both sides when the base series moves", async () => {
    const listA = await api("POST", "/api/lists", {
      payload: { id: newId(), name: "Move series source" },
    });
    const listAId = (listA.json() as { id: string }).id;
    const listB = await api("POST", "/api/lists", {
      payload: { id: newId(), name: "Move series target" },
    });
    const listBId = (listB.json() as { id: string }).id;

    const uid = "move-series@example.test";
    expect(
      (
        await dav("PUT", `/calendars/${listAId}/move-series.ics`, {
          body: vtodo(uid, "Moved series", [
            "DTSTART:20260115T090000Z",
            "DUE:20260115T093000Z",
            "RRULE:FREQ=DAILY;COUNT=3",
          ]),
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await dav("PUT", `/calendars/${listAId}/move-series-one.ics`, {
          body: vtodo(uid, "Moved occurrence", [
            "RECURRENCE-ID:20260115T090000Z",
            "DUE:20260115T113000Z",
          ]),
        })
      ).statusCode,
    ).toBe(201);

    const tokenA = syncTokenOf(
      (await dav("REPORT", `/calendars/${listAId}/`, { body: syncBody("") }))
        .body,
    );
    const tokenB = syncTokenOf(
      (await dav("REPORT", `/calendars/${listBId}/`, { body: syncBody("") }))
        .body,
    );

    const moved = await dav("MOVE", `/calendars/${listAId}/move-series.ics`, {
      headers: {
        destination: `/caldav/calendars/${listBId}/move-series-moved.ics`,
      },
    });
    expect(moved.statusCode).toBe(204);

    const oldDelta = await dav("REPORT", `/calendars/${listAId}/`, {
      body: syncBody(tokenA),
    });
    expect(oldDelta.statusCode).toBe(207);
    expect(oldDelta.body).toContain(
      `/caldav/calendars/${listAId}/move-series.ics`,
    );
    expect(oldDelta.body).toContain(
      `/caldav/calendars/${listAId}/move-series-one.ics`,
    );
    expect(oldDelta.body).toContain("HTTP/1.1 404 Not Found");

    const newDelta = await dav("REPORT", `/calendars/${listBId}/`, {
      body: syncBody(tokenB),
    });
    expect(newDelta.statusCode).toBe(207);
    expect(newDelta.body).toContain(
      `/caldav/calendars/${listBId}/move-series-moved.ics`,
    );
    expect(newDelta.body).toContain(
      `/caldav/calendars/${listBId}/move-series-one.ics`,
    );
    expect(newDelta.body).not.toContain("HTTP/1.1 404 Not Found");

    const occurrence = await dav(
      "GET",
      `/calendars/${listBId}/move-series-one.ics`,
    );
    expect(occurrence.statusCode).toBe(200);
    expect(occurrence.body).toContain("RECURRENCE-ID:20260115T090000Z");
  });

  it("rejects MOVE of an exception and a destination owned by an exception", async () => {
    const list = await api("POST", "/api/lists", {
      payload: { id: newId(), name: "MOVE exception guard" },
    });
    const listId = (list.json() as { id: string }).id;
    const uid = "move-exception@example.test";
    expect(
      (
        await dav("PUT", `/calendars/${listId}/exception-series.ics`, {
          body: vtodo(uid, "Exception series", [
            "DTSTART:20260115T090000Z",
            "DUE:20260115T093000Z",
            "RRULE:FREQ=DAILY;COUNT=3",
          ]),
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await dav("PUT", `/calendars/${listId}/exception-one.ics`, {
          body: vtodo(uid, "Exception occurrence", [
            "RECURRENCE-ID:20260115T090000Z",
            "DUE:20260115T113000Z",
          ]),
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await dav("PUT", `/calendars/${listId}/ordinary.ics`, {
          body: vtodo("move-ordinary@example.test", "Ordinary task"),
        })
      ).statusCode,
    ).toBe(201);

    const exceptionMove = await dav(
      "MOVE",
      `/calendars/${listId}/exception-one.ics`,
      {
        headers: {
          destination: `/caldav/calendars/${listId}/exception-one-moved.ics`,
        },
      },
    );
    expect(exceptionMove.statusCode).toBe(409);
    expect(exceptionMove.body).toContain("recurrence-id-move");

    const shadow = await dav("MOVE", `/calendars/${listId}/ordinary.ics`, {
      headers: {
        destination: `/caldav/calendars/${listId}/exception-one.ics`,
      },
    });
    expect(shadow.statusCode).toBe(409);

    // Both original exception resources are untouched.
    expect(
      (
        await dav("GET", `/calendars/${listId}/exception-one.ics`)
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await dav("GET", `/calendars/${listId}/exception-series.ics`)
      ).statusCode,
    ).toBe(200);
  });

  it("rejects a MOVE whose exceptions would collide in the target collection", async () => {
    const source = await api("POST", "/api/lists", {
      payload: { id: newId(), name: "Exception collision source" },
    });
    const sourceId = (source.json() as { id: string }).id;
    const target = await api("POST", "/api/lists", {
      payload: { id: newId(), name: "Exception collision target" },
    });
    const targetId = (target.json() as { id: string }).id;
    const exceptionHref = "shared-exception-href.ics";

    const seedSeries = async (
      listId: string,
      uid: string,
      baseHref: string,
    ): Promise<void> => {
      expect(
        (
          await dav("PUT", `/calendars/${listId}/${baseHref}`, {
            body: vtodo(uid, "Series", [
              "DTSTART:20260115T090000Z",
              "DUE:20260115T093000Z",
              "RRULE:FREQ=DAILY;COUNT=3",
            ]),
          })
        ).statusCode,
      ).toBe(201);
      expect(
        (
          await dav("PUT", `/calendars/${listId}/${exceptionHref}`, {
            body: vtodo(uid, "Occurrence", [
              "RECURRENCE-ID:20260115T090000Z",
              "DUE:20260115T113000Z",
            ]),
          })
        ).statusCode,
      ).toBe(201);
    };
    await seedSeries(sourceId, "collision-a@example.test", "series-a.ics");
    await seedSeries(targetId, "collision-b@example.test", "series-b.ics");

    const move = await dav("MOVE", `/calendars/${sourceId}/series-a.ics`, {
      headers: {
        destination: `/caldav/calendars/${targetId}/series-a-moved.ics`,
      },
    });
    expect(move.statusCode).toBe(409);
    expect(move.body).toContain("no-uid-conflict");
    expect(
      (
        getDb()
          .prepare("SELECT list_id FROM tasks WHERE ical_uid = ?")
          .get("collision-a@example.test") as { list_id: string | null }
      ).list_id,
    ).toBe(sourceId);
    expect(
      (
        await dav(
          "GET",
          `/calendars/${sourceId}/${exceptionHref}`,
        )
      ).statusCode,
    ).toBe(200);
  });

  it("only lets the task owner move a shared-list task", async () => {
    const stepUp = await api("POST", "/api/auth/password", {
      payload: { password: PASSWORD },
    });
    expect(stepUp.statusCode).toBe(200);
    const memberPassword = "member-move-password-01";
    const createdUser = await api("POST", "/api/users", {
      payload: {
        username: "caldav-move-member",
        password: memberPassword,
        timezone: "UTC",
      },
    });
    expect(createdUser.statusCode).toBe(201);
    const login = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { username: "caldav-move-member", password: memberPassword },
    });
    expect(login.statusCode).toBe(200);
    const memberCookie = cookieOf(login);

    const list = await api("POST", "/api/lists", {
      payload: { id: newId(), name: "Shared MOVE list" },
    });
    const listId = (list.json() as { id: string }).id;
    expect(
      (
        await api("POST", `/api/lists/${listId}/share`, {
          payload: { username: "caldav-move-member" },
        })
      ).statusCode,
    ).toBe(201);

    const ownerTaskId = newId();
    expect(
      (
        await api("POST", "/api/tasks", {
          payload: {
            id: ownerTaskId,
            title: "Owner task cannot be moved by member",
            listId,
          },
        })
      ).statusCode,
    ).toBe(201);

    const memberTokenRes = await api("POST", "/api/capture/tokens", {
      cookie: memberCookie,
      payload: { name: "Member MOVE CalDAV", kind: "caldav" },
    });
    expect(memberTokenRes.statusCode).toBe(201);
    const memberToken = (memberTokenRes.json() as { token: string }).token;

    const denied = await dav(
      "MOVE",
      `/calendars/${listId}/${ownerTaskId}.ics`,
      {
        token: memberToken,
        headers: {
          destination: `/caldav/calendars/inbox/${ownerTaskId}.ics`,
        },
      },
    );
    expect(denied.statusCode).toBe(403);
    expect(denied.body).toContain("task_owner_required");
    expect(
      (
        await dav("GET", `/calendars/${listId}/${ownerTaskId}.ics`, {
          token: memberToken,
        })
      ).statusCode,
    ).toBe(200);

    // A member's own task in the same shared list may still move to Inbox,
    // where it lands in the member's own Inbox.
    const memberTaskId = newId();
    expect(
      (
        await api("POST", "/api/tasks", {
          cookie: memberCookie,
          payload: {
            id: memberTaskId,
            title: "Member-owned task",
            listId,
          },
        })
      ).statusCode,
    ).toBe(201);
    const allowed = await dav(
      "MOVE",
      `/calendars/${listId}/${memberTaskId}.ics`,
      {
        token: memberToken,
        headers: {
          destination: `/caldav/calendars/inbox/${memberTaskId}.ics`,
        },
      },
    );
    expect(allowed.statusCode).toBe(204);
    const stored = getDb()
      .prepare("SELECT user_id, list_id FROM tasks WHERE id = ?")
      .get(memberTaskId) as { user_id: string; list_id: string | null };
    expect(stored.list_id).toBeNull();
    expect(stored.user_id).not.toBe("");
  });
});

describe("CalDAV per-list collections and sharing", () => {
  it("discovers lists and scopes resources to their collection", async () => {
    const listA = await api("POST", "/api/lists", {
      payload: { id: newId(), name: "CalDAV Work", color: "#3366ff" },
    });
    expect(listA.statusCode).toBe(201);
    const listAId = (listA.json() as { id: string }).id;
    const listB = await api("POST", "/api/lists", {
      payload: { id: newId(), name: "CalDAV Errands" },
    });
    expect(listB.statusCode).toBe(201);
    const listBId = (listB.json() as { id: string }).id;

    const home = await dav("PROPFIND", "/calendars/", {
      headers: { depth: "1" },
    });
    expect(home.statusCode).toBe(207);
    expect(home.body).toContain("/caldav/calendars/inbox/");
    expect(home.body).toContain(`/caldav/calendars/${listAId}/`);
    expect(home.body).toContain("CalDAV Work");
    expect(home.body).toContain("ical:calendar-color");
    // The flat collection remains reachable for existing clients but is not
    // advertised in discovery, so new clients do not subscribe twice.
    expect(home.body).not.toContain("/caldav/calendars/morrow/");

    const aTaskId = newId();
    const bTaskId = newId();
    expect(
      (
        await api("POST", "/api/tasks", {
          payload: { id: aTaskId, title: "Work task", listId: listAId },
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await api("POST", "/api/tasks", {
          payload: { id: bTaskId, title: "Errand task", listId: listBId },
        })
      ).statusCode,
    ).toBe(201);

    const query = () =>
      [
        '<?xml version="1.0"?>',
        '<cal:calendar-query xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">',
        "<d:prop><d:getetag/><cal:calendar-data/></d:prop>",
        '<cal:filter><cal:comp-filter name="VCALENDAR"><cal:comp-filter name="VTODO"/></cal:comp-filter></cal:filter>',
        "</cal:calendar-query>",
      ].join("");

    const report = await dav("REPORT", `/calendars/${listAId}/`, {
      body: query(),
    });
    expect(report.statusCode).toBe(207);
    expect(report.body).toContain(`/caldav/calendars/${listAId}/${aTaskId}.ics`);
    expect(report.body).not.toContain(bTaskId);

    const getA = await dav("GET", `/calendars/${listAId}/${aTaskId}.ics`);
    expect(getA.statusCode).toBe(200);
    const getWrongList = await dav(
      "GET",
      `/calendars/${listBId}/${aTaskId}.ics`,
    );
    expect(getWrongList.statusCode).toBe(404);

    // PUT into a list collection creates the task with that list id.
    const createdId = newId();
    const put = await dav("PUT", `/calendars/${listAId}/${createdId}.ics`, {
      body: vtodo(`${createdId}@morrow`, "Created inside list A"),
    });
    expect(put.statusCode).toBe(201);
    const stored = getDb()
      .prepare("SELECT list_id FROM tasks WHERE id = ?")
      .get(createdId) as { list_id: string | null };
    expect(stored.list_id).toBe(listAId);

    // UID uniqueness is per collection: the same UID may exist in two lists.
    const sharedUid = "cross-list-uid@example.test";
    const crossA = await dav("PUT", `/calendars/${listAId}/cross-a.ics`, {
      body: vtodo(sharedUid, "Cross-list A"),
    });
    expect(crossA.statusCode).toBe(201);
    const crossB = await dav("PUT", `/calendars/${listBId}/cross-b.ics`, {
      body: vtodo(sharedUid, "Cross-list B"),
    });
    expect(crossB.statusCode).toBe(201);
    expect(
      await dav("GET", `/calendars/${listAId}/cross-a.ics`),
    ).toHaveProperty("statusCode", 200);
    expect(
      await dav("GET", `/calendars/${listBId}/cross-b.ics`),
    ).toHaveProperty("statusCode", 200);

    // Inbox is its own virtual collection.
    const inboxTaskId = newId();
    expect(
      (
        await api("POST", "/api/tasks", {
          payload: { id: inboxTaskId, title: "Inbox task" },
        })
      ).statusCode,
    ).toBe(201);
    const inbox = await dav("REPORT", "/calendars/inbox/", {
      body: query(),
    });
    expect(inbox.statusCode).toBe(207);
    expect(inbox.body).toContain(`/caldav/calendars/inbox/${inboxTaskId}.ics`);
    expect(inbox.body).not.toContain(aTaskId);

    const inboxInitial = await dav("REPORT", "/calendars/inbox/", {
      body: syncBody(""),
    });
    const inboxToken = syncTokenOf(inboxInitial.body);
    const inboxTask2 = newId();
    expect(
      (
        await api("POST", "/api/tasks", {
          payload: { id: inboxTask2, title: "Second inbox task" },
        })
      ).statusCode,
    ).toBe(201);
    const inboxDelta = await dav("REPORT", "/calendars/inbox/", {
      body: syncBody(inboxToken),
    });
    expect(inboxDelta.statusCode).toBe(207);
    expect(inboxDelta.body).toContain(
      `/caldav/calendars/inbox/${inboxTask2}.ics`,
    );
    expect(inboxDelta.body).not.toContain(aTaskId);
  });

  it("syncs each list independently and rejects another list's token", async () => {
    const listA = await api("POST", "/api/lists", {
      payload: { id: newId(), name: "Sync list A" },
    });
    const listAId = (listA.json() as { id: string }).id;
    const listB = await api("POST", "/api/lists", {
      payload: { id: newId(), name: "Sync list B" },
    });
    const listBId = (listB.json() as { id: string }).id;

    const initialA = await dav("REPORT", `/calendars/${listAId}/`, {
      body: syncBody(""),
    });
    expect(initialA.statusCode).toBe(207);
    const tokenA = syncTokenOf(initialA.body);
    expect(tokenA).toContain(`:${listAId}:`);

    const initialB = await dav("REPORT", `/calendars/${listBId}/`, {
      body: syncBody(""),
    });
    const tokenB = syncTokenOf(initialB.body);

    const aTaskId = newId();
    const bTaskId = newId();
    expect(
      (
        await api("POST", "/api/tasks", {
          payload: { id: aTaskId, title: "New A task", listId: listAId },
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await api("POST", "/api/tasks", {
          payload: { id: bTaskId, title: "New B task", listId: listBId },
        })
      ).statusCode,
    ).toBe(201);

    const deltaA = await dav("REPORT", `/calendars/${listAId}/`, {
      body: syncBody(tokenA),
    });
    expect(deltaA.body).toContain(`/caldav/calendars/${listAId}/${aTaskId}.ics`);
    expect(deltaA.body).not.toContain(bTaskId);

    const deltaB = await dav("REPORT", `/calendars/${listBId}/`, {
      body: syncBody(tokenB),
    });
    expect(deltaB.body).toContain(`/caldav/calendars/${listBId}/${bTaskId}.ics`);
    expect(deltaB.body).not.toContain(aTaskId);

    // A token is scoped to its collection; using A's token on B fails closed.
    const wrongCollection = await dav("REPORT", `/calendars/${listBId}/`, {
      body: syncBody(tokenA),
    });
    expect(wrongCollection.statusCode).toBe(403);
    expect(wrongCollection.body).toContain("valid-sync-token");

    // Moving a task through the REST API tombstones it in the old list and
    // reports an update in the new list.
    const movedId = newId();
    expect(
      (
        await api("POST", "/api/tasks", {
          payload: { id: movedId, title: "Moving task", listId: listAId },
        })
      ).statusCode,
    ).toBe(201);
    const move = await api("PATCH", `/api/tasks/${movedId}`, {
      headers: { "if-match": '"rev-1"' },
      payload: { listId: listBId },
    });
    expect(move.statusCode).toBe(200);

    const oldList = await dav("REPORT", `/calendars/${listAId}/`, {
      body: syncBody(tokenA),
    });
    expect(oldList.body).toContain(`/caldav/calendars/${listAId}/${movedId}.ics`);
    expect(oldList.body).toContain("HTTP/1.1 404 Not Found");
    const newList = await dav("REPORT", `/calendars/${listBId}/`, {
      body: syncBody(tokenB),
    });
    expect(newList.body).toContain(`/caldav/calendars/${listBId}/${movedId}.ics`);
    expect(newList.body).not.toContain("HTTP/1.1 404 Not Found");
  });

  it("lets a member read and write a shared list collection", async () => {
    const stepUp = await api("POST", "/api/auth/password", {
      payload: { password: PASSWORD },
    });
    expect(stepUp.statusCode).toBe(200);
    const memberPassword = "member-caldav-password-01";
    const createdUser = await api("POST", "/api/users", {
      payload: {
        username: "caldav-member",
        password: memberPassword,
        timezone: "UTC",
      },
    });
    expect(createdUser.statusCode).toBe(201);
    const memberId = (createdUser.json() as { user: { id: string } }).user.id;
    const login = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { username: "caldav-member", password: memberPassword },
    });
    expect(login.statusCode).toBe(200);
    const memberCookie = cookieOf(login);

    const sharedList = await api("POST", "/api/lists", {
      payload: { id: newId(), name: "Shared CalDAV list" },
    });
    expect(sharedList.statusCode).toBe(201);
    const sharedListId = (sharedList.json() as { id: string }).id;
    const share = await api("POST", `/api/lists/${sharedListId}/share`, {
      payload: { username: "caldav-member" },
    });
    expect(share.statusCode).toBe(201);

    // Owner-created task on the shared list must be visible to the member.
    const ownerTaskId = newId();
    expect(
      (
        await api("POST", "/api/tasks", {
          payload: {
            id: ownerTaskId,
            title: "Owner task on shared list",
            listId: sharedListId,
          },
        })
      ).statusCode,
    ).toBe(201);

    const memberTokenRes = await api("POST", "/api/capture/tokens", {
      cookie: memberCookie,
      payload: { name: "Member CalDAV", kind: "caldav" },
    });
    expect(memberTokenRes.statusCode).toBe(201);
    const memberToken = (memberTokenRes.json() as { token: string }).token;

    const memberHome = await dav("PROPFIND", "/calendars/", {
      token: memberToken,
      headers: { depth: "1" },
    });
    expect(memberHome.statusCode).toBe(207);
    expect(memberHome.body).toContain(`/caldav/calendars/${sharedListId}/`);
    expect(memberHome.body).toContain("Shared CalDAV list");

    const memberRename = await dav(
      "PROPPATCH",
      `/calendars/${sharedListId}/`,
      {
        token: memberToken,
        body: [
          '<d:propertyupdate xmlns:d="DAV:">',
          "<d:set><d:prop><d:displayname>Member rename</d:displayname></d:prop></d:set>",
          "</d:propertyupdate>",
        ].join(""),
      },
    );
    expect(memberRename.statusCode).toBe(403);
    const memberDelete = await dav(
      "DELETE",
      `/calendars/${sharedListId}/`,
      { token: memberToken },
    );
    expect(memberDelete.statusCode).toBe(403);

    const ownerTask = await dav(
      "GET",
      `/calendars/${sharedListId}/${ownerTaskId}.ics`,
      { token: memberToken },
    );
    expect(ownerTask.statusCode).toBe(200);
    expect(ownerTask.body).toContain("Owner task on shared list");

    // Member sync token must see changes made by the list owner.
    const memberInitial = await dav(
      "REPORT",
      `/calendars/${sharedListId}/`,
      { token: memberToken, body: syncBody("") },
    );
    expect(memberInitial.statusCode).toBe(207);
    const memberToken1 = syncTokenOf(memberInitial.body);
    const lateTaskId = newId();
    expect(
      (
        await api("POST", "/api/tasks", {
          payload: {
            id: lateTaskId,
            title: "Owner task after member sync",
            listId: sharedListId,
          },
        })
      ).statusCode,
    ).toBe(201);
    const memberDelta = await dav(
      "REPORT",
      `/calendars/${sharedListId}/`,
      { token: memberToken, body: syncBody(memberToken1) },
    );
    expect(memberDelta.statusCode).toBe(207);
    expect(memberDelta.body).toContain(
      `/caldav/calendars/${sharedListId}/${lateTaskId}.ics`,
    );

    const ownerInitial = await dav(
      "REPORT",
      `/calendars/${sharedListId}/`,
      { body: syncBody("") },
    );
    const ownerToken = syncTokenOf(ownerInitial.body);

    const memberTaskId = newId();
    const memberPut = await dav(
      "PUT",
      `/calendars/${sharedListId}/${memberTaskId}.ics`,
      {
        token: memberToken,
        body: vtodo(`${memberTaskId}@morrow`, "Member task on shared list"),
      },
    );
    expect(memberPut.statusCode).toBe(201);
    const stored = getDb()
      .prepare("SELECT user_id, list_id FROM tasks WHERE id = ?")
      .get(memberTaskId) as { user_id: string; list_id: string | null };
    expect(stored.user_id).toBe(memberId);
    expect(stored.list_id).toBe(sharedListId);

    // The owner sees the member-created task in the same collection.
    const ownerRead = await dav(
      "GET",
      `/calendars/${sharedListId}/${memberTaskId}.ics`,
    );
    expect(ownerRead.statusCode).toBe(200);
    expect(ownerRead.body).toContain("Member task on shared list");

    // The owner's list sync must also see the member's journal row even
    // though that row carries the member's user_id.
    const ownerDelta = await dav(
      "REPORT",
      `/calendars/${sharedListId}/`,
      { body: syncBody(ownerToken) },
    );
    expect(ownerDelta.statusCode).toBe(207);
    expect(ownerDelta.body).toContain(
      `/caldav/calendars/${sharedListId}/${memberTaskId}.ics`,
    );

    // A private owner list stays invisible to the member.
    const privateList = await api("POST", "/api/lists", {
      payload: { id: newId(), name: "Owner private CalDAV list" },
    });
    expect(privateList.statusCode).toBe(201);
    const privateListId = (privateList.json() as { id: string }).id;
    const denied = await dav("PROPFIND", `/calendars/${privateListId}/`, {
      token: memberToken,
      headers: { depth: "0" },
    });
    expect(denied.statusCode).toBe(404);

    // Unsharing removes the collection from the member's next request.
    const unshare = await api(
      "DELETE",
      `/api/lists/${sharedListId}/share/${memberId}`,
    );
    expect(unshare.statusCode).toBe(200);
    const deniedAfterUnshare = await dav(
      "PROPFIND",
      `/calendars/${sharedListId}/`,
      { token: memberToken, headers: { depth: "0" } },
    );
    expect(deniedAfterUnshare.statusCode).toBe(404);
  });
});

describe("CalDAV TZID/VTIMEZONE", () => {
  it("preserves a client TZID and emits a matching VTIMEZONE", async () => {
    const body = vtodo("tz-route@example.test", "Timezone route", [
      "DTSTART;TZID=Europe/Berlin:20260115T090000",
      "DUE;TZID=Europe/Berlin:20260115T103000",
      "RRULE:FREQ=DAILY;COUNT=2",
    ]);
    const put = await dav("PUT", "/calendars/inbox/tz-route.ics", { body });
    expect(put.statusCode).toBe(201);

    const row = getDb()
      .prepare(
        "SELECT timezone, due_at, dtstart_local FROM tasks WHERE ical_uid = ? AND deleted_at IS NULL",
      )
      .get("tz-route@example.test") as
      | { timezone: string; due_at: string; dtstart_local: string }
      | undefined;
    expect(row?.timezone).toBe("Europe/Berlin");
    expect(row?.due_at).toBe("2026-01-15T09:30:00.000Z");
    expect(row?.dtstart_local).toBe("2026-01-15T09:00:00");

    const get = await dav("GET", "/calendars/inbox/tz-route.ics");
    expect(get.statusCode).toBe(200);
    expect(get.body).toContain("BEGIN:VTIMEZONE");
    expect(get.body).toContain("TZID:Europe/Berlin");
    expect(get.body).toContain("DTSTART;TZID=Europe/Berlin:20260115T090000");
    expect(get.body).toContain("DUE;TZID=Europe/Berlin:20260115T103000");
    expect(get.body.indexOf("END:VTIMEZONE")).toBeLessThan(
      get.body.indexOf("BEGIN:VTODO"),
    );
    // The representation ETag covers the VTIMEZONE and TZID values.
    expect(get.headers["etag"]).toBe(put.headers["etag"]);
  });

  it("leaves UTC resources in the previous UTC shape", async () => {
    const body = vtodo("utc-route@example.test", "UTC route", [
      "DUE:20260115T103000Z",
    ]);
    const put = await dav("PUT", "/calendars/inbox/utc-route.ics", { body });
    expect(put.statusCode).toBe(201);
    const get = await dav("GET", "/calendars/inbox/utc-route.ics");
    expect(get.statusCode).toBe(200);
    expect(get.body).toContain("DUE:20260115T103000Z");
    expect(get.body).not.toContain("BEGIN:VTIMEZONE");
    expect(get.body).not.toContain("TZID=");
  });
});

describe("CalDAV recurrence exceptions", () => {
  it("stores, exposes, syncs, and deletes a per-occurrence override", async () => {
    const uid = "recur-exception@example.test";
    const seriesHref = "recur-exception-series.ics";
    const exceptionHref = "recur-exception-one.ics";
    const series = await dav("PUT", `/calendars/inbox/${seriesHref}`, {
      body: vtodo(uid, "Daily series", [
        "DTSTART:20260115T090000Z",
        "DUE:20260115T093000Z",
        "RRULE:FREQ=DAILY;COUNT=3",
      ]),
    });
    expect(series.statusCode).toBe(201);

    const token = syncTokenOf(
      (
        await dav("REPORT", "/calendars/inbox/", {
          body: syncBody(""),
        })
      ).body,
    );

    const exception = await dav(
      "PUT",
      `/calendars/inbox/${exceptionHref}`,
      {
        body: vtodo(uid, "Changed occurrence", [
          "RECURRENCE-ID:20260115T090000Z",
          "DUE:20260115T113000Z",
          "STATUS:COMPLETED",
          "COMPLETED:20260115T100000Z",
        ]),
      },
    );
    expect(exception.statusCode).toBe(201);

    const get = await dav(
      "GET",
      `/calendars/inbox/${exceptionHref}`,
    );
    expect(get.statusCode).toBe(200);
    expect(get.body).toContain(`UID:${uid}`);
    expect(get.body).toContain("RECURRENCE-ID:20260115T090000Z");
    expect(get.body).toContain("SUMMARY:Changed occurrence");
    expect(get.body).toContain("STATUS:COMPLETED");

    const listing = await dav("PROPFIND", "/calendars/inbox/", {
      headers: { depth: "1" },
    });
    expect(listing.body).toContain(
      `/caldav/calendars/inbox/${seriesHref}`,
    );
    expect(listing.body).toContain(
      `/caldav/calendars/inbox/${exceptionHref}`,
    );

    const delta = await dav("REPORT", "/calendars/inbox/", {
      body: syncBody(token),
    });
    expect(delta.statusCode).toBe(207);
    expect(delta.body).toContain(
      `/caldav/calendars/inbox/${exceptionHref}`,
    );

    const deleted = await dav(
      "DELETE",
      `/calendars/inbox/${exceptionHref}`,
    );
    expect(deleted.statusCode).toBe(204);
    const tombstone = await dav("REPORT", "/calendars/inbox/", {
      body: syncBody(syncTokenOf(delta.body)),
    });
    expect(tombstone.body).toContain(
      `/caldav/calendars/inbox/${exceptionHref}`,
    );
    expect(tombstone.body).toContain("HTTP/1.1 404 Not Found");
  });

  it("round-trips EXDATE and reopens the occurrence when the line is removed", async () => {
    const uid = "exdate-roundtrip@example.test";
    const href = "exdate-roundtrip.ics";
    const base = (extra: string[]): string =>
      vtodo(uid, "EXDATE round-trip", [
        "DTSTART:20260115T090000Z",
        "DUE:20260115T093000Z",
        "RRULE:FREQ=DAILY;COUNT=3",
        ...extra,
      ]);

    expect(
      (
        await dav("PUT", `/calendars/inbox/${href}`, {
          body: base(["EXDATE:20260116T090000Z"]),
        })
      ).statusCode,
    ).toBe(201);
    const withExdate = await dav("GET", `/calendars/inbox/${href}`);
    expect(withExdate.statusCode).toBe(200);
    expect(withExdate.body.replace(/\r\n[ \t]/g, "")).toContain(
      "EXDATE:20260116T090000Z",
    );
    const exception = getDb()
      .prepare(
        `SELECT e.id, e.caldav_href FROM task_recurrence_exceptions e
           JOIN tasks t ON t.id = e.task_id
          WHERE t.ical_uid = ? AND e.deleted_at IS NULL`,
      )
      .get(uid) as { id: string; caldav_href: string } | undefined;
    expect(exception).toBeDefined();

    // A full-resource PUT replaces the EXDATE set: dropping the line reopens
    // the occurrence and tombstones the synthetic exception resource.
    expect(
      (
        await dav("PUT", `/calendars/inbox/${href}`, {
          body: base([]),
        })
      ).statusCode,
    ).toBe(204);
    const withoutExdate = await dav("GET", `/calendars/inbox/${href}`);
    expect(withoutExdate.body).not.toContain("EXDATE:");
    expect(
      (
        await dav("GET", `/calendars/inbox/${exception!.caldav_href}`)
      ).statusCode,
    ).toBe(404);
    expect(
      getDb()
        .prepare(
          `SELECT COUNT(*) AS n FROM task_recurrence_exceptions
            WHERE task_id = (SELECT id FROM tasks WHERE ical_uid = ?)
              AND deleted_at IS NULL`,
        )
        .get(uid),
    ).toEqual({ n: 0 });

    // Re-adding the EXDATE creates a live cancellation again.
    expect(
      (
        await dav("PUT", `/calendars/inbox/${href}`, {
          body: base(["EXDATE:20260116T090000Z"]),
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await dav("GET", `/calendars/inbox/${href}`)
      ).body.replace(/\r\n[ \t]/g, ""),
    ).toContain("EXDATE:20260116T090000Z");
  });

  it("journals the base when an EXDATE exception is deleted or converted", async () => {
    const uid = "exdate-base-journal@example.test";
    const href = "exdate-base-journal.ics";
    const base = (extra: string[]): string =>
      vtodo(uid, "EXDATE base journal", [
        "DTSTART:20260115T090000Z",
        "DUE:20260115T093000Z",
        "RRULE:FREQ=DAILY;COUNT=3",
        ...extra,
      ]);
    expect(
      (
        await dav("PUT", `/calendars/inbox/${href}`, {
          body: base(["EXDATE:20260116T090000Z"]),
        })
      ).statusCode,
    ).toBe(201);
    const synthetic = getDb()
      .prepare(
        `SELECT e.caldav_href FROM task_recurrence_exceptions e
           JOIN tasks t ON t.id = e.task_id
          WHERE t.ical_uid = ? AND e.deleted_at IS NULL`,
      )
      .get(uid) as { caldav_href: string };
    const token = syncTokenOf(
      (await dav("REPORT", "/calendars/inbox/", { body: syncBody("") })).body,
    );

    expect(
      (await dav("DELETE", `/calendars/inbox/${synthetic.caldav_href}`))
        .statusCode,
    ).toBe(204);
    const delta = await dav("REPORT", "/calendars/inbox/", {
      body: syncBody(token),
    });
    expect(delta.statusCode).toBe(207);
    expect(delta.body).toContain(`/caldav/calendars/inbox/${href}`);
    expect(delta.body).toContain(
      `/caldav/calendars/inbox/${synthetic.caldav_href}`,
    );
    expect(delta.body).toContain("HTTP/1.1 404 Not Found");
    expect((await dav("GET", `/calendars/inbox/${href}`)).body).not.toContain(
      "EXDATE:",
    );

    // Re-add the exclusion, then convert the synthetic row into an explicit
    // override. The base must be journaled again because EXDATE disappears.
    expect(
      (
        await dav("PUT", `/calendars/inbox/${href}`, {
          body: base(["EXDATE:20260116T090000Z"]),
        })
      ).statusCode,
    ).toBe(204);
    const token2 = syncTokenOf(
      (await dav("REPORT", "/calendars/inbox/", { body: syncBody("") })).body,
    );
    expect(
      (
        await dav("PUT", "/calendars/inbox/exdate-converted.ics", {
          body: vtodo(uid, "Converted occurrence", [
            "RECURRENCE-ID:20260116T090000Z",
            "DUE:20260116T113000Z",
          ]),
        })
      ).statusCode,
    ).toBeGreaterThanOrEqual(200);
    const convertedDelta = await dav("REPORT", "/calendars/inbox/", {
      body: syncBody(token2),
    });
    expect(convertedDelta.body).toContain(`/caldav/calendars/inbox/${href}`);
    expect(convertedDelta.body).toContain(
      "/caldav/calendars/inbox/exdate-converted.ics",
    );
    expect((await dav("GET", `/calendars/inbox/${href}`)).body).not.toContain(
      "EXDATE:",
    );
  });

  it("tombstones the old href when an exception resource is renamed", async () => {
    const uid = "exception-rename@example.test";
    expect(
      (
        await dav("PUT", "/calendars/inbox/exception-rename-series.ics", {
          body: vtodo(uid, "Rename series", [
            "DTSTART:20260115T090000Z",
            "DUE:20260115T093000Z",
            "RRULE:FREQ=DAILY;COUNT=3",
          ]),
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await dav("PUT", "/calendars/inbox/exception-old.ics", {
          body: vtodo(uid, "Old href occurrence", [
            "RECURRENCE-ID:20260116T090000Z",
            "DUE:20260116T113000Z",
          ]),
        })
      ).statusCode,
    ).toBe(201);
    const token = syncTokenOf(
      (await dav("REPORT", "/calendars/inbox/", { body: syncBody("") })).body,
    );

    expect(
      (
        await dav("PUT", "/calendars/inbox/exception-new.ics", {
          body: vtodo(uid, "Renamed occurrence", [
            "RECURRENCE-ID:20260116T090000Z",
            "DUE:20260116T113000Z",
          ]),
        })
      ).statusCode,
    ).toBe(204);

    const delta = await dav("REPORT", "/calendars/inbox/", {
      body: syncBody(token),
    });
    expect(delta.statusCode).toBe(207);
    expect(delta.body).toContain("/caldav/calendars/inbox/exception-old.ics");
    expect(delta.body).toContain("HTTP/1.1 404 Not Found");
    expect(delta.body).toContain("/caldav/calendars/inbox/exception-new.ics");
    expect(
      (await dav("GET", "/calendars/inbox/exception-old.ics")).statusCode,
    ).toBe(404);
    expect(
      (await dav("GET", "/calendars/inbox/exception-new.ics")).statusCode,
    ).toBe(200);
  });

  it("allocates a non-colliding href for an EXDATE-created exception", async () => {
    const uid = "exdate-collision@example.test";
    const href = "exdate-collision.ics";
    expect(
      (
        await dav("PUT", `/calendars/inbox/${href}`, {
          body: vtodo(uid, "EXDATE collision", [
            "DTSTART:20260115T090000Z",
            "DUE:20260115T093000Z",
            "RRULE:FREQ=DAILY;COUNT=3",
          ]),
        })
      ).statusCode,
    ).toBe(201);

    const second = "20260116T090000Z";
    const canonicalSecond = "2026-01-16T09:00:00.000Z";
    const generated = `exdate-collision~ex-${crypto
      .createHash("sha1")
      .update(canonicalSecond)
      .digest("hex")
      .slice(0, 10)}.ics`;
    // Occupy the name the EXDATE generator would choose for the second
    // occurrence with an explicit override on the first one.
    expect(
      (
        await dav("PUT", `/calendars/inbox/${generated}`, {
          body: vtodo(uid, "Explicit first occurrence", [
            "RECURRENCE-ID:20260115T090000Z",
            "DUE:20260115T113000Z",
          ]),
        })
      ).statusCode,
    ).toBe(201);

    expect(
      (
        await dav("PUT", `/calendars/inbox/${href}`, {
          body: vtodo(uid, "EXDATE collision", [
            "DTSTART:20260115T090000Z",
            "DUE:20260115T093000Z",
            "RRULE:FREQ=DAILY;COUNT=3",
            `EXDATE:${second}`,
          ]),
        })
      ).statusCode,
    ).toBe(204);

    const rows = getDb()
      .prepare(
        `SELECT e.recurrence_id, e.caldav_href
           FROM task_recurrence_exceptions e
           JOIN tasks t ON t.id = e.task_id
          WHERE t.ical_uid = ? AND e.deleted_at IS NULL
          ORDER BY e.recurrence_id`,
      )
      .all(uid) as Array<{ recurrence_id: string; caldav_href: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.caldav_href).toBe(generated);
    expect(rows[1]!.recurrence_id).toBe(canonicalSecond);
    expect(rows[1]!.caldav_href).not.toBe(generated);
    expect(rows[1]!.caldav_href).toMatch(/-1\.ics$/);
  });

  it("keeps an explicit override when its EXDATE is removed", async () => {
    const uid = "exdate-explicit@example.test";
    const href = "exdate-explicit.ics";
    const base = (extra: string[]): string =>
      vtodo(uid, "EXDATE explicit", [
        "DTSTART:20260115T090000Z",
        "DUE:20260115T093000Z",
        "RRULE:FREQ=DAILY;COUNT=3",
        ...extra,
      ]);
    expect(
      (
        await dav("PUT", `/calendars/inbox/${href}`, {
          body: base(["EXDATE:20260116T090000Z"]),
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await dav("PUT", "/calendars/inbox/exdate-explicit-override.ics", {
          body: vtodo(uid, "Explicit move", [
            "RECURRENCE-ID:20260116T090000Z",
            "DUE:20260116T113000Z",
          ]),
        })
      ).statusCode,
    ).toBeGreaterThanOrEqual(200);

    expect(
      (
        await dav("PUT", `/calendars/inbox/${href}`, {
          body: base([]),
        })
      ).statusCode,
    ).toBe(204);
    const override = await dav(
      "GET",
      "/calendars/inbox/exdate-explicit-override.ics",
    );
    expect(override.statusCode).toBe(200);
    expect(override.body).toContain("SUMMARY:Explicit move");
  });

  it("rejects cross-series exception href reuse and base shadowing", async () => {
    const uidA = "href-owner-a@example.test";
    const uidB = "href-owner-b@example.test";
    expect(
      (
        await dav("PUT", "/calendars/inbox/href-series-a.ics", {
          body: vtodo(uidA, "Series A", [
            "DTSTART:20260115T090000Z",
            "DUE:20260115T093000Z",
            "RRULE:FREQ=DAILY;COUNT=3",
          ]),
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await dav("PUT", "/calendars/inbox/href-series-b.ics", {
          body: vtodo(uidB, "Series B", [
            "DTSTART:20260115T090000Z",
            "DUE:20260115T093000Z",
            "RRULE:FREQ=DAILY;COUNT=3",
          ]),
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await dav("PUT", "/calendars/inbox/href-shared-exception.ics", {
          body: vtodo(uidA, "A occurrence", [
            "RECURRENCE-ID:20260116T090000Z",
            "DUE:20260116T113000Z",
          ]),
        })
      ).statusCode,
    ).toBe(201);
    const ownerTask = getDb()
      .prepare("SELECT id FROM tasks WHERE ical_uid = ?")
      .get(uidA) as { id: string };

    const rebind = await dav(
      "PUT",
      "/calendars/inbox/href-shared-exception.ics",
      {
        body: vtodo(uidB, "B tries to steal the href", [
          "RECURRENCE-ID:20260116T090000Z",
          "DUE:20260116T123000Z",
        ]),
      },
    );
    expect(rebind.statusCode).toBe(409);
    expect(rebind.body).toContain("no-uid-conflict");
    const unchanged = getDb()
      .prepare(
        "SELECT task_id FROM task_recurrence_exceptions WHERE caldav_href = 'href-shared-exception.ics' AND deleted_at IS NULL",
      )
      .get() as { task_id: string };
    expect(unchanged.task_id).toBe(ownerTask.id);
    const stillA = await dav(
      "GET",
      "/calendars/inbox/href-shared-exception.ics",
    );
    expect(stillA.statusCode).toBe(200);
    expect(stillA.body).toContain("SUMMARY:A occurrence");

    const shadow = await dav(
      "PUT",
      "/calendars/inbox/href-shared-exception.ics",
      {
        body: vtodo(uidA, "Base over exception", [
          "DTSTART:20260115T090000Z",
          "DUE:20260115T093000Z",
          "RRULE:FREQ=DAILY;COUNT=3",
        ]),
      },
    );
    expect(shadow.statusCode).toBe(409);
    expect(shadow.body).toContain("no-uid-conflict");
    expect(
      (
        await dav("GET", "/calendars/inbox/href-shared-exception.ics")
      ).body,
    ).toContain("RECURRENCE-ID:20260116T090000Z");
  });

  it("turns an EXDATE into a cancelled exception resource", async () => {
    const uid = "exdate-series@example.test";
    const href = "exdate-series.ics";
    const put = await dav("PUT", `/calendars/inbox/${href}`, {
      body: vtodo(uid, "EXDATE series", [
        "DTSTART:20260115T090000Z",
        "DUE:20260115T093000Z",
        "RRULE:FREQ=DAILY;COUNT=3",
        "EXDATE:20260116T090000Z",
      ]),
    });
    expect(put.statusCode).toBe(201);

    const row = getDb()
      .prepare(
        `SELECT e.caldav_href FROM task_recurrence_exceptions e
           JOIN tasks t ON t.id = e.task_id
          WHERE t.ical_uid = ? AND e.deleted_at IS NULL`,
      )
      .get(uid) as { caldav_href: string } | undefined;
    expect(row).toBeDefined();
    const exception = await dav(
      "GET",
      `/calendars/inbox/${row!.caldav_href}`,
    );
    expect(exception.statusCode).toBe(200);
    expect(exception.body).toContain("RECURRENCE-ID:20260116T090000Z");
    expect(exception.body).toContain("STATUS:CANCELLED");
  });
});

describe("CalDAV legacy all-tasks alias", () => {
  it("stays readable but rejects every mutation", async () => {
    const uid = "legacy-alias-read-only@example.test";
    const href = "legacy-alias-read-only.ics";
    expect(
      (
        await dav("PUT", `/calendars/inbox/${href}`, {
          body: vtodo(uid, "Readable through the alias"),
        })
      ).statusCode,
    ).toBe(201);

    const listing = await dav("PROPFIND", "/calendars/morrow/", {
      headers: { depth: "1" },
    });
    expect(listing.statusCode).toBe(207);
    expect(listing.body).toContain(`/caldav/calendars/morrow/${href}`);

    const get = await dav("GET", `/calendars/morrow/${href}`);
    expect(get.statusCode).toBe(200);
    expect(get.body).toContain(`UID:${uid}`);

    const put = await dav("PUT", "/calendars/morrow/new-through-alias.ics", {
      body: vtodo("legacy-alias-new@example.test", "Must not be created"),
    });
    expect(put.statusCode).toBe(403);
    expect(put.body).toContain("legacy_collection_read_only");

    const del = await dav("DELETE", `/calendars/morrow/${href}`, {
      headers: { "if-match": String(get.headers["etag"]) },
    });
    expect(del.statusCode).toBe(403);
    expect(await dav("GET", `/calendars/inbox/${href}`)).toHaveProperty(
      "statusCode",
      200,
    );

    const proppatch = await dav("PROPPATCH", "/calendars/morrow/", {
      body: [
        '<d:propertyupdate xmlns:d="DAV:">',
        "<d:set><d:prop><d:displayname>Nope</d:displayname></d:prop></d:set>",
        "</d:propertyupdate>",
      ].join(""),
    });
    expect(proppatch.statusCode).toBe(403);

    const move = await dav("MOVE", `/calendars/morrow/${href}`, {
      headers: {
        destination: `/caldav/calendars/inbox/${href}`,
      },
    });
    expect(move.statusCode).toBe(403);
  });
});

describe("CalDAV attachments", () => {
  it("exposes attachments as ATTACH, downloads with CalDAV auth, and journals changes", async () => {
    const taskId = newId();
    expect(
      (
        await api("POST", "/api/tasks", {
          payload: { id: taskId, title: "Attachment task" },
        })
      ).statusCode,
    ).toBe(201);

    const before = await dav("GET", `/calendars/inbox/${taskId}.ics`);
    expect(before.statusCode).toBe(200);
    const etagBefore = String(before.headers["etag"]);
    const token = syncTokenOf(
      (
        await dav("REPORT", "/calendars/inbox/", {
          body: syncBody(""),
        })
      ).body,
    );

    const boundary = "----morrow-caldav-attachment";
    const multipart = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="note.txt"\r\nContent-Type: text/plain\r\n\r\n`,
      ),
      Buffer.from("attachment body"),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const uploaded = await api("POST", `/api/tasks/${taskId}/attachments`, {
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: multipart,
    });
    expect(uploaded.statusCode).toBe(201);
    const attachmentId = (uploaded.json() as { id: string }).id;

    const after = await dav("GET", `/calendars/inbox/${taskId}.ics`);
    expect(after.statusCode).toBe(200);
    expect(String(after.headers["etag"])).not.toBe(etagBefore);
    const unfolded = after.body.replace(/\r\n[ \t]/g, "");
    expect(unfolded).toContain("ATTACH;");
    expect(unfolded).toContain(
      `/caldav/attachments/${encodeURIComponent(attachmentId)}`,
    );

    const download = await dav(
      "GET",
      `/attachments/${encodeURIComponent(attachmentId)}`,
    );
    expect(download.statusCode).toBe(200);
    expect(download.body).toBe("attachment body");
    expect(String(download.headers["content-type"])).toContain("text/plain");

    const delta = await dav("REPORT", "/calendars/inbox/", {
      body: syncBody(token),
    });
    expect(delta.statusCode).toBe(207);
    expect(delta.body).toContain(`/caldav/calendars/inbox/${taskId}.ics`);

    expect(
      (await api("DELETE", `/api/attachments/${attachmentId}`)).statusCode,
    ).toBe(200);
    const removed = await dav("GET", `/calendars/inbox/${taskId}.ics`);
    expect(removed.body).not.toContain("ATTACH;");
  });

  it("denies attachment downloads to a CalDAV user without task access", async () => {
    const stepUp = await api("POST", "/api/auth/password", {
      payload: { password: PASSWORD },
    });
    expect(stepUp.statusCode).toBe(200);
    const outsiderPassword = "outsider-attachment-password-01";
    expect(
      (
        await api("POST", "/api/users", {
          payload: {
            username: "caldav-attachment-outsider",
            password: outsiderPassword,
            timezone: "UTC",
          },
        })
      ).statusCode,
    ).toBe(201);
    const login = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: {
        username: "caldav-attachment-outsider",
        password: outsiderPassword,
      },
    });
    expect(login.statusCode).toBe(200);
    const outsiderCookie = cookieOf(login);
    const outsiderTokenRes = await api("POST", "/api/capture/tokens", {
      cookie: outsiderCookie,
      payload: { name: "Outsider CalDAV", kind: "caldav" },
    });
    expect(outsiderTokenRes.statusCode).toBe(201);
    const outsiderToken = (outsiderTokenRes.json() as { token: string }).token;

    const taskId = newId();
    expect(
      (
        await api("POST", "/api/tasks", {
          payload: { id: taskId, title: "Private attachment task" },
        })
      ).statusCode,
    ).toBe(201);
    const boundary = "----morrow-private-attachment";
    const uploaded = await api("POST", `/api/tasks/${taskId}/attachments`, {
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="private.txt"\r\nContent-Type: text/plain\r\n\r\n`,
        ),
        Buffer.from("private bytes"),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    });
    expect(uploaded.statusCode).toBe(201);
    const attachmentId = (uploaded.json() as { id: string }).id;

    const owner = await dav(
      "GET",
      `/attachments/${encodeURIComponent(attachmentId)}`,
    );
    expect(owner.statusCode).toBe(200);
    const outsider = await dav(
      "GET",
      `/attachments/${encodeURIComponent(attachmentId)}`,
      { token: outsiderToken },
    );
    expect(outsider.statusCode).toBe(404);
    expect(outsider.body).not.toContain("private bytes");
  });
});
