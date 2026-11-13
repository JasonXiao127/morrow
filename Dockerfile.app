# Morrow app image (plan §2 Backend + §10 deployment).
# Multi-stage, reproducible, non-root. Production must pin every image by
# digest (`docker images --digests` after `docker compose pull`); tags below
# are for local development only.
#
# TODO(prod): pin base + caddy + opencode images by digest, e.g.
#   FROM node:22-bookworm-slim@sha256:<digest> AS builder
#   image: caddy@sha256:<digest>
#   image: ghcr.io/anomalyco/opencode@sha256:<digest>
#   sg docker -c 'docker images --digests'

FROM node:22-bookworm-slim AS builder

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable && corepack prepare pnpm@9.12.3 --activate

# better-sqlite3 needs a compiler when prebuilt binaries are unavailable.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Layer caching: manifests + lockfile first, then frozen install (fatal).
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/agent/package.json packages/agent/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile

# Source + reproducible build (failures are fatal; no `|| true`).
COPY . ./
RUN pnpm -r build

# Prune dev dependencies; keep workspace prod deps for the runner.
RUN pnpm prune --prod

FROM node:22-bookworm-slim AS runner

ENV NODE_ENV=production

RUN useradd -m -u 10001 appuser \
  && mkdir -p /app /data \
  && chown appuser:appuser /app /data

WORKDIR /app

# Runtime files only: manifests, built dist, migrations, prompts, PWA assets,
# and pruned production node_modules. Secrets, .env, data/, and test
# artifacts are excluded via .dockerignore and never COPYd here.
COPY --from=builder --chown=appuser:appuser /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=builder --chown=appuser:appuser /app/apps/server/package.json ./apps/server/package.json
COPY --from=builder --chown=appuser:appuser /app/apps/server/dist ./apps/server/dist
COPY --from=builder --chown=appuser:appuser /app/apps/web/dist ./apps/web/dist
COPY --from=builder --chown=appuser:appuser /app/packages/agent/package.json ./packages/agent/package.json
COPY --from=builder --chown=appuser:appuser /app/packages/agent/dist ./packages/agent/dist
COPY --from=builder --chown=appuser:appuser /app/packages/agent/prompts ./packages/agent/prompts
COPY --from=builder --chown=appuser:appuser /app/packages/db/package.json ./packages/db/package.json
COPY --from=builder --chown=appuser:appuser /app/packages/db/dist ./packages/db/dist
COPY --from=builder --chown=appuser:appuser /app/packages/db/migrations ./packages/db/migrations
COPY --from=builder --chown=appuser:appuser /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=builder --chown=appuser:appuser /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder --chown=appuser:appuser /app/node_modules ./node_modules
COPY --from=builder --chown=appuser:appuser /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=builder --chown=appuser:appuser /app/packages/agent/node_modules ./packages/agent/node_modules
COPY --from=builder --chown=appuser:appuser /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=builder --chown=appuser:appuser /app/packages/shared/node_modules ./packages/shared/node_modules

USER appuser

EXPOSE 3000 3001
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "apps/server/dist/index.js"]
