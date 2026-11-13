import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import {
  closeDb,
  databaseIntegrity,
  getDb,
  listTables,
  openDatabase,
  resolveMigrationsFolder,
  setDatabaseReopenBlocked,
  type MorrowDatabase,
} from "../src/index.js";
import * as schema from "../src/schema.js";
import {
  captureTokens,
  deliveries,
  lists,
  taskCompletions,
  tasks,
  users,
} from "../src/schema.js";

const NOW = "2026-11-02T12:00:00.000Z";
const USER_ID = "01900000-0000-7000-8000-000000000001";
const LIST_ID = "01900000-0000-7000-8000-000000000002";
const TASK_ID = "01900000-0000-7000-8000-000000000003";

let dir: string;
let dbPath: string;
let handle: MorrowDatabase;

function insertCoreRows(): void {
  handle.db
    .insert(users)
    .values({
      id: USER_ID,
      username: "owner",
      passwordHash: "argon2id-placeholder",
      timezone: "America/New_York",
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run();

  handle.db
    .insert(lists)
    .values({
      id: LIST_ID,
      userId: USER_ID,
      name: "Inbox",
      sortKey: "V00000000000000",
      isInbox: true,
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run();

  handle.db
    .insert(tasks)
    .values({
      id: TASK_ID,
      userId: USER_ID,
      listId: LIST_ID,
      title: "Water the plants",
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "morrow-db-"));
  dbPath = join(dir, "morrow.db");
  handle = openDatabase({ path: dbPath });
});

afterEach(() => {
  try {
    handle.close();
  } catch {
    // ignore
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("SQLite client pragmas and schema", () => {
  it("opens WAL, FULL sync, foreign keys, and a 5s busy timeout", () => {
    const sqlite = handle.sqlite;
    expect(sqlite.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(sqlite.pragma("busy_timeout", { simple: true })).toBe(5000);
    expect(sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
    // synchronous: 0=OFF, 1=NORMAL, 2=FULL, 3=EXTRA
    expect(sqlite.pragma("synchronous", { simple: true })).toBe(2);
  });

  it("creates every §3 table plus the Drizzle journal", () => {
    const tables = listTables(handle.sqlite);
    expect(tables).toEqual(
      expect.arrayContaining([
        "users",
        "sessions",
        "lists",
        "tasks",
        "task_completions",
        "operations",
        "push_subscriptions",
        "deliveries",
        "agent_conversations",
        "agent_messages",
        "proposals",
        "activity",
        "provider_credentials",
        "settings",
        "backup_runs",
        "scheduler_state",
        "caldav_changes",
        "__drizzle_migrations",
      ]),
    );
  });

  it("hand-written SQL columns match the Drizzle models", () => {
    const models = [
      schema.users,
      schema.sessions,
      schema.lists,
      schema.tasks,
      schema.taskCompletions,
      schema.operations,
      schema.pushSubscriptions,
      schema.deliveries,
      schema.agentConversations,
      schema.agentMessages,
      schema.activity,
      schema.proposals,
      schema.providerCredentials,
      schema.settings,
      schema.backupRuns,
      schema.schedulerState,
    ];

    for (const model of models) {
      const config = getTableConfig(model);
      const actual = (
        handle.sqlite.pragma(`table_info("${config.name}")`) as Array<{
          name: string;
        }>
      )
        .map((column) => column.name)
        .sort();
      const expected = config.columns.map((column) => column.name).sort();
      expect(actual, config.name).toEqual(expected);
    }
  });

  it("adds CalDAV identity columns and per-collection partial unique indexes", () => {
    const columns = (
      handle.sqlite.pragma(`table_info("tasks")`) as Array<{ name: string }>
    ).map((column) => column.name);
    expect(columns).toEqual(
      expect.arrayContaining(["ical_uid", "caldav_href"]),
    );

    const indexes = (
      handle.sqlite.pragma(`index_list("tasks")`) as Array<{ name: string }>
    ).map((index) => index.name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        "tasks_collection_ical_uid_unique",
        "tasks_collection_caldav_href_unique",
      ]),
    );
  });

  it("installs the v0.3 recurrence exception and move-journal objects", () => {
    const tables = listTables(handle.sqlite);
    expect(tables).toContain("task_recurrence_exceptions");
    const triggers = (
      handle.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'")
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(triggers).toEqual(
      expect.arrayContaining([
        "recurrence_exceptions_caldav_insert",
        "recurrence_exceptions_caldav_update",
        "recurrence_exceptions_caldav_delete",
        "tasks_caldav_exceptions_visibility",
        "tasks_caldav_move_exceptions",
      ]),
    );
  });

  it("journals exceptions, attachments, and collection moves", () => {
    insertCoreRows();
    handle.sqlite
      .prepare(
        `INSERT INTO lists (id, user_id, name, is_inbox, created_at, updated_at)
         VALUES ('project-list', ?, 'Project', 0, ?, ?)`,
      )
      .run(USER_ID, NOW, NOW);
    handle.sqlite
      .prepare(
        `INSERT INTO tasks
           (id, user_id, list_id, title, ical_uid, caldav_href, created_at, updated_at)
         VALUES ('project-task', ?, 'project-list', 'Project task',
                 'project@example.test', 'project.ics', ?, ?)`,
      )
      .run(USER_ID, NOW, NOW);
    handle.sqlite
      .prepare(
        `INSERT INTO task_recurrence_exceptions
           (id, task_id, user_id, recurrence_id, caldav_href, patch_json,
            status, created_at, updated_at)
         VALUES ('trigger-exc', 'project-task', ?, '2026-11-03T09:00:00.000Z',
                 'project-exc.ics', '{}', 'cancelled', ?, ?)`,
      )
      .run(USER_ID, NOW, NOW);
    const exceptionInsert = handle.sqlite
      .prepare(
        `SELECT collection, change_type, exception_id FROM caldav_changes
          WHERE exception_id = 'trigger-exc' ORDER BY seq DESC LIMIT 1`,
      )
      .get() as {
      collection: string;
      change_type: string;
      exception_id: string;
    };
    expect(exceptionInsert).toEqual({
      collection: "project-list",
      change_type: "update",
      exception_id: "trigger-exc",
    });

    handle.sqlite
      .prepare(
        `INSERT INTO attachments
           (id, task_id, user_id, filename, mime_type, bytes, sha256,
            storage_path, created_at)
         VALUES ('trigger-attachment', 'project-task', ?, 'a.txt',
                 'text/plain', 3, 'sha', '/tmp/a.txt', ?)`,
      )
      .run(USER_ID, NOW);
    const attachmentJournal = handle.sqlite
      .prepare(
        `SELECT collection, change_type FROM caldav_changes
          WHERE task_id = 'project-task' ORDER BY seq DESC LIMIT 1`,
      )
      .get() as { collection: string; change_type: string };
    expect(attachmentJournal).toEqual({
      collection: "project-list",
      change_type: "update",
    });

    handle.sqlite
      .prepare(
        "UPDATE tasks SET list_id = NULL, updated_at = ? WHERE id = 'project-task'",
      )
      .run("2026-11-04T00:00:00.000Z");
    const moveRows = handle.sqlite
      .prepare(
        `SELECT collection, change_type FROM caldav_changes
          WHERE exception_id = 'trigger-exc' ORDER BY seq DESC LIMIT 2`,
      )
      .all() as Array<{ collection: string; change_type: string }>;
    expect(moveRows).toEqual([
      { collection: "inbox", change_type: "update" },
      { collection: "project-list", change_type: "delete" },
    ]);
  });

  it("repairs duplicate identities when moving to per-collection uniqueness", () => {
    const legacyDir = mkdtempSync(join(tmpdir(), "morrow-migration-identity-"));
    const legacy = new Database(join(legacyDir, "legacy.db"));
    try {
      const apply = (file: string) => {
        const sql = readFileSync(join(resolveMigrationsFolder(), file), "utf8");
        for (const statement of sql.split("--> statement-breakpoint")) {
          if (statement.trim() !== "") legacy.exec(statement);
        }
      };
      for (const file of [
        "0001_init.sql",
        "0002_provider_credentials.sql",
        "0003_agent_run_error.sql",
        "0004_product_features.sql",
        "0005_list_members.sql",
        "0006_owner_roles_and_token_kinds.sql",
        "0007_caldav_vtodo.sql",
        "0008_caldav_change_journal.sql",
        "0009_caldav_per_list_collections.sql",
      ]) {
        apply(file);
      }

      const otherUser = "01900000-0000-7000-8000-0000000000cc";
      legacy
        .prepare(
          `INSERT INTO users (id, username, password_hash, timezone, created_at, updated_at)
           VALUES (?, 'owner', 'x', 'UTC', ?, ?)`,
        )
        .run(USER_ID, NOW, NOW);
      legacy
        .prepare(
          `INSERT INTO users (id, username, password_hash, timezone, created_at, updated_at)
           VALUES (?, 'member', 'x', 'UTC', ?, ?)`,
        )
        .run(otherUser, NOW, NOW);
      legacy
        .prepare(
          `INSERT INTO lists (id, user_id, name, created_at, updated_at)
           VALUES ('shared-list', ?, 'Shared', ?, ?)`,
        )
        .run(USER_ID, NOW, NOW);
      const insertTask = legacy.prepare(
        `INSERT INTO tasks
           (id, user_id, list_id, title, ical_uid, caldav_href, created_at, updated_at)
         VALUES (?, ?, 'shared-list', ?, 'same-uid@morrow', 'same-href.ics', ?, ?)`,
      );
      insertTask.run("task-first", USER_ID, "First", NOW, NOW);
      insertTask.run(
        "task-second",
        otherUser,
        "Second",
        "2026-11-03T00:00:00.000Z",
        "2026-11-03T00:00:00.000Z",
      );

      // The new scope is the list, so these two members' rows conflict until
      // the migration repairs the later one deterministically.
      apply("0010_per_collection_identities.sql");

      const rows = legacy
        .prepare(
          `SELECT id, ical_uid, caldav_href FROM tasks ORDER BY created_at ASC`,
        )
        .all() as Array<{
        id: string;
        ical_uid: string;
        caldav_href: string;
      }>;
      expect(rows[0]?.ical_uid).toBe("same-uid@morrow");
      expect(rows[0]?.caldav_href).toBe("same-href.ics");
      expect(rows[1]?.ical_uid).toBe("same-uid@morrow~task-second");
      expect(rows[1]?.caldav_href).toBe("same-href.ics~task-second");

      const indexes = (
        legacy.pragma(`index_list("tasks")`) as Array<{ name: string }>
      ).map((index) => index.name);
      expect(indexes).toEqual(
        expect.arrayContaining([
          "tasks_collection_ical_uid_unique",
          "tasks_collection_caldav_href_unique",
        ]),
      );
    } finally {
      legacy.close();
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });

  it("backfills legacy tasks deterministically in migration 0007", () => {
    const legacyDir = mkdtempSync(join(tmpdir(), "morrow-migration-"));
    const legacy = new Database(join(legacyDir, "legacy.db"));
    try {
      for (const file of [
        "0001_init.sql",
        "0002_provider_credentials.sql",
        "0003_agent_run_error.sql",
        "0004_product_features.sql",
        "0005_list_members.sql",
        "0006_owner_roles_and_token_kinds.sql",
        "0007_caldav_vtodo.sql",
      ]) {
        const sql = readFileSync(
          join(resolveMigrationsFolder(), file),
          "utf8",
        );
        for (const statement of sql.split("--> statement-breakpoint")) {
          if (statement.trim() !== "") legacy.exec(statement);
        }
        if (file.startsWith("0007")) break;
        if (file.startsWith("0006")) {
          legacy
            .prepare(
              `INSERT INTO users (id, username, password_hash, timezone, created_at, updated_at)
               VALUES (?, 'owner', 'x', 'UTC', ?, ?)`,
            )
            .run(USER_ID, NOW, NOW);
          legacy
            .prepare(
              `INSERT INTO tasks (id, user_id, title, created_at, updated_at)
               VALUES (?, ?, 'Legacy task', ?, ?)`,
            )
            .run(TASK_ID, USER_ID, NOW, NOW);
        }
      }

      const row = legacy
        .prepare("SELECT ical_uid, caldav_href FROM tasks WHERE id = ?")
        .get(TASK_ID) as { ical_uid: string; caldav_href: string };
      expect(row.ical_uid).toBe(`${TASK_ID}@morrow`);
      expect(row.caldav_href).toBe(`${TASK_ID}.ics`);

      const indexes = (
        legacy.pragma(`index_list("tasks")`) as Array<{ name: string }>
      ).map((index) => index.name);
      expect(indexes).toEqual(
        expect.arrayContaining([
          "tasks_user_ical_uid_unique",
          "tasks_user_caldav_href_unique",
        ]),
      );
    } finally {
      legacy.close();
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });

  it("seeds the scheduler singleton", () => {
    const row = handle.sqlite
      .prepare("SELECT * FROM scheduler_state WHERE id = 1")
      .get() as { id: number; last_tick_at: string | null } | undefined;
    expect(row?.id).toBe(1);
    expect(row?.last_tick_at).toBeNull();
  });

  it("passes integrity_check and foreign_key_check", () => {
    const report = databaseIntegrity(handle.sqlite);
    expect(report.integrity).toEqual(["ok"]);
    expect(report.foreignKeyViolations).toEqual([]);
  });

  it("is idempotent across reopens", () => {
    insertCoreRows();
    handle.close();
    handle = openDatabase({ path: dbPath });
    const count = handle.sqlite
      .prepare("SELECT COUNT(*) AS n FROM users")
      .get() as { n: number };
    expect(count.n).toBe(1);
    const migrations = handle.sqlite
      .prepare("SELECT COUNT(*) AS n FROM __drizzle_migrations")
      .get() as { n: number };
    // Track the journal so each added migration does not break this test.
    const journal = JSON.parse(
      readFileSync(join(resolveMigrationsFolder(), "meta", "_journal.json"), "utf8"),
    ) as { entries: unknown[] };
    expect(migrations.n).toBe(journal.entries.length);
    expect(databaseIntegrity(handle.sqlite).foreignKeyViolations).toEqual([]);
  });
});

describe("rows, defaults, and constraints", () => {
  it("inserts and reads a task through Drizzle with §3 defaults", () => {
    insertCoreRows();
    const row = handle.db.select().from(tasks).where(eq(tasks.id, TASK_ID)).get();
    expect(row).toBeDefined();
    expect(row?.status).toBe("open");
    expect(row?.priority).toBe(0);
    expect(row?.allDay).toBe(false);
    expect(row?.recurrenceMode).toBe("schedule");
    expect(row?.clampPolicy).toBe("skip");
    expect(row?.occurrenceSeq).toBe(0);
    expect(row?.missedCount).toBe(0);
    expect(row?.rev).toBe(1);
    expect(row?.listId).toBe(LIST_ID);
  });

  it("defaults new users to member and tokens to the capture purpose", () => {
    insertCoreRows();
    const user = handle.db.select().from(users).where(eq(users.id, USER_ID)).get();
    expect(user?.role).toBe("member");

    handle.db
      .insert(captureTokens)
      .values({
        id: "01900000-0000-7000-8000-00000000000b",
        userId: USER_ID,
        name: "Default token",
        tokenHash: "token-hash-default",
        createdAt: NOW,
      })
      .run();
    const token = handle.sqlite
      .prepare("SELECT kind FROM capture_tokens WHERE token_hash = ?")
      .get("token-hash-default") as { kind: string };
    expect(token.kind).toBe("capture");
  });

  it("scopes CalDAV UID/href uniqueness per user and allows reuse after delete", () => {
    insertCoreRows();
    const secondUser = "01900000-0000-7000-8000-000000000004";
    handle.db
      .insert(users)
      .values({
        id: secondUser,
        username: "second",
        passwordHash: "argon2id-placeholder",
        timezone: "UTC",
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();

    const uid = "shared-uid@example.test";
    const href = "shared-resource.ics";
    const first = {
      id: "01900000-0000-7000-8000-000000000060",
      userId: USER_ID,
      title: "First CalDAV task",
      icalUid: uid,
      caldavHref: href,
      createdAt: NOW,
      updatedAt: NOW,
    } as const;
    handle.db.insert(tasks).values(first).run();

    expect(() =>
      handle.db
        .insert(tasks)
        .values({
          ...first,
          id: "01900000-0000-7000-8000-000000000061",
        })
        .run(),
    ).toThrow(/UNIQUE/);
    expect(() =>
      handle.db
        .insert(tasks)
        .values({
          ...first,
          id: "01900000-0000-7000-8000-000000000062",
          icalUid: "another-uid@example.test",
        })
        .run(),
    ).toThrow(/UNIQUE/);
    expect(() =>
      handle.db
        .insert(tasks)
        .values({
          ...first,
          id: "01900000-0000-7000-8000-000000000063",
          caldavHref: "another-resource.ics",
        })
        .run(),
    ).toThrow(/UNIQUE/);

    // A different user has its own collection namespace.
    handle.db
      .insert(tasks)
      .values({
        ...first,
        id: "01900000-0000-7000-8000-000000000064",
        userId: secondUser,
      })
      .run();

    // Soft delete releases the identity for a new live row.
    handle.db
      .update(tasks)
      .set({ deletedAt: NOW, rev: 2 })
      .where(eq(tasks.id, first.id))
      .run();
    expect(() =>
      handle.db
        .insert(tasks)
        .values({
          ...first,
          id: "01900000-0000-7000-8000-000000000065",
        })
        .run(),
    ).not.toThrow();
  });

  it("de-duplicates undeleted completions per occurrence but allows tombstones", () => {
    insertCoreRows();
    const completion = {
      id: "01900000-0000-7000-8000-000000000010",
      taskId: TASK_ID,
      occurrenceKey: "2026-11-02T14:00:00.000Z",
      status: "completed",
      completedAt: NOW,
      createdAt: NOW,
    };
    handle.db.insert(taskCompletions).values(completion).run();
    expect(() =>
      handle.db.insert(taskCompletions).values(completion).run(),
    ).toThrow(/UNIQUE/);

    handle.db
      .update(taskCompletions)
      .set({ deletedAt: NOW, rev: 2 })
      .where(eq(taskCompletions.id, completion.id))
      .run();

    expect(() =>
      handle.db
        .insert(taskCompletions)
        .values({
          ...completion,
          id: "01900000-0000-7000-8000-000000000011",
        })
        .run(),
    ).not.toThrow();
  });

  it("enforces the delivery dedupe key", () => {
    insertCoreRows();
    const delivery = {
      id: "01900000-0000-7000-8000-000000000020",
      taskId: TASK_ID,
      occurrenceKey: "2026-11-02T14:00:00.000Z",
      kind: "reminder",
      channel: "webpush",
      subscriptionId: "sub-1",
      createdAt: NOW,
      updatedAt: NOW,
    };
    handle.db.insert(deliveries).values(delivery).run();
    expect(() =>
      handle.db
        .insert(deliveries)
        .values({
          ...delivery,
          id: "01900000-0000-7000-8000-000000000021",
        })
        .run(),
    ).toThrow(/UNIQUE/);
  });

  it("rejects bad statuses and count+until at the SQL layer", () => {
    insertCoreRows();
    const insert = handle.sqlite.prepare(
      `INSERT INTO tasks
        (id, user_id, title, status, recurrence_count, recurrence_until_utc,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    expect(() =>
      insert.run(
        "01900000-0000-7000-8000-000000000030",
        USER_ID,
        "bad status",
        "nope",
        null,
        null,
        NOW,
        NOW,
      ),
    ).toThrow(/CHECK/);

    expect(() =>
      insert.run(
        "01900000-0000-7000-8000-000000000031",
        USER_ID,
        "count and until",
        "open",
        2,
        "2026-12-01T00:00:00.000Z",
        NOW,
        NOW,
      ),
    ).toThrow(/CHECK/);

    expect(() =>
      handle.sqlite
        .prepare("INSERT INTO scheduler_state (id) VALUES (2)")
        .run(),
    ).toThrow(/CHECK/);
  });

  it("rejects foreign-key violations", () => {
    insertCoreRows();
    expect(() =>
      handle.db
        .insert(tasks)
        .values({
          id: "01900000-0000-7000-8000-000000000040",
          userId: "01900000-0000-7000-8000-000000000099",
          title: "orphan",
          createdAt: NOW,
          updatedAt: NOW,
        })
        .run(),
    ).toThrow(/FOREIGN KEY/);
    expect(databaseIntegrity(handle.sqlite).foreignKeyViolations).toEqual([]);
  });

  it("sets list_id to NULL when a list is deleted and cascades user data", () => {
    insertCoreRows();
    handle.db.delete(lists).where(eq(lists.id, LIST_ID)).run();
    const task = handle.db
      .select()
      .from(tasks)
      .where(eq(tasks.id, TASK_ID))
      .get();
    expect(task?.listId).toBeNull();

    handle.db.delete(users).where(eq(users.id, USER_ID)).run();
    const remaining = handle.sqlite
      .prepare("SELECT COUNT(*) AS n FROM tasks")
      .get() as { n: number };
    expect(remaining.n).toBe(0);
  });

  it("keeps auth skeleton columns available", () => {
    insertCoreRows();
    // These are the raw-SQL names the app-server auth track already uses.
    const user = handle.sqlite
      .prepare("SELECT username, password_hash, timezone FROM users WHERE id = ?")
      .get(USER_ID) as
      | { username: string; password_hash: string; timezone: string }
      | undefined;
    expect(user?.username).toBe("owner");
    expect(user?.timezone).toBe("America/New_York");

    handle.sqlite
      .prepare(
        `INSERT INTO sessions
          (id, user_id, token_hash, created_at, last_seen_at, expires_at,
           absolute_expires_at, step_up_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "01900000-0000-7000-8000-000000000050",
        USER_ID,
        "token-hash",
        NOW,
        NOW,
        "2026-11-09T12:00:00.000Z",
        "2026-12-02T12:00:00.000Z",
        null,
      );

    handle.sqlite
      .prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
      .run("timezone", JSON.stringify("America/New_York"), NOW);

    const setting = handle.sqlite
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get("timezone") as { value: string };
    expect(JSON.parse(setting.value)).toBe("America/New_York");
  });
});

describe("restore reopen guard", () => {
  it("fails closed while the database file is being swapped", () => {
    closeDb();
    setDatabaseReopenBlocked(true);
    try {
      expect(() => getDb()).toThrow(/being restored/);
    } finally {
      setDatabaseReopenBlocked(false);
    }
    expect(getDb()).toBeTruthy();
    closeDb();
  });
});
