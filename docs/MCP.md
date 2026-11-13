# MCP (M4)

The app runs a stateless Streamable HTTP MCP listener on port **3001**. It is
reachable only from the Docker `agent` network by the OpenCode sidecar. Never
publish 3001, proxy it through Caddy, or expose it on a LAN interface. The
listener is separate from the public app on :3000.

## Authentication

- `Authorization: Bearer $REMINDERS_MCP_TOKEN` (`REMINDERS_MCP_TOKEN` from
  `./deploy/init-env.sh`).
- The plaintext token is never stored. SQLite keeps a SHA-256 hash with scopes,
  creation/expiry, `last_used`, and revocation metadata under the
  `mcp.tokens.v1` setting. Comparison is constant-time over every hash.
- Scopes: `read`, `write`, `propose`. Tool-to-scope mapping:
  - read: `reminders_list`, `reminders_get`, `reminders_search`,
    `reminders_lists`, `reminders_day`
  - write: `reminders_create`, `reminders_update`, `reminders_complete`,
    `reminders_snooze`, `reminders_skip`
  - propose: `reminders_propose`

> OpenCode prefixes model-facing tool names with the MCP server key. The
> bundled sidecar keys this server as `morrow`, so the assistant calls
> `morrow_reminders_*`; direct MCP clients continue to see `reminders_*`.

- Expiry, revoke, rotation, and `last_used` are enforced server-side.
  `/api/mcp/status`, `PATCH /api/mcp`, `POST /api/mcp/tokens/rotate`, and
  `DELETE /api/mcp/tokens/:id` require a fresh step-up password confirmation.
- Kill switch: `MCP_ENABLED=false` or `PATCH /api/mcp { enabled: false }`
  returns 503 before authentication. The token remains revocable.
- A live restore invalidates all MCP bearer hashes and restarts the listener
  without re-importing `REMINDERS_MCP_TOKEN`; the old sidecar token stops
  working. Log in as the owner and rotate a fresh token, then update the
  sidecar env/secret and restart it.

## Transport and hardening

- Stateless Streamable HTTP at `POST /mcp` (OpenCode `protocol: "auto"` may
  probe the 2026-07-28 revision and fall back to 2025-era legacy).
- Host allowlist: `MCP_ALLOWED_HOSTS` (default `app,localhost,127.0.0.1,::1`).
  Origin, when present, must be one of those hostnames.
- Request body cap: 256 KiB. HTTP rate limit: 120 requests/minute per token and
  240/minute per IP. Tool-call quota: 30/minute per OpenCode session.
- `_meta` correlation only: OpenCode sends
  `_meta["ai.opencode/sessionID"]` on tool calls. The app maps it to
  `agent_conversations` for proposal/conversation context. It is **not**
  authorization; the bearer token is.
- No `app-data` volume (`/data` SQLite/backups), Docker socket, or host path is
  exposed to the sidecar; only the provider overlay and key volumes in the
  mount table below.

## Provider overlay (M4.1)

The provider overlay is a second, separate OpenCode config file. It is global
in effect (every session), but it is not the agent/MCP config and does not
change the `reminders` agent. MCP config stays in `/workspace/opencode.jsonc`;
provider config is rendered by the app into `PROVIDER_OVERLAY_PATH`
(`/data/opencode-providers/global.json` by default).

The app writes the **singular** documented OpenCode `provider` shape. The
sidecar normalises it to v2's `providers` map internally; Morrow does not write
an ambiguous dual shape.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "openai": {
      "name": "OpenAI",
      "options": {
        "baseURL": "https://api.openai.com/v1",
        "apiKey": "{file:/data/secrets/providers/openai.key}"
      },
      "models": {
        "gpt-4.1-mini": { "name": "GPT-4.1 mini" }
      }
    },
    "ollama": {
      "name": "Ollama (local)",
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://host.docker.internal:11434/v1" },
      "models": { "qwen3:8b": {} }
    }
  }
}
```

Rules:

- One live provider per `providerId` (SQLite unique index where
  `deleted_at IS NULL`). `providerId` is lowercase `[a-z0-9][a-z0-9._-]{0,63}`.
- When present, `apiKey` is always `{file:/absolute/path}`; keyless local/custom
  providers omit it. The key is never literal JSON. The path is the app's
  `SECRETS_DIR/providers/<providerId>.key`.
- `{env:NAME}` and `{file:PATH}` in `baseURL` or header values pass through to
  the overlay unchanged. They are resolved only for the app's bounded probes;
  the sidecar must also see the env var or file, or OpenCode resolves an empty
  value.
- A key input that is a whole `{env:NAME}` or `{file:PATH}` reference is
  resolved once at write time and stored in the 0600 key file, so the overlay
  still carries only `{file:...}`.
- `models` is a `{ modelId: { name? } }` map. Discover models fills it from the
  provider's `/models`; a blank list is valid but the sidecar may have no
  selectable models for a custom provider.
- Built-in presets keep `npm: null` so sidecar metadata is authoritative. Local
  and custom providers use `npm: "@ai-sdk/openai-compatible"`; arbitrary npm
  packages are rejected.
- A provider whose key file is missing or does not match its DB fingerprint is
  omitted from the overlay and reported `degraded`, rather than emitting a
  `{file:...}` reference the sidecar cannot read.
- The app renders after create, update, rotate, delete, a successful model
  discovery, and when a provider is enabled/disabled, plus once at startup when
  rows exist. Renders are serialised so a stale snapshot cannot overwrite a
  newer one. Removing the last provider (or disabling all of them) writes a
  valid empty overlay (`"provider": {}`).
- The overlay file is mode 0644 because it contains references, not secrets.
  Keep it outside `SECRETS_DIR`; it is written temp file → fsync → rename →
  directory fsync.

### Volume mount table (bundled compose)

The app must expose the key directory at the **same absolute path** to the
sidecar, and the overlay directory must be a **directory** mount (not a single
file) so the atomic rename is visible.

| Volume / mount | App container | Sidecar container | Mode | Why |
|---|---|---|---|---|
| `opencode-providers` | `/data/opencode-providers` | `/home/opencode/.config/opencode/providers` | sidecar read-only | The app writes `global.json` here; the sidecar loads it via `OPENCODE_CONFIG` and the watcher sees the rename. |
| `opencode-secrets` | `/data/secrets` | `/data/secrets` | sidecar read-only | The app's `SECRETS_DIR`, including `providers/<id>.key`; `{file:/data/secrets/providers/<id>.key}` must resolve unchanged. |
| `app-data` | `/data` | not mounted | app writable | SQLite, backups, and other app state; deliberately not shared. |
| `config/opencode.jsonc` | not mounted | `/workspace/opencode.jsonc` | read-only | Project config (agent, permissions, MCP); sidecar runs with `working_dir: /workspace`. |
| `packages/agent/prompts` | not mounted | `/workspace/prompts` | read-only | System prompt. |
| sidecar state volumes | not mounted | `~/.local/share/opencode`, `~/.local/state/opencode`, `~/.cache/opencode` | writable | OAuth auth, sessions, logs, cache. Never share with the app. |

The bundled wiring mounts the overlay in a subdirectory of the sidecar's global
config directory and names it explicitly. It sets:

```yaml
app:
  environment:
    PROVIDER_OVERLAY_PATH: /data/opencode-providers/global.json
    SECRETS_DIR: /data/secrets
  volumes:
    - opencode-providers:/data/opencode-providers
    - opencode-secrets:/data/secrets
opencode:
  working_dir: /workspace
  environment:
    OPENCODE_CONFIG: /home/opencode/.config/opencode/providers/global.json
  volumes:
    - opencode-providers:/home/opencode/.config/opencode/providers:ro
    - opencode-secrets:/data/secrets:ro
```

OpenCode merges the `OPENCODE_CONFIG` overlay with the `/workspace`
project config, so the agent/MCP definitions and provider entries both apply.
The file is a custom config inside the global config directory, **not**
`~/.config/opencode/opencode.json`; if you choose the implicit global-file
alternative instead, name it `opencode.json` and do not bind-mount the single
file. `PROVIDER_OVERLAY_PATH` only tells the **app** where to write; the
sidecar's `OPENCODE_CONFIG` controls what OpenCode loads.

`providers-init` is a one-shot root helper that prepares fresh named volumes:
it creates `/providers` and `/secrets/providers` owned by 10001, sets directory
mode 0700, overlay files 0644, and key files 0600. Without it, a fresh named
volume is root-owned and the app cannot write.

The app writes `/data/opencode-providers` and `/data/secrets`; the sidecar
mounts the providers volume under its global config directory and the secrets
volume at the same `/data/secrets`, both read-only. It never writes provider
config. `/workspace` is read-only and is the only config the sidecar gets from
the app image. The sidecar's own auth and state volumes are writable but are not
exposed to the app.

The bundled sidecar runs as root (the image default) and can therefore read the
10001-owned 0600 keys. If you run the sidecar non-root, run it as 10001 or align
ownership of `SECRETS_DIR/providers`; otherwise OpenCode sees a missing key.
Keys stay 0600; never widen them to 0644 to "fix" a permission error.

Mounting the **whole** `SECRETS_DIR` (the `opencode-secrets` volume) gives the
sidecar read access to anything else stored there, such as a backup HMAC key,
VAPID private key, or readyz token. The sidecar only needs `providers/`. Keep
non-provider secrets in env or a separate directory/volume, or narrow the mount
to a dedicated provider-key directory. See `docs/SECURITY.md`.

### Watcher and reload

The app writes a complete temp file and renames it over the overlay. OpenCode's
config watcher sees the finished file and hot-reloads providers without a
sidecar restart. If a given sidecar build does not reload, restart `opencode`;
no app restart is needed. `GET /api/providers` reports
`overlay: { path, present }` so the operator can distinguish "render never
ran" from "sidecar did not reload".

### Verification

```bash
# Overlay exists, is valid JSON, and lists the provider IDs (no key values).
sg docker -c 'docker compose exec -T app node -e "const fs=require(\"fs\");const d=JSON.parse(fs.readFileSync(\"/data/opencode-providers/global.json\",\"utf8\"));console.log(Object.keys(d.provider))"'

# Key file is present and 0600 (do not print its contents).
sg docker -c 'docker compose exec -T app sh -c "stat -c \"%a %U:%G %n\" /data/secrets/providers/*.key"'

# The sidecar can read the same absolute key path.
sg docker -c 'docker compose exec -T opencode sh -c "test -r /data/secrets/providers/openai.key && echo key-readable || echo key-missing"'
```

## Tools

Only these 11 tools exist:

| Tool | Purpose | Scope |
|---|---|---|
| `reminders_list` | open tasks by view/list/status/query | read |
| `reminders_get` | one task by id | read |
| `reminders_search` | title/notes search | read |
| `reminders_lists` | lists | read |
| `reminders_day` | tasks on a wall date | read |
| `reminders_create` | one task, immediate + undo | write |
| `reminders_update` | ordinary fields, immediate + undo | write |
| `reminders_complete` | one task/occurrence, immediate + undo | write |
| `reminders_snooze` | one task, immediate + undo | write |
| `reminders_skip` | one recurring occurrence, immediate + undo | write |
| `reminders_propose` | 1–20 changes for user approval | propose |

There is **no delete tool**. Deletion can only be a `reminders_propose`
operation (`delete_task`) and only executes after the user approves the
proposal in the app.

Policy: single-item create/update/complete/snooze/skip are immediate with undo;
any batch, delete, recurrence change, list move, or >1 item requires a proposal.
Limits: 10 writes/run, 20 proposal operations (pending proposals included), 30
tool calls/minute. Every write is audited with actor, session, before/after,
and batch ID.

Task data is untrusted. Tool results wrap it in
`<<<UNTRUSTED_TASK_DATA>>>` markers and instruct the model to treat it as data,
never instructions. The model has no shell/file/web tools by construction.

## Tests

- `apps/server/test/mcp-auth.test.ts`: 401 without bearer, Host rejection,
  configured token, kill switch, tool surface.
- `apps/server/test/agent-policy.test.ts`: proposal-not-delete, quota, atomic
  apply/undo, prompt-injection canary.
- `apps/server/test/providers.test.ts`: key store/overlay renderer, masking,
  SSRF guard, probe mapping, kill switch, backup canary.
- `packages/agent/test/agent.test.ts`: singular `provider` overlay, absolute
  `{file:}` refs, plural-shape rejection, and compose mount paths.
- `pnpm --filter @morrow/agent contract`: real pinned sidecar check (see
  `docs/AGENT.md`).
