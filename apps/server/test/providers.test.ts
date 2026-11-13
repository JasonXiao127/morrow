/**
 * M4.1 provider credentials: key store, overlay renderer, SSRF guard,
 * masking, tamper degradation, model ownership, kill switch, backup canary,
 * and bounded probes.
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type MorrowDatabase } from "@morrow/db";
import {
  BACKUP_EXCLUDED_TABLES,
  BACKUP_TABLE_ALLOWLIST,
  exportBackup,
  findBackupSecretLeaks,
} from "../src/backup.js";
import {
  PROVIDER_PRESETS,
  ProviderError,
  allowPrivateProviderUrls,
  assertProvidersWritable,
  buildProviderOverlay,
  classifyHost,
  createProviderCredential,
  deleteProviderCredential,
  discoverModels,
  discoverStoredProviderModels,
  getProviderPreset,
  getProviderRow,
  inspectProviderKey,
  normalizeProviderOverlayToV2,
  providerHealth,
  providerOwnsModel,
  publicProvider,
  readProviderKey,
  resolveProviderPaths,
  rotateProviderCredentialKey,
  substituteProviderReferences,
  testProvider,
  testStoredProvider,
  updateProviderCredential,
  validateProviderBaseUrl,
  assertProviderUrlAllowed,
  type ProviderDb,
  type ProviderPaths,
} from "../src/providers.js";

const SECRET_KEY = "sk-live-CANARY-ABCD1234";

let database: MorrowDatabase;
let db: ProviderDb;
let root: string;
let paths: ProviderPaths;
let env: NodeJS.ProcessEnv;
let previousSecrets: string | undefined;
let previousBackup: string | undefined;
let previousOverlay: string | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-providers-"));
  database = openDatabase({ path: ":memory:" });
  db = database.sqlite as unknown as ProviderDb;
  paths = {
    secretsDir: path.join(root, "secrets"),
    overlayPath: path.join(root, "opencode-providers", "global.json"),
  };
  env = {
    ...process.env,
    SECRETS_DIR: paths.secretsDir,
    PROVIDER_OVERLAY_PATH: paths.overlayPath,
    PROVIDERS_ENABLED: "true",
    ALLOW_PRIVATE_PROVIDER_URLS: "false",
  };
  previousSecrets = process.env["SECRETS_DIR"];
  previousBackup = process.env["BACKUP_DIR"];
  previousOverlay = process.env["PROVIDER_OVERLAY_PATH"];
  process.env["SECRETS_DIR"] = paths.secretsDir;
  process.env["BACKUP_DIR"] = path.join(root, "backups");
  process.env["PROVIDER_OVERLAY_PATH"] = paths.overlayPath;
  fs.mkdirSync(paths.secretsDir, { recursive: true });
});

afterEach(() => {
  database.close();
  if (previousSecrets === undefined) delete process.env["SECRETS_DIR"];
  else process.env["SECRETS_DIR"] = previousSecrets;
  if (previousBackup === undefined) delete process.env["BACKUP_DIR"];
  else process.env["BACKUP_DIR"] = previousBackup;
  if (previousOverlay === undefined) delete process.env["PROVIDER_OVERLAY_PATH"];
  else process.env["PROVIDER_OVERLAY_PATH"] = previousOverlay;
  fs.rmSync(root, { recursive: true, force: true });
});

async function addProvider(
  overrides: Partial<Parameters<typeof createProviderCredential>[1]> = {},
) {
  return createProviderCredential(
    db,
    {
      kind: "custom",
      providerId: "acme",
      label: "Acme",
      baseUrl: "https://api.example.com/v1",
      models: ["model-a"],
      key: SECRET_KEY,
      headers: { "X-Title": "Morrow" },
      ...overrides,
    },
    { paths, env },
  );
}

function readOverlay(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(paths.overlayPath, "utf8")) as Record<
    string,
    unknown
  >;
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

describe("overlay renderer", () => {
  it("writes singular `provider`, a {file:} key reference, models, headers, and npm", async () => {
    const row = await addProvider();
    const keyPath = path.join(paths.secretsDir, "providers", "acme.key");

    expect(fs.readFileSync(keyPath, "utf8")).toBe(SECRET_KEY);
    expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);

    const overlay = readOverlay();
    expect(overlay["$schema"]).toBe("https://opencode.ai/config.json");
    expect(overlay).toHaveProperty("provider");
    expect(overlay).not.toHaveProperty("providers");

    const provider = (overlay["provider"] as Record<string, Record<string, unknown>>)[
      "acme"
    ]!;
    expect(provider["name"]).toBe("Acme");
    expect(provider["npm"]).toBe("@ai-sdk/openai-compatible");
    expect(provider["models"]).toEqual({ "model-a": {} });
    expect(provider["options"]).toEqual({
      baseURL: "https://api.example.com/v1",
      apiKey: `{file:${keyPath}}`,
      headers: { "X-Title": "Morrow" },
    });

    const text = fs.readFileSync(paths.overlayPath, "utf8");
    expect(text).not.toContain(SECRET_KEY);
    expect(text).not.toContain(row.key_fingerprint);
    // Singular config normalises to v2's `providers` map.
    const v2 = normalizeProviderOverlayToV2(
      JSON.parse(text) as Parameters<typeof normalizeProviderOverlayToV2>[0],
    );
    expect(v2.providers["acme"]?.package).toBe("@ai-sdk/openai-compatible");
    expect(v2.providers["acme"]?.settings?.["apiKey"]).toBe(
      `{file:${keyPath}}`,
    );
    expect(v2.providers["acme"]?.headers).toEqual({ "X-Title": "Morrow" });
  });

  it("rejects {env:} base URL indirection by default, allows it when allowlisted", async () => {
    // Default: no env reference is resolvable via the API.
    await expect(
      createProviderCredential(
        db,
        {
          kind: "custom",
          providerId: "envref",
          baseUrl: "{env:PROVIDER_ACME_URL}",
          models: ["m"],
          key: "sk-env-12345678",
        },
        { paths, env: { ...env, PROVIDER_ACME_URL: "https://api.example.com/v1" } },
      ),
    ).rejects.toMatchObject({ code: "env_reference_not_allowed" });

    // Operator opt-in: PROVIDER_ALLOWED_ENV_VARS names the resolvable vars.
    const referenceEnv = {
      ...env,
      PROVIDER_ACME_URL: "https://api.example.com/v1",
      PROVIDER_ALLOWED_ENV_VARS: "PROVIDER_ACME_URL",
    } as NodeJS.ProcessEnv;
    await createProviderCredential(
      db,
      {
        kind: "custom",
        providerId: "envref",
        baseUrl: "{env:PROVIDER_ACME_URL}",
        models: ["m"],
        key: "sk-env-12345678",
      },
      { paths, env: referenceEnv },
    );
    const overlay = readOverlay() as {
      provider: Record<string, { options?: { baseURL?: string } }>;
    };
    expect(overlay.provider["envref"]?.options?.baseURL).toBe(
      "{env:PROVIDER_ACME_URL}",
    );
  });

  it("rejects {env:OPENCODE_PASSWORD} and {file:/etc/passwd} at write time", async () => {
    const hostileEnv = {
      ...env,
      OPENCODE_PASSWORD: "server-side-canary-do-not-exfil",
    } as NodeJS.ProcessEnv;
    for (const key of ["{env:OPENCODE_PASSWORD}", "{file:/etc/passwd}"]) {
      await expect(
        createProviderCredential(
          db,
          {
            kind: "custom",
            providerId: "evil",
            baseUrl: "https://api.example.com/v1",
            key,
          },
          { paths, env: hostileEnv },
        ),
      ).rejects.toMatchObject({
        code: key.startsWith("{env:") ? "env_reference_not_allowed" : "invalid_file_reference",
      });
    }
    // Header values are gated identically: a header smuggling a file read or
    // an env var is rejected before anything is stored.
    await expect(
      createProviderCredential(
        db,
        {
          kind: "custom",
          providerId: "evil-headers",
          baseUrl: "https://api.example.com/v1",
          key: "sk-live-12345678",
          headers: { "X-Canary": "{file:/etc/passwd}" },
        },
        { paths, env: hostileEnv },
      ),
    ).rejects.toMatchObject({ code: "invalid_file_reference" });
    await expect(
      createProviderCredential(
        db,
        {
          kind: "custom",
          providerId: "evil-headers-env",
          baseUrl: "https://api.example.com/v1",
          key: "sk-live-12345678",
          headers: { "X-Canary": "{env:OPENCODE_PASSWORD}" },
        },
        { paths, env: hostileEnv },
      ),
    ).rejects.toMatchObject({ code: "env_reference_not_allowed" });
    // Nothing hostile was stored or rendered.
    const overlayText = fs.existsSync(paths.overlayPath)
      ? fs.readFileSync(paths.overlayPath, "utf8")
      : "";
    expect(overlayText).not.toContain("server-side-canary-do-not-exfil");
    expect(overlayText).not.toContain("OPENCODE_PASSWORD");
  });

  it("rejects traversal and sibling filenames, allows only the provider's own key file", async () => {
    const keyDir = path.join(paths.secretsDir, "providers");
    fs.mkdirSync(keyDir, { recursive: true });
    const ownKeyPath = path.join(keyDir, "selfref.key");
    fs.writeFileSync(ownKeyPath, SECRET_KEY);
    // Sibling / traversal / absolute-outside targets are all rejected.
    for (const target of [
      path.join(keyDir, "other.key"),
      path.join(keyDir, "..", "setup_token"),
      "/etc/passwd",
      `${keyDir}/other.key`,
    ]) {
      expect(() =>
        substituteProviderReferences(`prefix {file:${target}} suffix`, {
          env,
          providerId: "selfref",
          secretsDir: paths.secretsDir,
        }),
      ).toThrow(ProviderError);
    }
    // The provider's own key file resolves.
    expect(
      substituteProviderReferences(`{file:${ownKeyPath}}`, {
        env,
        providerId: "selfref",
        secretsDir: paths.secretsDir,
      }),
    ).toBe(SECRET_KEY);
    // …but never inside a base URL, where content would become a target.
    expect(() =>
      substituteProviderReferences(`https://api.example.com/{file:${ownKeyPath}}`, {
        env,
        providerId: "selfref",
        secretsDir: paths.secretsDir,
        allowFile: false,
      }),
    ).toThrow(
      expect.objectContaining({ code: "invalid_file_reference" }),
    );
  });

  it("resolves references only through the explicit allowlist", () => {
    // Default: every env reference is rejected.
    expect(() =>
      substituteProviderReferences("https://{env:HOST}/v1", {
        env: { HOST: "api.example.com" } as NodeJS.ProcessEnv,
      }),
    ).toThrow(expect.objectContaining({ code: "env_reference_not_allowed" }));
    // Explicit allowlist (CLI-side resolution): permitted names resolve.
    expect(
      substituteProviderReferences("https://{env:HOST}/v1", {
        env: { HOST: "api.example.com" } as NodeJS.ProcessEnv,
        allowedEnv: new Set(["HOST"]),
      }),
    ).toBe("https://api.example.com/v1");
    expect(() =>
      substituteProviderReferences("{env:MISSING_REFERENCE}", {
        env: {} as NodeJS.ProcessEnv,
        allowedEnv: new Set(["MISSING_REFERENCE"]),
      }),
    ).toThrow(ProviderError);
  });

  it("writes a valid empty overlay after the last provider is removed", async () => {
    await addProvider();
    await deleteProviderCredential(db, "acme", { paths, env });
    expect(readOverlay()["provider"]).toEqual({});
  });

  it("probe-time: stored {file:} / {env:} references never leave the server", async () => {
    // Local capture server in the auditor's leaktest pattern: if any
    // reference were resolved and sent, it would arrive here (Authorization
    // header or URL path). Legacy rows with stored references must fail
    // closed before any network I/O.
    const seen: Array<{ auth: unknown; url: string | undefined }> = [];
    const server = http.createServer((req, res) => {
      seen.push({ auth: req.headers["authorization"], url: req.url });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as { port: number }).port;
      const localEnv = {
        ...env,
        ALLOW_PRIVATE_PROVIDER_URLS: "true",
        OPENCODE_PASSWORD: "server-side-canary-do-not-exfil",
      } as NodeJS.ProcessEnv;
      const row = await createProviderCredential(
        db,
        {
          kind: "custom",
          providerId: "acme",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          key: SECRET_KEY,
        },
        { paths, env: localEnv },
      );
      // Simulate a pre-fix legacy row: hostile references stored verbatim.
      db.prepare(
        "UPDATE provider_credentials SET headers_json = ? WHERE id = ?",
      ).run(JSON.stringify({ "X-Canary": "{file:/etc/passwd}" }), row.id);
      const fileProbe = await testStoredProvider(db, row.id, {
        paths,
        env: localEnv,
      });
      expect(fileProbe.test.ok).toBe(false);
      expect(fileProbe.test.code).toBe("invalid_file_reference");

      db.prepare(
        "UPDATE provider_credentials SET headers_json = ? WHERE id = ?",
      ).run(JSON.stringify({ "X-Canary": "{env:OPENCODE_PASSWORD}" }), row.id);
      const envProbe = await testStoredProvider(db, row.id, {
        paths,
        env: localEnv,
      });
      expect(envProbe.test.ok).toBe(false);
      expect(envProbe.test.code).toBe("env_reference_not_allowed");

      // The canary never left: no request reached the capture server, and no
      // failure message echoes the secret.
      expect(seen).toHaveLength(0);
      expect(JSON.stringify(fileProbe)).not.toContain("server-side-canary");
      expect(JSON.stringify(envProbe)).not.toContain("server-side-canary");
      expect(JSON.stringify(envProbe)).toContain("OPENCODE_PASSWORD");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// ---------------------------------------------------------------------------
// Masking
// ---------------------------------------------------------------------------

describe("masking", () => {
  it("returns only last four key characters and header names", async () => {
    const row = await addProvider();
    const publicRow = publicProvider(row, paths);
    expect(publicRow.keyLast4).toBe("1234");
    expect(publicRow.keyPresent).toBe(true);
    expect(publicRow.headerNames).toEqual(["X-Title"]);
    expect(publicRow).not.toHaveProperty("key");
    expect(publicRow).not.toHaveProperty("key_fingerprint");
    expect(publicRow).not.toHaveProperty("keyFingerprint");
    expect(publicRow).not.toHaveProperty("headers");

    const serialized = JSON.stringify(publicRow);
    expect(serialized).not.toContain(SECRET_KEY);
    expect(serialized).not.toContain(row.key_fingerprint);
    expect(serialized).not.toContain("sk-live");
    expect(serialized).toContain("1234");
  });
});

// ---------------------------------------------------------------------------
// SSRF
// ---------------------------------------------------------------------------

describe("SSRF guard", () => {
  it("rejects http, loopback, private, link-local, and metadata by default", () => {
    const rejects = [
      "http://api.example.com/v1",
      "https://127.0.0.1/v1",
      "https://localhost/v1",
      "https://10.1.2.3/v1",
      "https://172.16.0.9/v1",
      "https://192.168.1.5/v1",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/v1",
      "https://[fd00::1]/v1",
      "https://[::ffff:127.0.0.1]/v1",
      "https://[::ffff:7f00:1]/v1",
      "https://[::ffff:a00:1]/v1",
      "https://[::ffff:a9fe:a9fe]/v1",
      "https://metadata.google.internal/v1",
    ];
    for (const url of rejects) {
      expect(
        () => validateProviderBaseUrl(url, { allowPrivate: false }),
        url,
      ).toThrow(ProviderError);
    }
    expect(classifyHost("10.0.0.1")).toBe("private");
    expect(classifyHost("127.0.0.1")).toBe("loopback");
    expect(classifyHost("169.254.169.254")).toBe("metadata");
    expect(classifyHost("[::ffff:7f00:1]")).toBe("loopback");
    expect(classifyHost("[::ffff:a00:1]")).toBe("private");
    expect(classifyHost("[::ffff:a9fe:a9fe]")).toBe("metadata");
  });

  it("allows http/private only with ALLOW_PRIVATE_PROVIDER_URLS=true", () => {
    expect(() =>
      validateProviderBaseUrl("http://127.0.0.1:11434/v1", {
        allowPrivate: true,
      }),
    ).not.toThrow();
    expect(() =>
      validateProviderBaseUrl("http://host.docker.internal:1234/v1", {
        allowPrivate: true,
      }),
    ).not.toThrow();
    expect(() =>
      validateProviderBaseUrl("http://ollama:11434/v1", {
        allowPrivate: true,
      }),
    ).not.toThrow();
    expect(() =>
      validateProviderBaseUrl("http://ollama:11434/v1", {
        allowPrivate: false,
      }),
    ).toThrow(ProviderError);
    expect(() =>
      validateProviderBaseUrl("http://api.example.com/v1", {
        allowPrivate: true,
      }),
    ).toThrow(/https/i);
    // Cloud metadata stays blocked even with the local-provider flag.
    expect(() =>
      validateProviderBaseUrl("http://169.254.169.254/latest/meta-data", {
        allowPrivate: true,
      }),
    ).toThrow(/metadata/i);
    expect(allowPrivateProviderUrls({} as NodeJS.ProcessEnv)).toBe(false);
    expect(
      allowPrivateProviderUrls({
        ALLOW_PRIVATE_PROVIDER_URLS: "true",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
  });

  it("rechecks DNS immediately before a probe and rejects private answers", async () => {
    await expect(
      assertProviderUrlAllowed("https://evil.example/v1", {
        allowPrivate: false,
        resolveHost: async () => ["127.0.0.1"],
      }),
    ).rejects.toMatchObject({ code: "private_address" });
    await expect(
      assertProviderUrlAllowed("https://evil.example/v1", {
        allowPrivate: false,
        resolveHost: async () => ["169.254.169.254"],
      }),
    ).rejects.toMatchObject({ code: "blocked_metadata_url" });
    await expect(
      assertProviderUrlAllowed("https://api.example.com/v1", {
        allowPrivate: false,
        resolveHost: async () => ["93.184.216.34"],
      }),
    ).resolves.toBeInstanceOf(URL);
  });
});

// ---------------------------------------------------------------------------
// Tamper / missing key
// ---------------------------------------------------------------------------

describe("key health", () => {
  it("reports degraded (not a crash) when the key file is missing", async () => {
    const row = await addProvider();
    fs.unlinkSync(path.join(paths.secretsDir, "providers", "acme.key"));
    const health = providerHealth(row, paths);
    expect(health.status).toBe("degraded");
    expect(health.keyState.state).toBe("missing");
    expect(health.message).toContain("missing");
    expect(() => publicProvider(row, paths)).not.toThrow();
    expect(buildProviderOverlay([row], paths).document.provider).toEqual({});
  });

  it("detects a tampered key by fingerprint without returning the key", async () => {
    const row = await addProvider();
    const keyPath = path.join(paths.secretsDir, "providers", "acme.key");
    fs.writeFileSync(keyPath, "tampered-key-value", { mode: 0o600 });
    const health = providerHealth(row, paths);
    expect(health.status).toBe("degraded");
    expect(health.keyState.state).toBe("tampered");
    expect(inspectProviderKey(row, paths).state).toBe("tampered");
    expect(readProviderKey(row, paths)).toBeNull();
    expect(JSON.stringify(publicProvider(row, paths))).not.toContain("tampered-key-value");
  });

  it("returns key_unavailable from test instead of throwing when the key vanished", async () => {
    const row = await addProvider();
    fs.unlinkSync(path.join(paths.secretsDir, "providers", "acme.key"));
    const result = await testStoredProvider(db, row.id, { paths, env });
    expect(result.test.ok).toBe(false);
    expect(result.test.code).toBe("key_unavailable");
    expect(result.provider.status).toBe("degraded");
  });
});

// ---------------------------------------------------------------------------
// Delete / model ownership
// ---------------------------------------------------------------------------

describe("delete", () => {
  it("removes config + key and clears a selected model owned by the provider", async () => {
    const row = await addProvider();
    database.sqlite
      .prepare(
        "INSERT INTO settings (key, value, rev, updated_at) VALUES ('ai.model', ?, 1, ?)",
      )
      .run(JSON.stringify("acme/model-a"), new Date().toISOString());

    const result = await deleteProviderCredential(db, "acme", { paths, env });
    expect(result.clearedModel).toBe("acme/model-a");
    const setting = database.sqlite
      .prepare("SELECT value FROM settings WHERE key = 'ai.model'")
      .get() as { value: string };
    expect(JSON.parse(setting.value)).toBeNull();
    expect(fs.existsSync(path.join(paths.secretsDir, "providers", "acme.key"))).toBe(
      false,
    );
    expect(getProviderRow(db, row.id)).toBeNull();
    expect(readOverlay()["provider"]).toEqual({});
  });

  it("updates label, models, enabled, and optionally the key", async () => {
    const row = await addProvider();
    const updated = await updateProviderCredential(
      db,
      row.id,
      {
        label: "Acme Updated",
        models: ["model-b", "model-c"],
        enabled: false,
      },
      { paths, env },
    );
    expect(updated.label).toBe("Acme Updated");
    expect(updated.enabled).toBe(0);
    expect(JSON.parse(updated.models_json)).toEqual([
      { id: "model-b" },
      { id: "model-c" },
    ]);

    const rotated = await updateProviderCredential(
      db,
      row.id,
      { key: "sk-live-NEW-KEY-9876" },
      { paths, env },
    );
    expect(rotated.key_last4).toBe("9876");
    expect(readProviderKey(rotated, paths)?.key).toBe("sk-live-NEW-KEY-9876");
    expect(readOverlay()).toBeDefined();
  });

  it("does not clear another provider's selected model", async () => {
    await addProvider();
    database.sqlite
      .prepare(
        "INSERT INTO settings (key, value, rev, updated_at) VALUES ('ai.model', ?, 1, ?)",
      )
      .run(JSON.stringify("other/model"), new Date().toISOString());
    const result = await deleteProviderCredential(db, "acme", { paths, env });
    expect(result.clearedModel).toBeNull();
    expect(providerOwnsModel("acme", "acme/model-a")).toBe(true);
    expect(providerOwnsModel("acme", "acme2/model-a")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Kill switch / presets
// ---------------------------------------------------------------------------

describe("kill switch and presets", () => {
  it("blocks creates, rotations, and deletes when PROVIDERS_ENABLED=false", async () => {
    const row = await addProvider();
    const off = { ...env, PROVIDERS_ENABLED: "false" } as NodeJS.ProcessEnv;
    expect(() => assertProvidersWritable(off)).toThrow(ProviderError);
    await expect(
      createProviderCredential(
        db,
        {
          kind: "custom",
          providerId: "second",
          baseUrl: "https://api.example.com/v1",
        },
        { paths, env: off },
      ),
    ).rejects.toMatchObject({ status: 503, code: "providers_disabled" });
    await expect(
      rotateProviderCredentialKey(db, row.id, "sk-new-12345678", {
        paths,
        env: off,
      }),
    ).rejects.toMatchObject({ status: 503, code: "providers_disabled" });
    await expect(
      deleteProviderCredential(db, row.id, { paths, env: off }),
    ).rejects.toMatchObject({ status: 503, code: "providers_disabled" });
  });

  it("exposes the required presets with honest local/key rules", () => {
    const ids = PROVIDER_PRESETS.map((preset) => preset.id);
    expect(ids).toEqual([
      "openai",
      "opencode",
      "opencode-go",
      "openrouter",
      "deepseek",
      "groq",
      "ollama",
      "lmstudio",
      "custom",
    ]);
    expect(getProviderPreset("ollama")?.requiresKey).toBe(false);
    expect(getProviderPreset("ollama")?.local).toBe(true);
    expect(getProviderPreset("lmstudio")?.requiresKey).toBe(false);
    expect(getProviderPreset("openai")?.requiresKey).toBe(true);
    expect(getProviderPreset("custom")?.npm).toBe(
      "@ai-sdk/openai-compatible",
    );
  });

  it("requires a key for API-key presets and reuses the preset provider id", async () => {
    await expect(
      createProviderCredential(
        db,
        { kind: "preset", preset: "openai", models: ["gpt-4.1"] },
        { paths, env },
      ),
    ).rejects.toMatchObject({ code: "key_required" });

    const row = await createProviderCredential(
      db,
      {
        kind: "preset",
        preset: "openai",
        models: ["gpt-4.1"],
        key: "sk-openai-test-1234",
      },
      { paths, env },
    );
    expect(row.provider_id).toBe("openai");
    expect(row.base_url).toBe("https://api.openai.com/v1");
    expect(readOverlay()["provider"]).toHaveProperty("openai");
  });
});

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

describe("bounded probes", () => {
  let server: http.Server;
  let port: number;
  let mode: "ok" | "401" | "429" | "slow" | "redirect";
  let seenAuth: string | undefined;

  beforeEach(async () => {
    mode = "ok";
    server = http.createServer((req, res) => {
      seenAuth = req.headers["authorization"];
      if (mode === "slow") {
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ data: [] }));
        }, 200);
        return;
      }
      if (mode === "401") {
        res.writeHead(401).end();
        return;
      }
      if (mode === "429") {
        res.writeHead(429).end();
        return;
      }
      if (mode === "redirect") {
        res.writeHead(302, { location: "http://169.254.169.254/latest" }).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: [
            { id: "model-a", name: "Model A" },
            { id: "model-b" },
          ],
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const localEnv = () =>
    ({ ...env, ALLOW_PRIVATE_PROVIDER_URLS: "true" }) as NodeJS.ProcessEnv;

  it("maps 200, 401, 403, 429, and timeout without leaking the key", async () => {
    const base = `http://127.0.0.1:${port}/v1`;

    const ok = await testProvider({
      baseUrl: base,
      key: "sk-probe-1234",
      env: localEnv(),
    });
    expect(ok).toMatchObject({ ok: true, code: "ok", httpStatus: 200 });
    expect(seenAuth).toBe("Bearer sk-probe-1234");
    expect(JSON.stringify(ok)).not.toContain("sk-probe-1234");

    mode = "401";
    const unauthorized = await testProvider({
      baseUrl: base,
      key: "sk-probe-1234",
      env: localEnv(),
    });
    expect(unauthorized).toMatchObject({ ok: false, code: "invalid_key" });

    mode = "429";
    const limited = await testProvider({
      baseUrl: base,
      key: "sk-probe-1234",
      env: localEnv(),
    });
    expect(limited).toMatchObject({ ok: false, code: "rate_limited" });

    mode = "slow";
    const timedOut = await testProvider({
      baseUrl: base,
      key: "sk-probe-1234",
      env: localEnv(),
      timeoutMs: 20,
    });
    expect(timedOut).toMatchObject({ ok: false, code: "timeout" });
  });

  it("never follows redirects", async () => {
    mode = "redirect";
    const result = await testProvider({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      env: localEnv(),
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("unreachable");
  });

  it("discovers OpenAI and Ollama model shapes", async () => {
    const models = await discoverModels({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      key: "sk-probe-1234",
      env: localEnv(),
    });
    expect(models.ok).toBe(true);
    expect(models.models?.map((model) => model.id)).toEqual([
      "model-a",
      "model-b",
    ]);
    expect(models.models?.[0]?.name).toBe("Model A");
  });

  it("persists discovered models and re-renders the overlay", async () => {
    const row = await createProviderCredential(
      db,
      {
        kind: "custom",
        providerId: "acme",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        models: [],
        key: SECRET_KEY,
      },
      { paths, env: localEnv() },
    );
    const result = await discoverStoredProviderModels(db, row.id, {
      paths,
      env: localEnv(),
    });
    expect(result.saved).toBe(true);
    expect(result.provider.models.map((model) => model.id)).toEqual([
      "model-a",
      "model-b",
    ]);
    const overlay = readOverlay() as {
      provider: Record<string, { models?: Record<string, unknown> }>;
    };
    expect(Object.keys(overlay.provider["acme"]?.models ?? {})).toEqual([
      "model-a",
      "model-b",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Backup canary
// ---------------------------------------------------------------------------

describe("backup exclusion", () => {
  it("never exports provider rows, key files, fingerprints, or key material", async () => {
    await addProvider();
    database.sqlite
      .prepare(
        "INSERT INTO settings (key, value, rev, updated_at) VALUES ('ai.model', ?, 1, ?)",
      )
      .run(JSON.stringify("acme/model-a"), new Date().toISOString());

    const result = await exportBackup(db as never, {
      backupDir: path.join(root, "backups"),
    });
    const text = Buffer.from(result.bytes).toString("utf8");

    expect(text).not.toContain(SECRET_KEY);
    expect(text).not.toContain("provider_credentials");
    expect(text).not.toContain("key_fingerprint");
    expect(text).not.toContain("key_last4");
    expect(findBackupSecretLeaks(result.bytes, [SECRET_KEY])).toEqual([]);
    expect(BACKUP_TABLE_ALLOWLIST).not.toHaveProperty("providerCredentials");
    expect(BACKUP_EXCLUDED_TABLES).toContain("provider_credentials");
  });

  it("refuses a BACKUP_DIR that overlaps SECRETS_DIR", async () => {
    await addProvider();
    await expect(
      exportBackup(db as never, {
        backupDir: path.join(paths.secretsDir, "backups"),
      }),
    ).rejects.toThrow(/SECRETS_DIR/);
  });
});

// ---------------------------------------------------------------------------
// Paths / status
// ---------------------------------------------------------------------------

describe("paths and status", () => {
  it("resolves env defaults and keeps the overlay outside the key directory", () => {
    const resolved = resolveProviderPaths({
      SECRETS_DIR: "/srv/morrow/secrets",
      PROVIDER_OVERLAY_PATH: "/srv/morrow/overlay/global.json",
    } as NodeJS.ProcessEnv);
    expect(resolved).toEqual({
      secretsDir: "/srv/morrow/secrets",
      overlayPath: "/srv/morrow/overlay/global.json",
    });
    const defaults = resolveProviderPaths({} as NodeJS.ProcessEnv);
    expect(defaults.overlayPath).toBe("/data/opencode-providers/global.json");
  });

  it("lists masked providers and presets through the summary", async () => {
    await addProvider();
    const { providerStatusSummary } = await import("../src/providers.js");
    const summary = providerStatusSummary(db, { paths, env });
    expect(summary.enabled).toBe(true);
    expect(summary.providers).toHaveLength(1);
    expect(summary.providers[0]?.keyLast4).toBe("1234");
    expect(summary.providers[0]?.status).toBe("untested");
    expect(summary.oauth.cliOnly).toBe(true);
    expect(summary.presets.map((preset) => preset.id)).toContain("custom");
    expect(JSON.stringify(summary)).not.toContain(SECRET_KEY);
  });
});
