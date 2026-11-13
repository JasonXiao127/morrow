/**
 * Contract test for the pinned OpenCode sidecar.
 *
 * Usage:
 *   OPENCODE_URL=http://127.0.0.1:4096 \
 *   OPENCODE_PASSWORD=... \
 *   MCP_URL=http://127.0.0.1:3001/mcp \
 *   REMINDERS_MCP_TOKEN=... \
 *   PROVIDER_OVERLAY_PATH=/data/opencode-providers/global.json \
 *   pnpm --filter @morrow/agent build && pnpm --filter @morrow/agent contract
 *
 * The command exits non-zero on a version, agent, permission, provider, or
 * tool-surface mismatch. It does not send a model prompt and does not spend
 * tokens. Provider {file:} volume checks print PENDING when Docker or the
 * compose sidecar is unavailable; a running sidecar with a missing key file
 * fails the contract.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OpenCode } from "@opencode/client";
import { MCP_TOOL_NAMES } from "./tools.js";
import { OPENCODE_PINNED_VERSION, REMINDERS_AGENT_ID } from "./runtime.js";

const DENIED = ["shell", "edit", "read", "webfetch", "websearch"];

export const PROVIDER_OVERLAY_SCHEMA = "https://opencode.ai/config.json";
export const DEFAULT_PROVIDER_OVERLAY_PATH =
  "/data/opencode-providers/global.json";

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Provider overlay (M4.1)
//
// The backend writes the documented singular `provider` shape. Pinned OpenCode
// 2.2.5 normalises it to the v2 `providers` map. These helpers keep the shape
// testable without a sidecar; the live contract additionally asks the sidecar
// for its provider list so the real pinned normaliser is exercised.
// ---------------------------------------------------------------------------

export interface ProviderOverlayOptions {
  baseURL?: string;
  apiKey?: string;
  headers?: Record<string, string>;
}

export interface ProviderOverlayEntry {
  name?: string;
  npm?: string;
  options?: ProviderOverlayOptions;
  models?: Record<string, { name?: string }>;
}

export interface ProviderOverlayDocument {
  $schema: string;
  provider: Record<string, ProviderOverlayEntry>;
}

export interface NormalizedProviderOverlay {
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
}

function readString(
  record: Record<string, unknown>,
  key: string,
  context: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${context}.${key} must be a non-empty string`);
  }
  return value.trim();
}

function readHeaders(
  value: unknown,
  context: string,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`${context}.headers must be an object`);
  }
  const headers: Record<string, string> = {};
  for (const [name, header] of Object.entries(value)) {
    if (typeof header !== "string") {
      throw new Error(`${context}.headers.${name} must be a string`);
    }
    headers[name] = header;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function readModels(
  value: unknown,
  context: string,
): Record<string, { name?: string }> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`${context}.models must be an object`);
  }
  const models: Record<string, { name?: string }> = {};
  for (const [id, raw] of Object.entries(value)) {
    if (!isRecord(raw)) {
      throw new Error(`${context}.models.${id} must be an object`);
    }
    const name = readString(raw, "name", `${context}.models.${id}`);
    models[id] = name ? { name } : {};
  }
  return Object.keys(models).length > 0 ? models : undefined;
}

/**
 * Parse and validate the singular `provider` overlay. Rejecting the plural
 * form keeps the contract unambiguous: 2.2.5 accepts the singular documented
 * shape and normalises it itself.
 */
export function parseProviderOverlay(input: unknown): ProviderOverlayDocument {
  if (!isRecord(input)) {
    throw new Error("provider overlay must be a JSON object");
  }
  if (input["$schema"] !== PROVIDER_OVERLAY_SCHEMA) {
    throw new Error(
      `provider overlay $schema must be ${PROVIDER_OVERLAY_SCHEMA}`,
    );
  }
  if ("providers" in input) {
    throw new Error(
      "provider overlay must use singular `provider`, not the v2 `providers` map",
    );
  }
  const rawProvider = input["provider"];
  if (!isRecord(rawProvider)) {
    throw new Error("provider overlay must contain a `provider` object");
  }

  const provider: Record<string, ProviderOverlayEntry> = {};
  for (const [rawId, rawEntry] of Object.entries(rawProvider)) {
    const id = rawId.trim();
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) {
      throw new Error(`provider overlay has an invalid provider id: ${rawId}`);
    }
    if (!isRecord(rawEntry)) {
      throw new Error(`provider overlay entry ${id} must be an object`);
    }
    const context = `provider.${id}`;
    const entry: ProviderOverlayEntry = {};
    const name = readString(rawEntry, "name", context);
    const npm = readString(rawEntry, "npm", context);
    if (name) entry.name = name;
    if (npm) entry.npm = npm;

    if (rawEntry["options"] !== undefined) {
      if (!isRecord(rawEntry["options"])) {
        throw new Error(`${context}.options must be an object`);
      }
      const rawOptions = rawEntry["options"];
      const options: ProviderOverlayOptions = {};
      const baseURL = readString(rawOptions, "baseURL", `${context}.options`);
      const apiKey = readString(rawOptions, "apiKey", `${context}.options`);
      const headers = readHeaders(
        rawOptions["headers"],
        `${context}.options`,
      );
      if (baseURL) options.baseURL = baseURL;
      if (apiKey) options.apiKey = apiKey;
      if (headers) options.headers = headers;
      if (Object.keys(options).length > 0) entry.options = options;
    }

    const models = readModels(rawEntry["models"], context);
    if (models) entry.models = models;
    provider[id] = entry;
  }

  const document: ProviderOverlayDocument = {
    $schema: PROVIDER_OVERLAY_SCHEMA,
    provider,
  };
  // Validate the paths now, even if this process cannot see the volume.
  providerFileRefs(document);
  return document;
}

function collectFileRefs(value: unknown, refs: Set<string>): void {
  if (typeof value === "string") {
    const pattern = /\{file:([^}]+)\}/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(value)) !== null) {
      const ref = match[1]?.trim() ?? "";
      if (!ref) throw new Error("provider overlay has an empty {file:} reference");
      if (!path.isAbsolute(ref)) {
        throw new Error(
          `provider {file:} reference must be absolute, got ${ref}`,
        );
      }
      refs.add(ref);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectFileRefs(item, refs);
    return;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) collectFileRefs(item, refs);
  }
}

/** Every absolute `{file:...}` path referenced by the overlay. */
export function providerFileRefs(document: ProviderOverlayDocument): string[] {
  const refs = new Set<string>();
  collectFileRefs(document.provider, refs);
  return [...refs].sort();
}

/** Assert every `{file:...}` key reference is readable and non-empty. */
export function assertProviderFileRefsResolve(
  document: ProviderOverlayDocument,
  read: (file: string) => string = (file) => fs.readFileSync(file, "utf8"),
): string[] {
  const refs = providerFileRefs(document);
  const missing: string[] = [];
  for (const ref of refs) {
    try {
      if (read(ref).trim() === "") missing.push(ref);
    } catch {
      missing.push(ref);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `provider {file:} references do not resolve: ${missing.join(", ")}`,
    );
  }
  return refs;
}

/** Mirror of the pinned 2.2.5 singular -> v2 normalisation. */
export function normalizeProviderOverlay(
  document: ProviderOverlayDocument,
): NormalizedProviderOverlay {
  const providers: NormalizedProviderOverlay["providers"] = {};
  for (const [id, entry] of Object.entries(document.provider)) {
    const settings: Record<string, string> = {};
    if (entry.options?.baseURL) settings["baseURL"] = entry.options.baseURL;
    if (entry.options?.apiKey) settings["apiKey"] = entry.options.apiKey;
    const normalized: (typeof providers)[string] = {};
    if (entry.name) normalized.name = entry.name;
    if (entry.npm) normalized.package = entry.npm;
    if (Object.keys(settings).length > 0) normalized.settings = settings;
    if (entry.options?.headers) normalized.headers = entry.options.headers;
    if (entry.models) normalized.models = entry.models;
    providers[id] = normalized;
  }
  return { $schema: PROVIDER_OVERLAY_SCHEMA, providers };
}

export interface MountCheckDeps {
  dockerAvailable: () => boolean;
  sidecarRunning: () => boolean;
  fileExistsInSidecar: (file: string) => boolean;
}

export interface MountCheckResult {
  status: "ok" | "pending";
  refs: string[];
}

/**
 * Live mount check. `pending` means Docker or the sidecar is unavailable, so
 * the contract cannot honestly prove the shared volume is mounted. A running
 * sidecar with a missing key file is a hard failure.
 */
export function checkMountedProviderFileRefs(
  refs: string[],
  deps: MountCheckDeps,
): MountCheckResult {
  if (refs.length === 0) return { status: "ok", refs: [] };
  if (!deps.dockerAvailable() || !deps.sidecarRunning()) {
    return { status: "pending", refs };
  }
  const missing = refs.filter((ref) => !deps.fileExistsInSidecar(ref));
  if (missing.length > 0) {
    throw new Error(
      `provider key files are not visible inside the sidecar (check the opencode-secrets mount): ${missing.join(", ")}`,
    );
  }
  return { status: "ok", refs };
}

async function checkAgent(baseUrl: string, password: string): Promise<void> {
  const directory = env("OPENCODE_WORKSPACE") || "/workspace";
  const client = OpenCode.make({
    baseUrl,
    headers: {
      authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
      "x-opencode-directory": encodeURIComponent(directory),
    },
  });
  const info = await client.server.info();
  const version = /(\d+\.\d+\.\d+)/.exec(info.version)?.[1] ?? info.version;
  if (version !== OPENCODE_PINNED_VERSION) {
    throw new Error(
      `OpenCode version ${info.version} does not match pinned ${OPENCODE_PINNED_VERSION}`,
    );
  }
  console.log(`ok  version ${info.version}`);

  let agent;
  try {
    // 2.2.5 resolves a location lazily: list before get so a fresh sidecar
    // (or one started with a custom OPENCODE_CONFIG) has the agent loaded.
    await client.agent.list({ location: { directory } });
    agent = (
      await client.agent.get({
        agentID: REMINDERS_AGENT_ID,
        location: { directory },
      })
    ).data;
  } catch (error) {
    throw new Error(`agent “${REMINDERS_AGENT_ID}” is missing: ${message(error)}`);
  }
  const permissions = agent.permissions ?? [];
  const denyAll = permissions.some(
    (rule) => rule.action === "*" && rule.resource === "*" && rule.effect === "deny",
  );
  const allowReminders = permissions.some(
    (rule) =>
      rule.action === "morrow_reminders_*" &&
      rule.resource === "*" &&
      rule.effect === "allow",
  );
  if (!denyAll || !allowReminders) {
    throw new Error(
      "agent permissions are not deny-* + allow-morrow_reminders_*; inspect opencode.jsonc",
    );
  }
  for (const denied of DENIED) {
    const allowed = permissions.some(
      (rule) =>
        rule.action === denied &&
        (rule.resource === "*" || rule.resource.startsWith(`${denied}:`)) &&
        rule.effect === "allow",
    );
    if (allowed) throw new Error(`agent allows denied tool ${denied}`);
  }
  if (!agent.system?.includes("Propose; don't surprise")) {
    throw new Error("reminders system prompt was not loaded from prompts/reminders.md");
  }
  console.log(`ok  agent ${REMINDERS_AGENT_ID} is deny-by-default with morrow_reminders_* only`);
  console.log("ok  shell/edit/read/webfetch/websearch are not allowed");
}

async function mcpRequest(
  url: string,
  token: string,
  body: unknown,
  protocolVersion?: string,
  extraHeaders: Record<string, string> = {},
): Promise<unknown> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${token}`,
    ...extraHeaders,
  };
  if (protocolVersion) headers["mcp-protocol-version"] = protocolVersion;
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`MCP HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  // The legacy transport answers JSON. A 2026-era response may be an SSE frame.
  if (text.trim().startsWith("{")) return JSON.parse(text) as unknown;
  const data = text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("");
  return data ? (JSON.parse(data) as unknown) : null;
}

async function checkMcp(url: string, token: string): Promise<void> {
  if (!url || !token) {
    console.log("skip MCP handshake (set MCP_URL and REMINDERS_MCP_TOKEN)");
    return;
  }
  const init = await mcpRequest(
    url,
    token,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "morrow-contract", version: "0.1.0" },
      },
    },
    "2025-11-25",
  );
  const initResult = (init as { result?: { serverInfo?: { name?: string } } })
    ?.result;
  if (!initResult) throw new Error("MCP initialize returned no result");
  console.log(`ok  MCP initialize (${initResult.serverInfo?.name ?? "unnamed"})`);

  const list = await mcpRequest(
    url,
    token,
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    "2025-11-25",
  );
  const tools = (
    list as { result?: { tools?: Array<{ name?: string }> } }
  )?.result?.tools;
  if (!Array.isArray(tools)) {
    throw new Error("MCP tools/list returned no tools array");
  }
  const names = tools.map((tool) => tool.name ?? "").sort();
  const expected = [...MCP_TOOL_NAMES].sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(
      `MCP tool surface mismatch. Expected ${expected.join(", ")}; got ${names.join(", ") || "none"}`,
    );
  }
  for (const forbidden of DENIED) {
    if (names.includes(forbidden) || names.some((name) => name.endsWith(`_${forbidden}`))) {
      throw new Error(`MCP exposed forbidden tool ${forbidden}`);
    }
  }
  if (names.some((name) => name.includes("delete"))) {
    throw new Error("MCP exposed a delete tool; the policy requires proposals");
  }
  console.log(`ok  MCP exposes ${names.length} reminders_* reminders tools and no delete tool`);
}

async function checkModernMcp(url: string, token: string): Promise<void> {
  if (!url || !token) return;
  const envelope = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientCapabilities": {},
  };
  const discover = await mcpRequest(
    url,
    token,
    {
      jsonrpc: "2.0",
      id: 10,
      method: "server/discover",
      params: { _meta: envelope },
    },
    "2026-07-28",
    { "mcp-method": "server/discover" },
  );
  const versions = (
    discover as { result?: { supportedVersions?: string[] } }
  )?.result?.supportedVersions;
  if (!versions?.includes("2026-07-28")) {
    throw new Error("MCP did not negotiate the 2026-07-28 revision");
  }
  const list = await mcpRequest(
    url,
    token,
    {
      jsonrpc: "2.0",
      id: 11,
      method: "tools/list",
      params: { _meta: envelope },
    },
    "2026-07-28",
    { "mcp-method": "tools/list" },
  );
  const tools = (
    list as { result?: { tools?: Array<{ name?: string }> } }
  )?.result?.tools;
  if (!Array.isArray(tools)) throw new Error("modern tools/list returned no tools");
  const names = tools.map((tool) => tool.name ?? "").sort();
  const expected = [...MCP_TOOL_NAMES].sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error("modern MCP tool surface mismatch");
  }
  console.log("ok  MCP modern 2026-07-28 handshake + tool surface");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Live provider overlay checks
// ---------------------------------------------------------------------------

interface DockerMode {
  viaSg: boolean;
  cwd: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function findComposeDir(): string {
  let dir = path.resolve(env("COMPOSE_DIR") || process.cwd());
  for (;;) {
    if (fs.existsSync(path.join(dir, "compose.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

function dockerAttempt(args: string[], mode: DockerMode) {
  const options = {
    cwd: mode.cwd,
    encoding: "utf8" as const,
    timeout: 20_000,
  };
  if (!mode.viaSg) return spawnSync("docker", args, options);
  const command = `docker ${args.map(shellQuote).join(" ")}`;
  return spawnSync("sg", ["docker", "-c", command], options);
}

function dockerMode(): DockerMode | null {
  const cwd = findComposeDir();
  const direct = spawnSync("docker", ["info"], {
    cwd,
    stdio: "ignore",
    timeout: 10_000,
  });
  if (!direct.error && direct.status === 0) return { viaSg: false, cwd };
  // This environment grants Docker through the `docker` group via sg(1).
  const sg = spawnSync("sg", ["docker", "-c", "docker info"], {
    cwd,
    stdio: "ignore",
    timeout: 10_000,
  });
  if (!sg.error && sg.status === 0) return { viaSg: true, cwd };
  return null;
}

function sidecarRunning(mode: DockerMode): boolean {
  const result = dockerAttempt(
    ["compose", "ps", "--status", "running", "--services"],
    mode,
  );
  if (result.status !== 0) return false;
  return (result.stdout ?? "").split(/\s+/).includes("opencode");
}

function fileExistsInSidecar(mode: DockerMode, file: string): boolean {
  const result = dockerAttempt(
    [
      "compose",
      "exec",
      "-T",
      "opencode",
      "sh",
      "-c",
      'test -s "$1"',
      "sh",
      file,
    ],
    mode,
  );
  return result.status === 0;
}

function overlayPath(): string {
  const configured = env("PROVIDER_OVERLAY_PATH");
  const primary = configured || DEFAULT_PROVIDER_OVERLAY_PATH;
  if (fs.existsSync(primary)) return primary;
  if (!configured) {
    const local = path.join(
      findComposeDir(),
      "data",
      "opencode-providers",
      "global.json",
    );
    if (fs.existsSync(local)) return local;
  }
  return primary;
}

async function checkProviderOverlay(
  baseUrl: string,
  password: string,
): Promise<void> {
  const file = overlayPath();
  if (!fs.existsSync(file)) {
    console.log(`PENDING provider overlay not found at ${file}`);
    return;
  }
  const document = parseProviderOverlay(
    JSON.parse(fs.readFileSync(file, "utf8")) as unknown,
  );
  const ids = Object.keys(document.provider);
  console.log(
    `ok  provider overlay parses as a singular-provider OpenCode config (${ids.length} provider${ids.length === 1 ? "" : "s"})`,
  );
  const normalized = normalizeProviderOverlay(document);
  if (Object.keys(normalized.providers).length !== ids.length) {
    throw new Error("provider overlay normalisation lost providers");
  }
  console.log("ok  singular `provider` normalises to the v2 `providers` map");

  if (ids.length === 0) {
    console.log("PENDING provider overlay has no configured providers");
    return;
  }

  const directory = env("OPENCODE_WORKSPACE") || "/workspace";
  const client = OpenCode.make({
    baseUrl,
    headers: {
      authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
      "x-opencode-directory": encodeURIComponent(directory),
    },
  });
  const listed = await client.provider.list({ location: { directory } });
  const available = new Set<string>(
    listed.data.map((provider) => String(provider.id)),
  );
  for (const id of ids) {
    if (!available.has(id)) {
      throw new Error(
        `provider overlay entry “${id}” does not appear in the pinned 2.2.5 provider list`,
      );
    }
  }
  console.log(
    `ok  overlay provider${ids.length === 1 ? "" : "s"} ${ids.join(", ")} accepted by pinned 2.2.5`,
  );

  const refs = providerFileRefs(document);
  if (refs.length === 0) {
    console.log("ok  provider overlay has no {file:} key references");
    return;
  }

  // When the contract runs inside the app container, the shared volumes are
  // already visible here and no Docker API is needed.
  try {
    assertProviderFileRefsResolve(document);
    console.log(
      `ok  ${refs.length} provider {file:} key reference${refs.length === 1 ? "" : "s"} resolve in this process`,
    );
    return;
  } catch {
    // Host run: fall through to an exec check inside the sidecar.
  }

  const mode = dockerMode();
  const mounted = checkMountedProviderFileRefs(refs, {
    dockerAvailable: () => mode !== null,
    sidecarRunning: () => mode !== null && sidecarRunning(mode),
    fileExistsInSidecar: (ref) =>
      mode !== null && fileExistsInSidecar(mode, ref),
  });
  if (mounted.status === "pending") {
    console.log(
      `PENDING provider {file:} mount check (Docker or the opencode sidecar is unavailable): ${refs.join(", ")}`,
    );
    return;
  }
  console.log(
    `ok  ${refs.length} provider {file:} key reference${refs.length === 1 ? "" : "s"} resolve inside the sidecar`,
  );
}

async function main(): Promise<void> {
  const baseUrl = env("OPENCODE_URL") || "http://127.0.0.1:4096";
  const password = env("OPENCODE_PASSWORD");
  if (!password) {
    throw new Error("OPENCODE_PASSWORD is required");
  }
  await checkAgent(baseUrl, password);
  await checkProviderOverlay(baseUrl, password);
  await checkMcp(env("MCP_URL"), env("REMINDERS_MCP_TOKEN"));
  await checkModernMcp(env("MCP_URL"), env("REMINDERS_MCP_TOKEN"));
  console.log("contract: passed");
}

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entrypoint === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`contract: failed: ${message(error)}`);
    process.exit(1);
  });
}
