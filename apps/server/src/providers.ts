/**
 * Provider credentials (M4.1).
 *
 * Morrow owns provider *metadata* and an encrypted-at-rest-by-filesystem key
 * file; the OpenCode sidecar owns all model traffic. There is no app-direct
 * model call anywhere in this module: `testProvider` and `discoverModels` are
 * bounded admin probes, not inference.
 *
 * Layers:
 *  1. Key store — `SECRETS_DIR/providers/<provider_id>.key`, 0600, atomic
 *     write + fsync. Only SHA-256 fingerprint and last four characters live in
 *     SQLite.
 *  2. Renderer — writes an OpenCode overlay JSON (singular `provider`, the
 *     documented shape; the sidecar normalises it to v2's `providers` map).
 *     `options.apiKey` is always `{file:/abs/path}`, never a literal secret.
 *     `{env:NAME}` / `{file:PATH}` references in key/header/baseUrl input are
 *     gated before any resolution or storage: `{env:}` requires an explicit
 *     `PROVIDER_ALLOWED_ENV_VARS` allowlist entry (empty by default, so every
 *     env reference via the API is rejected — advanced indirection belongs in
 *     the OpenCode CLI, which resolves references in the operator's own
 *     environment); `{file:}` must name the provider's own
 *     `SECRETS_DIR/providers/<provider_id>.key` (lexical + realpath
 *     containment) and is never permitted inside a base URL, where resolved
 *     content would become a request target. Probes re-enforce the same gate,
 *     so legacy rows with stored references fail closed without network I/O.
 *  3. SSRF guard — HTTPS by default; loopback/link-local/private blocked unless
 *     ALLOW_PRIVATE_PROVIDER_URLS=true (Ollama/LM Studio); cloud metadata is
 *     always blocked; no redirects; 5 s timeout; DNS rechecked immediately
 *     before every probe.
 *  4. Service layer used by routesProviders.ts.
 *
 * Sidecar mount (compose.yaml is owned by the docs crew; this comment is the
 * contract): the app volume must expose this file to the sidecar's global
 * config dir, for example
 *
 *   app:
 *     volumes: ["app-data:/data"]
 *     environment: ["PROVIDER_OVERLAY_PATH=/data/opencode-providers/global.json"]
 *   opencode:
 *     volumes:
 *       # Mount the DIRECTORY, not a single file: an atomic rename inside a
 *       # named volume is visible to both containers, while a single-file bind
 *       # mount would keep pointing at the replaced inode.
 *       - "app-data:/data:ro"
 *     # The docs crew maps /data/opencode-providers/global.json into
 *     # /home/opencode/.config/opencode/opencode.json (or sets
 *     # OPENCODE_CONFIG to it in addition to the workspace config).
 *
 * The atomic rename below is deliberate: OpenCode's config watcher sees the
 * finished file and hot-reloads it, so no sidecar restart is required.
 *
 * Path note: `{file:...}` contains the app's absolute key path. The sidecar
 * must see `SECRETS_DIR/providers` at that SAME absolute path (mounting the
 * app data volume at /data in both containers does this). Otherwise the key
 * reference resolves to a missing file and OpenCode reports a provider error.
 *
 * UID note: key files are 0600 (required). The sidecar must run as the same
 * numeric UID/GID as the app, or the operator must align ownership of the
 * shared `providers` directory. Never widen the key mode to 0644.
 */
import { createHash, randomBytes } from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { nowIso } from "@morrow/shared";

// ---------------------------------------------------------------------------
// Constants and shared types
// ---------------------------------------------------------------------------

export const PROVIDER_OVERLAY_SCHEMA = "https://opencode.ai/config.json";
export const CUSTOM_OPENAI_COMPATIBLE_NPM = "@ai-sdk/openai-compatible";
export const PROVIDER_KEY_FILE_MODE = 0o600;
export const PROVIDER_TEST_TIMEOUT_MS = 5_000;
export const PROVIDER_MAX_RESPONSE_BYTES = 1_000_000;
export const PROVIDER_MAX_MODELS = 500;
export const PROVIDER_MAX_HEADERS = 20;

export type ProviderKind = "preset" | "custom";

export interface ProviderPreset {
  id: string;
  label: string;
  baseUrl: string | null;
  npm: string | null;
  requiresKey: boolean;
  /** Local providers are HTTP + private by nature and need the safety flag. */
  local: boolean;
  note?: string;
}

/**
 * The nine supported presets. `custom` is the openai-compatible escape hatch.
 * Built-in canonical providers keep `npm: null` so the sidecar's own metadata
 * (package, model catalog) stays authoritative; only local/custom providers
 * declare the openai-compatible package explicitly.
 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    npm: null,
    requiresKey: true,
    local: false,
    note: "API key only. ChatGPT Plus/Pro OAuth stays in the OpenCode CLI.",
  },
  {
    id: "opencode",
    label: "OpenCode",
    baseUrl: "https://opencode.ai/inference/openai/v1",
    npm: null,
    requiresKey: true,
    local: false,
  },
  {
    id: "opencode-go",
    label: "OpenCode Go",
    baseUrl: "https://opencode.ai/inference/go/openai/v1",
    npm: null,
    requiresKey: true,
    local: false,
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    npm: null,
    requiresKey: true,
    local: false,
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    npm: null,
    requiresKey: true,
    local: false,
  },
  {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    npm: null,
    requiresKey: true,
    local: false,
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    baseUrl: "http://127.0.0.1:11434/v1",
    npm: CUSTOM_OPENAI_COMPATIBLE_NPM,
    requiresKey: false,
    local: true,
    note: "Requires ALLOW_PRIVATE_PROVIDER_URLS=true. Use host.docker.internal from inside Docker.",
  },
  {
    id: "lmstudio",
    label: "LM Studio (local)",
    baseUrl: "http://127.0.0.1:1234/v1",
    npm: CUSTOM_OPENAI_COMPATIBLE_NPM,
    requiresKey: false,
    local: true,
    note: "Requires ALLOW_PRIVATE_PROVIDER_URLS=true. Use host.docker.internal from inside Docker.",
  },
  {
    id: "custom",
    label: "Custom OpenAI-compatible",
    baseUrl: null,
    npm: CUSTOM_OPENAI_COMPATIBLE_NPM,
    requiresKey: false,
    local: false,
    note: "Any openai-compatible /v1 endpoint. Non-public hosts need ALLOW_PRIVATE_PROVIDER_URLS=true.",
  },
] as const;

export function getProviderPreset(id: string): ProviderPreset | null {
  return PROVIDER_PRESETS.find((preset) => preset.id === id) ?? null;
}

export class ProviderError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.status = status;
  }
}

export interface ProviderDbStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  };
  [key: string]: unknown;
}

export interface ProviderDb {
  prepare(sql: string): ProviderDbStatement;
  transaction?<T>(fn: () => T): () => T;
}

export interface ProviderCredentialRow {
  id: string;
  provider_id: string;
  label: string;
  kind: ProviderKind;
  base_url: string | null;
  models_json: string;
  npm_pkg: string | null;
  headers_json: string;
  key_last4: string | null;
  key_fingerprint: string | null;
  enabled: number;
  last_test_at: string | null;
  last_test_ok: number | null;
  last_error: string | null;
  rev: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface ProviderModel {
  id: string;
  name?: string;
}

export interface ProviderPaths {
  secretsDir: string;
  overlayPath: string;
}

export function resolveProviderPaths(
  env: NodeJS.ProcessEnv = process.env,
): ProviderPaths {
  const secretsDir = path.resolve(
    env["SECRETS_DIR"] ?? path.join(process.cwd(), "data", "secrets"),
  );
  const overlayPath = path.resolve(
    env["PROVIDER_OVERLAY_PATH"] ??
      env["PROVIDER_OVERLAY_FILE"] ??
      "/data/opencode-providers/global.json",
  );
  return { secretsDir, overlayPath };
}

/** Directory whose entire contents are excluded from backups. */
export function providerKeyDir(paths: Partial<ProviderPaths> = {}): string {
  const resolved = resolveProviderPaths();
  return path.join(
    path.resolve(paths.secretsDir ?? resolved.secretsDir),
    "providers",
  );
}

export function providersEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env["PROVIDERS_ENABLED"] ?? "true").trim().toLowerCase() !== "false";
}

export function assertProvidersWritable(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!providersEnabled(env)) {
    throw new ProviderError(
      "providers_disabled",
      "Provider changes are disabled by the PROVIDERS_ENABLED=false kill switch.",
      503,
    );
  }
}

export function allowPrivateProviderUrls(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    (env["ALLOW_PRIVATE_PROVIDER_URLS"] ?? "false").trim().toLowerCase() ===
    "true"
  );
}

// ---------------------------------------------------------------------------
// Provider id / model / header validation
// ---------------------------------------------------------------------------

const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+~-]{0,199}$/;
const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,64}$/;
const BLOCKED_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "upgrade",
  "keep-alive",
  "proxy-authorization",
]);

export function assertProviderId(providerId: string): string {
  const id = providerId.trim().toLowerCase();
  if (!PROVIDER_ID_RE.test(id)) {
    throw new ProviderError(
      "invalid_provider_id",
      "Provider id must be 1–64 lowercase letters, digits, dots, dashes or underscores.",
    );
  }
  return id;
}

export function normalizeProviderModels(
  input: unknown,
): ProviderModel[] {
  if (input === undefined || input === null) return [];
  let entries: unknown[];
  if (Array.isArray(input)) {
    entries = input;
  } else if (typeof input === "object") {
    // OpenCode's own config uses a `{ modelId: { name } }` map. Accept it as
    // an alternative to the array the UI sends.
    entries = Object.entries(input as Record<string, unknown>).map(
      ([id, value]) => ({
        id,
        ...(value && typeof value === "object"
          ? { name: (value as Record<string, unknown>)["name"] }
          : {}),
      }),
    );
  } else {
    throw new ProviderError("invalid_models", "models must be an array or object.");
  }
  if (entries.length > PROVIDER_MAX_MODELS) {
    throw new ProviderError(
      "invalid_models",
      `At most ${PROVIDER_MAX_MODELS} models can be listed.`,
    );
  }
  const byId = new Map<string, ProviderModel>();
  for (const entry of entries) {
    let id: string | undefined;
    let name: string | undefined;
    if (typeof entry === "string") {
      id = entry;
    } else if (entry && typeof entry === "object") {
      const record = entry as Record<string, unknown>;
      if (typeof record["id"] === "string") id = record["id"];
      if (typeof record["name"] === "string") name = record["name"];
    }
    if (!id || !MODEL_ID_RE.test(id.trim())) {
      throw new ProviderError(
        "invalid_models",
        "Each model needs an id (letters, digits, ._:/@+~-).",
      );
    }
    const clean: ProviderModel = { id: id.trim() };
    if (name && name.trim() !== "" && name.trim() !== clean.id) {
      clean.name = name.trim().slice(0, 200);
    }
    byId.set(clean.id, clean);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function parseModelsJson(value: string | null | undefined): ProviderModel[] {
  if (!value) return [];
  try {
    return normalizeProviderModels(JSON.parse(value));
  } catch {
    return [];
  }
}

export function modelsJson(models: ProviderModel[]): string {
  return JSON.stringify(normalizeProviderModels(models));
}

export function normalizeProviderHeaders(
  input: unknown,
): Record<string, string> {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new ProviderError("invalid_headers", "headers must be an object.");
  }
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > PROVIDER_MAX_HEADERS) {
    throw new ProviderError(
      "invalid_headers",
      `At most ${PROVIDER_MAX_HEADERS} headers are allowed.`,
    );
  }
  const out: Record<string, string> = {};
  for (const [rawName, rawValue] of entries) {
    const name = rawName.trim();
    if (!HEADER_NAME_RE.test(name)) {
      throw new ProviderError(
        "invalid_headers",
        "Header names must be 1–64 letters, digits or dashes.",
      );
    }
    if (BLOCKED_HEADERS.has(name.toLowerCase())) {
      throw new ProviderError(
        "invalid_headers",
        `Header "${name}" cannot be set by a provider.`,
      );
    }
    if (typeof rawValue !== "string" || rawValue.length > 2000) {
      throw new ProviderError(
        "invalid_headers",
        `Header "${name}" must be a string of at most 2000 characters.`,
      );
    }
    if (/[\r\n]/.test(rawValue)) {
      throw new ProviderError(
        "invalid_headers",
        `Header "${name}" cannot contain line breaks.`,
      );
    }
    out[name] = rawValue;
  }
  return out;
}

export function parseHeadersJson(value: string | null | undefined): Record<string, string> {
  if (!value) return {};
  try {
    return normalizeProviderHeaders(JSON.parse(value));
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// {env:} / {file:} substitution — used by bounded probes only
//
// SECURITY: references are resolved server-side and the result is sent to a
// third-party provider URL. An allowlisted value must never let one tenant's
// request exfiltrate another secret:
//
// - `{env:NAME}` is rejected via the API unless NAME appears in the explicit
//   allowlist `PROVIDER_ALLOWED_ENV_VARS` (comma-separated, empty by default
//   → every env reference is rejected). Advanced operators who need sidecar
//   indirection should prefer the OpenCode CLI, which resolves references in
//   the operator's own environment instead of the server's.
// - `{file:PATH}` must name the calling provider's own key file,
//   `SECRETS_DIR/providers/<provider_id>.key`, verified by lexical AND
//   realpath containment (symlink escapes rejected) plus an exact basename
//   match. Absolute paths outside the key directory, traversal (`..`),
//   and other filenames (e.g. /etc/passwd) are rejected.
//
// Key input is a literal secret: whole-value references are resolved once at
// write time through the same gate, so `{env:OPENCODE_PASSWORD}` or
// `{file:/etc/passwd}` as a key can never reach a probe. Header values are
// gated identically. The only `{file:...}` the server emits on its own is
// the overlay's `apiKey` pointer, constructed internally (never from user
// input) by buildProviderOverlay.
// ---------------------------------------------------------------------------

const REFERENCE_RE = /\{(env|file):([^}]+)\}/g;
const WHOLE_REFERENCE_RE = /^\{(env|file):[^}]+\}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Explicit allowlist for `{env:NAME}` references (CSV in
 * `PROVIDER_ALLOWED_ENV_VARS`). Empty by default: no env reference is
 * resolvable via the API.
 */
export function providerAllowedEnvRefs(
  env: NodeJS.ProcessEnv = process.env,
): Set<string> {
  const raw = env["PROVIDER_ALLOWED_ENV_VARS"] ?? "";
  return new Set(
    raw
      .split(",")
      .map((name) => name.trim())
      .filter((name) => ENV_NAME_RE.test(name)),
  );
}

export interface ProviderReferenceOptions {
  env?: NodeJS.ProcessEnv;
  readFile?: (filePath: string) => string;
  maxDepth?: number;
  /** Provider on whose behalf the reference is resolved (file scoping). */
  providerId?: string;
  secretsDir?: string;
  /**
   * Explicit env allowlist. Defaults to PROVIDER_ALLOWED_ENV_VARS (empty).
   * Pass a populated set only for trusted CLI-side resolution.
   */
  allowedEnv?: ReadonlySet<string>;
  /**
   * Whether `{file:...}` references are structurally permitted at all.
   * Base URLs are never file content: pass `false` so any `{file:...}` in a
   * URL is rejected instead of being resolved into a request target.
   */
  allowFile?: boolean;
}

/**
 * The only readable `{file:...}` target: the provider's own
 * `SECRETS_DIR/providers/<provider_id>.key`. Returns the resolved absolute
 * path or throws ProviderError. Both lexical and realpath containment are
 * checked so `..` traversal and symlink escapes are rejected.
 */
export function assertProviderFileReferenceAllowed(
  filePath: string,
  options: { providerId?: string; secretsDir?: string } = {},
): string {
  if (!path.isAbsolute(filePath)) {
    throw new ProviderError(
      "invalid_file_reference",
      "Provider {file:...} references must be absolute paths.",
    );
  }
  const secretsDir = path.resolve(
    options.secretsDir ?? resolveProviderPaths().secretsDir,
  );
  const keyDir = path.join(secretsDir, "providers");
  const resolved = path.resolve(filePath);
  if (resolved !== keyDir && !resolved.startsWith(keyDir + path.sep)) {
    throw new ProviderError(
      "invalid_file_reference",
      "Provider {file:...} references must point inside SECRETS_DIR/providers/.",
    );
  }
  try {
    const realTarget = fs.realpathSync(resolved);
    const realKeyDir = fs.realpathSync(keyDir);
    if (
      realTarget !== realKeyDir &&
      !realTarget.startsWith(realKeyDir + path.sep)
    ) {
      throw new ProviderError(
        "invalid_file_reference",
        "Provider {file:...} references must point inside SECRETS_DIR/providers/.",
      );
    }
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    // Missing file: fall through to the basename check so the error still
    // names the policy (the caller maps unreadable files to
    // missing_file_reference).
  }
  const base = path.basename(resolved);
  if (!base.endsWith(".key")) {
    throw new ProviderError(
      "invalid_file_reference",
      "Provider {file:...} references must name a SECRETS_DIR/providers/<provider_id>.key file.",
    );
  }
  let idPart: string;
  try {
    idPart = assertProviderId(base.slice(0, -".key".length));
  } catch {
    throw new ProviderError(
      "invalid_file_reference",
      "Provider {file:...} references must name a SECRETS_DIR/providers/<provider_id>.key file.",
    );
  }
  if (options.providerId !== undefined) {
    const expected = assertProviderId(options.providerId);
    if (idPart !== expected) {
      throw new ProviderError(
        "invalid_file_reference",
        `Provider {file:...} must reference SECRETS_DIR/providers/${expected}.key only.`,
      );
    }
  }
  return resolved;
}

/**
 * Structural reference gate (no file reads): throws unless every
 * `{env:NAME}` in `value` is allowlisted and every `{file:PATH}` names the
 * provider's own key file. Use at write time for key/header/baseUrl input;
 * resolution ({@link substituteProviderReferences}) re-enforces at probe time
 * so legacy rows with stored references fail closed instead of exfiltrating.
 */
export function assertProviderReferencesAllowed(
  value: string,
  options: {
    providerId?: string;
    secretsDir?: string;
    env?: NodeJS.ProcessEnv;
    allowedEnv?: ReadonlySet<string>;
    allowFile?: boolean;
  } = {},
): void {
  const env = options.env ?? process.env;
  const allowedEnv = options.allowedEnv ?? providerAllowedEnvRefs(env);
  const secretsDir = options.secretsDir ?? resolveProviderPaths(env).secretsDir;
  const allowFile = options.allowFile ?? true;
  REFERENCE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  try {
    while ((match = REFERENCE_RE.exec(value)) !== null) {
      const kind = match[1];
      const key = (match[2] ?? "").trim();
      if (kind === "env") {
        if (!ENV_NAME_RE.test(key) || !allowedEnv.has(key)) {
          throw new ProviderError(
            "env_reference_not_allowed",
            `Environment reference {env:${key}} is not allowed via the API. ` +
              `Set PROVIDER_ALLOWED_ENV_VARS to allowlist it, or use a literal value.`,
          );
        }
      } else {
        if (!allowFile) {
          throw new ProviderError(
            "invalid_file_reference",
            "Provider {file:...} references are not allowed in base URLs.",
          );
        }
        assertProviderFileReferenceAllowed(key, {
          providerId: options.providerId,
          secretsDir,
        });
      }
    }
  } finally {
    REFERENCE_RE.lastIndex = 0;
  }
}

/**
 * API key input must be a literal secret. Whole-value references are rejected
 * here (unknown env names, or file paths outside the provider's own key
 * file) so a `{env:SECRET}` / `{file:/etc/passwd}` key can never be stored
 * and later probed out to an attacker URL. Resolution of a self-referencing
 * key file goes through the same allowlisted substitution below.
 */
export function resolveProviderKeyInput(
  raw: string,
  env: NodeJS.ProcessEnv = process.env,
  options: {
    providerId?: string;
    secretsDir?: string;
    allowedEnv?: ReadonlySet<string>;
    allowFile?: boolean;
  } = {},
): string {
  const trimmed = raw.trim();
  if (WHOLE_REFERENCE_RE.test(trimmed)) {
    return substituteProviderReferences(trimmed, {
      env,
      providerId: options.providerId,
      secretsDir: options.secretsDir,
      allowedEnv: options.allowedEnv,
      allowFile: options.allowFile,
    }).trim();
  }
  return trimmed;
}

/**
 * Resolve OpenCode-style references for a bounded admin probe. The overlay
 * itself keeps the reference text; secrets never get written into the JSON.
 *
 * Every reference is gated: `{env:NAME}` requires NAME in the explicit
 * allowlist (none by default), `{file:PATH}` must be the provider's own key
 * file. Violations throw ProviderError and the probe records the failure
 * without performing any network I/O.
 */
export function substituteProviderReferences(
  value: string,
  options: ProviderReferenceOptions = {},
): string {
  const env = options.env ?? process.env;
  const readFile =
    options.readFile ?? ((filePath: string) => fs.readFileSync(filePath, "utf8"));
  const allowedEnv = options.allowedEnv ?? providerAllowedEnvRefs(env);
  const secretsDir = options.secretsDir ?? resolveProviderPaths(env).secretsDir;
  const allowFile = options.allowFile ?? true;
  let current = value;
  for (let depth = 0; depth < (options.maxDepth ?? 3); depth += 1) {
    REFERENCE_RE.lastIndex = 0;
    if (!REFERENCE_RE.test(current)) break;
    REFERENCE_RE.lastIndex = 0;
    current = current.replace(REFERENCE_RE, (_match, kind: string, inner: string) => {
      const key = inner.trim();
      if (kind === "env") {
        if (!ENV_NAME_RE.test(key) || !allowedEnv.has(key)) {
          throw new ProviderError(
            "env_reference_not_allowed",
            `Environment reference {env:${key}} is not allowed via the API. ` +
              `Set PROVIDER_ALLOWED_ENV_VARS to allowlist it, or use a literal value.`,
          );
        }
        const resolved = env[key];
        if (resolved === undefined || resolved === "") {
          throw new ProviderError(
            "missing_env_reference",
            `Environment variable ${key} is not set.`,
          );
        }
        return resolved;
      }
      if (!allowFile) {
        throw new ProviderError(
          "invalid_file_reference",
          "Provider {file:...} references are not allowed in base URLs.",
        );
      }
      const allowed = assertProviderFileReferenceAllowed(key, {
        providerId: options.providerId,
        secretsDir,
      });
      try {
        return readFile(allowed).trim();
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError(
          "missing_file_reference",
          `Provider file reference is not readable: ${path.basename(allowed)}.`,
        );
      }
    });
  }
  return current;
}

// ---------------------------------------------------------------------------
// SSRF guard
// ---------------------------------------------------------------------------

export type HostClass =
  | "public"
  | "private"
  | "loopback"
  | "link_local"
  | "metadata"
  | "reserved";

export interface ProviderUrlPolicy {
  allowPrivate?: boolean;
  /** Creation-time validation: skip DNS (the sidecar may resolve later). */
  skipDns?: boolean;
  resolveHost?: (host: string) => Promise<string[]>;
  env?: NodeJS.ProcessEnv;
}

function ipv4Class(ip: string): HostClass {
  const parts = ip.split(".").map((part) => Number.parseInt(part, 10));
  const [a = 0, b = 0] = parts;
  if (ip === "169.254.169.254" || ip === "100.100.100.200") return "metadata";
  if (a === 127) return "loopback";
  if (a === 0 || a === 10) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 169 && b === 254) return "link_local";
  if (a === 100 && b >= 64 && b <= 127) return "private"; // CGNAT
  if (a >= 224) return "reserved";
  return "public";
}

function embeddedIpv4FromIpv6(ip: string): string | null {
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (dotted) return dotted[1]!;
  // URL parsers normalize `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`.
  const mapped =
    /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip) ??
    /^::ffff:0:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip) ??
    /^::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
  if (!mapped) return null;
  const hi = Number.parseInt(mapped[1]!, 16);
  const lo = Number.parseInt(mapped[2]!, 16);
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

function ipv6Class(raw: string): HostClass {
  const ip = raw.split("%")[0]!.toLowerCase();
  if (ip === "::1") return "loopback";
  if (ip === "::") return "private";
  if (ip === "fd00:ec2::254") return "metadata";
  const embedded = embeddedIpv4FromIpv6(ip);
  if (embedded) return ipv4Class(embedded);
  if (ip.startsWith("fc") || ip.startsWith("fd")) return "private";
  if (/^fe[89ab]/.test(ip)) return "link_local";
  if (ip.startsWith("ff")) return "reserved";
  return "public";
}

export function classifyHost(hostname: string): HostClass {
  let host = hostname.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (net.isIPv4(host)) return ipv4Class(host);
  if (net.isIPv6(host)) return ipv6Class(host);
  if (host === "metadata.google.internal" || host === "metadata") {
    return "metadata";
  }
  if (host === "localhost" || host.endsWith(".localhost")) return "loopback";
  if (host.endsWith(".local") || host.endsWith(".internal")) return "private";
  // Docker Compose service names (`ollama`, `lmstudio`, `app`) are single
  // labels. Treat them as private so the safety flag is required, while a
  // public FQDN still has a dot.
  if (!host.includes(".") && !host.includes(":")) return "private";
  return "public";
}

function isPrivateClass(cls: HostClass): boolean {
  return cls === "private" || cls === "loopback" || cls === "link_local";
}

/**
 * Synchronous URL gate used when a credential is created/rotated. Public hosts
 * still get a DNS recheck in `assertProviderUrlAllowed` before any probe.
 */
export function validateProviderBaseUrl(
  raw: string,
  options: ProviderUrlPolicy = {},
): URL {
  const env = options.env ?? process.env;
  const allowPrivate = options.allowPrivate ?? allowPrivateProviderUrls(env);
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ProviderError("invalid_base_url", "baseUrl must be an absolute URL.");
  }
  if (url.username || url.password) {
    throw new ProviderError(
      "invalid_base_url",
      "baseUrl must not contain credentials; use the key field.",
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ProviderError(
      "invalid_base_url",
      "baseUrl must use https:// (http:// is allowed only for local providers).",
    );
  }
  const cls = classifyHost(url.hostname);
  if (cls === "metadata") {
    throw new ProviderError(
      "blocked_metadata_url",
      "Cloud metadata endpoints are never allowed as provider base URLs.",
    );
  }
  if (url.protocol === "http:" && (!allowPrivate || !isPrivateClass(cls))) {
    throw new ProviderError(
      "https_required",
      "Provider base URLs must use https://. Set ALLOW_PRIVATE_PROVIDER_URLS=true only for Ollama/LM Studio on a trusted network.",
    );
  }
  if (cls === "reserved") {
    throw new ProviderError(
      "blocked_url",
      "Reserved/multicast addresses are not allowed as provider base URLs.",
    );
  }
  if (!allowPrivate && isPrivateClass(cls)) {
    throw new ProviderError(
      "private_address",
      "Private, loopback and link-local provider URLs are blocked. Set ALLOW_PRIVATE_PROVIDER_URLS=true for Ollama/LM Studio.",
    );
  }
  return url;
}

/**
 * Async gate for actual probes. DNS is resolved immediately before the fetch
 * and every answer is classified; redirects are disabled by the caller, so a
 * rebinding host cannot bounce the request to an internal address. (A custom
 * dispatcher that pins the resolved address would close the remaining DNS
 * race; that is intentionally left for a future hardening pass.)
 */
export async function assertProviderUrlAllowed(
  raw: string,
  options: ProviderUrlPolicy = {},
): Promise<URL> {
  const env = options.env ?? process.env;
  const allowPrivate = options.allowPrivate ?? allowPrivateProviderUrls(env);
  const url = validateProviderBaseUrl(raw, { ...options, allowPrivate, env });
  if (options.skipDns) return url;

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  if (net.isIP(hostname)) {
    addresses = [hostname];
  } else {
    const resolver =
      options.resolveHost ??
      (async (host: string) =>
        (await dns.lookup(host, { all: true, verbatim: true })).map(
          (entry) => entry.address,
        ));
    try {
      addresses = await resolver(hostname);
    } catch {
      throw new ProviderError(
        "dns_failed",
        `Provider host ${hostname} could not be resolved.`,
      );
    }
  }
  if (addresses.length === 0) {
    throw new ProviderError(
      "dns_failed",
      `Provider host ${hostname} did not resolve to an address.`,
    );
  }
  for (const address of addresses) {
    const cls = classifyHost(address);
    if (cls === "metadata") {
      throw new ProviderError(
        "blocked_metadata_url",
        "Cloud metadata endpoints are never allowed as provider base URLs.",
      );
    }
    if (!allowPrivate && isPrivateClass(cls)) {
      throw new ProviderError(
        "private_address",
        `Provider host ${hostname} resolves to a private address and is blocked.`,
      );
    }
    if (cls === "reserved") {
      throw new ProviderError(
        "blocked_url",
        "Reserved/multicast provider addresses are not allowed.",
      );
    }
  }
  return url;
}

// ---------------------------------------------------------------------------
// Key store
// ---------------------------------------------------------------------------

export interface StoredProviderKey {
  keyPath: string;
  fingerprint: string;
  last4: string;
}

export function providerKeyPath(
  providerId: string,
  paths: Partial<ProviderPaths> = {},
): string {
  const id = assertProviderId(providerId);
  return path.join(providerKeyDir(paths), `${id}.key`);
}

export function fingerprintProviderKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

export function providerKeyLast4(key: string): string {
  return key.length <= 4 ? key : key.slice(-4);
}

function fsyncDirectory(dir: string): void {
  try {
    const fd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Directory fsync is best-effort (some filesystems refuse it).
  }
}

/**
 * Atomic, fsynced 0600 write: temp file in the same directory → fsync → rename
 * → directory fsync. A crash never leaves a partially-written key at the
 * canonical path.
 */
export function atomicWriteSecretFile(
  filePath: string,
  contents: string,
  mode = PROVIDER_KEY_FILE_MODE,
): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    // Tighten a pre-existing providers directory as well; mkdir mode only
    // applies when the directory is created.
    fs.chmodSync(dir, 0o700);
  } catch {
    // Best-effort; the key file itself is still written 0600.
  }
  const temp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  let fd: number | null = null;
  try {
    fd = fs.openSync(temp, "wx", mode);
    fs.writeFileSync(fd, contents, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temp, filePath);
    fs.chmodSync(filePath, mode);
    fsyncDirectory(dir);
  } catch (error) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
    try {
      fs.unlinkSync(temp);
    } catch {
      // temp may already be renamed
    }
    throw error;
  }
}

export function writeProviderKey(
  providerId: string,
  rawKey: string,
  paths: Partial<ProviderPaths> = {},
): StoredProviderKey {
  const key = rawKey.trim();
  if (key.length < 1 || key.length > 4096) {
    throw new ProviderError(
      "invalid_key",
      "API key must be between 1 and 4096 characters.",
    );
  }
  if (/[\u0000-\u001f\u007f]/.test(key)) {
    throw new ProviderError(
      "invalid_key",
      "API key cannot contain control characters or line breaks.",
    );
  }
  const keyPath = providerKeyPath(providerId, paths);
  atomicWriteSecretFile(keyPath, key, PROVIDER_KEY_FILE_MODE);
  return {
    keyPath,
    fingerprint: fingerprintProviderKey(key),
    last4: providerKeyLast4(key),
  };
}

export function deleteProviderKey(
  providerId: string,
  paths: Partial<ProviderPaths> = {},
): boolean {
  const keyPath = providerKeyPath(providerId, paths);
  try {
    fs.unlinkSync(keyPath);
    fsyncDirectory(path.dirname(keyPath));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export interface ProviderKeyState {
  state: "none" | "ok" | "missing" | "tampered";
  keyPresent: boolean;
  keyPath: string | null;
  modeWide: boolean;
}

/**
 * Compare the on-disk key with the SQLite fingerprint. A deleted/tampered key
 * marks the provider degraded; it never crashes the list or render path.
 */
export function inspectProviderKey(
  row: Pick<ProviderCredentialRow, "provider_id" | "key_fingerprint" | "key_last4">,
  paths: Partial<ProviderPaths> = {},
): ProviderKeyState {
  if (!row.key_fingerprint && !row.key_last4) {
    return { state: "none", keyPresent: false, keyPath: null, modeWide: false };
  }
  const keyPath = providerKeyPath(row.provider_id, paths);
  try {
    const stat = fs.statSync(keyPath);
    const key = fs.readFileSync(keyPath, "utf8").trim();
    // eslint-disable-next-line no-bitwise
    const modeWide = (stat.mode & 0o077) !== 0;
    if (!row.key_fingerprint) {
      return {
        state: key ? "ok" : "missing",
        keyPresent: key.length > 0,
        keyPath,
        modeWide,
      };
    }
    if (fingerprintProviderKey(key) !== row.key_fingerprint) {
      return { state: "tampered", keyPresent: true, keyPath, modeWide };
    }
    return { state: "ok", keyPresent: true, keyPath, modeWide };
  } catch {
    return { state: "missing", keyPresent: false, keyPath, modeWide: false };
  }
}

export function readProviderKey(
  row: Pick<ProviderCredentialRow, "provider_id" | "key_fingerprint" | "key_last4">,
  paths: Partial<ProviderPaths> = {},
): { key: string; keyPath: string } | null {
  const inspected = inspectProviderKey(row, paths);
  if (inspected.state !== "ok" || !inspected.keyPath) return null;
  try {
    const key = fs.readFileSync(inspected.keyPath, "utf8").trim();
    return key ? { key, keyPath: inspected.keyPath } : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Renderer: singular `provider` (documented OpenCode shape)
// ---------------------------------------------------------------------------

export interface OverlayProvider {
  name?: string;
  npm?: string;
  options?: {
    baseURL?: string;
    apiKey?: string;
    headers?: Record<string, string>;
  };
  models?: Record<string, { name?: string }>;
}

export interface ProviderOverlayDocument {
  $schema: string;
  provider: Record<string, OverlayProvider>;
}

export interface ProviderOverlayResult {
  document: ProviderOverlayDocument;
  path: string;
  degraded: Array<{ providerId: string; state: ProviderKeyState["state"] }>;
}

/**
 * Pure overlay builder. Every row must already be filtered to live+enabled.
 * Missing/tampered keys are omitted and reported as degraded rather than
 * producing a `{file:...}` reference to a file the sidecar cannot read.
 */
export function buildProviderOverlay(
  rows: ProviderCredentialRow[],
  paths: Partial<ProviderPaths> = {},
): ProviderOverlayResult {
  const defaults = resolveProviderPaths();
  const resolved: ProviderPaths = {
    secretsDir: path.resolve(paths.secretsDir ?? defaults.secretsDir),
    overlayPath: path.resolve(paths.overlayPath ?? defaults.overlayPath),
  };
  const provider: Record<string, OverlayProvider> = {};
  const degraded: ProviderOverlayResult["degraded"] = [];
  for (const row of [...rows].sort((a, b) =>
    a.provider_id.localeCompare(b.provider_id),
  )) {
    const keyState = inspectProviderKey(row, resolved);
    if (keyState.state === "missing" || keyState.state === "tampered") {
      degraded.push({ providerId: row.provider_id, state: keyState.state });
      continue;
    }
    const options: NonNullable<OverlayProvider["options"]> = {};
    if (row.base_url) options.baseURL = row.base_url;
    if (keyState.state === "ok" && keyState.keyPath) {
      options.apiKey = `{file:${keyState.keyPath}}`;
    }
    const headers = parseHeadersJson(row.headers_json);
    if (Object.keys(headers).length > 0) options.headers = headers;
    const models = parseModelsJson(row.models_json);
    const entry: OverlayProvider = { name: row.label };
    if (row.npm_pkg) entry.npm = row.npm_pkg;
    if (Object.keys(options).length > 0) entry.options = options;
    if (models.length > 0) {
      entry.models = Object.fromEntries(
        models.map((model) => [
          model.id,
          model.name ? { name: model.name } : {},
        ]),
      );
    }
    provider[row.provider_id] = entry;
  }
  return {
    document: { $schema: PROVIDER_OVERLAY_SCHEMA, provider },
    path: resolved.overlayPath,
    degraded,
  };
}

/**
 * v2's internal shape (`providers` plural, `package`, `settings`). The sidecar
 * performs this normalisation on load; exporting it keeps our contract
 * testable and documents the mapping without writing an ambiguous dual shape.
 */
export function normalizeProviderOverlayToV2(
  document: ProviderOverlayDocument,
): {
  $schema: string;
  providers: Record<
    string,
    {
      name?: string;
      package?: string;
      settings?: Record<string, string>;
      headers?: Record<string, string>;
      models?: Record<string, { name?: string }>;
    }
  >;
} {
  const providers: Record<
    string,
    {
      name?: string;
      package?: string;
      settings?: Record<string, string>;
      headers?: Record<string, string>;
      models?: Record<string, { name?: string }>;
    }
  > = {};
  for (const [id, entry] of Object.entries(document.provider)) {
    const settings: Record<string, string> = {};
    if (entry.options?.baseURL) settings["baseURL"] = entry.options.baseURL;
    if (entry.options?.apiKey) settings["apiKey"] = entry.options.apiKey;
    const headers = entry.options?.headers;
    const normalized: (typeof providers)[string] = {};
    if (entry.name) normalized.name = entry.name;
    if (entry.npm) normalized.package = entry.npm;
    if (Object.keys(settings).length > 0) normalized.settings = settings;
    if (headers && Object.keys(headers).length > 0) normalized.headers = headers;
    if (entry.models) normalized.models = entry.models;
    providers[id] = normalized;
  }
  return { $schema: PROVIDER_OVERLAY_SCHEMA, providers };
}

/** Atomic write; mode 0644 because the file contains references, not secrets. */
export function writeProviderOverlayFile(
  document: ProviderOverlayDocument,
  overlayPath: string,
): void {
  const dir = path.dirname(overlayPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  const temp = path.join(
    dir,
    `.${path.basename(overlayPath)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  const contents = `${JSON.stringify(document, null, 2)}\n`;
  let fd: number | null = null;
  try {
    fd = fs.openSync(temp, "wx", 0o644);
    fs.writeFileSync(fd, contents, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temp, overlayPath);
    fs.chmodSync(overlayPath, 0o644);
    fsyncDirectory(dir);
  } catch (error) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
    try {
      fs.unlinkSync(temp);
    } catch {
      // ignore
    }
    throw error;
  }
}

let overlayQueue: Promise<unknown> = Promise.resolve();

/** Serialise renders so two requests cannot interleave a stale snapshot. */
export function syncProviderOverlay(
  db: ProviderDb,
  options: Partial<ProviderPaths> & { env?: NodeJS.ProcessEnv } = {},
): Promise<ProviderOverlayResult> {
  const run = async (): Promise<ProviderOverlayResult> => {
    const rows = listProviderRows(db, { enabledOnly: true });
    const result = buildProviderOverlay(rows, options);
    writeProviderOverlayFile(result.document, result.path);
    return result;
  };
  const next = overlayQueue.then(run, run);
  overlayQueue = next.catch(() => undefined);
  return next;
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function asRow(value: unknown): ProviderCredentialRow | null {
  return value ? (value as ProviderCredentialRow) : null;
}

export function listProviderRows(
  db: ProviderDb,
  options: { includeDeleted?: boolean; enabledOnly?: boolean } = {},
): ProviderCredentialRow[] {
  const clauses: string[] = [];
  if (!options.includeDeleted) clauses.push("deleted_at IS NULL");
  if (options.enabledOnly) clauses.push("enabled = 1");
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT * FROM provider_credentials ${where} ORDER BY provider_id ASC`)
    .all() as ProviderCredentialRow[];
  return rows;
}

export function getProviderRow(
  db: ProviderDb,
  idOrProviderId: string,
): ProviderCredentialRow | null {
  if (!idOrProviderId || idOrProviderId.length > 128) return null;
  // Prefer the immutable row id; a user-chosen providerId must not be able to
  // shadow another row whose generated id happens to match the string.
  const byId = db
    .prepare(
      "SELECT * FROM provider_credentials WHERE id = ? AND deleted_at IS NULL LIMIT 1",
    )
    .get(idOrProviderId);
  if (byId) return asRow(byId);
  const byProviderId = db
    .prepare(
      "SELECT * FROM provider_credentials WHERE provider_id = ? AND deleted_at IS NULL ORDER BY provider_id ASC LIMIT 1",
    )
    .get(idOrProviderId);
  return asRow(byProviderId);
}

// ---------------------------------------------------------------------------
// Public projection (masking)
// ---------------------------------------------------------------------------

export type ProviderHealth =
  | "ready"
  | "degraded"
  | "untested"
  | "disabled";

export interface PublicProvider {
  id: string;
  providerId: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string | null;
  models: ProviderModel[];
  npm: string | null;
  headerNames: string[];
  keyPresent: boolean;
  keyLast4: string | null;
  status: ProviderHealth;
  statusMessage: string | null;
  enabled: boolean;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastError: string | null;
  rev: number;
  createdAt: string;
  updatedAt: string;
}

export function providerHealth(
  row: ProviderCredentialRow,
  paths: Partial<ProviderPaths> = {},
): { status: ProviderHealth; message: string | null; keyState: ProviderKeyState } {
  const keyState = inspectProviderKey(row, paths);
  if (!row.enabled) {
    return { status: "disabled", message: "Provider is disabled.", keyState };
  }
  if (keyState.state === "missing") {
    return {
      status: "degraded",
      message:
        "The key file is missing. Rotate the key; the provider is omitted from the sidecar overlay.",
      keyState,
    };
  }
  if (keyState.state === "tampered") {
    return {
      status: "degraded",
      message:
        "The key file does not match its fingerprint. Rotate the key; the provider is omitted from the sidecar overlay.",
      keyState,
    };
  }
  if (row.last_test_ok === 0) {
    return {
      status: "degraded",
      message: row.last_error ?? "The last provider test failed.",
      keyState,
    };
  }
  if (row.last_test_ok === 1) {
    return { status: "ready", message: null, keyState };
  }
  return { status: "untested", message: null, keyState };
}

export function publicProvider(
  row: ProviderCredentialRow,
  paths: Partial<ProviderPaths> = {},
): PublicProvider {
  const health = providerHealth(row, paths);
  return {
    id: row.id,
    providerId: row.provider_id,
    label: row.label,
    kind: row.kind,
    baseUrl: row.base_url,
    models: parseModelsJson(row.models_json),
    npm: row.npm_pkg,
    headerNames: Object.keys(parseHeadersJson(row.headers_json)),
    keyPresent: health.keyState.keyPresent,
    keyLast4: row.key_last4,
    status: health.status,
    statusMessage: health.message,
    enabled: row.enabled === 1 || (row.enabled as unknown) === true,
    lastTestAt: row.last_test_at,
    lastTestOk:
      row.last_test_ok === null || row.last_test_ok === undefined
        ? null
        : row.last_test_ok === 1,
    lastError: row.last_error,
    rev: row.rev,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Bounded probes (never inference; no app-direct model traffic)
// ---------------------------------------------------------------------------

export interface ProviderProbeResult {
  ok: boolean;
  code: string;
  httpStatus: number | null;
  message: string | null;
  latencyMs: number;
  checkedAt: string;
  models?: ProviderModel[];
}

function joinModelsUrl(baseUrl: string): URL {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL("models", base);
}

function authHeaders(
  key: string | null,
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = { ...headers, accept: "application/json" };
  if (key) out["authorization"] = `Bearer ${key}`;
  if (!Object.keys(out).some((name) => name.toLowerCase() === "user-agent")) {
    out["user-agent"] = "Morrow/0.1 (+provider-check)";
  }
  return out;
}

async function boundedFetch(
  url: URL,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<Response> {
  return fetch(url, {
    method: "GET",
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
}

function probeError(error: unknown): { code: string; message: string } {
  const name =
    error && typeof error === "object" && "name" in error
      ? String((error as { name: unknown }).name)
      : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return {
      code: "timeout",
      message: "The provider did not answer within 5 seconds.",
    };
  }
  return {
    code: "unreachable",
    message: "The provider could not be reached.",
  };
}

function mapHttpStatus(status: number): {
  ok: boolean;
  code: string;
  message: string | null;
} {
  if (status >= 200 && status < 300) {
    return { ok: true, code: "ok", message: null };
  }
  if (status === 401) {
    return {
      ok: false,
      code: "invalid_key",
      message: "The provider rejected the API key (401).",
    };
  }
  if (status === 403) {
    return {
      ok: false,
      code: "forbidden",
      message: "The provider refused the request (403). Check key scopes.",
    };
  }
  if (status === 404 || status === 405) {
    return {
      ok: true,
      code: "endpoint_missing",
      message:
        "The base URL is reachable, but it does not expose GET /models.",
    };
  }
  if (status === 429) {
    return {
      ok: false,
      code: "rate_limited",
      message: "The provider rate-limited the test (429). Try again later.",
    };
  }
  if (status >= 500) {
    return {
      ok: false,
      code: "provider_error",
      message: `The provider returned HTTP ${status}.`,
    };
  }
  return {
    ok: false,
    code: "http_error",
    message: `The provider returned HTTP ${status}.`,
  };
}

export interface TestProviderInput {
  baseUrl: string;
  key?: string | null;
  headers?: Record<string, string>;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Scopes `{file:}` resolution to this provider's own key file. */
  providerId?: string;
  secretsDir?: string;
  /** Test-only resolver injection. */
  resolveHost?: (host: string) => Promise<string[]>;
  skipDns?: boolean;
}

/**
 * One bounded GET. The `/models` endpoint is the cheapest key validation
 * available across OpenAI-compatible providers; a 404 still proves the base
 * URL is reachable, so it is reported as a reachability pass with a note.
 */
export async function testProvider(
  input: TestProviderInput,
): Promise<ProviderProbeResult> {
  const started = Date.now();
  let url: URL;
  try {
    const resolvedBase = substituteProviderReferences(input.baseUrl, {
      env: input.env,
      providerId: input.providerId,
      secretsDir: input.secretsDir,
      // A base URL is never file content: reject every {file:} here so a
      // stored reference cannot turn key material into a request target.
      allowFile: false,
    });
    await assertProviderUrlAllowed(resolvedBase, {
      env: input.env,
      resolveHost: input.resolveHost,
      skipDns: input.skipDns,
    });
    url = joinModelsUrl(resolvedBase);
  } catch (error) {
    if (error instanceof ProviderError) {
      return {
        ok: false,
        code: error.code,
        httpStatus: null,
        message: error.message,
        latencyMs: Date.now() - started,
        checkedAt: nowIso(),
      };
    }
    throw error;
  }
  try {
    const response = await boundedFetch(
      url,
      authHeaders(input.key ?? null, input.headers ?? {}),
      input.timeoutMs ?? PROVIDER_TEST_TIMEOUT_MS,
    );
    const mapped = mapHttpStatus(response.status);
    try {
      await response.body?.cancel();
    } catch {
      // ignore
    }
    return {
      ...mapped,
      httpStatus: response.status,
      latencyMs: Date.now() - started,
      checkedAt: nowIso(),
    };
  } catch (error) {
    return {
      ok: false,
      ...probeError(error),
      httpStatus: null,
      latencyMs: Date.now() - started,
      checkedAt: nowIso(),
    };
  }
}

function parseDiscoveredModels(payload: unknown): ProviderModel[] {
  const out = new Map<string, ProviderModel>();
  const push = (id: unknown, name?: unknown): void => {
    if (typeof id !== "string" || !MODEL_ID_RE.test(id.trim())) return;
    const clean: ProviderModel = { id: id.trim() };
    if (typeof name === "string" && name.trim() && name.trim() !== clean.id) {
      clean.name = name.trim().slice(0, 200);
    }
    out.set(clean.id, clean);
  };
  if (Array.isArray(payload)) {
    for (const entry of payload) {
      if (typeof entry === "string") push(entry);
      else if (entry && typeof entry === "object") {
        const record = entry as Record<string, unknown>;
        push(record["id"] ?? record["model"] ?? record["name"], record["name"]);
      }
    }
  } else if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const data = Array.isArray(record["data"]) ? record["data"] : null;
    const models = Array.isArray(record["models"]) ? record["models"] : null;
    for (const entry of [...(data ?? []), ...(models ?? [])]) {
      if (typeof entry === "string") {
        push(entry);
      } else if (entry && typeof entry === "object") {
        const item = entry as Record<string, unknown>;
        push(
          item["id"] ?? item["model"] ?? item["name"],
          item["name"] ?? item["display_name"],
        );
      }
    }
  }
  return [...out.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, PROVIDER_MAX_MODELS);
}

export async function discoverModels(input: {
  baseUrl: string;
  key?: string | null;
  headers?: Record<string, string>;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Scopes `{file:}` resolution to this provider's own key file. */
  providerId?: string;
  secretsDir?: string;
  resolveHost?: (host: string) => Promise<string[]>;
  skipDns?: boolean;
}): Promise<ProviderProbeResult> {
  const started = Date.now();
  let url: URL;
  try {
    const resolvedBase = substituteProviderReferences(input.baseUrl, {
      env: input.env,
      providerId: input.providerId,
      secretsDir: input.secretsDir,
      // A base URL is never file content: reject every {file:} here so a
      // stored reference cannot turn key material into a request target.
      allowFile: false,
    });
    await assertProviderUrlAllowed(resolvedBase, {
      env: input.env,
      resolveHost: input.resolveHost,
      skipDns: input.skipDns,
    });
    url = joinModelsUrl(resolvedBase);
  } catch (error) {
    if (error instanceof ProviderError) {
      return {
        ok: false,
        code: error.code,
        httpStatus: null,
        message: error.message,
        latencyMs: Date.now() - started,
        checkedAt: nowIso(),
        models: [],
      };
    }
    throw error;
  }
  try {
    const response = await boundedFetch(
      url,
      authHeaders(input.key ?? null, input.headers ?? {}),
      input.timeoutMs ?? PROVIDER_TEST_TIMEOUT_MS,
    );
    if (!response.ok) {
      const mapped = mapHttpStatus(response.status);
      try {
        await response.body?.cancel();
      } catch {
        // ignore
      }
      return {
        ...mapped,
        httpStatus: response.status,
        latencyMs: Date.now() - started,
        checkedAt: nowIso(),
        models: [],
      };
    }
    const text = await readBoundedText(response);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        ok: false,
        code: "invalid_response",
        httpStatus: response.status,
        message: "The provider returned a non-JSON model list.",
        latencyMs: Date.now() - started,
        checkedAt: nowIso(),
        models: [],
      };
    }
    const models = parseDiscoveredModels(parsed);
    return {
      ok: true,
      code: models.length > 0 ? "ok" : "empty",
      httpStatus: response.status,
      message:
        models.length > 0
          ? null
          : "The provider answered but listed no models.",
      latencyMs: Date.now() - started,
      checkedAt: nowIso(),
      models,
    };
  } catch (error) {
    return {
      ok: false,
      ...probeError(error),
      httpStatus: null,
      latencyMs: Date.now() - started,
      checkedAt: nowIso(),
      models: [],
    };
  }
}

async function readBoundedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > PROVIDER_MAX_RESPONSE_BYTES) {
    throw new ProviderError(
      "response_too_large",
      "The provider response exceeded the discovery size cap.",
    );
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > PROVIDER_MAX_RESPONSE_BYTES) {
        throw new ProviderError(
          "response_too_large",
          "The provider response exceeded the discovery size cap.",
        );
      }
      chunks.push(value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

// ---------------------------------------------------------------------------
// Service layer (routes stay thin; tests use this directly)
// ---------------------------------------------------------------------------

export interface CreateProviderInput {
  providerId?: string;
  preset?: string;
  kind: ProviderKind;
  label?: string;
  baseUrl?: string;
  models?: unknown;
  key?: string;
  headers?: unknown;
  npm?: string;
}

export interface ProviderServiceOptions {
  paths?: Partial<ProviderPaths>;
  env?: NodeJS.ProcessEnv;
}

export interface UpdateProviderInput {
  label?: string;
  baseUrl?: string;
  models?: unknown;
  key?: string;
  headers?: unknown;
  enabled?: boolean;
}

interface ResolvedCreateInput {
  providerId: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string | null;
  models: ProviderModel[];
  npm: string | null;
  headers: Record<string, string>;
  key: string | null;
}

function resolveCreateInput(
  input: CreateProviderInput,
  options: ProviderServiceOptions,
): ResolvedCreateInput {
  const env = options.env ?? process.env;
  const presetId = input.preset ?? (input.kind === "preset" ? input.providerId : undefined);
  const preset = presetId ? getProviderPreset(presetId) : null;
  if (input.kind === "preset" && !preset) {
    throw new ProviderError(
      "unknown_preset",
      `Unknown provider preset: ${presetId ?? "(missing)"}.`,
    );
  }
  // The `custom` entry is a UI shortcut for the custom shape, not a fixed
  // provider id: the caller chooses providerId (or defaults to "custom").
  const customShape = input.kind === "custom" || preset?.id === "custom";
  const providerId = assertProviderId(
    input.providerId ??
      (preset && preset.id !== "custom" ? preset.id : customShape ? "custom" : ""),
  );
  if (preset && preset.id !== "custom" && providerId !== preset.id) {
    throw new ProviderError(
      "invalid_provider_id",
      `The ${preset.id} preset uses providerId "${preset.id}".`,
    );
  }
  if (!preset && !customShape) {
    throw new ProviderError("unknown_preset", "A preset id is required.");
  }

  const baseUrlRaw = (input.baseUrl ?? preset?.baseUrl ?? "").trim();
  if (!baseUrlRaw) {
    throw new ProviderError(
      "base_url_required",
      "Custom providers need an https base URL.",
    );
  }
  // Gate every reference-bearing field BEFORE any resolution or storage:
  // allowlisted env vars only (none by default), file refs only to the
  // provider's own key file — and never any {file:} inside a base URL, where
  // resolved content would become a request target. The raw reference text is
  // still what is stored (the sidecar resolves allowlisted refs at runtime),
  // but the server only ever resolves through the same gate.
  const refScope = {
    providerId,
    secretsDir: options.paths?.secretsDir,
    env,
  };
  assertProviderReferencesAllowed(baseUrlRaw, { ...refScope, allowFile: false });
  // Validate the concrete target, but keep the reference text in the row and
  // overlay so allowlisted `{env:}` indirection survives a sidecar restart.
  validateProviderBaseUrl(
    substituteProviderReferences(baseUrlRaw, {
      env,
      providerId,
      secretsDir: options.paths?.secretsDir,
      allowFile: false,
    }),
    { env },
  );

  const npm = customShape
    ? (input.npm ?? CUSTOM_OPENAI_COMPATIBLE_NPM)
    : (preset?.npm ?? null);
  if (npm !== null && npm !== CUSTOM_OPENAI_COMPATIBLE_NPM) {
    throw new ProviderError(
      "invalid_npm",
      `Custom providers use ${CUSTOM_OPENAI_COMPATIBLE_NPM}; arbitrary npm packages are not allowed.`,
    );
  }

  const key =
    typeof input.key === "string"
      ? resolveProviderKeyInput(input.key, env, refScope)
      : "";
  if (preset?.requiresKey && key === "") {
    throw new ProviderError(
      "key_required",
      `The ${preset.label} preset requires an API key.`,
    );
  }

  const headers = normalizeProviderHeaders(input.headers);
  for (const headerValue of Object.values(headers)) {
    assertProviderReferencesAllowed(headerValue, refScope);
  }

  return {
    providerId,
    label:
      (input.label ?? preset?.label ?? input.providerId ?? "Provider")
        .trim()
        .slice(0, 100) || "Provider",
    kind: customShape ? "custom" : "preset",
    baseUrl: baseUrlRaw,
    models: normalizeProviderModels(input.models),
    npm,
    headers,
    key: key === "" ? null : key,
  };
}

export async function createProviderCredential(
  db: ProviderDb,
  input: CreateProviderInput,
  options: ProviderServiceOptions = {},
): Promise<ProviderCredentialRow> {
  assertProvidersWritable(options.env);
  const env = options.env ?? process.env;
  const resolved = resolveCreateInput(input, { ...options, env });
  const existing = db
    .prepare(
      "SELECT id FROM provider_credentials WHERE provider_id = ? AND deleted_at IS NULL",
    )
    .get(resolved.providerId);
  if (existing) {
    throw new ProviderError(
      "provider_exists",
      `A ${resolved.providerId} provider is already connected. Rotate its key or delete it first.`,
      409,
    );
  }

  const now = nowIso();
  const id = `pcr_${randomBytes(12).toString("hex")}`;
  const keyValue = resolved.key?.trim() ?? "";
  const keyLast4 = keyValue ? providerKeyLast4(keyValue) : null;
  const keyFingerprint = keyValue
    ? fingerprintProviderKey(keyValue)
    : null;
  // Insert first: two concurrent creates cannot both own the same providerId,
  // and the loser must never unlink the winner's key file.
  db.prepare(
    `INSERT INTO provider_credentials
       (id, provider_id, label, kind, base_url, models_json, npm_pkg, headers_json,
        key_last4, key_fingerprint, enabled, last_test_at, last_test_ok, last_error,
        rev, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, NULL, NULL, 1, ?, ?, NULL)`,
  ).run(
    id,
    resolved.providerId,
    resolved.label,
    resolved.kind,
    resolved.baseUrl,
    modelsJson(resolved.models),
    resolved.npm,
    JSON.stringify(resolved.headers),
    keyLast4,
    keyFingerprint,
    now,
    now,
  );
  if (keyValue) {
    try {
      writeProviderKey(resolved.providerId, keyValue, options.paths);
    } catch (error) {
      // Do not leave a row without its key file.
      db.prepare("DELETE FROM provider_credentials WHERE id = ?").run(id);
      throw error;
    }
  }
  // A failed overlay write must not lose the credential row; GET reports it
  // and the next mutation/render retries. Never include the key in errors.
  await syncProviderOverlay(db, { ...options.paths, env }).catch(() => undefined);
  return getProviderRow(db, id) as ProviderCredentialRow;
}

/**
 * Update a provider's mutable fields. `providerId`, `kind`, and `npm` are
 * immutable; a supplied key is resolved and written through the same gate as
 * rotate. Disabling keeps the row/key but omits it from the overlay.
 */
export async function updateProviderCredential(
  db: ProviderDb,
  idOrProviderId: string,
  input: UpdateProviderInput,
  options: ProviderServiceOptions = {},
): Promise<ProviderCredentialRow> {
  assertProvidersWritable(options.env);
  const env = options.env ?? process.env;
  const row = getProviderRow(db, idOrProviderId);
  if (!row) {
    throw new ProviderError("provider_not_found", "Provider not found.", 404);
  }

  let baseUrl = row.base_url;
  if (input.baseUrl !== undefined) {
    const baseUrlRaw = input.baseUrl.trim();
    if (!baseUrlRaw) {
      throw new ProviderError("base_url_required", "A provider needs a base URL.");
    }
    const refScope = {
      providerId: row.provider_id,
      secretsDir: options.paths?.secretsDir,
      env,
    };
    assertProviderReferencesAllowed(baseUrlRaw, { ...refScope, allowFile: false });
    validateProviderBaseUrl(
      substituteProviderReferences(baseUrlRaw, {
        ...refScope,
        allowFile: false,
      }),
      { env },
    );
    baseUrl = baseUrlRaw;
  }

  const headers =
    input.headers !== undefined
      ? normalizeProviderHeaders(input.headers)
      : parseHeadersJson(row.headers_json);
  for (const headerValue of Object.values(headers)) {
    assertProviderReferencesAllowed(headerValue, {
      providerId: row.provider_id,
      secretsDir: options.paths?.secretsDir,
      env,
    });
  }
  const models =
    input.models !== undefined
      ? normalizeProviderModels(input.models)
      : parseModelsJson(row.models_json);

  let keyLast4 = row.key_last4;
  let keyFingerprint = row.key_fingerprint;
  let keyChanged = false;
  if (input.key !== undefined) {
    const stored = writeProviderKey(
      row.provider_id,
      resolveProviderKeyInput(input.key, env, {
        providerId: row.provider_id,
        secretsDir: options.paths?.secretsDir,
      }),
      options.paths,
    );
    keyLast4 = stored.last4;
    keyFingerprint = stored.fingerprint;
    keyChanged = true;
  }

  const now = nowIso();
  const enabled =
    input.enabled === undefined
      ? row.enabled
      : input.enabled
        ? 1
        : 0;
  const targetChanged = input.baseUrl !== undefined || keyChanged;
  db.prepare(
    `UPDATE provider_credentials
        SET label = ?, base_url = ?, models_json = ?, headers_json = ?,
            key_last4 = ?, key_fingerprint = ?, enabled = ?,
            last_test_at = CASE WHEN ? THEN NULL ELSE last_test_at END,
            last_test_ok = CASE WHEN ? THEN NULL ELSE last_test_ok END,
            last_error = CASE WHEN ? THEN NULL ELSE last_error END,
            rev = rev + 1, updated_at = ?
      WHERE id = ?`,
  ).run(
    input.label?.trim() || row.label,
    baseUrl,
    modelsJson(models),
    JSON.stringify(headers),
    keyLast4,
    keyFingerprint,
    enabled,
    targetChanged ? 1 : 0,
    targetChanged ? 1 : 0,
    targetChanged ? 1 : 0,
    now,
    row.id,
  );
  await syncProviderOverlay(db, { ...options.paths, env }).catch(() => undefined);
  return getProviderRow(db, row.id) as ProviderCredentialRow;
}

export async function rotateProviderCredentialKey(
  db: ProviderDb,
  idOrProviderId: string,
  rawKey: string,
  options: ProviderServiceOptions = {},
): Promise<ProviderCredentialRow> {
  assertProvidersWritable(options.env);
  const env = options.env ?? process.env;
  const row = getProviderRow(db, idOrProviderId);
  if (!row) {
    throw new ProviderError("provider_not_found", "Provider not found.", 404);
  }
  const stored = writeProviderKey(
    row.provider_id,
    resolveProviderKeyInput(rawKey, env, {
      providerId: row.provider_id,
      secretsDir: options.paths?.secretsDir,
    }),
    options.paths,
  );
  const now = nowIso();
  db.prepare(
    `UPDATE provider_credentials
        SET key_last4 = ?, key_fingerprint = ?, last_test_at = NULL,
            last_test_ok = NULL, last_error = NULL, rev = rev + 1, updated_at = ?
      WHERE id = ?`,
  ).run(stored.last4, stored.fingerprint, now, row.id);
  await syncProviderOverlay(db, { ...options.paths, env }).catch(() => undefined);
  return getProviderRow(db, row.id) as ProviderCredentialRow;
}

export function providerOwnsModel(
  providerId: string,
  modelRef: string,
): boolean {
  return modelRef === providerId || modelRef.startsWith(`${providerId}/`);
}

/**
 * Soft-delete the credential, remove the key file, clear the selected model if
 * it belonged to this provider, then re-render the overlay from live rows.
 */
export async function deleteProviderCredential(
  db: ProviderDb,
  idOrProviderId: string,
  options: ProviderServiceOptions = {},
): Promise<{ row: ProviderCredentialRow; clearedModel: string | null }> {
  assertProvidersWritable(options.env);
  const env = options.env ?? process.env;
  const row = getProviderRow(db, idOrProviderId);
  if (!row) {
    throw new ProviderError("provider_not_found", "Provider not found.", 404);
  }
  const now = nowIso();
  db.prepare(
    `UPDATE provider_credentials
        SET deleted_at = ?, enabled = 0, rev = rev + 1, updated_at = ?
      WHERE id = ?`,
  ).run(now, now, row.id);
  try {
    deleteProviderKey(row.provider_id, options.paths);
  } catch {
    // The row is gone from the UI; a leftover file is not secret-bearing in
    // the overlay and the next rotate overwrites it. Report via logs upstream.
  }

  let clearedModel: string | null = null;
  const setting = db
    .prepare("SELECT value FROM settings WHERE key = 'ai.model'")
    .get() as { value: string } | undefined;
  if (setting) {
    try {
      const parsed = JSON.parse(setting.value) as unknown;
      if (typeof parsed === "string" && providerOwnsModel(row.provider_id, parsed)) {
        clearedModel = parsed;
        db.prepare(
          "UPDATE settings SET value = 'null', rev = rev + 1, updated_at = ? WHERE key = 'ai.model'",
        ).run(now);
      }
    } catch {
      // Malformed setting is left for the assistant settings route to repair.
    }
  }

  await syncProviderOverlay(db, { ...options.paths, env }).catch(() => undefined);
  return { row, clearedModel };
}

function credentialForProbe(
  row: ProviderCredentialRow,
  options: ProviderServiceOptions,
): { baseUrl: string; key: string | null; headers: Record<string, string> } {
  const baseUrl = row.base_url ?? getProviderPreset(row.provider_id)?.baseUrl ?? "";
  if (!baseUrl) {
    throw new ProviderError(
      "base_url_missing",
      "This provider has no base URL. Recreate it with a baseUrl.",
    );
  }
  const keyState = inspectProviderKey(row, options.paths);
  if (keyState.state === "missing" || keyState.state === "tampered") {
    throw new ProviderError(
      "key_unavailable",
      keyState.state === "tampered"
        ? "The key file does not match its fingerprint. Rotate the key."
        : "The key file is missing. Rotate the key.",
      409,
    );
  }
  const read = readProviderKey(row, options.paths);
  const headers = Object.fromEntries(
    Object.entries(parseHeadersJson(row.headers_json)).map(([name, value]) => [
      name,
      // Gated resolution: a stored legacy reference that is not allowlisted
      // throws here, so the probe records a failure instead of exfiltrating.
      substituteProviderReferences(value, {
        env: options.env,
        providerId: row.provider_id,
        secretsDir: options.paths?.secretsDir,
      }),
    ]),
  );
  return {
    baseUrl,
    key: read?.key ?? null,
    headers,
  };
}

export async function testStoredProvider(
  db: ProviderDb,
  idOrProviderId: string,
  options: ProviderServiceOptions & {
    timeoutMs?: number;
    resolveHost?: (host: string) => Promise<string[]>;
    skipDns?: boolean;
  } = {},
): Promise<{ provider: PublicProvider; test: ProviderProbeResult }> {
  assertProvidersWritable(options.env);
  const env = options.env ?? process.env;
  const row = getProviderRow(db, idOrProviderId);
  if (!row) {
    throw new ProviderError("provider_not_found", "Provider not found.", 404);
  }
  let probe: ProviderProbeResult;
  try {
    const credential = credentialForProbe(row, options);
    probe = await testProvider({
      ...credential,
      providerId: row.provider_id,
      secretsDir: options.paths?.secretsDir,
      timeoutMs: options.timeoutMs,
      env,
      resolveHost: options.resolveHost,
      skipDns: options.skipDns,
    });
  } catch (error) {
    const providerError =
      error instanceof ProviderError
        ? error
        : new ProviderError("probe_failed", "The provider test failed.");
    probe = {
      ok: false,
      code: providerError.code,
      httpStatus: null,
      message: providerError.message,
      latencyMs: 0,
      checkedAt: nowIso(),
    };
  }
  const now = nowIso();
  db.prepare(
    `UPDATE provider_credentials
        SET last_test_at = ?, last_test_ok = ?, last_error = ?, rev = rev + 1, updated_at = ?
      WHERE id = ?`,
  ).run(now, probe.ok ? 1 : 0, probe.ok ? null : probe.message, now, row.id);
  return {
    provider: publicProvider(
      getProviderRow(db, row.id) as ProviderCredentialRow,
      options.paths,
    ),
    test: probe,
  };
}

export async function discoverStoredProviderModels(
  db: ProviderDb,
  idOrProviderId: string,
  options: ProviderServiceOptions & {
    timeoutMs?: number;
    resolveHost?: (host: string) => Promise<string[]>;
    skipDns?: boolean;
  } = {},
): Promise<{
  provider: PublicProvider;
  discovery: ProviderProbeResult;
  saved: boolean;
}> {
  assertProvidersWritable(options.env);
  const env = options.env ?? process.env;
  const row = getProviderRow(db, idOrProviderId);
  if (!row) {
    throw new ProviderError("provider_not_found", "Provider not found.", 404);
  }
  let discovery: ProviderProbeResult;
  try {
    const credential = credentialForProbe(row, options);
    discovery = await discoverModels({
      ...credential,
      providerId: row.provider_id,
      secretsDir: options.paths?.secretsDir,
      timeoutMs: options.timeoutMs,
      env,
      resolveHost: options.resolveHost,
      skipDns: options.skipDns,
    });
  } catch (error) {
    const providerError =
      error instanceof ProviderError
        ? error
        : new ProviderError("discovery_failed", "Model discovery failed.");
    discovery = {
      ok: false,
      code: providerError.code,
      httpStatus: null,
      message: providerError.message,
      latencyMs: 0,
      checkedAt: nowIso(),
      models: [],
    };
  }
  let saved = false;
  if (discovery.ok && (discovery.models?.length ?? 0) > 0) {
    const now = nowIso();
    db.prepare(
      `UPDATE provider_credentials
          SET models_json = ?, last_error = NULL, rev = rev + 1, updated_at = ?
        WHERE id = ?`,
    ).run(modelsJson(discovery.models ?? []), now, row.id);
    saved = true;
    await syncProviderOverlay(db, { ...options.paths, env }).catch(
      () => undefined,
    );
  }
  return {
    provider: publicProvider(
      getProviderRow(db, row.id) as ProviderCredentialRow,
      options.paths,
    ),
    discovery,
    saved,
  };
}

/**
 * The honest copy surfaced by GET /api/providers: OAuth subscription logins
 * are not app-managed. They stay in the OpenCode CLI and never become a
 * Morrow credential row.
 */
export const OAUTH_CLI_ONLY = {
  cliOnly: true,
  providers: ["ChatGPT Plus/Pro (OpenAI OAuth)", "GitHub Copilot", "GitLab Duo"],
  message:
    "Subscription OAuth sign-in stays in the OpenCode CLI. Run `docker compose exec opencode opencode auth login`; Morrow manages API-key providers only.",
} as const;

export function providerStatusSummary(
  db: ProviderDb,
  options: ProviderServiceOptions = {},
): {
  enabled: boolean;
  overlayPath: string;
  providers: PublicProvider[];
  presets: Array<
    ProviderPreset & { custom: boolean }
  >;
  oauth: typeof OAUTH_CLI_ONLY;
} {
  const env = options.env ?? process.env;
  const defaults = resolveProviderPaths(env);
  const paths: ProviderPaths = {
    secretsDir: path.resolve(options.paths?.secretsDir ?? defaults.secretsDir),
    overlayPath: path.resolve(options.paths?.overlayPath ?? defaults.overlayPath),
  };
  return {
    enabled: providersEnabled(env),
    overlayPath: paths.overlayPath,
    providers: listProviderRows(db, { includeDeleted: false }).map((row) =>
      publicProvider(row, paths),
    ),
    presets: PROVIDER_PRESETS.map((preset) => ({
      ...preset,
      custom: preset.id === "custom",
    })),
    oauth: OAUTH_CLI_ONLY,
  };
}
