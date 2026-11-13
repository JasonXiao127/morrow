# Agent (M4)

The assistant is optional. Morrow's tasks, recurrence, scheduler, push, backup,
and restore work with the sidecar removed. `packages/agent` is the OpenCode shim
inside the app server: it owns the pinned client, session/conversation mapping,
MCP tools, prompts, policy, quotas, capture fallback, and plan-my-day. The
browser never receives an OpenCode URL or credential.

## Sidecar

- Image: `ghcr.io/anomalyco/opencode:2.2.5` (pin by digest in production).
- Command: `opencode serve --hostname 0.0.0.0 --port 4096`.
- Private `agent` Docker network only. Do not publish 4096 or 3001 or proxy
  them through the TLS front door (Caddy, Tailscale Serve, or an external
  proxy).
- Basic auth (`OPENCODE_PASSWORD`); no host mounts beyond the read-only
  `/workspace` config/prompt and the read-only provider overlay/key volumes; no
  Docker socket; `app-data` (SQLite/backups) is not mounted.
- `config/opencode.jsonc` defines the `reminders` primary agent, deny-by-default
  permissions with `morrow_reminders_*` allowed, explicit shell/edit/read/webfetch/
  websearch deny policies, and the remote MCP server with `protocol: "auto"`,
  `codemode: false`, `oauth: false`, and 30 s startup/catalog/execution
  timeouts. The system prompt is `packages/agent/prompts/reminders.md`, mounted
  read-only at `/workspace/prompts/reminders.md`.
- The app passes the model per OpenCode session; the config does not pin one.
- OpenCode prefixes MCP tool names with the server key. The server is keyed
  `morrow`, so the model sees `morrow_reminders_*` while the MCP endpoint still
  exposes `reminders_*`. The prompt and permissions use the model-facing names.

Validate the config against the sidecar before/after upgrading:

```bash
OPENCODE_CONFIG=$PWD/config/opencode.jsonc opencode debug config
```

## Model setup (Settings → AI)

API-key providers are managed in **Settings → AI → Providers** (M4.1). The app
stores provider metadata and a 0600 key file; the OpenCode sidecar owns every
model request. No Morrow route calls a model.

1. Open **Settings → AI → Providers → Add provider**.
2. Pick a preset (or **Custom OpenAI-compatible**) and confirm the endpoint and
   label. The preset table below lists the exact `providerId`, base URL, and
   whether a key is required. Custom defaults the `providerId` to `custom`; you
   may choose another slug (for example `acme`) on the API.
3. Paste the API key. It is write-only: the app writes
   `SECRETS_DIR/providers/<providerId>.key` atomically with mode 0600 and keeps
   only the SHA-256 fingerprint and last four characters in SQLite. The key is
   never returned, audited, included in a JSON backup, or logged.
4. Enter your Morrow password for step-up (10-minute freshness), then **Save
   provider**. The app writes the credential row and re-renders the OpenCode
   overlay, so the sidecar sees the provider without a restart.
5. The wizard immediately runs **Test** and, on success, **Refresh models**
   (`GET {baseUrl}/models`). A failed test does not discard the row; fix the
   endpoint or key and test again. Model IDs can also be entered by hand.
6. Choose a model under **Chat model**. The selector lists only models whose
   `capabilities.tools` is true. Saving re-validates the provider/model/variant
   through the app's `/api/model` proxy; the browser never receives the sidecar
   URL or credential.
7. Status must read `ready`. The model is passed to each conversation session.

The save is the commit point, the test follows it, and the model choice is a
separate step. A provider can be saved and tested successfully before any model
is selected; the assistant then uses the sidecar default, if one is configured.

| Preset | `providerId` | Base URL | Key | Notes |
|---|---|---|---|---|
| OpenAI | `openai` | `https://api.openai.com/v1` | required | ChatGPT Plus/Pro OAuth is CLI-only. |
| OpenCode | `opencode` | `https://opencode.ai/inference/openai/v1` | required | OpenCode inference key. |
| OpenCode Go | `opencode-go` | `https://opencode.ai/inference/go/openai/v1` | required | OpenCode Go key. |
| OpenRouter | `openrouter` | `https://openrouter.ai/api/v1` | required | One key, many models. |
| DeepSeek | `deepseek` | `https://api.deepseek.com/v1` | required | |
| Groq | `groq` | `https://api.groq.com/openai/v1` | required | |
| Ollama (local) | `ollama` | `http://127.0.0.1:11434/v1` | optional | Needs `ALLOW_PRIVATE_PROVIDER_URLS=true`; use `host.docker.internal` inside Docker. |
| LM Studio (local) | `lmstudio` | `http://127.0.0.1:1234/v1` | optional | Same private-URL flag and Docker host note. |
| Custom OpenAI-compatible | `custom` (or chosen slug) | hand-typed | optional | `npm` is fixed to `@ai-sdk/openai-compatible`; private hosts need the flag. |

Custom providers and local providers may be keyless. Built-in presets keep
`npm: null` so the sidecar's own provider metadata and catalog stay
authoritative; only local/custom entries declare the OpenAI-compatible package.

### OAuth stays in the CLI

Subscription OAuth is not app-managed and never becomes a Morrow credential
row. Sign in on the host or in the sidecar:

```bash
docker compose exec -it opencode opencode auth login
```

CLI-only providers are:

- ChatGPT Plus/Pro (OpenAI OAuth)
- GitHub Copilot
- GitLab Duo

Morrow's provider list reports this honestly under `oauth` in
`GET /api/providers`; the Settings panel links to the CLI command instead of
offering an OAuth button. Sidecar auth is stored in the `opencode-data` volume
(`~/.local/share/opencode/auth.json`), not in the app database or backup.

### Local models (Ollama, LM Studio)

Local presets use `http://` and a private/loopback host, so
`ALLOW_PRIVATE_PROVIDER_URLS=true` is required. From inside a container,
`127.0.0.1` is the container itself, not the host. Add
`host.docker.internal:host-gateway` to **both** the app and sidecar containers
(the app runs the probe, the sidecar runs inference), and use:

```text
http://host.docker.internal:11434/v1   # Ollama
http://host.docker.internal:1234/v1    # LM Studio
```

The model host must listen beyond loopback. `docs/RUNBOOK.md` has the exact
Ollama/LM Studio networking, firewall, and verification steps.

If the model list is empty, no provider/model is connected or discovery has not
run. If the status is `model_not_tool_capable`, choose a different model. If
`contract_mismatch`, the sidecar version and the pinned `@opencode/client` do
not match; update both.

A model can also be supplied by the sidecar default. The UI's "Use the sidecar
default" option clears the explicit `ai.model` setting. Deleting a provider
clears `ai.model` only when the selected model belongs to that provider
(`providerId` or `providerId/...`).

A **fallback model** can be saved alongside the chat model. Morrow does not
switch silently: the fallback appears in Settings → AI, can be applied with
**Use fallback now**, and takes effect in a **new conversation** (a fresh
OpenCode session). The assistant error banner links straight to model settings
so a provider quota/outage is recoverable without digging through logs.

**Proposal previews** include the fields a reviewer needs: due date/time,
all-day, priority, notes, reminder offsets, and recurrence (`rrule`,
`dtstartLocal`, until/count, mode, week start, clamp policy). **Tool activity**
from mutating tools (`create/update/complete/snooze/skip/propose`) is persisted
as compact transcript cards; read-only lookups stay live-only.

AI-off paths:

- No `OPENCODE_URL`, or `ai.enabled = false`: status is `not_configured` or
  `disabled`; chat returns a typed 503/problem; capture and plan-my-day still
  use deterministic code; all M0–M3 features continue.
- Sidecar unreachable: status is `unreachable`; no reminder mutation is
  attempted.
- No Morrow provider rows: Settings → Providers is empty. The assistant may
  still use a CLI OAuth/global-config provider, but nothing is managed here.
  Tasks, recurrence, scheduler, push, backup/restore, search, and the PWA are
  unaffected.
- `PROVIDERS_ENABLED=false` blocks provider *changes* (create, rotate, delete,
  discover) with a 503; reads and tests keep working. It does **not** stop the
  sidecar from using an already-rendered overlay. To stop assistant traffic,
  use `ai.enabled=false`, blank `OPENCODE_URL`, or stop the sidecar.

### Traffic rule

- The browser talks only to same-origin `/api`. The sidecar URL, basic-auth
  password, MCP bearer, and provider keys never reach the browser.
- The app server talks to the sidecar over the private `agent` network for
  status, model catalog, sessions, capture, and plan-my-day. It never forwards
  raw sidecar events or endpoints to the client.
- Provider **Test** and **Discover models** are the only app-originated
  requests to a provider. They are bounded `GET {baseUrl}/models` probes (5 s,
  no redirects, 1 MiB cap, at most 500 models), not inference. All completions
  go through the sidecar using the overlay.
- The app reads a key only for a bounded probe. The sidecar reads the key
  through `{file:/abs/path}` in the overlay. It never enters SQLite, the
  overlay text, an API response, an audit row, a backup, or a log.

## Sessions, events, resync

- One interactive OpenCode session per `agent_conversations` row.
- The app subscribes to OpenCode `/api/event` once and projects safe events
  (text deltas, tool names, run state, usage) to the browser's assistant SSE.
  Reasoning, tool arguments, file paths, credentials, and raw endpoints are
  never forwarded.
- Events are live-only. The app resyncs the transcript with `message.list`
  after a run and after every event-stream reconnect; `GET .../stream` also
  sends a snapshot and replays a small in-memory ring by `Last-Event-ID`.
- `session.wait` is wrapped in a 90 s deadline; timeout interrupts the session.
- Current date/time/timezone is written with
  `experimental.session.instructions.entry.put` (key `morrow.context`) and is
  also repeated in the first prompt so older builds are safe.

## Policy and quotas

Immediate, audited, undoable (single item):

`morrow_reminders_create`, `morrow_reminders_update` (ordinary fields), `morrow_reminders_complete`,
`morrow_reminders_snooze`, `morrow_reminders_skip`.

Proposal + approval:

Any batch, delete, recurrence change, list move, or more than one item. There
is no delete tool; deletions can only be `morrow_reminders_propose` operations and are
executed by `POST /api/proposals/:id/apply`.

Limits: 10 immediate writes per run; 20 proposal operations (pending proposals
count); 30 tool calls per minute per OpenCode session. Every write stores actor,
session, before/after snapshot, batch ID, and summary in `activity`.

## Capture and plan-my-day

- `POST /api/capture/parse` keeps M1's deterministic parser. The M4 pre-handler
  only takes over `ai: true` / `mode: "auto"|"model"`, calls
  `experimental.generate.text` with a JSON-only instruction, validates the
  result, and falls back to deterministic parsing on any model failure.
- `POST /api/assistant/plan-my-day` builds a deterministic proposal from
  overdue, today, and unscheduled tasks. It never writes directly.

## Contract test (pinned 2.2.5)

The contract test checks the sidecar version, the `reminders` agent's
permissions, that the system prompt loaded, and (when `MCP_URL` is reachable)
that the MCP handshake exposes only the 11 `reminders_*` tools with no delete,
shell, read, edit, webfetch, or websearch tool.

```bash
pnpm --filter @morrow/agent build
OPENCODE_URL=http://127.0.0.1:4096 \
OPENCODE_PASSWORD="$OPENCODE_PASSWORD" \
MCP_URL=http://127.0.0.1:3001/mcp \
REMINDERS_MCP_TOKEN="$REMINDERS_MCP_TOKEN" \
pnpm --filter @morrow/agent contract
```

Run the sidecar locally with the same config if you are not using Compose:

```bash
docker run --rm -p 127.0.0.1:4096:4096 \
  -e OPENCODE_PASSWORD="$OPENCODE_PASSWORD" \
  -e OPENCODE_CONFIG=/workspace/opencode.jsonc \
  -v "$PWD/config/opencode.jsonc:/workspace/opencode.jsonc:ro" \
  -v "$PWD/packages/agent/prompts:/workspace/prompts:ro" \
  ghcr.io/anomalyco/opencode:2.2.5 \
  serve --hostname 0.0.0.0 --port 4096
```

This minimal run mounts only the workspace config, so it has no provider
overlay. Use Compose or add the `opencode-providers`/`opencode-secrets` mounts
(and `OPENCODE_CONFIG`) from `docs/MCP.md` when you need Settings → Providers to
reach this sidecar.

The command exits non-zero on a version, agent, permission, prompt, or tool
surface mismatch. It does not send a model prompt.

## Local harness (2.2.5 field-test)

Development uses a dedicated pinned `2.2.5` sidecar, separate from the
production Compose sidecar. Do not reuse the running OpenChamber server on
`127.0.0.1:39271`: it is OpenCode 2.2.4 and uses that session, not the app's
`reminders` agent. Do not use `*-free` models for acceptance; the free tier
was exhausted during field testing.

- Config: `config/opencode.harness.jsonc` (production `config/opencode.jsonc`
  unchanged). Same `reminders` agent, deny-by-default permissions,
  shell/edit/read/webfetch/websearch deny policies, and prompt
  `{file:/workspace/prompts/reminders.md}`. MCP points at
  `http://127.0.0.1:3001/mcp` with `Bearer {env:REMINDERS_MCP_TOKEN}`.
  A local Ollama provider block is included; adjust the model to a
  TOOL-CAPABLE one you pulled.
- Launcher: `deploy/harness.sh` (requires `OPENCODE_PASSWORD` and
  `REMINDERS_MCP_TOKEN`, both harness-only secrets). Runtime state lives in
  `$HOME/.morrow-harness/` (outside the repo). Supports `--stop`, `--logs`,
  `--status`, and refuses to start when the image is not 2.2.5.
- Ports: `4098` (sidecar) and `3001` (app MCP) on localhost only; never
  exposed publicly. The app rejects wildcard MCP hosts.
- App env for a local run: `DATABASE_PATH=/tmp/morrow-harness/app.db`,
  `SECRETS_DIR=/tmp/morrow-harness/secrets`, `SETUP_TOKEN=harness-setup-token`,
  `PORT=4605`, `APP_URL=http://127.0.0.1:4605`,
  `OPENCODE_URL=http://127.0.0.1:4098`, `OPENCODE_PASSWORD=<harness password>`,
  `OPENCODE_WORKSPACE=/workspace`, `MCP_ENABLED=true`, `MCP_HOST=127.0.0.1`,
  `MCP_PORT=3001`, `REMINDERS_MCP_TOKEN=<harness token>`. Then
  `pnpm -r build && node apps/server/dist/index.js`.
- Model requirement: a local tool-capable model (Ollama/LM Studio) or an
  existing OpenCode auth provider. `GET /api/assistant/status` must report
  ready and the model before live acceptance.
- Tests: contract (`OPENCODE_URL=http://127.0.0.1:4098 ... pnpm --filter
  @morrow/agent contract`), live/tool prompts (`node
  deploy/harness-smoke.mjs`), and the no-token stub provider
  (`node packages/agent/test/stub-provider.mjs`, live mode when the sidecar
  lists a `stub` provider).
- Failures are honest: a provider 429 surfaces its real message
  (`assistant.run.failed` carries `{code, status, retryAfterMs}`), persists
  as the conversation's `lastError` until a successful run or dismissal, and
  the assistant panel shows a dismissible banner that survives reload.
- Vision: `AgentModelSummary` carries `input: string[]` and
  `vision: boolean`; Settings → AI shows “Reads images” or “Text only” next
  to the selected model. Attachments need image input; text-only models stay
  selectable for text chat.
