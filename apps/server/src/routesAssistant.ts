/**
 * Assistant, proposal, capture-fallback, model, and MCP admin routes
 * (appended to the M0 route table; plan §5 + §6).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { AgentError } from "@morrow/agent";
import { getDb } from "@morrow/db";
import { nowIso } from "@morrow/shared";
import { authenticateRequest, isOwner, isStepUpFresh } from "./auth.js";
import { parseCapture } from "./captureParse.js";
import { AssistantError, type AssistantService } from "./assistant.js";
import {
  badRequest,
  forbidden,
  notFound,
  sendProblem,
  unauthorized,
} from "./errors.js";
import {
  mcpStatus,
  revokeMcpToken,
  rotateMcpToken,
  setMcpEnabled,
} from "./mcp.js";

const conversationCreateSchema = z.object({
  title: z.string().trim().max(100).optional(),
});

const promptSchema = z.object({
  text: z.string().min(1).max(4000),
});

const planSchema = z.object({
  timezone: z.string().min(1).max(128).optional(),
  conversationId: z.string().min(1).max(64).nullable().optional(),
});

const assistantSettingsSchema = z.object({
  aiEnabled: z.boolean().optional(),
  model: z.string().trim().max(200).nullable().optional(),
  fallbackModel: z.string().trim().max(200).nullable().optional(),
});

const applySchema = z.object({
  operations: z.array(z.number().int().min(0)).max(20).optional(),
  operationIds: z.array(z.string().min(1).max(100)).max(20).optional(),
  payloadHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/i)
    .optional(),
  baseRev: z.number().int().positive().optional(),
});

const undoBatchSchema = z.object({
  batchId: z.string().min(1).max(64),
});

const mcpToggleSchema = z.object({ enabled: z.boolean() });

/**
 * Assistant, proposal, model, MCP, and capture-AI surfaces are workspace-global
 * in this phase. Per-user AI sessions are a later refactor; until then members
 * get owner_only rather than sharing the owner's agent context.
 */
function requireOwner(
  req: FastifyRequest,
  reply: FastifyReply,
): ReturnType<typeof authenticateRequest> {
  const auth = authenticateRequest(req);
  if (!auth) {
    unauthorized(req, reply);
    return null;
  }
  if (!isOwner(auth.user)) {
    forbidden(
      req,
      reply,
      "owner_only",
      "Only the workspace owner can use the assistant or MCP.",
    );
    return null;
  }
  return auth;
}

function problemFromError(
  req: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): FastifyReply {
  if (error instanceof AssistantError || error instanceof AgentError) {
    return sendProblem(
      req,
      reply,
      error.status,
      error.status === 404
        ? "Not Found"
        : error.status === 409
          ? "Conflict"
          : error.status === 412
            ? "Precondition Failed"
            : error.status === 429
              ? "Too Many Requests"
              : error.status >= 500
                ? "Service Unavailable"
                : "Bad Request",
      { detail: error.message, code: error.code },
    );
  }
  throw error;
}

function parseLastEventId(req: FastifyRequest): number | null {
  const raw = req.headers["last-event-id"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function sseWrite(
  res: import("node:http").ServerResponse,
  id: number,
  type: string,
  data: unknown,
): void {
  res.write(`id: ${id}\n`);
  res.write(`event: ${type}\n`);
  const payload = JSON.stringify({
    v: 1,
    id: String(id),
    type,
    at: nowIso(),
    data,
  });
  for (const line of payload.split("\n")) res.write(`data: ${line}\n`);
  res.write("\n");
}

export async function registerAssistantRoutes(
  app: FastifyInstance,
  service: AssistantService,
): Promise<void> {
  // ---- status / model ------------------------------------------------------
  app.get("/api/assistant/status", async (req, reply) => {
    const auth = requireOwner(req, reply);
    if (!auth) return;
    const status = await service.status();
    return reply.send({ status });
  });

  app.get("/api/model", async (req, reply) => {
    const auth = requireOwner(req, reply);
    if (!auth) return;
    const status = await service.status();
    const models = await service.listModels();
    return reply.send({
      current: status.model,
      status,
      models: models.map((model) => ({
        ...model,
        variantLabels: model.variants,
      })),
    });
  });

  app.post("/api/assistant/settings", async (req, reply) => {
    const auth = requireOwner(req, reply);
    if (!auth) return;
    // Model/enabled flips redirect future assistant traffic (and billing):
    // require a fresh step-up, matching the MCP/provider admin routes.
    if (!isStepUpFresh(auth.session)) {
      return forbidden(req, reply, "step_up_required", "Confirm your password first.");
    }
    const parsed = assistantSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      return badRequest(req, reply, "Check the assistant settings.", "invalid_request");
    }
    try {
      const status = await service.updateSettings({
        aiEnabled: parsed.data.aiEnabled,
        model: parsed.data.model,
        fallbackModel: parsed.data.fallbackModel,
      });
      return reply.send({ status });
    } catch (error) {
      return problemFromError(req, reply, error);
    }
  });

  // ---- conversations -------------------------------------------------------
  app.post("/api/assistant/conversations", async (req, reply) => {
    const auth = requireOwner(req, reply);
    if (!auth) return;
    const parsed = conversationCreateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return badRequest(req, reply, "Check the conversation title.", "invalid_request");
    }
    const conversation = await service.createConversation({
      title: parsed.data.title ?? null,
    });
    return reply.code(201).send({ conversation });
  });

  app.get("/api/assistant/conversations", async (req, reply) => {
    const auth = requireOwner(req, reply);
    if (!auth) return;
    return reply.send({ conversations: service.listConversations() });
  });

  app.get("/api/assistant/conversations/:id/messages", async (req, reply) => {
    const auth = requireOwner(req, reply);
    if (!auth) return;
    const id = (req.params as { id?: string }).id;
    if (!id) return notFound(req, reply);
    try {
      const conversation = service.getConversation(id);
      const messages = service.listMessages(id);
      const proposals = service.listProposals({
        conversationId: id,
        limit: 20,
      });
      return reply.send({
        conversation,
        messages,
        proposals,
        running: service.isRunning(id),
        lastError: conversation.lastError ?? null,
      });
    } catch (error) {
      return problemFromError(req, reply, error);
    }
  });

  app.post("/api/assistant/conversations/:id/messages", async (req, reply) => {
    const auth = requireOwner(req, reply);
    if (!auth) return;
    const id = (req.params as { id?: string }).id;
    if (!id) return notFound(req, reply);
    const parsed = promptSchema.safeParse(req.body);
    if (!parsed.success) {
      return badRequest(req, reply, "Write a message first.", "invalid_request");
    }
    try {
      const result = await service.sendPrompt(id, parsed.data.text);
      return reply.code(202).send({
        message: result.message,
        runId: result.runId,
        status: result.status,
      });
    } catch (error) {
      return problemFromError(req, reply, error);
    }
  });

  app.post("/api/assistant/conversations/:id/stop", async (req, reply) => {
    const auth = requireOwner(req, reply);
    if (!auth) return;
    const id = (req.params as { id?: string }).id;
    if (!id) return notFound(req, reply);
    try {
      return reply.send(await service.stop(id));
    } catch (error) {
      return problemFromError(req, reply, error);
    }
  });

  // ---- browser SSE ---------------------------------------------------------
  app.get("/api/assistant/conversations/:id/stream", async (req, reply) => {
    const auth = requireOwner(req, reply);
    if (!auth) return;
    const id = (req.params as { id?: string }).id;
    if (!id) return notFound(req, reply);
    let conversation;
    try {
      conversation = service.getConversation(id);
    } catch (error) {
      return problemFromError(req, reply, error);
    }
    const status = await service.status();
    const lastEventId = parseLastEventId(req);

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    try {
      (res as unknown as { flushHeaders?: () => void }).flushHeaders?.();
    } catch {
      // ignore
    }
    res.write("retry: 3000\n\n");

    let closed = false;
    let ready = false;
    const buffered: Array<import("./assistant.js").StreamEvent> = [];
    const writeEvent = (event: import("./assistant.js").StreamEvent): void => {
      if (closed) return;
      sseWrite(res, event.id, event.type, event.data);
    };
    const unsubscribe = service.bus.addListener(id, (event) => {
      if (!ready) buffered.push(event);
      else writeEvent(event);
    });
    // The snapshot is the authoritative transcript/proposal state. Replay only
    // events that happened after it, so a reconnect never paints stale deltas
    // back over completed messages.
    const snapshotCursor = service.bus.currentId();
    const messages = service.listMessages(id);
    const proposals = service.listProposals({ conversationId: id, limit: 20 });
    sseWrite(res, 0, "assistant.snapshot", {
      conversation,
      messages,
      proposals,
      running: service.isRunning(id),
      status,
      cursor: snapshotCursor,
    });
    const replayAfter = Math.max(lastEventId ?? 0, snapshotCursor);
    for (const event of service.bus.replay(id, replayAfter)) writeEvent(event);
    ready = true;
    for (const event of buffered.splice(0)) {
      if (event.id > snapshotCursor) writeEvent(event);
    }

    const heartbeat = setInterval(() => {
      if (closed) return;
      try {
        res.write(`: heartbeat ${nowIso()}\n\n`);
      } catch {
        // close handler cleans up
      }
    }, 20_000);
    heartbeat.unref?.();

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      try {
        res.end();
      } catch {
        // ignore
      }
    };
    req.raw.socket.on("close", cleanup);
    res.on("close", cleanup);
  });

  // ---- capture fallback ----------------------------------------------------
  // M1 owns the deterministic route. This preHandler only takes over the
  // M4-flagged request (`ai: true` or `mode: "auto"|"model"`) and otherwise
  // lets the M1 handler run unchanged.
  app.addHook("preHandler", async (req, reply) => {
    if (req.method !== "POST" || req.url.split("?")[0] !== "/api/capture/parse") {
      return;
    }
    const body =
      req.body !== null && typeof req.body === "object"
        ? (req.body as Record<string, unknown>)
        : null;
    if (!body) return;
    const explicitMode =
      body["mode"] === "model" || body["mode"] === "auto"
        ? (body["mode"] as "model" | "auto")
        : null;
    const legacyAi = body["ai"] === true && explicitMode === null;
    if (!explicitMode && !legacyAi) return;
    const auth = requireOwner(req, reply);
    if (!auth) return;
    const text = typeof body["text"] === "string" ? body["text"].trim() : "";
    if (text.length < 1 || text.length > 4000) {
      badRequest(req, reply, "text must be 1–4000 characters.");
      return;
    }
    const timezone =
      typeof body["timezone"] === "string" && body["timezone"].trim()
        ? body["timezone"].trim()
        : (auth.user.timezone ?? "UTC");

    let deterministic: ReturnType<typeof parseCapture> | null = null;
    try {
      deterministic = parseCapture(text, timezone);
    } catch {
      deterministic = null;
    }
    const hasSchedule = Boolean(
      deterministic?.dueAt || deterministic?.dueDate || deterministic?.rrule,
    );

    if (legacyAi && !explicitMode) {
      const status = await service.status();
      if (!status.available) {
        reply.header("x-morrow-m4", "capture-ai");
        return sendProblem(req, reply, 503, "Service Unavailable", {
          detail:
            "AI-assisted capture is unavailable. The deterministic parser remains available without ai:true.",
          code: "ai_unavailable",
        });
      }
    }

    // Preserve M1's richer deterministic parser (priority/list/tonight) for
    // ordinary captures. The model is an optional fallback, not a replacement.
    if (explicitMode === "auto" && hasSchedule && deterministic) {
      return reply.send({ ...deterministic, source: "deterministic", serverTime: nowIso() });
    }

    const status = await service.status();
    if (!status.available) {
      if (deterministic) {
        return reply.send({
          ...deterministic,
          source: "deterministic_fallback",
          note: "The assistant is off or unreachable; used the deterministic parser.",
          serverTime: nowIso(),
        });
      }
      return sendProblem(req, reply, 503, "Service Unavailable", {
        detail: "AI-assisted capture is unavailable.",
        code: "ai_unavailable",
      });
    }

    try {
      const parsed = await service.captureParse(text, {
        timezone,
        mode: explicitMode === "model" ? "model" : "auto",
      });
      if (
        (parsed.source === "deterministic" ||
          parsed.source === "deterministic_fallback") &&
        deterministic
      ) {
        return reply.send({
          ...deterministic,
          source: "deterministic_fallback",
          note: parsed.note ?? null,
          serverTime: nowIso(),
        });
      }
      return reply.send({
        title: parsed.title || deterministic?.title || text,
        dueAt: parsed.dueAt ?? deterministic?.dueAt ?? null,
        dueDate: parsed.dueDate ?? deterministic?.dueDate ?? null,
        allDay: parsed.dueAt || parsed.dueDate ? parsed.allDay : (deterministic?.allDay ?? false),
        remindAt: parsed.remindAt ?? deterministic?.remindAt ?? null,
        reminderTimeLocal: deterministic?.reminderTimeLocal ?? null,
        rrule: parsed.rrule ?? deterministic?.rrule ?? null,
        dtstartLocal: parsed.dtstartLocal ?? deterministic?.dtstartLocal ?? null,
        priority: deterministic?.priority ?? 0,
        listName: deterministic?.listName ?? null,
        confidence: parsed.confidence,
        source: parsed.source,
        note: parsed.note ?? null,
        serverTime: nowIso(),
      });
    } catch (error) {
      if (deterministic) {
        return reply.send({
          ...deterministic,
          source: "deterministic_fallback",
          note:
            error instanceof Error
              ? error.message.slice(0, 200)
              : "The model was unavailable; used the deterministic parser.",
          serverTime: nowIso(),
        });
      }
      return problemFromError(req, reply, error);
    }
  });

  // ---- plan-my-day ---------------------------------------------------------
  app.post("/api/assistant/plan-my-day", async (req, reply) => {
    const auth = requireOwner(req, reply);
    if (!auth) return;
    const parsed = planSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return badRequest(req, reply, "Check the plan request.", "invalid_request");
    }
    try {
      return reply.send(service.planMyDay(parsed.data));
    } catch (error) {
      return problemFromError(req, reply, error);
    }
  });

  // ---- proposals -----------------------------------------------------------
  app.get("/api/proposals", async (req, reply) => {
    const auth = requireOwner(req, reply);
    if (!auth) return;
    const query = req.query as {
      status?: string;
      conversationId?: string;
      limit?: string;
    };
    const limit = query.limit ? Number.parseInt(query.limit, 10) : 20;
    const status =
      query.status === "all" ? undefined : (query.status ?? "pending");
    return reply.send({
      proposals: service.listProposals({
        status,
        conversationId: query.conversationId,
        limit: Number.isFinite(limit) ? limit : 20,
      }),
    });
  });

  app.get("/api/proposals/:id", async (req, reply) => {
    const auth = requireOwner(req, reply);
    if (!auth) return;
    const id = (req.params as { id?: string }).id;
    if (!id) return notFound(req, reply);
    try {
      return reply.send({ proposal: service.getProposal(id) });
    } catch (error) {
      return problemFromError(req, reply, error);
    }
  });

  app.post("/api/proposals/:id/apply", async (req, reply) => {
    const auth = requireOwner(req, reply);
    if (!auth) return;
    const id = (req.params as { id?: string }).id;
    if (!id) return notFound(req, reply);
    const parsed = applySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return badRequest(req, reply, "Check the selected proposal items.", "invalid_request");
    }
    try {
      const result = service.applyProposal(id, {
        selectedIndexes: parsed.data.operations,
        selectedOperationIds: parsed.data.operationIds,
        payloadHash: parsed.data.payloadHash,
        baseRev: parsed.data.baseRev,
      });
      return reply.send(result);
    } catch (error) {
      return problemFromError(req, reply, error);
    }
  });

  app.post("/api/proposals/:id/dismiss", async (req, reply) => {
    const auth = requireOwner(req, reply);
    if (!auth) return;
    const id = (req.params as { id?: string }).id;
    if (!id) return notFound(req, reply);
    try {
      return reply.send({ proposal: service.dismissProposal(id) });
    } catch (error) {
      return problemFromError(req, reply, error);
    }
  });

  app.post("/api/proposals/:id/undo", async (req, reply) => {
    const auth = requireOwner(req, reply);
    if (!auth) return;
    const id = (req.params as { id?: string }).id;
    if (!id) return notFound(req, reply);
    try {
      return reply.send(service.undoProposal(id));
    } catch (error) {
      return problemFromError(req, reply, error);
    }
  });

  app.post("/api/assistant/undo", async (req, reply) => {
    const auth = requireOwner(req, reply);
    if (!auth) return;
    const parsed = undoBatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return badRequest(req, reply, "Check the undo request.", "invalid_request");
    }
    try {
      return reply.send(service.undoBatch(parsed.data.batchId));
    } catch (error) {
      return problemFromError(req, reply, error);
    }
  });

  // ---- MCP admin (step-up for mutations) -----------------------------------
  app.get("/api/mcp/status", async (req, reply) => {
    const auth = requireOwner(req, reply);
    if (!auth) return;
    return reply.send(mcpStatus(getDb()));
  });

  app.patch("/api/mcp", async (req, reply) => {
    const auth = requireOwner(req, reply);
    if (!auth) return;
    if (!isStepUpFresh(auth.session)) {
      return forbidden(req, reply, "step_up_required", "Confirm your password first.");
    }
    const parsed = mcpToggleSchema.safeParse(req.body);
    if (!parsed.success) {
      return badRequest(req, reply, "Expected { enabled: boolean }.", "invalid_request");
    }
    setMcpEnabled(getDb(), parsed.data.enabled);
    return reply.send({ ok: true, enabled: parsed.data.enabled });
  });

  app.post("/api/mcp/tokens/rotate", async (req, reply) => {
    const auth = requireOwner(req, reply);
    if (!auth) return;
    if (!isStepUpFresh(auth.session)) {
      return forbidden(req, reply, "step_up_required", "Confirm your password first.");
    }
    const rotated = rotateMcpToken(getDb());
    // The plaintext token is returned exactly once and never stored.
    return reply.send({
      token: rotated.token,
      tokenId: rotated.record.id,
      scopes: rotated.record.scopes,
    });
  });

  app.delete("/api/mcp/tokens/:id", async (req, reply) => {
    const auth = requireOwner(req, reply);
    if (!auth) return;
    if (!isStepUpFresh(auth.session)) {
      return forbidden(req, reply, "step_up_required", "Confirm your password first.");
    }
    const id = (req.params as { id?: string }).id;
    if (!id) return notFound(req, reply);
    return reply.send({ revoked: revokeMcpToken(getDb(), id) });
  });

}
