/**
 * AgentRuntime adapter around the pinned `@opencode/client` (plan §1 shim).
 *
 * Everything the app needs from OpenCode is behind this interface so a future
 * API change only touches one file and AI-off mode never imports credentials
 * into the browser. No OpenCode URL or basic-auth credential is ever returned
 * by an API route.
 */
import fs from "node:fs";
import path from "node:path";
import { OpenCode } from "@opencode/client";
import type {
  AgentModelRef,
  AgentModelSummary,
  AgentStatus,
  AgentStatusName,
  PromptFile,
} from "./types.js";
import { formatModelRef, parseModelRef } from "./util.js";

export type { PromptFile };

export const OPENCODE_PINNED_VERSION = "2.2.5";
export const REMINDERS_AGENT_ID = "reminders";

export interface RuntimeMessage {
  opencodeMessageId: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
}

export interface AgentRuntime {
  readonly kind: "opencode" | "disabled";
  readonly pinnedVersion: string;
  status(opts?: { enabled?: boolean; model?: string | null }): Promise<AgentStatus>;
  listModels(): Promise<AgentModelSummary[]>;
  resolveModel(ref?: string | null): Promise<{
    ref: AgentModelRef;
    summary: AgentModelSummary;
  } | null>;
  ensureSession(input: {
    existingSessionId?: string | null;
    title?: string | null;
    model?: string | null;
  }): Promise<string>;
  setInstructions(sessionId: string, snapshot: Record<string, unknown>): Promise<void>;
  prompt(
    sessionId: string,
    text: string,
    opts?: { runId?: string; files?: PromptFile[] } | string,
  ): Promise<{ messageId: string | null }>;
  waitForIdle(sessionId: string, timeoutMs: number): Promise<void>;
  /** Session outcome after a run (`null` when the session is gone). */
  sessionOutcome(sessionId: string): Promise<"succeeded" | "failed" | "interrupted" | null>;
  interrupt(sessionId: string): Promise<void>;
  listMessages(sessionId: string, limit?: number): Promise<RuntimeMessage[]>;
  generateText(prompt: string, model?: string | null): Promise<string>;
  subscribe(
    handler: (event: unknown) => void,
    onReconnect?: () => void,
  ): () => void;
  close(): void;
}

export interface OpenCodeRuntimeOptions {
  baseUrl: string;
  password: string;
  directory: string;
  pinnedVersion?: string;
}

export interface RuntimeEnv {
  OPENCODE_URL?: string;
  OPENCODE_PASSWORD?: string;
  SECRETS_DIR?: string;
  OPENCODE_WORKSPACE?: string;
}

function readSecretFile(env: RuntimeEnv, name: string): string | null {
  try {
    const dir = env.SECRETS_DIR ?? path.join(process.cwd(), "data", "secrets");
    const file = path.join(dir, name);
    const value = fs.readFileSync(file, "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

/** Build a runtime from env. Returns null when the sidecar is not configured. */
export function createRuntimeFromEnv(env: RuntimeEnv = process.env): AgentRuntime | null {
  const baseUrl = (env.OPENCODE_URL ?? "").trim();
  if (!baseUrl) return null;
  const password =
    (env.OPENCODE_PASSWORD ?? "").trim() ||
    readSecretFile(env, "opencode_password") ||
    "";
  if (!password) return null;
  return new OpenCodeAgentRuntime({
    baseUrl,
    password,
    directory: (env.OPENCODE_WORKSPACE ?? "/workspace").trim() || "/workspace",
  });
}

export class OpenCodeAgentRuntime implements AgentRuntime {
  readonly kind = "opencode" as const;
  readonly pinnedVersion: string;
  private readonly client: ReturnType<typeof OpenCode.make>;
  private readonly directory: string;
  private readonly password: string;
  private controller: AbortController | null = null;

  constructor(options: OpenCodeRuntimeOptions) {
    this.pinnedVersion = options.pinnedVersion ?? OPENCODE_PINNED_VERSION;
    this.directory = options.directory;
    this.password = options.password;
    this.client = OpenCode.make({
      baseUrl: options.baseUrl.replace(/\/+$/, ""),
      headers: {
        authorization: `Basic ${Buffer.from(`opencode:${options.password}`).toString("base64")}`,
        "x-opencode-directory": encodeURIComponent(options.directory),
      },
    });
  }

  async ping(timeoutMs = 2500): Promise<{ version: string }> {
    return runWithTimeout(
      () => this.client.server.info(),
      timeoutMs,
      "OpenCode did not answer in time.",
    );
  }

  async listModels(): Promise<AgentModelSummary[]> {
    const result = await this.client.model.list({
      location: { directory: this.directory },
    });
    return result.data
      .filter((model) => model.type === undefined || model.type === "chat")
      .map((model) => toModelSummary(model));
  }

  async resolveModel(ref?: string | null): Promise<{
    ref: AgentModelRef;
    summary: AgentModelSummary;
  } | null> {
    const models = await this.listModels();
    const parsed = ref ? parseModelRef(ref) : null;
    if (parsed) {
      const summary = models.find(
        (model) =>
          model.providerID === parsed.providerID &&
          model.modelID === parsed.model &&
          (parsed.variant === undefined ||
            model.variants.includes(parsed.variant)),
      );
      return summary ? { ref: parsed, summary } : null;
    }
    const fallback = await this.client.model.default({
      location: { directory: this.directory },
    });
    const model = fallback.data;
    if (!model) return null;
    const summary = toModelSummary(model);
    return { ref: { providerID: model.providerID, model: model.modelID }, summary };
  }

  async status(opts: { enabled?: boolean; model?: string | null } = {}): Promise<AgentStatus> {
    const enabled = opts.enabled ?? true;
    if (!enabled) {
      return status("disabled", false, "The assistant is switched off.", opts.model);
    }
    let info: { version: string };
    try {
      info = await this.ping();
    } catch (error) {
      return {
        ...status(
          "unreachable",
          false,
          error instanceof Error && error.name === "TimeoutError"
            ? "OpenCode did not answer in time."
            : "OpenCode is not reachable.",
          opts.model,
        ),
        version: null,
      };
    }
    const versionOk = normalizeVersion(info.version) === this.pinnedVersion;
    if (!versionOk) {
      return {
        ...status(
          "contract_mismatch",
          false,
          `OpenCode ${info.version} does not match the pinned ${this.pinnedVersion}.`,
          opts.model,
        ),
        version: info.version,
        pinnedVersion: this.pinnedVersion,
      };
    }
    let selected: Awaited<ReturnType<OpenCodeAgentRuntime["resolveModel"]>> = null;
    try {
      selected = await this.resolveModel(opts.model);
    } catch {
      selected = null;
    }
    if (!selected) {
      return {
        ...status(
          "model_missing",
          false,
          "No model is connected. Choose a tool-capable model in Settings → AI.",
          opts.model,
        ),
        version: info.version,
        vision: false,
      };
    }
    if (!selected.summary.tools) {
      return {
        ...status(
          "model_not_tool_capable",
          false,
          `${selected.summary.name} does not support tools. Choose a tool-capable model.`,
          formatModelRef(selected.ref),
        ),
        version: info.version,
        vision: selected.summary.vision,
      };
    }
    return {
      ...status("ready", true, null, formatModelRef(selected.ref)),
      version: info.version,
      pinnedVersion: this.pinnedVersion,
      models: [],
      vision: selected.summary.vision,
    };
  }

  async ensureSession(input: {
    existingSessionId?: string | null;
    title?: string | null;
    model?: string | null;
  }): Promise<string> {
    if (input.existingSessionId) {
      try {
        const existing = await this.client.session.get({
          sessionID: input.existingSessionId,
        });
        if (existing?.id) return input.existingSessionId;
      } catch {
        // Fall through and create a replacement.
      }
    }
    const selected = await this.resolveModel(input.model);
    if (!selected) {
      throw new Error("No tool-capable model is connected.");
    }
    const session = await this.client.session.create({
      agent: REMINDERS_AGENT_ID,
      title: input.title?.slice(0, 100) || "Morrow assistant",
      model: {
        id: selected.ref.model,
        providerID: selected.ref.providerID,
        ...(selected.ref.variant ? { variant: selected.ref.variant } : {}),
      },
      location: { directory: this.directory },
      permissions: [
        { action: "*", resource: "*", effect: "deny" },
        { action: "morrow_reminders_*", resource: "*", effect: "allow" },
      ],
    });
    return session.id;
  }

  async setInstructions(
    sessionId: string,
    snapshot: Record<string, unknown>,
  ): Promise<void> {
    await this.client.experimental.session.instructions.entry.put({
      sessionID: sessionId,
      key: "morrow.context",
      value: snapshot as never,
    });
  }

  async prompt(
    sessionId: string,
    text: string,
    opts?: { runId?: string; files?: PromptFile[] } | string,
  ): Promise<{ messageId: string | null }> {
    const runId = typeof opts === "string" ? opts : opts?.runId;
    const files = typeof opts === "string" ? undefined : opts?.files;
    // The sidecar validates message ids (`msg_…`). Our run ids (`run_…`)
    // are a separate namespace for bus events, so only forward an id the
    // sidecar accepts; otherwise let it mint one and return that.
    const id = runId?.startsWith("msg_") ? runId : undefined;
    const result = await this.client.session.prompt({
      sessionID: sessionId,
      text,
      ...(id ? { id } : {}),
      ...(files && files.length > 0
        ? {
            files: files.map((file) => ({
              uri: file.uri,
              ...(file.name ? { name: file.name } : {}),
              ...(file.description ? { description: file.description } : {}),
            })),
          }
        : {}),
      delivery: "queue",
    });
    const messageId =
      result && typeof result === "object" && "id" in result
        ? String((result as { id: unknown }).id)
        : null;
    // Never return our `run_…` namespace as an OpenCode message id: linking it
    // makes later resyncs miss the real message and insert a duplicate row.
    return { messageId: messageId || null };
  }

  async waitForIdle(sessionId: string, timeoutMs: number): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      await this.client.experimental.session.wait(
        { sessionID: sessionId },
        { signal: controller.signal },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async sessionOutcome(
    sessionId: string,
  ): Promise<"succeeded" | "failed" | "interrupted" | null> {
    try {
      const session = await this.client.session.get({ sessionID: sessionId });
      const outcome = (session as { outcome?: unknown }).outcome;
      return outcome === "succeeded" ||
        outcome === "failed" ||
        outcome === "interrupted"
        ? outcome
        : null;
    } catch {
      return null;
    }
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.client.session.interrupt({ sessionID: sessionId });
  }

  async listMessages(sessionId: string, limit = 100): Promise<RuntimeMessage[]> {
    const result = await this.client.message.list({
      sessionID: sessionId,
      limit: Math.min(200, Math.max(1, limit)),
      // Latest page first, then restore chronological order for persistence.
      order: "desc",
    });
    const out: RuntimeMessage[] = [];
    for (const message of [...result.data].reverse()) {
      if (message.type === "user") {
        out.push({
          opencodeMessageId: message.id,
          role: "user",
          text: message.text ?? "",
          createdAt: new Date(message.time.created).toISOString(),
        });
        continue;
      }
      if (message.type !== "assistant") continue;
      const text = message.content
        .filter(
          (part): part is { type: "text"; text: string } =>
            part.type === "text" && typeof part.text === "string",
        )
        .map((part) => part.text)
        .join("\n")
        .trim();
      if (!text) continue;
      out.push({
        opencodeMessageId: message.id,
        role: "assistant",
        text,
        createdAt: new Date(message.time.created).toISOString(),
      });
    }
    return out;
  }

  async generateText(prompt: string, model?: string | null): Promise<string> {
    const parsed = model ? parseModelRef(model) : null;
    const result = await this.client.experimental.generate.text({
      prompt,
      ...(parsed
        ? {
            model: {
              id: parsed.model,
              providerID: parsed.providerID,
              ...(parsed.variant ? { variant: parsed.variant } : {}),
            },
          }
        : {}),
    });
    return typeof result.text === "string" ? result.text : "";
  }

  subscribe(
    handler: (event: unknown) => void,
    onReconnect?: () => void,
  ): () => void {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    void (async () => {
      let reconnectAttempts = 0;
      while (!controller.signal.aborted) {
        try {
          const stream = this.client.event.subscribe({
            signal: controller.signal,
          });
          for await (const event of stream) {
            if (controller.signal.aborted) break;
            reconnectAttempts = 0;
            handler(event);
          }
        } catch {
          if (controller.signal.aborted) break;
        }
        if (controller.signal.aborted) break;
        reconnectAttempts += 1;
        if (reconnectAttempts > 1) onReconnect?.();
        const delay = Math.min(15_000, 1_000 * 2 ** Math.min(4, reconnectAttempts));
        await sleep(delay);
      }
    })();
    return () => {
      controller.abort();
      if (this.controller === controller) this.controller = null;
    };
  }

  close(): void {
    this.controller?.abort();
    this.controller = null;
  }
}

function status(
  name: AgentStatusName,
  available: boolean,
  message: string | null,
  model?: string | null,
): AgentStatus {
  return {
    enabled: name !== "disabled",
    available,
    connected: available && name === "ready",
    status: name,
    model: model ?? null,
    message,
    pinnedVersion: OPENCODE_PINNED_VERSION,
    vision: false,
  };
}

/** Single mapping for `listModels` and `resolveModel` (plan step 3). */
export function toModelSummary(model: {
  providerID: string;
  modelID: string;
  name: string;
  capabilities?: { tools?: boolean; input?: string[] } | null;
  variants: Array<{ id: string }>;
  status?: string;
}): AgentModelSummary {
  const input = Array.isArray(model.capabilities?.input)
    ? model.capabilities!.input!.filter(
        (entry): entry is string => typeof entry === "string",
      )
    : [];
  return {
    id: `${model.providerID}/${model.modelID}`,
    providerID: model.providerID,
    modelID: model.modelID,
    name: model.name,
    tools: Boolean(model.capabilities?.tools),
    variants: model.variants.map((variant) => variant.id),
    status: model.status,
    input,
    vision: input.includes("image"),
  };
}

function normalizeVersion(value: string): string {
  const match = /(\d+\.\d+\.\d+)/.exec(value);
  return match?.[1] ?? value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWithTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(message);
          error.name = "TimeoutError";
          reject(error);
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
