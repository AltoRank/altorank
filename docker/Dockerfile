# AltoRank dashboard, self-hosted.
#
# Multi-stage so the runtime image carries the standalone server bundle and
# nothing else: no source, no dev dependencies, no package manager.
#
# Build from the repo root, not from this directory:
#   docker build -f docker/Dockerfile -t altorank .

# ── deps ──────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app

# The workspace root package files decide the dependency tree; copying only
# these first keeps this layer cached across source-only changes.
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
# --force bypasses EBADPLATFORM on darwin-only optional binaries that the
# lockfile carries (@rolldown/binding-darwin-arm64, pulled in by vitest, which
# this image never runs). The linux binaries it does need still install, since
# they match the platform.
RUN npm ci --workspace=altorank-web --include-workspace-root --force

# ── build ─────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app
# npm workspaces hoist every dependency to the root, so there is no
# apps/web/node_modules to copy.
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Next inlines NEXT_PUBLIC_* at build time, so they must be present now rather
# than at runtime. They are not secrets: the anon key is designed to be public
# and is constrained by row-level security.
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_APP_URL
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NEXT_TELEMETRY_DISABLED=1

RUN npm run build --workspace=altorank-web

# ── runtime ───────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000

# Never run the server as root.
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

# `output: "standalone"` produces exactly these three pieces.
COPY --from=build --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=nextjs:nodejs /app/apps/web/public ./apps/web/public

USER nextjs
EXPOSE 3000

# No shell, so a stopped container is a stopped process rather than an orphan.
CMD ["node", "apps/web/server.js"]
