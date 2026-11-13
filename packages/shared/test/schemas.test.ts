import { describe, expect, it } from "vitest";
import {
  completeTaskSchema,
  listCreateSchema,
  listUpdateSchema,
  taskCreateSchema,
  taskSchema,
  taskUpdateSchema,
} from "../src/index.js";

const TASK_ID = "01900000-0000-7000-8000-000000000001";
const LIST_ID = "01900000-0000-7000-8000-000000000002";
const NOW = "2026-11-02T12:00:00.000Z";

describe("list schemas", () => {
  it("accepts a minimal list create", () => {
    expect(listCreateSchema.parse({ name: "Inbox" })).toEqual({
      name: "Inbox",
    });
  });

  it("rejects blank names and bad ids", () => {
    expect(() => listCreateSchema.parse({ name: "  " })).toThrow();
    expect(() =>
      listCreateSchema.parse({
        id: "not-a-uuid",
        name: "Inbox",
      }),
    ).toThrow();
  });

  it("allows partial updates with a base revision", () => {
    expect(listUpdateSchema.parse({ name: "Today", baseRev: 3 })).toEqual({
      name: "Today",
      baseRev: 3,
    });
  });
});

describe("task schemas", () => {
  it("accepts a minimal capture", () => {
    const task = taskCreateSchema.parse({ title: "Milk" });
    expect(task.title).toBe("Milk");
    expect(task.status).toBeUndefined();
  });

  it("accepts a full timed recurrence", () => {
    const task = taskCreateSchema.parse({
      title: "Standup",
      listId: LIST_ID,
      dueAt: NOW,
      timezone: "America/New_York",
      reminderTimeLocal: "09:00:00",
      dtstartLocal: "2026-11-02T09:00:00",
      rrule: "FREQ=WEEKLY;BYDAY=MO",
      recurrenceMode: "schedule",
      clampPolicy: "skip",
      sortKey: "V00000000000000",
    });
    expect(task.rrule).toBe("FREQ=WEEKLY;BYDAY=MO");
  });

  it("rejects COUNT + UNTIL and dual UNTIL columns", () => {
    expect(() =>
      taskCreateSchema.parse({
        title: "Bad",
        dtstartLocal: "2026-11-02T09:00:00",
        rrule: "FREQ=DAILY",
        recurrenceCount: 3,
        recurrenceUntilUtc: "2026-12-01T00:00:00.000Z",
      }),
    ).toThrow(/mutually exclusive/);

    expect(() =>
      taskCreateSchema.parse({
        title: "Bad",
        recurrenceUntilUtc: "2026-12-01T00:00:00.000Z",
        recurrenceUntilDate: "2026-12-01",
      }),
    ).toThrow(/mutually exclusive/);
  });

  it("requires a wall due date for all-day tasks", () => {
    expect(() =>
      taskCreateSchema.parse({
        title: "All day",
        allDay: true,
        dueAt: NOW,
      }),
    ).toThrow(/all-day/);

    expect(
      taskCreateSchema.parse({
        title: "All day",
        allDay: true,
        dueDate: "2026-11-02",
        dueAt: NOW,
      }).dueDate,
    ).toBe("2026-11-02");
  });

  it("requires dtstartLocal when a rule is present", () => {
    expect(() =>
      taskCreateSchema.parse({
        title: "Recurring",
        rrule: "FREQ=DAILY",
      }),
    ).toThrow(/dtstartLocal/);
  });

  it("validates persisted tasks", () => {
    const task = taskSchema.parse({
      id: TASK_ID,
      userId: "01900000-0000-7000-8000-000000000003",
      listId: null,
      title: "Milk",
      notes: null,
      status: "open",
      priority: 0,
      dueAt: null,
      dueDate: null,
      allDay: false,
      timezone: null,
      remindAt: null,
      reminderTimeLocal: null,
      remindOffsetMinutes: null,
      snoozedUntil: null,
      dtstartLocal: null,
      nextOccurrenceAt: null,
      nextOccurrenceLocal: null,
      occurrenceSeq: 0,
      rrule: null,
      recurrenceUntilUtc: null,
      recurrenceUntilDate: null,
      recurrenceCount: null,
      wkst: null,
      recurrenceMode: "schedule",
      clampPolicy: "skip",
      seriesEndedAt: null,
      missedCount: 0,
      completedAt: null,
      sortKey: "V00000000000000",
      createdBy: null,
      updatedBy: null,
      rev: 1,
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
    });
    expect(task.id).toBe(TASK_ID);
  });

  it("allows patch updates and completion payloads", () => {
    expect(taskUpdateSchema.parse({ status: "done" }).status).toBe("done");
    expect(
      completeTaskSchema.parse({
        occurrenceKey: "2026-11-02",
        source: "user",
      }).occurrenceKey,
    ).toBe("2026-11-02");
    expect(() =>
      completeTaskSchema.parse({ occurrenceKey: "2026-11-02T09:00:00" }),
    ).toThrow();
  });
});
