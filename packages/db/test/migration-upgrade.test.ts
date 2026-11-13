import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  databaseIntegrity,
  migrationStatus,
  openDatabase,
  resolveMigrationsFolder,
} from "../src/index.js";

const NOW = "2026-11-02T12:00:00.000Z";
const USER_ID = "01900000-0000-7000-8000-000000000001";
const LIST_ID = "01900000-0000-7000-8000-000000000002";
const TASK_ID = "01900000-0000-7000-8000-000000000003";
const COMPLETION_ID = "01900000-0000-7000-8000-000000000004";

interface Journal {
  version: string;
  dialect: string;
  entries: Array<{
    idx: number;
    version: string;
    when: number;
    tag: string;
    breakpoints: boolean;
  }>;
}

const FULL_JOURNAL = JSON.parse(
  fs.readFileSync(
    path.join(resolveMigrationsFolder(), "meta", "_journal.json"),
    "utf8",
  ),
) as Journal;

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-migration-matrix-"));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/**
 * Build a migrations folder that contains only the first `count` migrations.
 * Opening a fresh DB against it simulates a database created by an older app.
 */
function prefixFolder(count: number): string {
  const dir = path.join(root, `prefix-${count}`);
  fs.mkdirSync(path.join(dir, "meta"), { recursive: true });
  const entries = FULL_JOURNAL.entries.slice(0, count);
  fs.writeFileSync(
    path.join(dir, "meta", "_journal.json"),
    JSON.stringify({ ...FULL_JOURNAL, entries }, null, 2),
  );
  for (const entry of entries) {
    fs.copyFileSync(
      path.join(resolveMigrationsFolder(), `${entry.tag}.sql`),
      path.join(dir, `${entry.tag}.sql`),
    );
  }
  return dir;
}

function insertCoreData(sqlite: Database.Database): void {
  sqlite
    .prepare(
      `INSERT INTO users
        (id, username, password_hash, timezone, created_at, updated_at)
       VALUES (?, 'owner', 'argon2id-placeholder', 'America/New_York', ?, ?)`,
    )
    .run(USER_ID, NOW, NOW);
  sqlite
    .prepare(
      `INSERT INTO lists
        (id, user_id, name, sort_key, is_inbox, created_at, updated_at)
       VALUES (?, ?, 'Inbox', 'V00000000000000', 1, ?, ?)`,
    )
    .run(LIST_ID, USER_ID, NOW, NOW);
  sqlite
    .prepare(
      `INSERT INTO tasks
        (id, user_id, list_id, title, created_at, updated_at)
       VALUES (?, ?, ?, 'Water the plants', ?, ?)`,
    )
    .run(TASK_ID, USER_ID, LIST_ID, NOW, NOW);
  sqlite
    .prepare(
      `INSERT INTO task_completions
        (id, task_id, occurrence_key, status, completed_at, created_at)
       VALUES (?, ?, '2026-11-02T14:00:00.000Z', 'completed', ?, ?)`,
    )
    .run(COMPLETION_ID, TASK_ID, NOW, NOW);
  sqlite
    .prepare(
      `INSERT INTO settings (key, value, updated_at)
       VALUES ('timezone', '"America/New_York"', ?)`,
    )
    .run(NOW);
}

function assertCoreData(sqlite: Database.Database): void {
  const user = sqlite
    .prepare("SELECT username FROM users WHERE id = ?")
    .get(USER_ID) as { username: string } | undefined;
  expect(user?.username).toBe("owner");

  const list = sqlite
    .prepare("SELECT name FROM lists WHERE id = ?")
    .get(LIST_ID) as { name: string } | undefined;
  expect(list?.name).toBe("Inbox");

  const task = sqlite
    .prepare("SELECT title, list_id FROM tasks WHERE id = ?")
    .get(TASK_ID) as { title: string; list_id: string | null } | undefined;
  expect(task?.title).toBe("Water the plants");
  expect(task?.list_id).toBe(LIST_ID);

  const completion = sqlite
    .prepare("SELECT status FROM task_completions WHERE id = ?")
    .get(COMPLETION_ID) as { status: string } | undefined;
  expect(completion?.status).toBe("completed");

  const setting = sqlite
    .prepare("SELECT value FROM settings WHERE key = 'timezone'")
    .get() as { value: string } | undefined;
  expect(JSON.parse(setting?.value ?? "null")).toBe("America/New_York");

  const report = databaseIntegrity(sqlite);
  expect(report.integrity).toEqual(["ok"]);
  expect(report.foreignKeyViolations).toEqual([]);
}

describe("migration upgrade matrix", () => {
  it.each(
    FULL_JOURNAL.entries.map(
      (entry, index) => [index + 1, entry.tag] as const,
    ),
  )(
    "preserves core data when upgrading from migration %i (%s) to current",
    (count) => {
      const dir = fs.mkdtempSync(path.join(root, `upgrade-${count}-`));
      const dbPath = path.join(dir, "morrow.db");
      const prefix = prefixFolder(count);

      const first = openDatabase({ path: dbPath, migrationsFolder: prefix });
      try {
        insertCoreData(first.sqlite);
      } finally {
        first.close();
      }

      const upgraded = openDatabase({
        path: dbPath,
        backupBeforeMigrate: true,
        keepMigrationBackups: 3,
      });
      try {
        assertCoreData(upgraded.sqlite);
        const status = migrationStatus(upgraded.sqlite);
        expect(status.pending).toBe(0);
        expect(status.newer).toBe(false);
        expect(status.appliedCount).toBe(FULL_JOURNAL.entries.length);

        const backups = fs
          .readdirSync(dir)
          .filter((name) => name.startsWith("morrow.db.pre-migration-"));
        if (count < FULL_JOURNAL.entries.length) {
          expect(backups.length).toBeGreaterThanOrEqual(1);
          const backup = new Database(path.join(dir, backups[0]!), {
            readonly: true,
          });
          try {
            const row = backup
              .prepare("SELECT title FROM tasks WHERE id = ?")
              .get(TASK_ID) as { title: string } | undefined;
            expect(row?.title).toBe("Water the plants");
          } finally {
            backup.close();
          }
        } else {
          expect(backups).toEqual([]);
        }
      } finally {
        upgraded.close();
      }
    },
  );

  it("keeps only the configured number of pre-migration snapshots", async () => {
    const dir = fs.mkdtempSync(path.join(root, "retention-"));
    const dbPath = path.join(dir, "morrow.db");
    const first = openDatabase({
      path: dbPath,
      migrationsFolder: prefixFolder(1),
    });
    try {
      insertCoreData(first.sqlite);
    } finally {
      first.close();
    }

    for (const count of [2, 3, 4]) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const handle = openDatabase({
        path: dbPath,
        migrationsFolder: prefixFolder(count),
        backupBeforeMigrate: true,
        keepMigrationBackups: 2,
      });
      handle.close();
    }

    const backups = fs
      .readdirSync(dir)
      .filter((name) => name.startsWith("morrow.db.pre-migration-"));
    expect(backups.length).toBe(2);
  });
});

describe("schema compatibility guard", () => {
  it("refuses to open a database with a migration newer than the app", () => {
    const dir = fs.mkdtempSync(path.join(root, "newer-"));
    const dbPath = path.join(dir, "morrow.db");
    const first = openDatabase({ path: dbPath });
    try {
      first.sqlite
        .prepare(
          "INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('future', ?)",
        )
        .run(Number.MAX_SAFE_INTEGER);
    } finally {
      first.close();
    }

    expect(() => openDatabase({ path: dbPath })).toThrow(/newer than this app/i);

    const inspect = new Database(dbPath, { readonly: true });
    try {
      expect(inspect.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({
        n: 0,
      });
    } finally {
      inspect.close();
    }
  });
});

describe("migration failure rollback", () => {
  it("keeps the previous schema and core data when a migration fails", () => {
    const dir = fs.mkdtempSync(path.join(root, "bad-migration-"));
    const dbPath = path.join(dir, "morrow.db");
    const first = openDatabase({
      path: dbPath,
      migrationsFolder: prefixFolder(1),
    });
    try {
      insertCoreData(first.sqlite);
    } finally {
      first.close();
    }

    const bad = path.join(root, "bad-migrations");
    fs.mkdirSync(path.join(bad, "meta"), { recursive: true });
    fs.copyFileSync(
      path.join(resolveMigrationsFolder(), "0001_init.sql"),
      path.join(bad, "0001_init.sql"),
    );
    fs.writeFileSync(
      path.join(bad, "0002_bad.sql"),
      'CREATE TABLE "users" ("id" text);',
    );
    fs.writeFileSync(
      path.join(bad, "meta", "_journal.json"),
      JSON.stringify(
        {
          ...FULL_JOURNAL,
          entries: [
            { ...FULL_JOURNAL.entries[0]! },
            {
              idx: 1,
              version: "6",
              when: FULL_JOURNAL.entries[0]!.when + 1,
              tag: "0002_bad",
              breakpoints: true,
            },
          ],
        },
        null,
        2,
      ),
    );

    expect(() => openDatabase({ path: dbPath, migrationsFolder: bad })).toThrow();

    const inspect = new Database(dbPath, { readonly: true });
    try {
      const status = migrationStatus(inspect);
      expect(status.appliedCount).toBe(1);
      expect(inspect.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({
        n: 1,
      });
      expect(inspect.prepare("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({
        n: 1,
      });
    } finally {
      inspect.close();
    }
  });
});
