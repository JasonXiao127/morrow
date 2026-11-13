import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateX25519Identity, identityToRecipient } from "age-encryption";
import { openDatabase } from "@morrow/db";
import {
  BackupVerificationError,
  exportBackup,
  verifyUploadBackup,
  verifyUploadBackupAsync,
  type BackupDb,
} from "../src/backup.js";
import { seedSecretsDb } from "./helpers.js";

const NOW = "2026-11-02T12:00:00.000Z";
let identity = "";
let recipient = "";
const oldIdentity = process.env["BACKUP_AGE_IDENTITY"];

beforeAll(async () => {
  identity = await generateX25519Identity();
  recipient = await identityToRecipient(identity);
});

afterAll(() => {
  if (oldIdentity === undefined) delete process.env["BACKUP_AGE_IDENTITY"];
  else process.env["BACKUP_AGE_IDENTITY"] = oldIdentity;
});

describe("age-encrypted backups", () => {
  it("writes a real .json.age envelope and restores with the identity", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-age-"));
    const { sqlite, close } = openDatabase({ path: ":memory:" });
    const db = sqlite as unknown as BackupDb;
    try {
      seedSecretsDb(db);
      const result = await exportBackup(db, {
        backupDir: dir,
        exportedAt: NOW,
        ageRecipient: recipient,
      });
      expect(result.encrypted).toBe(true);
      expect(result.name.endsWith(".json.age")).toBe(true);
      expect(result.age?.enabled).toBe(true);
      const ciphertext = fs.readFileSync(result.path);
      expect(ciphertext.toString("utf8", 0, 21)).toContain("age-encryption.org");

      expect(() => verifyUploadBackup(ciphertext)).toThrow(
        BackupVerificationError,
      );
      await expect(
        verifyUploadBackupAsync(ciphertext, { hmacKey: undefined }),
      ).rejects.toThrow(/BACKUP_AGE_IDENTITY/);

      process.env["BACKUP_AGE_IDENTITY"] = identity;
      const document = await verifyUploadBackupAsync(ciphertext);
      expect(document.data.tasks).toHaveLength(1);
      expect(document.sha256).toBe(result.document.sha256);
    } finally {
      close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
