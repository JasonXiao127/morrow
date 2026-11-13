/**
 * Provider credential routes (M4.1).
 *
 *   GET    /api/providers                      masked metadata + presets
 *   POST   /api/providers                      connect a preset/custom provider
 *   PATCH  /api/providers/:id/rotate           replace the API key
 *   DELETE /api/providers/:id                  remove config + key
 *   POST   /api/providers/:id/test             bounded reachability/key probe
 *   POST   /api/providers/:id/discover-models  best-effort GET {baseUrl}/models
 *
 * Invariants:
 * - The plaintext key is accepted once, written to a 0600 file, and never
 *   returned, logged, or audited. Responses expose last four characters only.
 * - All mutations require a fresh step-up password confirmation and an audit
 *   row with the public (secret-free) provider projection.
 * - No route calls a model. `test` and `discover-models` are the only outbound
 *   requests, both go through providers.ts's SSRF guard, and neither returns
 *   model output.
 */
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { getDb } from "@morrow/db";
import { authenticateRequest, isOwner, isStepUpFresh } from "./auth.js";
import { recordActivity, type ActivityDb } from "./activity.js";
import {
  badRequest,
  forbidden,
  notFound,
  sendProblem,
  unauthorized,
} from "./errors.js";
import {
  OAUTH_CLI_ONLY,
  ProviderError,
  createProviderCredential,
  deleteProviderCredential,
  discoverStoredProviderModels,
  getProviderRow,
  listProviderRows,
  providerStatusSummary,
  publicProvider,
  resolveProviderPaths,
  rotateProviderCredentialKey,
  syncProviderOverlay,
  testStoredProvider,
  updateProviderCredential,
  type ProviderDb,
  type ProviderServiceOptions,
  type PublicProvider,
} from "./providers.js";

const modelSchema = z.union([
  z.string().trim().min(1).max(200),
  z
    .object({
      id: z.string().trim().min(1).max(200),
      name: z.string().trim().min(1).max(200).optional(),
    })
    .strict(),
]);

const createProviderSchema = z
  .object({
    providerId: z.string().trim().min(1).max(64).optional(),
    preset: z.string().trim().min(1).max(64).optional(),
    kind: z.enum(["preset", "custom"]),
    label: z.string().trim().max(100).optional(),
    baseUrl: z.string().trim().min(1).max(2048).optional(),
    models: z
      .union([
        z.array(modelSchema).max(500),
        // OpenCode-style { modelId: { name } } map.
        z.record(z.string(), z.unknown()),
      ])
      .optional(),
    key: z.string().min(1).max(4096).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    npm: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

const rotateProviderSchema = z
  .object({
    key: z.string().min(1).max(4096),
  })
  .strict();

const updateProviderSchema = z
  .object({
    label: z.string().trim().min(1).max(100).optional(),
    baseUrl: z.string().trim().min(1).max(2048).optional(),
    models: z
      .union([
        z.array(modelSchema).max(500),
        z.record(z.string(), z.unknown()),
      ])
      .optional(),
    key: z.string().min(1).max(4096).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

/**
 * Provider credentials are workspace-global (one overlay for the sidecar), so
 * every provider route is owner-only in this phase. Members get owner_only.
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
      "Only the workspace owner can manage AI providers.",
    );
    return null;
  }
  return auth;
}

function problemTitle(status: number): string {
  switch (status) {
    case 404:
      return "Not Found";
    case 409:
      return "Conflict";
    case 503:
      return "Service Unavailable";
    default:
      return "Bad Request";
  }
}

function problemFromError(
  req: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): FastifyReply {
  if (error instanceof ProviderError) {
    return sendProblem(req, reply, error.status, problemTitle(error.status), {
      detail: error.message,
      code: error.code,
    });
  }
  throw error;
}

export interface ProviderRouteDeps {
  db?: ProviderDb;
  options?: ProviderServiceOptions;
}

export async function registerProviderRoutes(
  app: FastifyInstance,
  deps: ProviderRouteDeps = {},
): Promise<void> {
  const activeDb = (): ProviderDb =>
    deps.db ?? (getDb() as unknown as ProviderDb);
  const db = activeDb();
  const options = deps.options ?? {};
  const defaultPaths = resolveProviderPaths(options.env);
  const paths = {
    secretsDir: path.resolve(options.paths?.secretsDir ?? defaultPaths.secretsDir),
    overlayPath: path.resolve(
      options.paths?.overlayPath ?? defaultPaths.overlayPath,
    ),
  };

  // Startup reconciliation: after a restore/volume change the SQLite metadata
  // may exist while the overlay file does not. Render once so the sidecar
  // picks up the current providers without requiring a mutation. Skip when
  // there are no rows (avoids touching /data in AI-off/dev runs).
  try {
    if (listProviderRows(db).length > 0) {
      await syncProviderOverlay(db, {
        ...options.paths,
        env: options.env,
      });
    }
  } catch {
    // Best-effort: the next mutation or test retries the render.
  }

  const audit = (
    actorId: string,
    action: string,
    entityId: string,
    before: PublicProvider | null,
    after: PublicProvider | null,
    summary: string,
  ): void => {
    try {
      recordActivity(activeDb() as unknown as ActivityDb, {
        actor: "user",
        actorId,
        action,
        entityType: "provider",
        entityId,
        before,
        after,
        summary,
      });
    } catch {
      // Audit is best-effort; never fail the provider mutation it describes.
    }
  };

  // ---- GET /api/providers --------------------------------------------------
  app.get("/api/providers", async (req, reply) => {
    const auth = requireOwner(req, reply);
    if (!auth) return;
    const summary = providerStatusSummary(activeDb(), options);
    return reply.send({
      ...summary,
      overlay: {
        path: paths.overlayPath,
        // Never expose the key directory or its contents.
        present: (() => {
          try {
            return fs.existsSync(paths.overlayPath);
          } catch {
            return false;
          }
        })(),
      },
    });
  });

  // ---- POST /api/providers -------------------------------------------------
  app.post("/api/providers", async (req, reply) => {
    const auth = requireOwner(req, reply);
    if (!auth) return;
    if (!isStepUpFresh(auth.session)) {
      return forbidden(req, reply, "step_up_required", "Confirm your password first.");
    }
    const parsed = createProviderSchema.safeParse(req.body);
    if (!parsed.success) {
      return badRequest(
        req,
        reply,
        "Check the provider fields (kind, baseUrl, models, key, headers).",
        "invalid_request",
      );
    }
    try {
      const row = await createProviderCredential(activeDb(), parsed.data, options);
      const provider = publicProvider(row, paths);
      audit(
        auth.user.id,
        "provider.create",
        row.id,
        null,
        provider,
        `Connected ${row.kind} provider ${row.provider_id}`,
      );
      return reply.code(201).send({ provider });
    } catch (error) {
      return problemFromError(req, reply, error);
    }
  });

  // ---- PATCH /api/providers/:id ------------------------------------------
  app.patch("/api/providers/:id", async (req, reply) => {
    const auth = requireOwner(req, reply);
    if (!auth) return;
    if (!isStepUpFresh(auth.session)) {
      return forbidden(req, reply, "step_up_required", "Confirm your password first.");
    }
    const id = (req.params as { id?: string }).id;
    if (!id) return notFound(req, reply);
    const parsed = updateProviderSchema.safeParse(req.body);
    if (!parsed.success) {
      return badRequest(
        req,
        reply,
        "Check the provider fields (label, baseUrl, models, headers, key, enabled).",
        "invalid_request",
      );
    }
    const before = getProviderRow(activeDb(), id);
    if (!before) return notFound(req, reply);
    try {
      const row = await updateProviderCredential(
        activeDb(),
        id,
        parsed.data,
        options,
      );
      const provider = publicProvider(row, paths);
      audit(
        auth.user.id,
        "provider.update",
        row.id,
        publicProvider(before, paths),
        provider,
        `Updated provider ${row.provider_id}`,
      );
      return reply.send({ provider });
    } catch (error) {
      return problemFromError(req, reply, error);
    }
  });

  // ---- PATCH /api/providers/:id/rotate ------------------------------------
  app.patch("/api/providers/:id/rotate", async (req, reply) => {
    const auth = requireOwner(req, reply);
    if (!auth) return;
    if (!isStepUpFresh(auth.session)) {
      return forbidden(req, reply, "step_up_required", "Confirm your password first.");
    }
    const id = (req.params as { id?: string }).id;
    if (!id) return notFound(req, reply);
    const parsed = rotateProviderSchema.safeParse(req.body);
    if (!parsed.success) {
      return badRequest(req, reply, "A new API key is required.", "invalid_request");
    }
    const before = getProviderRow(activeDb(), id);
    if (!before) return notFound(req, reply);
    try {
      const row = await rotateProviderCredentialKey(activeDb(), id, parsed.data.key, options);
      const provider = publicProvider(row, paths);
      audit(
        auth.user.id,
        "provider.rotate",
        row.id,
        publicProvider(before, paths),
        provider,
        `Rotated the key for ${row.provider_id} (last4 ${row.key_last4 ?? "----"})`,
      );
      return reply.send({ provider });
    } catch (error) {
      return problemFromError(req, reply, error);
    }
  });

  // ---- DELETE /api/providers/:id -----------------------------------------
  app.delete("/api/providers/:id", async (req, reply) => {
    const auth = requireOwner(req, reply);
    if (!auth) return;
    if (!isStepUpFresh(auth.session)) {
      return forbidden(req, reply, "step_up_required", "Confirm your password first.");
    }
    const id = (req.params as { id?: string }).id;
    if (!id) return notFound(req, reply);
    const before = getProviderRow(activeDb(), id);
    if (!before) return notFound(req, reply);
    try {
      const { row, clearedModel } = await deleteProviderCredential(activeDb(), id, options);
      audit(
        auth.user.id,
        "provider.delete",
        row.id,
        publicProvider(before, paths),
        null,
        `Removed provider ${row.provider_id} and its key file`,
      );
      return reply.send({ ok: true, clearedModel });
    } catch (error) {
      return problemFromError(req, reply, error);
    }
  });

  // ---- POST /api/providers/:id/test --------------------------------------
  // Auth + fresh step-up: a probe sends the stored key to a third-party URL.
  app.post("/api/providers/:id/test", async (req, reply) => {
    const auth = requireOwner(req, reply);
    if (!auth) return;
    if (!isStepUpFresh(auth.session)) {
      return forbidden(req, reply, "step_up_required", "Confirm your password first.");
    }
    const id = (req.params as { id?: string }).id;
    if (!id) return notFound(req, reply);
    try {
      const result = await testStoredProvider(activeDb(), id, options);
      audit(
        auth.user.id,
        "provider.test",
        result.provider.id,
        null,
        result.provider,
        `Tested ${result.provider.providerId}: ${result.test.code}`,
      );
      return reply.send(result);
    } catch (error) {
      return problemFromError(req, reply, error);
    }
  });

  // ---- POST /api/providers/:id/discover-models ---------------------------
  // Same gate as test: discovery performs an authenticated outbound fetch.
  app.post("/api/providers/:id/discover-models", async (req, reply) => {
    const auth = requireOwner(req, reply);
    if (!auth) return;
    if (!isStepUpFresh(auth.session)) {
      return forbidden(req, reply, "step_up_required", "Confirm your password first.");
    }
    const id = (req.params as { id?: string }).id;
    if (!id) return notFound(req, reply);
    try {
      const result = await discoverStoredProviderModels(activeDb(), id, options);
      audit(
        auth.user.id,
        "provider.discover_models",
        result.provider.id,
        null,
        result.provider,
        `Discovered ${result.discovery.models?.length ?? 0} model(s) for ${result.provider.providerId}`,
      );
      return reply.send(result);
    } catch (error) {
      return problemFromError(req, reply, error);
    }
  });
}
