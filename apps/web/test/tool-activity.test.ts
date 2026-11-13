import { describe, expect, it } from "vitest";
import {
  parseToolActivityContent,
  toolActivityLabel,
} from "../src/lib/tool-activity.js";

describe("tool activity transcript cards", () => {
  it("parses successful and failed mutating tool calls", () => {
    expect(parseToolActivityContent("tool:reminders_create:ok")).toEqual({
      tool: "reminders_create",
      ok: true,
    });
    expect(parseToolActivityContent("tool:reminders_propose:failed")).toEqual({
      tool: "reminders_propose",
      ok: false,
    });
  });

  it("ignores ordinary system prose and malformed activity", () => {
    expect(parseToolActivityContent("The assistant is ready.")).toBeNull();
    expect(parseToolActivityContent("tool:reminders_create")).toBeNull();
    expect(parseToolActivityContent("tool:reminders_create:maybe")).toBeNull();
    expect(parseToolActivityContent("tool::ok")).toBeNull();
  });

  it("uses friendly labels and falls back to the raw tool name", () => {
    expect(toolActivityLabel("reminders_create")).toBe("Created a task");
    expect(toolActivityLabel("morrow_reminders_create")).toBe("Created a task");
    expect(toolActivityLabel("reminders_propose")).toBe("Prepared a proposal");
    expect(toolActivityLabel("custom_tool")).toBe("custom tool");
  });
});
