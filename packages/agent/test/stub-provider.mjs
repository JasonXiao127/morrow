#!/usr/bin/env node
/**
 * Stub-provider test (harness step 5).
 *
 * Serves an OpenAI-compatible `/v1/chat/completions` returning `pong`
 * (no streaming needed). Two modes:
 *
 * - CI (default, no sidecar): starts the stub, asserts `/v1/models` and
 *   `/v1/chat/completions` answer with the canned pong payload, and asserts
 *   a harness-only provider doc pointing at the stub parses as a valid
 *   singular-`provider` overlay. Spends no tokens, needs no sidecar.
 *
 * - Live (when OPENCODE_URL + OPENCODE_PASSWORD are set and the sidecar
 *   lists a `stub` provider): creates a session on `stub/pong`, sends
 *   "Say pong", waits, and asserts the assistant reply contains pong.
 *   Requires the operator to have added once to
 *   `$MORROW_HARNESS_DIR/opencode.jsonc`:
 *
 *     "provider": {
 *       "stub": {
 *         "name": "Stub (harness tests)",
 *         "npm": "@ai-sdk/openai-compatible",
 *         "options": { "baseURL": "http://127.0.0.1:<stub-port>/v1" },
 *         "models": { "pong": {} }
 *       }
 *     }
 *
 *   (Use `--write-config` to have this script patch the harness config
 *   automatically and print the stub URL to use.)
 *
 * Usage:
 *   node packages/agent/test/stub-provider.mjs [--write-config] [--port 0]
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const WRITE_CONFIG = args.includes("--write-config");
const portFlag = args.indexOf("--port");
const PREFERRED_PORT = portFlag >= 0 ? Number(args[portFlag + 1]) || 0 : 0;

const PONG = "pong";

function stubHandler(req, res) {
  const url = new URL(req.url || "/", "http://stub");
  if (req.method === "GET" && url.pathname === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        object: "list",
        data: [{ id: "pong", object: "model", created: 0, owned_by: "stub" }],
      }),
    );
    return;
  }
  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-stub",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "pong",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: PONG },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
}

async function main() {
  const server = http.createServer(stubHandler);
  await new Promise((resolve) => server.listen(PREFERRED_PORT, "127.0.0.1", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  console.log(`stub provider listening at ${baseUrl}`);

  try {
    // 1. Stub answers like an OpenAI-compatible provider.
    const models = await (await fetch(`${baseUrl}/models`)).json();
    if (!Array.isArray(models?.data) || models.data[0]?.id !== "pong") {
      throw new Error(`stub /v1/models mismatch: ${JSON.stringify(models).slice(0, 200)}`);
    }
    console.log("ok  stub /v1/models lists pong");

    const completion = await (
      await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "pong", messages: [{ role: "user", content: "Say pong." }] }),
      })
    ).json();
    const text = completion?.choices?.[0]?.message?.content;
    if (text !== PONG) throw new Error(`stub completion mismatch: ${JSON.stringify(completion).slice(0, 200)}`);
    console.log("ok  stub /v1/chat/completions returns pong");

    // 2. A harness-only provider doc pointing at the stub parses.
    const { parseProviderOverlay, providerFileRefs } = await import("../dist/contract.js");
    const doc = parseProviderOverlay({
      $schema: "https://opencode.ai/config.json",
      provider: {
        stub: {
          name: "Stub (harness tests)",
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: baseUrl },
          models: { pong: {} },
        },
      },
    });
    if (providerFileRefs(doc).length !== 0) throw new Error("stub overlay should have no {file:} refs");
    console.log("ok  harness-only stub provider parses as singular `provider`");

    if (WRITE_CONFIG) {
      const dir = process.env.MORROW_HARNESS_DIR || path.join(os.homedir(), ".morrow-harness");
      const file = path.join(dir, "opencode.jsonc");
      if (!fs.existsSync(file)) {
        console.log(`note: harness config not found at ${file}; not writing (start the harness first)`);
      } else {
        const raw = fs.readFileSync(file, "utf8");
        if (raw.includes('"stub"')) {
          console.log("ok  harness config already contains a stub provider");
        } else {
          console.log(`add to ${file} under the top-level object:\n`);
          console.log(
            `  "provider": { "stub": { "name": "Stub (harness tests)", "npm": "@ai-sdk/openai-compatible", "options": { "baseURL": "${baseUrl}" }, "models": { "pong": {} } } },`,
          );
          console.log("\nthen restart the harness and re-run without --write-config.");
        }
      }
    }

    // 3. Live prompt through the sidecar when it is reachable with a stub provider.
    const sidecarUrl = (process.env.OPENCODE_URL || "").trim();
    const password = (process.env.OPENCODE_PASSWORD || "").trim();
    if (!sidecarUrl || !password) {
      console.log("skip live session prompt (set OPENCODE_URL + OPENCODE_PASSWORD with a stub provider configured)");
      console.log("stub-provider: passed (offline)");
      return;
    }
    const { OpenCode } = await import("@opencode/client");
    const directory = (process.env.OPENCODE_WORKSPACE || "/workspace").trim() || "/workspace";
    const client = OpenCode.make({
      baseUrl: sidecarUrl.replace(/\/+$/, ""),
      headers: {
        authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
        "x-opencode-directory": encodeURIComponent(directory),
      },
    });
    const providers = await client.provider.list({ location: { directory } });
    const ids = providers.data.map((p) => String(p.id));
    if (!ids.includes("stub")) {
      console.log(`skip live session prompt (sidecar providers: ${ids.join(", ") || "none"}; add the stub provider first)`);
      console.log("stub-provider: passed (offline)");
      return;
    }
    const session = await client.session.create({
      agent: "reminders",
      title: "Stub smoke",
      model: { id: "pong", providerID: "stub" },
      location: { directory },
      permissions: [
        { action: "*", resource: "*", effect: "deny" },
        { action: "morrow_reminders_*", resource: "*", effect: "allow" },
      ],
    });
    await client.session.prompt({
      sessionID: session.id,
      text: "Say pong.",
      delivery: "queue",
    });
    const started = Date.now();
    let reply = "";
    while (Date.now() - started < 60_000) {
      await new Promise((r) => setTimeout(r, 1500));
      const listed = await client.message.list({ sessionID: session.id, limit: 20, order: "desc" });
      for (const m of listed.data) {
        if (m.type !== "assistant" || !Array.isArray(m.content)) continue;
        const textParts = m.content
          .filter((p) => p.type === "text" && typeof p.text === "string")
          .map((p) => p.text)
          .join("\n");
        if (textParts.toLowerCase().includes("pong")) reply = textParts;
      }
      if (reply) break;
    }
    if (!reply.toLowerCase().includes("pong")) {
      throw new Error("live stub prompt did not return pong within 60s");
    }
    console.log("ok  live session prompt via stub provider returns pong");
    console.log("stub-provider: passed (live)");
  } finally {
    server.close();
  }
}

main().catch((error) => {
  console.error(`stub-provider: failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
