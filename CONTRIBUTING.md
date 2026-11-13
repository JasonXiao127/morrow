# Contributing

Thanks for helping with Morrow, a self-hosted reminders PWA with an optional
beta AI assistant. This guide covers local setup, the checks we expect, and the
behavior that must not regress. For architecture and invariants read
[`AGENTS.md`](AGENTS.md) and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md);
for security, read [`docs/SECURITY.md`](docs/SECURITY.md).

By contributing you agree that your changes are licensed under the project's
[MIT license](LICENSE).

## Prerequisites

- Node.js 22 (CI uses 22; newer local versions may work but are not the target)
- pnpm 9.12.3 (`packageManager` in `package.json`)
- Docker Engine with Compose v2 for the full stack and e2e
- Optional: a TLS front door, OpenCode sidecar, or model provider only if you
  are working on deployment or the assistant

## Setup

```sh
git clone <your-fork>
cd <repo>
pnpm install
```

For the self-hosted app:

```sh
cp .env.example .env
./deploy/init-env.sh          # generates 0600 secrets, VAPID keys, dirs
docker compose up -d --build
```

`init-env.sh` fills only empty values and never prints a secret that is already
set. `.env` is gitignored. Never commit `.env`, `data/`, backups, provider keys,
or tokens. For local-only work, `SITE_ADDRESS=:80` + `APP_URL=http://localhost`
is the zero-config pair; see the README and `docs/RUNBOOK.md` for TLS choices.

## Commands

| Command | What it does |
|---|---|
| `pnpm install` | Install workspace dependencies |
| `pnpm typecheck` | TypeScript across all workspaces |
| `pnpm test` | Vitest unit/integration; no network or paid models |
| `pnpm build` | Build server, web PWA, shared, db, agent |
| `pnpm e2e` / `./e2e.sh` | Fresh DB + API + Playwright; needs Docker and browsers |
| `docker compose config` | Validate the default bundle |
| `pnpm dev` | Dev override with app on `:3100` |
| `pnpm --filter @morrow/agent contract` | Pinned OpenCode sidecar contract check |

Run `pnpm typecheck`, `pnpm test`, and `pnpm build` before opening a PR. CI runs
exactly those after `pnpm install --frozen-lockfile`.

## Test matrix

- **Unit/integration (CI):** 625 tests today — server 395, web 107, shared 56,
  db 39, agent 28. Add tests next to the code you change. Server tests use
  `apps/server/test/helpers.ts` for temp DBs and app instances.
- **Invariant coverage:** agent policy, proposal/undo behavior, authorization,
  restore, reminder arming, offline outbox, and CalDAV have dedicated suites.
  Do not weaken them.
- **Manual gates (not CI):** Playwright `pnpm e2e`, the OpenCode contract/live
  harness, real-device Web Push, the age-encrypted restore drill, and physical
  CalDAV clients. Never call a paid model provider in automated tests.

## Compose modes

Pick one front door per host; do not give two services port 443.

| Mode | Command |
|---|---|
| Bundled Caddy (default) | `docker compose up -d --build` |
| Dev (`NODE_ENV=development`, app `:3100`) | `pnpm dev` |
| Tailscale Serve | `docker compose -f compose.yaml -f compose.tailscale.yaml up -d --build app` |
| External TLS proxy | `docker compose -f compose.yaml -f compose.external.yaml up -d --build app` |
| Caddy + private loopback | `docker compose -f compose.yaml -f compose.loopback.yaml up -d --build app caddy` |
| AI-off | set `OPENCODE_URL=` and `MCP_ENABLED=false`, then `docker compose up -d caddy app` |

`APP_URL` is the canonical origin. `TRUST_PROXY` must be an exact proxy CIDR
(never `true`/`*`); when the app runs in Docker that is the `edge` subnet even
for a host-level proxy. Validate any new overlay with `docker compose config`.

## Code conventions

- TypeScript strict, ESM, Node 22. Keep the existing workspace package layout
  (`@morrow/server`, `@morrow/web`, `@morrow/shared`, `@morrow/db`,
  `@morrow/agent`).
- Match the surrounding style: 2-space indentation, small focused modules,
  explicit types at boundaries, and no new runtime dependency without need.
- Keep domain logic out of routes where a module already owns it
  (`tasks.ts`, `access.ts`, `authz.ts`, `scheduler.ts`, and friends).
- Scheduling math belongs in `packages/shared`; schema changes get a new
  forward-only migration in `packages/db/migrations/`.
- The PWA is list-first, not chat-home. Preserve keyboard access, 44px targets,
  offline behavior, and same-origin-only API traffic.
- Update the relevant docs (`README.md`, `docs/API.md`, `docs/MCP.md`,
  `docs/AGENT.md`, `docs/RUNBOOK.md`) when behavior, env vars, or contracts
  change. Keep docs honest about unproven manual gates.

## PR checklist

- [ ] The change is focused and explained (what, why, and user-visible effect).
- [ ] `pnpm typecheck`, `pnpm test`, and `pnpm build` pass locally.
- [ ] New behavior has tests; existing invariant tests still pass.
- [ ] AI-off remains first-class: no core flow now requires OpenCode, MCP, or a
      model.
- [ ] No autonomous delete, and bulk/delete/recurrence/list-move changes still
      require an approved proposal.
- [ ] Single-item assistant writes remain audited and undoable.
- [ ] Assistant/provider/settings changes stay owner-only and workspace-global.
- [ ] `APP_URL`/`TRUST_PROXY` behavior is unchanged or documented; compose
      overlays still validate.
- [ ] No secrets, `.env`, `data/`, backups, or generated artifacts are added.
- [ ] Migrations are new and forward-only; no applied migration was edited.
- [ ] Docs are updated and do not overclaim production readiness.

## AI-generated changes

AI-assisted patches are welcome, but the contributor is responsible for them.
Review the diff, understand the change, and run the checks above. AI-generated
changes must preserve the proposal/approval and undo invariants, must not add
autonomous delete or expand the assistant's tool surface casually, and must
keep AI-off behavior intact. Do not paste secrets, private task data, or
provider responses into prompts or commits.

## Reporting bugs and security issues

Use GitHub issues for normal bugs with reproduction steps and redacted logs.
Report vulnerabilities privately through GitHub Security Advisories; see
[`SECURITY.md`](SECURITY.md). Never put secrets in an issue or PR.
