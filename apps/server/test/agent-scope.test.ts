import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type MorrowDatabase } from "@morrow/db";
import { TaskStore } from "@morrow/agent";

const NOW = "2026-11-08T18:00:00.000Z";
const OWNER = "01900000-0000-7000-8000-000000000101";
const MEMBER = "01900000-0000-7000-8000-000000000102";
const OWNER_LIST = "01900000-0000-7000-8000-000000000201";
const MEMBER_LIST = "01900000-0000-7000-8000-000000000202";
const MEMBER_PRIVATE_LIST = "01900000-0000-7000-8000-000000000203";

function seed(database: MorrowDatabase): void {
  const db = database.sqlite;
  const insertUser = db.prepare(
    `INSERT INTO users (id, username, password_hash, timezone, rev, created_at, updated_at)
     VALUES (?, ?, 'not-used', 'UTC', 1, ?, ?)`,
  );
  insertUser.run(OWNER, "owner", NOW, NOW);
  insertUser.run(MEMBER, "member", NOW, NOW);

  const insertList = db.prepare(
    `INSERT INTO lists (id, user_id, name, sort_key, is_inbox, rev, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, 1, ?, ?)`,
  );
  insertList.run(OWNER_LIST, OWNER, "Owner list", "0000000000000000", NOW, NOW);
  insertList.run(MEMBER_LIST, MEMBER, "Member list", "0000000000000001", NOW, NOW);
  insertList.run(
    MEMBER_PRIVATE_LIST,
    MEMBER,
    "Member private list",
    "0000000000000002",
    NOW,
    NOW,
  );

  const member = db.prepare(
    `INSERT INTO list_members (list_id, user_id, role, created_at)
     VALUES (?, ?, 'member', ?)`,
  );
  member.run(OWNER_LIST, MEMBER, NOW);
  member.run(MEMBER_LIST, OWNER, NOW);

  const insertTask = db.prepare(
    `INSERT INTO tasks
      (id, user_id, list_id, title, status, priority, all_day, occurrence_seq,
       recurrence_mode, clamp_policy, missed_count, sort_key, rev, created_at,
       updated_at)
     VALUES (?, ?, ?, ?, 'open', 0, 0, 0, 'schedule', 'skip', 0, ?, 1, ?, ?)`,
  );
  insertTask.run(
    "owner-private",
    OWNER,
    null,
    "Owner private",
    "0000000000000000",
    NOW,
    NOW,
  );
  insertTask.run(
    "member-private",
    MEMBER,
    null,
    "Member private",
    "0000000000000001",
    NOW,
    NOW,
  );
  insertTask.run(
    "member-in-owner-list",
    MEMBER,
    OWNER_LIST,
    "Member in owner list",
    "0000000000000002",
    NOW,
    NOW,
  );
  insertTask.run(
    "owner-in-member-list",
    OWNER,
    MEMBER_LIST,
    "Owner in member list",
    "0000000000000003",
    NOW,
    NOW,
  );
}

describe("agent task scope follows REST list access", () => {
  let database: MorrowDatabase;

  beforeEach(() => {
    database = openDatabase({ path: ":memory:" });
    seed(database);
  });

  afterEach(() => database.close());

  it("shows the owner their own tasks and tasks in shared lists, but not a member-private task", () => {
    const store = new TaskStore(database.sqlite, OWNER);
    const tasks = store.listTasks({ status: "all", limit: 200 });

    expect(tasks.map((task) => task.id).sort()).toEqual(
      ["member-in-owner-list", "owner-in-member-list", "owner-private"].sort(),
    );
    expect(store.getTask("member-private")).toBeNull();
    expect(store.getTask("member-in-owner-list")?.title).toBe(
      "Member in owner list",
    );
    expect(store.getList(MEMBER_LIST)?.name).toBe("Member list");
    expect(store.listLists().map((list) => list.id).sort()).toEqual(
      [MEMBER_LIST, OWNER_LIST].sort(),
    );
  });

  it("refuses to mutate a task outside the actor's access, including by exact id", () => {
    const store = new TaskStore(database.sqlite, OWNER);
    expect(() =>
      store.updateTask("member-private", { title: "Hijacked" }),
    ).toThrow(/not found/i);
    expect(() => store.completeTask("member-private")).toThrow(/not found/i);
    expect(() => store.softDeleteTask("member-private")).toThrow(/not found/i);

    const row = database.sqlite
      .prepare("SELECT title, status, deleted_at FROM tasks WHERE id = ?")
      .get("member-private") as {
      title: string;
      status: string;
      deleted_at: string | null;
    };
    expect(row).toEqual({
      title: "Member private",
      status: "open",
      deleted_at: null,
    });
  });

  it("rejects an undo snapshot that restores into an inaccessible list", () => {
    const store = new TaskStore(database.sqlite, OWNER);
    expect(() =>
      store.restoreTaskRow({
        id: "member-in-owner-list",
        list_id: MEMBER_PRIVATE_LIST,
      }),
    ).toThrow(/no longer access/i);
  });

  it("lets a shared-list member read and update a task created by the list owner", () => {
    const store = new TaskStore(database.sqlite, MEMBER);
    expect(store.getTask("owner-in-member-list")?.title).toBe(
      "Owner in member list",
    );
    const updated = store.updateTask("owner-in-member-list", {
      title: "Updated by member",
    });
    expect(updated.after.title).toBe("Updated by member");

    const viewed = store.listTasks({ status: "all", limit: 200 });
    expect(viewed.map((task) => task.id).sort()).toEqual(
      [
        "member-in-owner-list",
        "member-private",
        "owner-in-member-list",
      ].sort(),
    );
  });

  it("allows creating in a shared list but rejects an inaccessible list", () => {
    const store = new TaskStore(database.sqlite, MEMBER);
    const created = store.createTask({
      id: "member-created-in-owner-list",
      title: "Created in shared list",
      listId: OWNER_LIST,
    });
    expect(created.listId).toBe(OWNER_LIST);

    // A list owned by an unrelated third account would fail; use the owner's
    // list id with a fresh store bound to a user who is not a member.
    const outsider = "01900000-0000-7000-8000-000000000103";
    database.sqlite
      .prepare(
        `INSERT INTO users (id, username, password_hash, timezone, rev, created_at, updated_at)
         VALUES (?, 'outsider', 'not-used', 'UTC', 1, ?, ?)`,
      )
      .run(outsider, NOW, NOW);
    const outsiderStore = new TaskStore(database.sqlite, outsider);
    expect(() =>
      outsiderStore.createTask({ title: "Nope", listId: OWNER_LIST }),
    ).toThrow(/target list does not exist/i);
    expect(outsiderStore.getTask("owner-private")).toBeNull();
  });
});
