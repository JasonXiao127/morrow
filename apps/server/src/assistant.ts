/**
 * Assistant service (plan §5, §6, §9).
 *
 * Owns:
 * - one OpenCode event subscription, fanned out as safe browser SSE events;
 * - conversation <-> OpenCode session mapping;
 * - one-shot capture fallback and deterministic plan-my-day;
 * - proposal CRUD/apply/undo;
 * - resync from OpenCode messages after reconnect.
 *
 * AI-off is first-class: every method that needs the model checks status first
 * and throws a typed AgentError instead of touching core reminder state.
 */
import {
  applyProposal as applyProposalOperation,
  buildPlanMyDay,
  capturePrompt,
  createProposal,
  dismissProposal as dismissProposalOperation,
  getProposalWithPreview,
  listProposalsWithPreview,
  mapOpenCodeEvent,
  parseCaptureDeterministic,
  quotas,
  TaskStore,
  ownerUserId,
  undoActivityBatch,
  undoProposal as undoProposalOperation,
  validateCaptureModelJson,
  type AgentModelSummary,
  type AgentStatus,
  type ApplyProposalResult,
  type AssistantMessageRecord,
  type CaptureParse,
  type ConversationRecord,
  type ProposalRecord,
  type PromptFile,
  type RuntimeMessage,
  createRuntimeFromEnv,
  type AgentRuntime,
} from "@morrow/agent";
import type { BetterDb } from "@morrow/db";
import { nowIso, wallDateInZone, wallTimeInZone } from "@morrow/shared";

export interface AssistantLogger {
  info: (value: unknown, message?: string) => void;
  warn: (value: unknown, message?: string) => void;
  error: (value: unknown, message?: string) => void;
}

export interface AssistantDeps {
  db: BetterDb;
  logger?: AssistantLogger;
}

export interface StreamEvent {
  id: number;
  at: string;
  type: string;
  data: Record<string, unknown>;
}

interface ActiveRun {
  runId: string;
  sessionId: string;
  startedAt: number;
}

/**
 * Persistent assistant tool cards. Keep the format in sync with
 * apps/web/src/lib/tool-activity.ts (`tool:<name>:<ok|failed>`).
 * Only mutating tools become transcript cards; read-only lookups stay live-only
 * so a normal question does not fill the chat with noise.
 */
const TOOL_ACTIVITY_PREFIX = "tool:";
const MUTATING_TOOL_NAMES = new Set([
  "reminders_create",
  "reminders_update",
  "reminders_complete",
  "reminders_snooze",
  "reminders_skip",
  "reminders_propose",
]);

type StreamListener = (event: StreamEvent) => void;

class AssistantEventBus {
  private nextId = 1;
  private readonly rings = new Map<string, StreamEvent[]>();
  private readonly listeners = new Map<string, Set<StreamListener>>();

  currentId(): number {
    return this.nextId - 1;
  }

  publish(
    conversationId: string | null,
    type: string,
    data: Record<string, unknown>,
  ): StreamEvent | null {
    const event: StreamEvent = {
      id: this.nextId++,
      at: nowIso(),
      type,
      data,
    };
    if (!conversationId) {
      // Broadcast global activity (for example an MCP proposal with no
      // conversation) to every currently open assistant stream.
      for (const key of this.listeners.keys()) this.push(key, event);
      return event;
    }
    this.push(conversationId, event);
    return event;
  }

  private push(conversationId: string, event: StreamEvent): void {
    const ring = this.rings.get(conversationId) ?? [];
    ring.push(event);
    if (ring.length > 200) ring.splice(0, ring.length - 200);
    this.rings.set(conversationId, ring);
    for (const listener of this.listeners.get(conversationId) ?? []) {
      listener(event);
    }
  }

  addListener(conversationId: string, listener: StreamListener): () => void {
    const set = this.listeners.get(conversationId) ?? new Set<StreamListener>();
    set.add(listener);
    this.listeners.set(conversationId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(conversationId);
    };
  }

  replay(conversationId: string, lastEventId: number | null): StreamEvent[] {
    const ring = this.rings.get(conversationId) ?? [];
    return lastEventId == null
      ? []
      : ring.filter((event) => event.id > lastEventId);
  }
}

export class AssistantService {
  store: TaskStore;
  readonly bus = new AssistantEventBus();
  private readonly logger?: AssistantLogger;
  private readonly runtime: AgentRuntime | null;
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly syncing = new Set<string>();
  private readonly drafts = new Map<string, string>();
  /** callId → tool name, populated from `session.tool.input.started`. */
  private readonly toolNames = new Map<string, string>();
  /** Latest `assistant.run.failed` payload per conversation (cleared on success). */
  private readonly runFailures = new Map<
    string,
    { code: string | null; message: string; status?: number; retryAfterMs?: number }
  >();
  private statusCache: { at: number; value: AgentStatus } | null = null;
  private unsubscribeRuntime: (() => void) | null = null;

  constructor(deps: AssistantDeps) {
    this.store = new TaskStore(deps.db, ownerUserId(deps.db) ?? undefined);
    this.logger = deps.logger;
    this.runtime = createRuntimeFromEnv();
    if (this.runtime) {
      this.unsubscribeRuntime = this.runtime.subscribe(
        (event) => this.onRuntimeEvent(event),
        () => this.onRuntimeReconnect(),
      );
    }
  }

  close(): void {
    this.unsubscribeRuntime?.();
    this.runtime?.close();
  }

  /**
   * Point the service at a freshly reopened DB singleton after a live restore.
   * The HTTP routes hold this service instance, so replacing the store is
   * enough to rebind conversations/proposals/MCP reads without re-registering
   * routes. Runtime/event subscriptions are process-scoped and stay alive.
   */
  rebind(db: BetterDb): void {
    this.store = new TaskStore(db, ownerUserId(db) ?? undefined);
    this.activeRuns.clear();
    this.syncing.clear();
    this.drafts.clear();
    this.toolNames.clear();
    this.runFailures.clear();
    this.statusCache = null;
  }

  private aiEnabled(): boolean {
    if (!this.runtime) return false;
    const configured = this.store.getSetting("ai.enabled");
    if (typeof configured === "boolean") return configured;
    return true;
  }

  private aiModel(): string | null {
    const model = this.store.getSetting("ai.model");
    return typeof model === "string" && model.trim() ? model.trim() : null;
  }

  private aiFallbackModel(): string | null {
    const model = this.store.getSetting("ai.fallbackModel");
    return typeof model === "string" && model.trim() ? model.trim() : null;
  }

  async status(force = false): Promise<AgentStatus> {
    if (!force && this.statusCache && Date.now() - this.statusCache.at < 5_000) {
      return this.statusCache.value;
    }
    let value: AgentStatus;
    if (!this.runtime) {
      value = {
        enabled: false,
        available: false,
        connected: false,
        status: "not_configured",
        model: null,
        message: "OpenCode is not configured. Morrow works fully without it.",
      };
    } else if (!this.aiEnabled()) {
      value = {
        enabled: false,
        available: false,
        connected: false,
        status: "disabled",
        model: this.aiModel(),
        message: "The assistant is switched off. Morrow works fully without it.",
      };
    } else {
      try {
        value = await this.runtime.status({
          enabled: true,
          model: this.aiModel(),
        });
      } catch (error) {
        value = {
          enabled: true,
          available: false,
          connected: false,
          status: "unreachable",
          model: this.aiModel(),
          message:
            error instanceof Error
              ? error.message.slice(0, 300)
              : "OpenCode is not reachable.",
        };
      }
    }
    value = { ...value, fallbackModel: this.aiFallbackModel() };
    this.statusCache = { at: Date.now(), value };
    return value;
  }

  async listModels(): Promise<AgentModelSummary[]> {
    if (!this.runtime) return [];
    try {
      return await this.runtime.listModels();
    } catch {
      return [];
    }
  }

  private async validateSelectableModel(model: string): Promise<void> {
    if (!this.runtime) {
      throw new AssistantError(
        "agent_not_configured",
        "OpenCode is not configured, so a model cannot be selected.",
        503,
      );
    }
    const resolved = await this.runtime.resolveModel(model);
    if (!resolved) {
      throw new AssistantError(
        "model_missing",
        "That model is not available. Refresh the model list and try again.",
        400,
      );
    }
    if (!resolved.summary.tools) {
      throw new AssistantError(
        "model_not_tool_capable",
        "That model does not support tools. Choose a tool-capable model.",
        400,
      );
    }
  }

  async updateSettings(patch: {
    aiEnabled?: boolean;
    model?: string | null;
    fallbackModel?: string | null;
  }): Promise<AgentStatus> {
    if (typeof patch.aiEnabled === "boolean") {
      this.store.setSetting("ai.enabled", patch.aiEnabled);
    }
    if (patch.model !== undefined) {
      if (patch.model === null || patch.model === "") {
        this.store.setSetting("ai.model", null);
      } else {
        await this.validateSelectableModel(patch.model);
        this.store.setSetting("ai.model", patch.model);
      }
    }
    if (patch.fallbackModel !== undefined) {
      if (patch.fallbackModel === null || patch.fallbackModel === "") {
        this.store.setSetting("ai.fallbackModel", null);
      } else {
        await this.validateSelectableModel(patch.fallbackModel);
        this.store.setSetting("ai.fallbackModel", patch.fallbackModel);
      }
    }
    this.statusCache = null;
    return this.status(true);
  }

  private requireRuntime(): AgentRuntime {
    if (!this.runtime) {
      throw new AssistantError(
        "agent_not_configured",
        "The assistant is off. Morrow works fully without it.",
        503,
      );
    }
    return this.runtime;
  }

  private async requireReady(): Promise<AgentStatus> {
    const status = await this.status(true);
    if (!status.available) {
      const code =
        status.status === "disabled"
          ? "agent_disabled"
          : status.status === "not_configured" ||
              status.status === "unconfigured"
            ? "agent_not_configured"
            : status.status;
      throw new AssistantError(
        code,
        status.message ?? "The assistant is not ready.",
        503,
      );
    }
    return status;
  }

  // -------------------------------------------------------------------------
  // conversations
  // -------------------------------------------------------------------------

  listConversations(): ConversationRecord[] {
    return this.store.listConversations(20);
  }

  getConversation(id: string): ConversationRecord {
    const conversation = this.store.getConversation(id);
    if (!conversation) {
      throw new AssistantError("not_found", "Conversation not found.", 404);
    }
    return conversation;
  }

  async createConversation(input: {
    title?: string | null;
    createSession?: boolean;
  } = {}): Promise<ConversationRecord> {
    const conversation = this.store.createConversation(input.title ?? "New conversation");
    if (input.createSession === false || !this.runtime) return conversation;
    const status = await this.status();
    if (!status.available) return conversation;
    try {
      const sessionId = await this.runtime.ensureSession({
        title: input.title ?? "Morrow assistant",
        model: this.aiModel(),
      });
      this.store.setConversationSession(conversation.id, sessionId);
      return this.getConversation(conversation.id);
    } catch (error) {
      this.logger?.warn(
        { err: error },
        "assistant session creation failed; will retry on first prompt",
      );
      return conversation;
    }
  }

  private async ensureSession(conversation: ConversationRecord): Promise<string> {
    const runtime = this.requireRuntime();
    if (conversation.opencodeSessionId) {
      try {
        return await runtime.ensureSession({
          existingSessionId: conversation.opencodeSessionId,
          title: conversation.title,
          model: this.aiModel(),
        });
      } catch {
        // A stale OpenCode session is replaced below.
      }
    }
    const sessionId = await runtime.ensureSession({
      title: conversation.title,
      model: this.aiModel(),
    });
    this.store.setConversationSession(conversation.id, sessionId);
    return sessionId;
  }

  listMessages(conversationId: string): AssistantMessageRecord[] {
    this.getConversation(conversationId);
    return this.store.listMessages(conversationId, 200);
  }

  async sendPrompt(
    conversationId: string,
    text: string,
    opts: { files?: PromptFile[] } = {},
  ): Promise<{ message: AssistantMessageRecord; runId: string; status: AgentStatus }> {
    const trimmed = text.trim();
    if (!trimmed) {
      throw new AssistantError("invalid_request", "Write a message first.", 400);
    }
    if (trimmed.length > 4000) {
      throw new AssistantError(
        "invalid_request",
        "Messages are limited to 4,000 characters.",
        400,
      );
    }
    const status = await this.requireReady();
    const runtime = this.requireRuntime();
    const conversation = this.getConversation(conversationId);
    const sessionId = await this.ensureSession(conversation);
    const timezone = this.store.timezone();
    const now = new Date();
    try {
      await runtime.setInstructions(sessionId, {
        now: nowIso(),
        timezone,
        localDate: wallDateInZone(now, timezone),
        localTime: wallTimeInZone(now, timezone),
        policy: "propose broad changes; immediate single-item writes have undo",
      });
    } catch {
      // Older OpenCode builds may not support instructions.entry; the system
      // prompt still contains the policy. The date/time snapshot is repeated
      // in the first prompt so the model is never guessing.
    }
    let message = this.store.addMessage({
      conversationId,
      role: "user",
      content: trimmed,
    });
    // A new prompt starts a fresh attempt; the old banner goes away.
    try {
      this.store.clearConversationError(conversationId);
    } catch {
      // Older DBs without the error columns still work; the banner is best-effort.
    }
    this.runFailures.delete(conversationId);
    const runId = `run_${now.getTime().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    quotas.beginRun(sessionId);
    this.activeRuns.set(conversationId, {
      runId,
      sessionId,
      startedAt: Date.now(),
    });
    this.bus.publish(conversationId, "assistant.message", {
      message,
    });
    const promptText = [
      `Current date: ${wallDateInZone(now, timezone)} (${timezone}).`,
      trimmed,
    ].join("\n\n");
    try {
      const result = await runtime.prompt(sessionId, promptText, {
        runId,
        ...(opts.files && opts.files.length > 0 ? { files: opts.files } : {}),
      });
      if (result?.messageId) {
        if (this.store.linkUserMessageById(message.id, result.messageId)) {
          const updated = this.store.getMessage(message.id);
          if (updated) {
            message = updated;
            this.bus.publish(conversationId, "assistant.message", { message });
          }
        }
      }
    } catch (error) {
      this.activeRuns.delete(conversationId);
      throw new AssistantError(
        "prompt_failed",
        error instanceof Error
          ? error.message.slice(0, 300)
          : "The assistant could not start.",
        503,
      );
    }
    void this.finishRun(conversationId, sessionId, runId);
    return { message, runId, status };
  }

  private async finishRun(
    conversationId: string,
    sessionId: string,
    runId: string,
  ): Promise<void> {
    const runtime = this.runtime;
    if (!runtime) return;
    try {
      await runtime.waitForIdle(sessionId, 90_000);
      await this.syncConversation(conversationId);
      // Idle follows failed runs too, so check the outcome before calling
      // the run a success: a failed outcome keeps the persisted error.
      const outcome = await runtime.sessionOutcome(sessionId);
      if (outcome === "failed") {
        const failure = this.runFailures.get(conversationId) ?? {
          code: null as string | null,
          message:
            "The assistant run failed. Nothing beyond reported tool changes was saved.",
        };
        try {
          this.store.setConversationError(conversationId, {
            code: failure.code,
            message: failure.message,
          });
        } catch {
          // best-effort on older DBs
        }
        this.bus.publish(conversationId, "assistant.run.failed", {
          runId,
          message: failure.message,
          ...(failure.code ? { code: failure.code } : {}),
          ...(failure.status !== undefined ? { status: failure.status } : {}),
          ...(failure.retryAfterMs !== undefined
            ? { retryAfterMs: failure.retryAfterMs }
            : {}),
        });
        return;
      }
      if (outcome === "interrupted") {
        this.bus.publish(conversationId, "assistant.run.stopped", { runId });
        return;
      }
      try {
        this.store.clearConversationError(conversationId);
      } catch {
        // best-effort on older DBs
      }
      this.runFailures.delete(conversationId);
      this.bus.publish(conversationId, "assistant.run.completed", { runId });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "AbortError";
      try {
        await runtime.interrupt(sessionId);
      } catch {
        // ignore interrupt failure
      }
      const message = timedOut
        ? "The assistant took too long and was stopped. Check the task list before retrying."
        : "The assistant stopped before finishing. Nothing beyond reported tool changes was saved.";
      try {
        this.store.setConversationError(conversationId, {
          code: timedOut ? "timeout" : "run_failed",
          message,
        });
      } catch {
        // best-effort on older DBs
      }
      this.bus.publish(conversationId, "assistant.run.failed", {
        runId,
        message,
        code: timedOut ? "timeout" : "run_failed",
      });
    } finally {
      const active = this.activeRuns.get(conversationId);
      if (active?.runId === runId) this.activeRuns.delete(conversationId);
      this.drafts.delete(conversationId);
    }
  }

  async stop(conversationId: string): Promise<{ stopped: boolean }> {
    const conversation = this.getConversation(conversationId);
    const active = this.activeRuns.get(conversationId);
    if (!active) return { stopped: false };
    if (this.runtime && conversation.opencodeSessionId) {
      try {
        await this.runtime.interrupt(conversation.opencodeSessionId);
      } catch {
        // ignore
      }
    }
    this.activeRuns.delete(conversationId);
    this.bus.publish(conversationId, "assistant.run.stopped", {
      runId: active.runId,
    });
    return { stopped: true };
  }

  isRunning(conversationId: string): boolean {
    return this.activeRuns.has(conversationId);
  }

  // -------------------------------------------------------------------------
  // OpenCode events and resync
  // -------------------------------------------------------------------------

  private onRuntimeEvent(raw: unknown): void {
    const event = mapOpenCodeEvent(raw);
    if (!event) return;
    const conversation = this.store.conversationBySession(event.sessionId);
    if (!conversation) return;
    const conversationId = conversation.id;
    switch (event.type) {
      case "assistant.run.started":
        this.drafts.set(conversationId, "");
        this.bus.publish(conversationId, "assistant.run.started", event.data);
        return;
      case "assistant.text.delta": {
        const delta = String(event.data["delta"] ?? "");
        if (delta) {
          const draft = `${this.drafts.get(conversationId) ?? ""}${delta}`;
          this.drafts.set(conversationId, draft.slice(-20_000));
        }
        this.bus.publish(conversationId, "assistant.delta", {
          delta,
          messageId: event.data["messageId"] ?? null,
        });
        return;
      }
      case "assistant.text.ended":
        this.bus.publish(conversationId, "assistant.text", {
          text: event.data["text"] ?? this.drafts.get(conversationId) ?? "",
          messageId: event.data["messageId"] ?? null,
        });
        return;
      case "assistant.tool.started": {
        const callId =
          typeof event.data["callId"] === "string" && event.data["callId"]
            ? String(event.data["callId"])
            : null;
        const tool =
          typeof event.data["tool"] === "string"
            ? String(event.data["tool"]).slice(0, 100)
            : "";
        if (callId && tool) this.toolNames.set(`${conversationId}:${callId}`, tool);
        this.bus.publish(conversationId, event.type, event.data);
        return;
      }
      case "assistant.tool.finished": {
        const callId =
          typeof event.data["callId"] === "string" && event.data["callId"]
            ? String(event.data["callId"])
            : null;
        const toolKey = callId ? `${conversationId}:${callId}` : null;
        const toolFromCallId =
          callId?.startsWith("functions.")
            ? callId.slice("functions.".length).split(":")[0] ?? null
            : null;
        const rawTool =
          (toolKey ? this.toolNames.get(toolKey) : null) ??
          toolFromCallId ??
          (typeof event.data["tool"] === "string"
            ? String(event.data["tool"])
            : "reminders_tool");
        if (toolKey) this.toolNames.delete(toolKey);
        const tool = rawTool.replace(/^morrow_/, "");
        const ok = event.data["ok"] === true;
        if (MUTATING_TOOL_NAMES.has(tool)) {
          const syntheticId = callId ? `tool:${callId}` : null;
          try {
            const already =
              syntheticId !== null
                ? this.store.messageByOpenCodeId(conversationId, syntheticId)
                : null;
            if (!already) {
              const message = this.store.addMessage({
                conversationId,
                role: "system",
                content: `${TOOL_ACTIVITY_PREFIX}${tool}:${ok ? "ok" : "failed"}`,
                opencodeMessageId: syntheticId,
                parts: { kind: "tool", tool, ok, callId },
              });
              this.bus.publish(conversationId, "assistant.message", { message });
            }
          } catch {
            // A failed transcript insert must not break the live run.
          }
        }
        this.bus.publish(conversationId, event.type, event.data);
        return;
      }
      case "assistant.run.completed":
        try {
          this.store.clearConversationError(conversationId);
        } catch {
          // best-effort on older DBs
        }
        this.runFailures.delete(conversationId);
        this.bus.publish(conversationId, "assistant.run.completed", event.data);
        void this.syncConversation(conversationId);
        return;
      case "assistant.run.failed": {
        const message =
          typeof event.data["message"] === "string" && event.data["message"]
            ? String(event.data["message"]).slice(0, 300)
            : "The assistant run failed.";
        const code =
          typeof event.data["code"] === "string" ? event.data["code"] : null;
        const status =
          typeof event.data["status"] === "number" ? event.data["status"] : undefined;
        const retryAfterMs =
          typeof event.data["retryAfterMs"] === "number"
            ? event.data["retryAfterMs"]
            : undefined;
        this.runFailures.set(conversationId, { code, message, status, retryAfterMs });
        try {
          this.store.setConversationError(conversationId, {
            code,
            message,
          });
        } catch {
          // best-effort on older DBs
        }
        this.bus.publish(conversationId, "assistant.run.failed", event.data);
        return;
      }
      case "assistant.run.stopped":
        this.bus.publish(conversationId, "assistant.run.stopped", event.data);
        return;
      case "assistant.status":
        this.bus.publish(conversationId, "assistant.status", event.data);
        return;
      default:
        return;
    }
  }

  private onRuntimeReconnect(): void {
    this.bus.publish(null, "assistant.reconnected", { at: nowIso() });
    try {
      for (const conversation of this.store.listConversations(50)) {
        if (!conversation.opencodeSessionId) continue;
        void this.syncConversation(conversation.id);
      }
    } catch (error) {
      // The sidecar can reconnect before first-run setup creates the owner.
      // There is nothing to resync yet; the next reconnect will try again.
      this.logger?.warn(
        { err: error },
        "assistant reconnect skipped before setup",
      );
    }
  }

  /**
   * Pull the OpenCode transcript after a run/reconnect. Live events are not
   * replayable, so the transcript is the source of truth (plan §6).
   */
  async syncConversation(conversationId: string): Promise<AssistantMessageRecord[]> {
    if (this.syncing.has(conversationId)) return [];
    this.syncing.add(conversationId);
    try {
      const conversation = this.store.getConversation(conversationId);
      if (!conversation?.opencodeSessionId || !this.runtime) return [];
      let messages: RuntimeMessage[] = [];
      try {
        messages = await this.runtime.listMessages(
          conversation.opencodeSessionId,
          100,
        );
      } catch {
        return [];
      }
      const added: AssistantMessageRecord[] = [];
      for (const message of messages) {
        // ID first: a local row created by sendPrompt already carries the
        // OpenCode message id, so identical prompt text never cross-links.
        if (this.store.messageByOpenCodeId(conversationId, message.opencodeMessageId)) {
          continue;
        }
        if (message.role === "user") {
          // Legacy fallback only: rows created before id linking.
          const linked = this.store.linkUserMessage(
            conversationId,
            message.text,
            message.opencodeMessageId,
          );
          if (linked) continue;
        }
        if (!message.text.trim()) continue;
        added.push(
          this.store.addMessage({
            conversationId,
            role: message.role,
            content: message.text,
            opencodeMessageId: message.opencodeMessageId,
          }),
        );
      }
      if (added.length > 0) {
        this.store.touchConversation(conversationId);
        this.bus.publish(conversationId, "assistant.resync", {
          messages: added,
        });
      }
      return added;
    } finally {
      this.syncing.delete(conversationId);
    }
  }

  // -------------------------------------------------------------------------
  // proposals
  // -------------------------------------------------------------------------

  listProposals(opts: {
    status?: string;
    conversationId?: string;
    limit?: number;
  } = {}): ProposalRecord[] {
    this.store.expireProposals();
    return listProposalsWithPreview(this.store, opts);
  }

  getProposal(id: string): ProposalRecord {
    this.store.expireProposals();
    const proposal = getProposalWithPreview(this.store, id);
    if (!proposal) {
      throw new AssistantError("not_found", "Proposal not found.", 404);
    }
    return proposal;
  }

  applyProposal(
    id: string,
    options: {
      selectedIndexes?: number[];
      selectedOperationIds?: string[];
      payloadHash?: string;
      baseRev?: number;
    },
  ): ApplyProposalResult {
    const user = this.store.getUser();
    const result = applyProposalOperation(this.store, id, {
      ...options,
      actorId: user.id,
    });
    this.bus.publish(result.proposal.conversationId, "proposal.updated", {
      proposal: result.proposal,
      applied: result.applied,
      batchId: result.batchId,
    });
    this.bus.publish(result.proposal.conversationId, "assistant.activity", {
      action: "proposal.apply",
      batchId: result.batchId,
      undoable: true,
      summary: `Applied ${result.applied} approved change(s)`,
    });
    return result;
  }

  dismissProposal(id: string): ProposalRecord {
    const user = this.store.getUser();
    const proposal = dismissProposalOperation(this.store, id, user.id);
    this.bus.publish(proposal.conversationId, "proposal.updated", { proposal });
    return proposal;
  }

  undoProposal(id: string): {
    proposal: ProposalRecord;
    undone: number;
    batchId: string;
  } {
    const user = this.store.getUser();
    const result = undoProposalOperation(this.store, id, user.id);
    this.bus.publish(result.proposal.conversationId, "proposal.updated", {
      proposal: result.proposal,
      undone: result.undone,
    });
    return result;
  }

  undoBatch(batchId: string): { undone: number; batchId: string } {
    const user = this.store.getUser();
    return undoActivityBatch(this.store, batchId, user.id);
  }

  // -------------------------------------------------------------------------
  // capture / plan
  // -------------------------------------------------------------------------

  async captureParse(
    text: string,
    opts: { timezone?: string; mode?: "auto" | "deterministic" | "model" } = {},
  ): Promise<CaptureParse> {
    const timezone = opts.timezone?.trim() || this.store.timezone();
    const deterministic = parseCaptureDeterministic(text, timezone);
    const mode = opts.mode ?? "auto";
    if (mode === "deterministic") return deterministic;
    const autoModel =
      mode === "model" ||
      (mode === "auto" &&
        (!deterministic.dueAt && !deterministic.dueDate && !deterministic.rrule) &&
        /\b(next|this|by|before|end of|eod|weekend|month|january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(
          text,
        ));
    if (!autoModel) return deterministic;
    if (!this.runtime) return deterministic;
    const status = await this.status();
    if (!status.available) {
      return {
        ...deterministic,
        source: "deterministic_fallback",
        note: status.message,
      };
    }
    try {
      const raw = await this.runtime.generateText(
        capturePrompt(text, timezone),
        status.model,
      );
      const parsed = validateCaptureModelJson(raw, timezone);
      if (parsed) return parsed;
      return {
        ...deterministic,
        source: "deterministic_fallback",
        note: "The model returned an invalid capture; used the deterministic parser.",
      };
    } catch (error) {
      return {
        ...deterministic,
        source: "deterministic_fallback",
        note:
          error instanceof Error
            ? error.message.slice(0, 200)
            : "The model was unavailable; used the deterministic parser.",
      };
    }
  }

  planMyDay(input: { timezone?: string; conversationId?: string | null } = {}): {
    proposal: ProposalRecord | null;
    summary: string;
    plan: ReturnType<typeof buildPlanMyDay>;
  } {
    const plan = buildPlanMyDay(this.store, {
      timezone: input.timezone?.trim() || undefined,
    });
    if (plan.operations.length === 0) {
      return { proposal: null, summary: plan.summary, plan };
    }
    let conversationId = input.conversationId ?? null;
    if (conversationId) {
      try {
        this.getConversation(conversationId);
      } catch {
        conversationId = null;
      }
    }
    if (!conversationId) {
      conversationId = this.store.listConversations(1)[0]?.id ?? null;
    }
    const proposal = createProposal(this.store, {
      conversationId,
      summary: plan.summary,
      operations: plan.operations,
    });
    this.bus.publish(conversationId, "proposal.created", {
      proposalId: proposal.id,
      summary: proposal.summary,
      operationCount: proposal.operations.length,
      preview: proposal.preview,
    });
    return { proposal, summary: plan.summary, plan };
  }

  /** Safe sink used by the MCP listener. Never forwards raw tool input. */
  handleExternalEvent(event: {
    type: string;
    conversationId: string | null;
    data: Record<string, unknown>;
  }): void {
    this.bus.publish(event.conversationId, event.type, event.data);
  }
}

export class AssistantError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "AssistantError";
    this.code = code;
    this.status = status;
  }
}

let singleton: AssistantService | null = null;

export function initAssistant(deps: AssistantDeps): AssistantService {
  singleton?.close();
  singleton = new AssistantService(deps);
  return singleton;
}

export function getAssistant(): AssistantService {
  if (!singleton) {
    throw new Error("assistant not initialized");
  }
  return singleton;
}

/** Rebind the singleton (when present) to the reopened DB after restore. */
export function rebindAssistant(db: BetterDb): boolean {
  if (!singleton) return false;
  singleton.rebind(db);
  return true;
}

export function closeAssistant(): void {
  singleton?.close();
  singleton = null;
}
