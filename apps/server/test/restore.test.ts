import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { databaseIntegrity, openDatabase } from "@morrow/db";
import {
  BackupVerificationError,
  exportBackup,
  importBackup,
  readBackupDataFromDb,
  verifyBackupBytes,
  type BackupDb,
} from "../src/backup.js";
import {
  computeRestoreDiff,
  restoreIntoDb,
} from "../src/restore.js";
import { memBackupDb, seedSecretsDb } from "./helpers.js";

const NOW = "2026-11-02T12:00:00.000Z";
const TASK_ID = "01900000-0000-7000-8000-000000000003";
const LIST_ID = "01900000-0000-7000-8000-000000000002";
const USER_ID = "01900000-0000-7000-8000-000000000001";

function memDb() {
  return memBackupDb();
}

describe("restore drill: export -> wipe -> import round-trip", () => {
  it("round-trips allowlisted data exactly (export, wipe, import)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-restore-"));
    const source = memDb();
    try {
      seedSecretsDb(source.db);
      const { bytes } = await exportBackup(source.db, {
        backupDir: dir,
        hmacKey: "hmac-key-outside-backup-dir",
        exportedAt: NOW,
      });
      const original = readBackupDataFromDb(source.db);

      // Wipe: a fresh handle with no user data at all.
      const target = memDb();
      try {
        const result = await importBackup(bytes, {
          dryRun: false,
          db: target.db,
          hmacKey: "hmac-key-outside-backup-dir",
        });
        expect(result.dryRun).toBe(false);
        // Exact equality on every allowlisted table + settings.
        expect(readBackupDataFromDb(target.db)).toEqual(original);
      } finally {
        target.close();
      }
    } finally {
      source.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects tampered bytes (sha) and wrong HMAC keys", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-restore-"));
    const source = memDb();
    try {
      seedSecretsDb(source.db);
      const { bytes } = await exportBackup(source.db, {
        backupDir: dir,
        hmacKey: "hmac-key-outside-backup-dir",
        exportedAt: NOW,
      });

      // Flip one content byte (same length, valid JSON, wrong hash).
      const tampered = Buffer.from(bytes);
      const index = tampered.indexOf("Milk");
      expect(index).toBeGreaterThan(-1);
      tampered[index] = "S".charCodeAt(0);
      const bad = verifyBackupBytes(tampered, {
        hmacKey: "hmac-key-outside-backup-dir",
      });
      expect(bad.ok).toBe(false);
      await expect(
        importBackup(tampered, {
          dryRun: true,
          hmacKey: "hmac-key-outside-backup-dir",
        }),
      ).rejects.toThrow(BackupVerificationError);

      // Right bytes, wrong HMAC key → invalid.
      const wrongKey = verifyBackupBytes(bytes, { hmacKey: "wrong-key" });
      expect(wrongKey.ok).toBe(false);
      expect(wrongKey.hmac).toBe("invalid");

      // No key configured → sha still verified, hmac unchecked but ok.
      expect(verifyBackupBytes(bytes).ok).toBe(true);
      expect(verifyBackupBytes(bytes).hmac).toBe("unchecked");
    } finally {
      source.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dryRun diff reports added/updated/deleted + conflicts", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-restore-"));
    const source = memDb();
    try {
      seedSecretsDb(source.db);
      const { document } = await exportBackup(source.db, {
        backupDir: dir,
        exportedAt: NOW,
      });

      // Live diverges after the snapshot:
      //  - task title changed (live is NEWER → updated + conflict)
      //  - a brand-new live task (absent in backup → would be deleted)
      //  - list hard-deleted live (present in backup → would be re-added)
      source.db
        .prepare("UPDATE tasks SET title = ?, updated_at = ? WHERE id = ?")
        .run("Silk", "2027-01-01T00:00:00.000Z", TASK_ID);
      source.db
        .prepare(
          `INSERT INTO tasks (id, user_id, title, rev, created_at, updated_at)
           VALUES ('01900000-0000-7000-8000-0000000000aa', ?, 'Live-only', 1, ?, ?)`,
        )
        .run(USER_ID, NOW, NOW);
      source.db.prepare("DELETE FROM lists WHERE id = ?").run(LIST_ID);

      const live = readBackupDataFromDb(source.db);
      const diff = computeRestoreDiff(live, document.data);

      expect(diff.tables.tasks.updated).toEqual([TASK_ID]);
      expect(diff.tables.tasks.deleted).toEqual([
        "01900000-0000-7000-8000-0000000000aa",
      ]);
      expect(diff.tables.lists.added).toEqual([LIST_ID]);
      expect(diff.conflicts).toHaveLength(1);
      expect(diff.conflicts[0]).toMatchObject({
        table: "tasks",
        id: TASK_ID,
        incomingUpdatedAt: NOW,
        liveUpdatedAt: "2027-01-01T00:00:00.000Z",
      });
      expect(diff.totals).toMatchObject({ added: 1, updated: 1, deleted: 1 });
    } finally {
      source.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("restore into a temp DB passes integrity_check + foreign_key_check", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-restore-"));
    const tmpDbPath = path.join(dir, "temp-restore.db");
    const source = memDb();
    try {
      seedSecretsDb(source.db);
      const { document } = await exportBackup(source.db, {
        backupDir: dir,
        exportedAt: NOW,
      });

      // Temp-DB flow: fresh file, migrate-on-open, apply, then check.
      const temp = openDatabase({ path: tmpDbPath });
      try {
        const outcome = restoreIntoDb(temp.sqlite as unknown as BackupDb, document, {
          actor: "test",
          markResetRequired: true,
        });
        expect(outcome.counts.tasks).toBe(1);

        const health = databaseIntegrity(temp.sqlite);
        expect(health.integrity).toEqual(["ok"]);
        expect(health.foreignKeyViolations).toEqual([]);

        // Post-restore cleanup ran: sessions revoked, leases cleared, flags set.
        const sessions = temp.sqlite
          .prepare("SELECT COUNT(*) AS n FROM sessions")
          .get() as { n: number };
        expect(sessions.n).toBe(0);
        const resetFlag = temp.sqlite
          .prepare("SELECT value FROM settings WHERE key = 'login_reset_required'")
          .get() as { value: string } | undefined;
        expect(resetFlag?.value).toBe("true");
      } finally {
        temp.close();
      }
    } finally {
      source.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
