import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "@morrow/db";
import {
  BACKUP_ACTIVITY_LIMIT,
  BACKUP_APP_VERSION,
  BACKUP_FORMAT,
  BACKUP_MAX_BYTES,
  BACKUP_SCHEMA_VERSION,
  BACKUP_TABLE_ALLOWLIST,
  BACKUP_VERSION,
  BackupVerificationError,
  createBackupDocument,
  decodeAndVerifyBackup,
  exportBackup,
  importBackup,
  listBackupRuns,
  parseJsonWithLimits,
  pruneBackups,
  readBackupDataFromDb,
  resolveBackupMaxBytes,
  runBackupNow,
  selectBackupsToRetain,
  serializeBackupPayload,
  serializeBackupDocument,
  sha256Hex,
  verifyBackupBytes,
  verifyUploadBackup,
  type BackupData,
  type BackupDb,
  type BackupPayload,
} from "../src/backup.js";
import { SEED_NOW, SEED_USER_ID, seedSecretsDb } from "./helpers.js";

const NOW = "2026-11-02T12:00:00.000Z";
const USER_ID = "01900000-0000-7000-8000-000000000001";

function sampleData(): BackupData {
  return {
    lists: [
      {
        id: "01900000-0000-7000-8000-000000000002",
        user_id: USER_ID,
        name: "Inbox",
        sort_key: "V00000000000000",
        is_inbox: 1,
        rev: 1,
        created_at: NOW,
        updated_at: NOW,
        deleted_at: null,
      },
    ],
    tasks: [
      {
        id: "01900000-0000-7000-8000-000000000003",
        user_id: USER_ID,
        list_id: "01900000-0000-7000-8000-000000000002",
        title: "Milk",
        notes: null,
        status: "open",
        priority: 0,
        all_day: 0,
        occurrence_seq: 0,
        recurrence_mode: "schedule",
        clamp_policy: "skip",
        missed_count: 0,
        rev: 1,
        created_at: NOW,
        updated_at: NOW,
        deleted_at: null,
      },
    ],
    taskCompletions: [],
    settings: {
      timezone: "America/New_York",
      // Deliberately present to prove the allowlist drops secrets.
      vapidPrivateKey: "super-secret-private-key",
    },
    conversations: [],
    activity: [],
  };
}

function readDocument(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(bytes));
}

describe("backup format", () => {
  it("includes the CalDAV identity columns in the task allowlist", () => {
    expect(BACKUP_TABLE_ALLOWLIST.tasks).toEqual(
      expect.arrayContaining(["ical_uid", "caldav_href"]),
    );
    const data = sampleData();
    data.tasks[0]!["ical_uid"] = "backup-uid@example.test";
    data.tasks[0]!["caldav_href"] = "backup-uid.ics";
    const { bytes } = createBackupDocument(data, { exportedAt: NOW });
    const parsed = readDocument(bytes) as {
      data: { tasks: Array<Record<string, unknown>> };
    };
    expect(parsed.data.tasks[0]?.["ical_uid"]).toBe("backup-uid@example.test");
    expect(parsed.data.tasks[0]?.["caldav_href"]).toBe("backup-uid.ics");
  });

  it("creates the §3 envelope and a verifiable exact-byte hash", () => {
    const { document, bytes } = createBackupDocument(sampleData(), {
      exportedAt: NOW,
    });

    expect(document.format).toBe(BACKUP_FORMAT);
    expect(document.version).toBe(BACKUP_VERSION);
    expect(document.schemaVersion).toBe(BACKUP_SCHEMA_VERSION);
    expect(document.appVersion).toBe(BACKUP_APP_VERSION);
    expect(document.exportedAt).toBe(NOW);
    expect(document.sha256).toMatch(/^[0-9a-f]{64}$/);

    const parsed = readDocument(bytes) as Record<string, unknown>;
    expect(parsed["format"]).toBe("morrow.backup");
    expect(parsed["sha256"]).toBe(document.sha256);
    expect(Array.isArray(parsed["data"])).toBe(false);

    const verified = verifyBackupBytes(bytes);
    expect(verified.ok).toBe(true);
    expect(verified.errors).toEqual([]);
    expect(verified.sha256).toBe(document.sha256);
    expect(verified.hmac).toBe("absent");
    expect(verified.bytes).toBe(bytes.byteLength);
  });

  it("rejects any byte change", () => {
    const { bytes } = createBackupDocument(sampleData(), { exportedAt: NOW });
    const tampered = Buffer.from(bytes);
    const index = tampered.indexOf("Milk");
    expect(index).toBeGreaterThan(-1);
    tampered[index] = "S".charCodeAt(0); // Milk -> Silk (same length)

    const verified = verifyBackupBytes(tampered);
    expect(verified.ok).toBe(false);
    expect(verified.errors.join(" ")).toMatch(/sha256|canonical/);
  });

  it("rejects reformatted JSON even when semantically equal", () => {
    const { document, bytes } = createBackupDocument(sampleData(), {
      exportedAt: NOW,
    });
    expect(verifyBackupBytes(bytes).ok).toBe(true);

    const pretty = new TextEncoder().encode(JSON.stringify(document, null, 2));
    const verified = verifyBackupBytes(pretty);
    expect(verified.ok).toBe(false);
    expect(verified.errors.join(" ")).toMatch(/canonical/);
  });

  it("supports HMAC-SHA256 with a key outside the backup", () => {
    const key = "backup-hmac-key-outside-backup-dir";
    const { bytes } = createBackupDocument(sampleData(), {
      exportedAt: NOW,
      hmacKey: key,
    });

    expect(verifyBackupBytes(bytes).hmac).toBe("unchecked");
    expect(verifyBackupBytes(bytes).ok).toBe(true);

    const good = verifyBackupBytes(bytes, { hmacKey: key });
    expect(good.ok).toBe(true);
    expect(good.hmac).toBe("valid");

    const bad = verifyBackupBytes(bytes, { hmacKey: "wrong-key" });
    expect(bad.ok).toBe(false);
    expect(bad.hmac).toBe("invalid");
    expect(bad.errors.join(" ")).toMatch(/HMAC/);
  });

  it("drops secrets and non-allowlisted settings from the export", () => {
    const { bytes } = createBackupDocument(sampleData(), { exportedAt: NOW });
    const text = new TextDecoder().decode(bytes);
    expect(text).not.toContain("vapidPrivateKey");
    expect(text).not.toContain("super-secret-private-key");

    const parsed = readDocument(bytes) as {
      data: { settings: Record<string, unknown> };
    };
    expect(parsed.data.settings["timezone"]).toBe("America/New_York");
    expect(parsed.data.settings["vapidPrivateKey"]).toBeUndefined();
  });

  it("rejects unknown columns and non-allowlisted settings on import", () => {
    const data = sampleData() as unknown as BackupData;
    const tasks = data.tasks as Array<Record<string, unknown>>;
    tasks[0]!["password_hash"] = "must-never-import";

    const payload: BackupPayload = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: NOW,
      appVersion: BACKUP_APP_VERSION,
      schemaVersion: BACKUP_SCHEMA_VERSION,
      data,
    };
    const payloadBytes = serializeBackupPayload(payload);
    const bytes = serializeBackupDocument({
      ...payload,
      sha256: sha256Hex(payloadBytes),
    });

    const verified = verifyBackupBytes(bytes);
    expect(verified.ok).toBe(false);
    expect(verified.errors.join(" ")).toMatch(/non-allowlisted column/);
  });

  it("enforces the upload size cap", () => {
    const { bytes } = createBackupDocument(sampleData(), { exportedAt: NOW });
    const verified = verifyBackupBytes(bytes, { maxBytes: 10 });
    expect(verified.ok).toBe(false);
    expect(verified.errors.join(" ")).toMatch(/exceeds/);
  });

  it("resolves a configurable backup cap with safe bounds", () => {
    expect(resolveBackupMaxBytes({} as NodeJS.ProcessEnv)).toBe(
      BACKUP_MAX_BYTES,
    );
    expect(
      resolveBackupMaxBytes({ BACKUP_MAX_MB: "100" } as NodeJS.ProcessEnv),
    ).toBe(100 * 1024 * 1024);
    expect(
      resolveBackupMaxBytes({ BACKUP_MAX_MB: "0" } as NodeJS.ProcessEnv),
    ).toBe(BACKUP_MAX_BYTES);
    expect(
      resolveBackupMaxBytes({ BACKUP_MAX_MB: "nope" } as NodeJS.ProcessEnv),
    ).toBe(BACKUP_MAX_BYTES);
  });

  it("rejects invalid UTF-8/JSON and unknown top-level fields", () => {
    expect(verifyBackupBytes(new Uint8Array([0xff, 0xfe])).ok).toBe(false);
    expect(verifyBackupBytes("{").ok).toBe(false);

    const { bytes } = createBackupDocument(sampleData(), { exportedAt: NOW });
    const text = new TextDecoder().decode(bytes);
    const withExtra = text.replace('{"format"', '{"hello":"world","format"');
    const verified = verifyBackupBytes(new TextEncoder().encode(withExtra));
    expect(verified.ok).toBe(false);
    expect(verified.errors.join(" ")).toMatch(/unknown top-level/);
  });

  it("accepts an older schemaVersion with optional v0.2/v0.3 fields absent", () => {
    const data = sampleData();
    delete data.listMembers;
    delete data.tags;
    delete data.taskTags;
    delete data.subtasks;
    delete data.taskRecurrenceExceptions;
    delete (data.settings as Record<string, unknown>)["vapidPrivateKey"];
    const payload: BackupPayload = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: NOW,
      appVersion: BACKUP_APP_VERSION,
      schemaVersion: 1,
      data,
    };
    const bytes = serializeBackupDocument({
      ...payload,
      sha256: sha256Hex(serializeBackupPayload(payload)),
    });
    const verified = verifyBackupBytes(bytes);
    expect(verified.ok).toBe(true);
    expect(verified.errors).toEqual([]);
  });

  it("caps activity in JSON backups to the newest rows", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-backup-activity-"));
    const handle = openDatabase({ path: path.join(dir, "morrow.db") });
    try {
      const insert = handle.sqlite.prepare(
        `INSERT INTO activity
           (action, entity_type, entity_id, summary, created_at)
         VALUES ('task.create', 'task', ?, ?, ?)`,
      );
      const total = BACKUP_ACTIVITY_LIMIT + 5;
      const seed = handle.sqlite.transaction(() => {
        for (let i = 0; i < total; i += 1) {
          insert.run(`task-${i}`, `row ${i}`, NOW);
        }
      });
      seed();

      const data = readBackupDataFromDb(
        handle.sqlite as unknown as BackupDb,
      );
      expect(data.activity).toHaveLength(BACKUP_ACTIVITY_LIMIT);
      expect(data.activity[0]?.["summary"]).toBe(
        `row ${total - BACKUP_ACTIVITY_LIMIT}`,
      );
      expect(data.activity[data.activity.length - 1]?.["summary"]).toBe(
        `row ${total - 1}`,
      );
    } finally {
      handle.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a wrong format or future schema version", () => {
    const { document } = createBackupDocument(sampleData(), { exportedAt: NOW });
    const wrongFormat = { ...document, format: "other.backup" };
    const payloadBytes = serializeBackupPayload(wrongFormat as BackupPayload);
    const bytes = serializeBackupDocument({
      ...wrongFormat,
      sha256: sha256Hex(payloadBytes),
    } as typeof document);
    expect(verifyBackupBytes(bytes).ok).toBe(false);

    const future = { ...document, schemaVersion: 99 };
    const futurePayload = serializeBackupPayload(future);
    const futureBytes = serializeBackupDocument({
      ...future,
      sha256: sha256Hex(futurePayload),
    });
    const verified = verifyBackupBytes(futureBytes);
    expect(verified.ok).toBe(false);
    expect(verified.errors.join(" ")).toMatch(/newer/);
  });

  it("throws BackupVerificationError from decode helpers", () => {
    const { bytes } = createBackupDocument(sampleData());
    const tampered = Buffer.from(bytes);
    tampered[tampered.length - 5] = 0;
    expect(() => decodeAndVerifyBackup(tampered)).toThrow(
      BackupVerificationError,
    );
    expect(decodeAndVerifyBackup(bytes).format).toBe(BACKUP_FORMAT);
  });
});

describe("M3 export ledger + retention", () => {

  it("exportBackup writes a canonical file, fsyncs, and records backup_runs", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-backup-"));
    const { sqlite, close } = openDatabase({ path: ":memory:" });
    const db = sqlite as unknown as BackupDb;
    try {
      seedSecretsDb(db);
      const result = await exportBackup(db, {
        backupDir: dir,
        hmacKey: "hmac-key-outside-backup-dir",
        exportedAt: NOW,
        status: "manual",
      });
      expect(result.name).toMatch(/^morrow-20261102T120000000Z-[0-9a-f]{6}\.json$/);
      expect(fs.existsSync(result.path)).toBe(true);
      expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(result.bytesWritten).toBe(result.bytes.byteLength);

      // The file on disk verifies exactly (no reformat drift).
      const onDisk = fs.readFileSync(result.path);
      const verified = verifyBackupBytes(onDisk, {
        hmacKey: "hmac-key-outside-backup-dir",
      });
      expect(verified.ok).toBe(true);
      expect(verified.hmac).toBe("valid");

      // Ledger row recorded.
      const runs = listBackupRuns(db);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.sha256).toBe(result.sha256);
      expect(runs[0]?.status).toBe("manual");
      expect(runs[0]?.fileExists).toBe(true);
    } finally {
      close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never exports password hashes, session tokens, push keys, or HMAC keys", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-backup-"));
    const { sqlite, close } = openDatabase({ path: ":memory:" });
    const db = sqlite as unknown as BackupDb;
    try {
      seedSecretsDb(db);
      const { bytes } = await exportBackup(db, {
        backupDir: dir,
        hmacKey: "hmac-key-outside-backup-dir",
        exportedAt: NOW,
      });
      const text = new TextDecoder().decode(bytes);
      for (const secret of [
        "PW-HASH-SECRET-1",
        "SESS-TOKEN-SECRET-2",
        "P256DH-SECRET-3",
        "AUTH-SECRET-4",
        "VAPID-PRIV-SECRET-5",
        "ENDPOINT-SECRET-6",
        "hmac-key-outside-backup-dir",
        "password_hash",
        "token_hash",
        "p256dh",
      ]) {
        expect(text).not.toContain(secret);
      }
      // Allowlisted, non-secret settings survive.
      const parsed = JSON.parse(text) as {
        data: { settings: Record<string, unknown> };
      };
      expect(parsed.data.settings["timezone"]).toBe("America/New_York");
      expect(parsed.data.settings["agent"]).toEqual({ model: "x" });
    } finally {
      close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("importBackup dryRun returns counts without touching the DB", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-backup-"));
    const { sqlite, close } = openDatabase({ path: ":memory:" });
    const db = sqlite as unknown as BackupDb;
    try {
      seedSecretsDb(db);
      const { bytes } = await exportBackup(db, {
        backupDir: dir,
        exportedAt: NOW,
      });
      const before = readBackupDataFromDb(db);
      const result = await importBackup(bytes, { dryRun: true });
      expect(result.dryRun).toBe(true);
      expect(result.counts.tasks).toBe(1);
      expect(result.counts.lists).toBe(1);
      expect(result.counts.settings).toBe(2);
      // Untouched.
      expect(readBackupDataFromDb(db)).toEqual(before);
    } finally {
      close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("selectBackupsToRetain keeps 14d/8w/6m and prunes the rest", () => {
    const now = Date.parse("2026-11-02T12:00:00.000Z");
    const entries = [
      { id: "new-a", createdAt: "2026-11-02T11:00:00.000Z" },
      { id: "old-a", createdAt: "2026-11-02T10:00:00.000Z" },
      { id: "week-1", createdAt: "2026-10-10T12:00:00.000Z" },
      { id: "ancient", createdAt: "2025-01-01T12:00:00.000Z" },
    ];
    const { keep, prune } = selectBackupsToRetain(entries, now);
    expect(keep).toContain("new-a");
    expect(prune).toContain("old-a");
    expect(prune).toContain("ancient");
    expect(keep).not.toContain("ancient");
  });

  it("pruneBackups deletes pruned files + ledger rows", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-backup-"));
    const { sqlite, close } = openDatabase({ path: ":memory:" });
    const db = sqlite as unknown as BackupDb;
    try {
      seedSecretsDb(db);
      const first = await exportBackup(db, { backupDir: dir, exportedAt: NOW });
      // Fake an ancient run with a real file on disk.
      const ancientPath = path.join(dir, "morrow-20200101T000000000Z-abcdef.json");
      fs.writeFileSync(ancientPath, "{}");
      db.prepare(
        `INSERT INTO backup_runs (id, path, sha256, bytes, schema_version, created_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "ancient-run",
        ancientPath,
        "0".repeat(64),
        2,
        1,
        "2020-01-01T00:00:00.000Z",
        "manual",
      );
      const { kept, pruned } = pruneBackups(db, dir, Date.parse(NOW));
      expect(kept).toContain(first.backupRunId);
      expect(pruned.map((p) => p.id)).toContain("ancient-run");
      expect(fs.existsSync(ancientPath)).toBe(false);
      expect(listBackupRuns(db).map((r) => r.id)).not.toContain("ancient-run");
    } finally {
      close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never prunes a pre-restore snapshot inside 7 days", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-backup-"));
    const { sqlite, close } = openDatabase({ path: ":memory:" });
    const db = sqlite as unknown as BackupDb;
    try {
      seedSecretsDb(db);
      const pre = await exportBackup(db, {
        backupDir: dir,
        exportedAt: NOW,
        status: "pre-restore",
      });
      const { kept, pruned } = pruneBackups(db, dir, Date.parse(NOW));
      expect(kept).toContain(pre.backupRunId);
      expect(pruned.map((p) => p.id)).not.toContain(pre.backupRunId);
      expect(fs.existsSync(pre.path)).toBe(true);
    } finally {
      close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runBackupNow exposes only pruned basenames (no BACKUP_DIR layout)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-backup-"));
    const { sqlite, close } = openDatabase({ path: ":memory:" });
    const db = sqlite as unknown as BackupDb;
    try {
      seedSecretsDb(db);
      const ancientPath = path.join(
        dir,
        "morrow-20200101T000000000Z-abcdef.json",
      );
      fs.writeFileSync(ancientPath, "{}");
      db.prepare(
        `INSERT INTO backup_runs (id, path, sha256, bytes, schema_version, created_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "ancient-run",
        ancientPath,
        "0".repeat(64),
        2,
        1,
        "2020-01-01T00:00:00.000Z",
        "manual",
      );

      const { pruned } = await runBackupNow(db, {
        backupDir: dir,
        exportedAt: NOW,
      });
      const entry = pruned.find((p) => p.id === "ancient-run");
      expect(entry?.path).toBe(path.basename(ancientPath));
      expect(entry?.path).not.toContain(path.sep);
      expect(fs.existsSync(ancientPath)).toBe(false);
    } finally {
      close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("round-trips recurrence exception rows", async () => {
    const source = openDatabase({ path: ":memory:" });
    const target = openDatabase({ path: ":memory:" });
    try {
      seedSecretsDb(source.sqlite as unknown as BackupDb);
      source.sqlite
        .prepare(
          `INSERT INTO task_recurrence_exceptions
             (id, task_id, user_id, recurrence_id, caldav_href, patch_json,
              status, completed_at, ical_extra_json, rev, created_at,
              updated_at, deleted_at)
           VALUES ('exc-backup-1', '01900000-0000-7000-8000-000000000003',
                   ?, '2026-11-03T09:00:00.000Z', 'exc-backup.ics', '{}',
                   'cancelled', NULL, NULL, 1, ?, ?, NULL)`,
        )
        .run(SEED_USER_ID, SEED_NOW, SEED_NOW);
      const data = readBackupDataFromDb(
        source.sqlite as unknown as BackupDb,
      );
      expect(data.taskRecurrenceExceptions).toHaveLength(1);
      const { bytes } = createBackupDocument(data, { exportedAt: NOW });
      await importBackup(bytes, {
        db: target.sqlite as unknown as BackupDb,
        dryRun: false,
      });
      const restored = target.sqlite
        .prepare(
          "SELECT task_id, recurrence_id, caldav_href, patch_json, status, ical_extra_json FROM task_recurrence_exceptions WHERE id = 'exc-backup-1'",
        )
        .get() as
        | {
            task_id: string;
            recurrence_id: string;
            caldav_href: string;
            patch_json: string;
            status: string;
            ical_extra_json: string | null;
          }
        | undefined;
      expect(restored).toEqual({
        task_id: "01900000-0000-7000-8000-000000000003",
        recurrence_id: "2026-11-03T09:00:00.000Z",
        caldav_href: "exc-backup.ics",
        patch_json: "{}",
        status: "cancelled",
        ical_extra_json: null,
      });
    } finally {
      source.close();
      target.close();
    }
  });

  it("rejects a backup whose live rows duplicate a collection identity", async () => {
    const { sqlite, close } = openDatabase({ path: ":memory:" });
    const db = sqlite as unknown as BackupDb;
    try {
      seedSecretsDb(db);
      const data = sampleData();
      const base = data.tasks[0] as Record<string, unknown>;
      base["ical_uid"] = "duplicate-backup@example.test";
      base["caldav_href"] = "duplicate-backup.ics";
      data.tasks.push({
        ...(data.tasks[0] as (typeof data.tasks)[number]),
        id: "01900000-0000-7000-8000-0000000000f1",
        title: "Duplicate identity",
      });
      const { bytes } = createBackupDocument(data, { exportedAt: NOW });
      await expect(
        importBackup(bytes, { db, dryRun: false }),
      ).rejects.toThrow(/duplicate collection identity/);
      // The failed transaction left the seeded DB intact.
      expect(
        (
          db
            .prepare("SELECT COUNT(*) AS n FROM tasks")
            .get() as { n: number }
        ).n,
      ).toBe(1);
    } finally {
      close();
    }
  });

  it("verifyUploadBackup enforces the 25MB cap and JSON caps", () => {    expect(() =>
      verifyUploadBackup(new Uint8Array(BACKUP_MAX_BYTES + 1)),
    ).toThrow(/exceeds/);
    expect(() => parseJsonWithLimits("[[[[")).toThrow(/not valid JSON/);
    // Depth cap: 200-deep nesting trips the default maxDepth of 64.
    let deep = "0";
    for (let i = 0; i < 200; i += 1) deep = `[${deep}]`;
    expect(() => parseJsonWithLimits(deep)).toThrow(/depth/);
    // String cap: a single 2MB string trips the 1MB cap.
    expect(() =>
      parseJsonWithLimits(JSON.stringify("x".repeat(2_000_000))),
    ).toThrow(/length/);
  });
});
