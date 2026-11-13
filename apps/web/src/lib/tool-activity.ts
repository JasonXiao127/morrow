/**
 * Persistent tool-activity cards.
 *
 * The server stores mutating tool calls as local `system` messages in this
 * compact format (see apps/server/src/assistant.ts):
 *
 *   tool:<tool-name>:<ok|failed>
 *
 * Read-only lookups are live-only and never become transcript cards.
 */
export const TOOL_ACTIVITY_PREFIX = "tool:";

export interface ToolActivity {
  tool: string;
  ok: boolean;
}

export function parseToolActivityContent(content: string): ToolActivity | null {
  if (!content.startsWith(TOOL_ACTIVITY_PREFIX)) return null;
  const rest = content.slice(TOOL_ACTIVITY_PREFIX.length);
  const separator = rest.lastIndexOf(":");
  if (separator <= 0 || separator === rest.length - 1) return null;
  const tool = rest.slice(0, separator);
  const status = rest.slice(separator + 1);
  if (status !== "ok" && status !== "failed") return null;
  if (!/^[a-z0-9_]+$/.test(tool)) return null;
  return { tool, ok: status === "ok" };
}

const TOOL_LABELS: Record<string, string> = {
  reminders_create: "Created a task",
  reminders_update: "Updated a task",
  reminders_complete: "Completed a task",
  reminders_snooze: "Snoozed a task",
  reminders_skip: "Skipped an occurrence",
  reminders_propose: "Prepared a proposal",
  reminders_list: "Read tasks",
  reminders_get: "Read a task",
  reminders_search: "Searched tasks",
  reminders_lists: "Read lists",
  reminders_day: "Read a day",
};

export function toolActivityLabel(tool: string): string {
  const normalized = tool.replace(/^morrow_/, "");
  return (
    TOOL_LABELS[normalized] ??
    normalized.replaceAll("_", " ")
  );
}
