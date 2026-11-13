/**
 * Safe projection of OpenCode events (plan §6 Sessions and events).
 *
 * The browser never receives reasoning, tool arguments, file paths, auth
 * material, or raw OpenCode endpoints. Only text deltas, tool names, run
 * state, and usage are forwarded.
 */
export interface SafeAgentEvent {
  type:
    | "assistant.run.started"
    | "assistant.text.delta"
    | "assistant.text.ended"
    | "assistant.tool.started"
    | "assistant.tool.finished"
    | "assistant.run.completed"
    | "assistant.run.failed"
    | "assistant.run.stopped"
    | "assistant.status";
  sessionId: string;
  data: Record<string, unknown>;
}

const SAFE_TYPES = new Set([
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.text.delta",
  "session.text.started",
  "session.text.ended",
  "session.tool.input.started",
  "session.tool.success",
  "session.tool.failed",
  "session.idle",
  "session.status",
  "session.inbox.enqueued",
  "session.inbox.delivered",
  "session.inbox.cancelled",
  "session.retry.scheduled",
  "session.usage.updated",
]);

export function mapOpenCodeEvent(event: unknown): SafeAgentEvent | null {
  if (!event || typeof event !== "object") return null;
  const raw = event as Record<string, unknown>;
  const type = typeof raw["type"] === "string" ? raw["type"] : "";
  if (!SAFE_TYPES.has(type)) return null;
  const data =
    raw["data"] && typeof raw["data"] === "object"
      ? (raw["data"] as Record<string, unknown>)
      : {};
  const sessionId =
    typeof data["sessionID"] === "string" ? data["sessionID"] : "";
  if (!sessionId) return null;
  const messageId =
    typeof data["assistantMessageID"] === "string"
      ? data["assistantMessageID"]
      : null;

  switch (type) {
    case "session.execution.started":
      return { type: "assistant.run.started", sessionId, data: {} };
    case "session.execution.succeeded":
      return { type: "assistant.run.completed", sessionId, data: {} };
    case "session.execution.failed": {
      const error =
        data["error"] && typeof data["error"] === "object"
          ? (data["error"] as Record<string, unknown>)
          : {};
      const rawMessage =
        typeof error["message"] === "string" && error["message"].trim()
          ? error["message"]
          : typeof data["message"] === "string" && data["message"].trim()
            ? data["message"]
            : "The assistant run failed.";
      const code =
        typeof error["type"] === "string" && error["type"].trim()
          ? error["type"].slice(0, 100)
          : null;
      const status =
        typeof error["status"] === "number" &&
        Number.isFinite(error["status"])
          ? error["status"]
          : undefined;
      const retryAfterMs =
        typeof error["retryAfterMs"] === "number" &&
        Number.isFinite(error["retryAfterMs"])
          ? error["retryAfterMs"]
          : undefined;
      // Never forward response bodies, headers, credentials, or raw payloads.
      return {
        type: "assistant.run.failed",
        sessionId,
        data: {
          message: rawMessage.slice(0, 300),
          ...(code ? { code } : {}),
          ...(status !== undefined ? { status } : {}),
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        },
      };
    }
    case "session.execution.interrupted":
      return { type: "assistant.run.stopped", sessionId, data: {} };
    case "session.text.delta":
      return {
        type: "assistant.text.delta",
        sessionId,
        data: {
          delta: typeof data["delta"] === "string" ? data["delta"] : "",
          messageId,
        },
      };
    case "session.text.ended":
      return {
        type: "assistant.text.ended",
        sessionId,
        data: {
          text: typeof data["text"] === "string" ? data["text"] : null,
          messageId,
        },
      };
    case "session.tool.input.started": {
      const tool =
        typeof data["name"] === "string" ? data["name"].slice(0, 100) : "";
      if (!tool) return null;
      return {
        type: "assistant.tool.started",
        sessionId,
        data: {
          tool,
          callId: typeof data["id"] === "string" ? data["id"] : null,
        },
      };
    }
    case "session.tool.success":
    case "session.tool.failed":
      return {
        type: "assistant.tool.finished",
        sessionId,
        data: {
          tool:
            typeof data["name"] === "string"
              ? data["name"].slice(0, 100)
              : "reminders_tool",
          callId: typeof data["id"] === "string" ? data["id"] : null,
          ok: type === "session.tool.success",
        },
      };
    case "session.idle":
      return { type: "assistant.run.completed", sessionId, data: { idle: true } };
    case "session.status":
      return {
        type: "assistant.status",
        sessionId,
        data: {
          status:
            typeof data["status"] === "string" ? data["status"] : "unknown",
        },
      };
    case "session.inbox.enqueued":
      return { type: "assistant.status", sessionId, data: { queued: true } };
    case "session.inbox.delivered":
      return { type: "assistant.status", sessionId, data: { queued: false } };
    case "session.inbox.cancelled":
      return { type: "assistant.run.stopped", sessionId, data: { cancelled: true } };
    case "session.retry.scheduled":
      return {
        type: "assistant.status",
        sessionId,
        data: { retrying: true },
      };
    case "session.usage.updated":
      return {
        type: "assistant.status",
        sessionId,
        data: {
          cost:
            typeof data["cost"] === "number" ? data["cost"] : undefined,
        },
      };
    default:
      return null;
  }
}
