#!/usr/bin/env node
/**
 * CalDAV VTODO smoke test against a running Morrow instance.
 *
 * This is an HTTP-level check (no external dependencies, no third-party
 * services). It does not replace the real-client matrix in
 * docs/CALDAV-INTEROP.md; it proves the server surface before a manual run.
 *
 * Usage:
 *   MORROW_URL=http://127.0.0.1:4591 \
 *   MORROW_CALDAV_TOKEN=<kind=caldav token> \
 *   node scripts/caldav-smoke.mjs
 *
 * The token is sent only in a Basic authorization header (never a query
 * string) and is never printed.
 */
import crypto from "node:crypto";

const baseUrl = (process.env.MORROW_URL ?? "http://127.0.0.1:3000").replace(
  /\/+$/,
  "",
);
const token = process.env.MORROW_CALDAV_TOKEN?.trim();
if (!token) {
  console.error("MORROW_CALDAV_TOKEN is required.");
  process.exit(2);
}

const auth = `Basic ${Buffer.from(`owner:${token}`).toString("base64")}`;
const uid = `morrow-smoke-${crypto.randomUUID()}@example.test`;
const href = `morrow-smoke-${crypto.randomUUID()}.ics`;
const collectionPath = "/caldav/calendars/inbox/";
const resourcePath = `${collectionPath}${href}`;
let failures = 0;

function check(name, condition, detail = "") {
  if (condition) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function request(method, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    redirect: "follow",
    headers: {
      authorization: auth,
      ...(options.body !== undefined
        ? { "content-type": "text/calendar; charset=utf-8" }
        : {}),
      ...(options.headers ?? {}),
    },
    body: options.body,
  });
  return {
    status: response.status,
    headers: response.headers,
    url: response.url,
    body: await response.text(),
  };
}

function vtodo(summary, extra = []) {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Morrow smoke//EN",
    "BEGIN:VTODO",
    `UID:${uid}`,
    `SUMMARY:${summary}`,
    "DUE;VALUE=DATE:20301231",
    "PRIORITY:5",
    "CATEGORIES:Smoke",
    ...extra,
    "END:VTODO",
    "END:VCALENDAR",
  ].join("\r\n");
}

function syncToken(body) {
  return /<d:sync-token>([^<]+)<\/d:sync-token>/.exec(body)?.[1] ?? "";
}

async function cleanup() {
  try {
    const current = await request("GET", resourcePath);
    if (current.status === 200) {
      await request("DELETE", resourcePath, {
        headers: { "if-match": String(current.headers.get("etag") ?? "") },
      });
    }
  } catch {
    // Best-effort cleanup. A leftover smoke task is clearly labelled.
  }
}

try {
  // The well-known endpoint redirects to /caldav/; clients use PROPFIND there.
  const discovery = await request("PROPFIND", "/.well-known/caldav", {
    headers: { depth: "0" },
  });
  check(
    "discovery reaches the CalDAV home",
    discovery.status === 207 &&
      (discovery.body.includes("current-user-principal") ||
        discovery.body.includes("calendar-home-set")),
    `status ${discovery.status}`,
  );

  const home = await request(
    "PROPFIND",
    "/caldav/calendars/",
    { headers: { depth: "1" } },
  );
  check("calendar home PROPFIND is 207", home.status === 207, `status ${home.status}`);
  check(
    "calendar home advertises the Inbox collection",
    home.body.includes("/caldav/calendars/inbox/"),
  );

  const collection = await request("PROPFIND", collectionPath, {
    headers: { depth: "0" },
  });
  check(
    "collection advertises VTODO",
    collection.status === 207 && collection.body.includes('name="VTODO"'),
    `status ${collection.status}`,
  );
  check(
    "collection advertises calendar-query/multiget/sync",
    collection.body.includes("calendar-query") &&
      collection.body.includes("calendar-multiget") &&
      collection.body.includes("sync-collection"),
  );
  check(
    "collection has a dynamic ctag",
    /<cs:getctag>ctag-/.test(collection.body),
  );

  const create = await request("PUT", resourcePath, {
    body: vtodo("Morrow smoke task"),
    headers: { "if-none-match": "*" },
  });
  check(
    "PUT create returns 201",
    create.status === 201,
    `status ${create.status}`,
  );

  const read = await request("GET", resourcePath);
  check("GET returns the VTODO", read.status === 200 && read.body.includes(uid), `status ${read.status}`);
  check("GET includes a strong ETag", Boolean(read.headers.get("etag")));
  const etag = String(read.headers.get("etag") ?? "");

  const conflict = await request("PUT", resourcePath, {
    body: vtodo("Morrow smoke conflict"),
    headers: { "if-match": '"definitely-stale"' },
  });
  check(
    "stale If-Match returns 412",
    conflict.status === 412,
    `status ${conflict.status}`,
  );

  const query = await request("REPORT", collectionPath, {
    body: `<?xml version="1.0"?><d:calendar-query xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><cal:calendar-data/></d:prop><cal:filter><cal:comp-filter name="VCALENDAR"><cal:comp-filter name="VTODO"/></cal:comp-filter></cal:filter></d:calendar-query>`,
  });
  check(
    "calendar-query returns the resource",
    query.status === 207 && query.body.includes(href),
    `status ${query.status}`,
  );

  const multiget = await request("REPORT", collectionPath, {
    body: `<?xml version="1.0"?><d:calendar-multiget xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><cal:calendar-data/></d:prop><d:href>${collectionPath}${href}</d:href></d:calendar-multiget>`,
  });
  check(
    "calendar-multiget returns the resource",
    multiget.status === 207 && multiget.body.includes(uid),
    `status ${multiget.status}`,
  );

  const initialSync = await request("REPORT", collectionPath, {
    body: `<?xml version="1.0"?><d:sync-collection xmlns:d="DAV:"><d:sync-token/><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>`,
  });
  const tokenBefore = syncToken(initialSync.body);
  check(
    "initial sync-collection returns a token",
    initialSync.status === 207 && tokenBefore !== "",
    `status ${initialSync.status}`,
  );

  const update = await request("PUT", resourcePath, {
    body: vtodo("Morrow smoke task updated"),
    headers: { "if-match": etag },
  });
  check(
    "current If-Match update returns 204",
    update.status === 204,
    `status ${update.status}`,
  );

  const datedToken = await request("REPORT", collectionPath, {
    body: `<?xml version="1.0"?><d:sync-collection xmlns:d="DAV:"><d:sync-token>${tokenBefore}</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>`,
  });
  check(
    "sync token reports the changed resource and returns a fresh token",
    datedToken.status === 207 &&
      datedToken.body.includes(href) &&
      syncToken(datedToken.body) !== "" &&
      syncToken(datedToken.body) !== tokenBefore,
    `status ${datedToken.status}`,
  );

  const afterUpdate = await request("GET", resourcePath);
  const updatedEtag = String(afterUpdate.headers.get("etag") ?? "");
  check(
    "GET reflects the update",
    afterUpdate.status === 200 &&
      afterUpdate.body.includes("Morrow smoke task updated"),
    `status ${afterUpdate.status}`,
  );

  const remove = await request("DELETE", resourcePath, {
    headers: { "if-match": updatedEtag },
  });
  check("DELETE returns 204", remove.status === 204, `status ${remove.status}`);
  const gone = await request("GET", resourcePath);
  check("deleted resource returns 404", gone.status === 404, `status ${gone.status}`);
} catch (err) {
  failures += 1;
  console.error(
    `FAIL smoke run aborted: ${err instanceof Error ? err.message : String(err)}`,
  );
} finally {
  await cleanup();
}

if (failures > 0) {
  console.error(`CalDAV smoke: ${failures} failure(s).`);
  process.exit(1);
}
console.log("CalDAV smoke: all checks passed.");
