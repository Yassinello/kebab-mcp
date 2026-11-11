# Base image pinned by digest (multi-arch OCI index for node:22-alpine,
# resolved 2026-11-11 via `docker buildx imagetools inspect node:22-alpine`).
# The tag is kept for readability; the digest is what is pulled. Bump both
# together (Dependabot's docker ecosystem can automate this).
FROM node:26-alpine@sha256:8996bb5821d62a8fd9bb27c1cb07462f3fdce6e47d640c6a881ead0b064ce216 AS base

# deps stage: full install (dev + prod) — needed by builder.
# TECH-AUDIT T6: the previous layout stripped dev deps here, leaving the
# builder stage without typescript / next / eslint. The fix is to keep
# full deps at build time. The runner only needs `.next/standalone`, which
# already ships the traced production node_modules.
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# builder stage: compile Next standalone output (needs dev deps).
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# runner stage: standalone output only, non-root, healthcheck,
# SIGTERM-aware entry.
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs

# CI-09 (2026-11 audit): no `npm ci --omit=dev` here any more. next.config
# sets `output: "standalone"`, so `.next/standalone` already contains the
# server, its own package.json and the node_modules traced by Next's file
# tracer (OTel etc. are bundled into the server chunks). A second install
# produced a second, untraced node_modules tree and doubled the image.

# copy Next standalone + static + public.
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# The standalone extract emits its OWN server.js at /app/server.js. Keep it
# (it chdir()s to its own directory, so it must stay in /app) under another
# name, then install the SIGTERM wrapper (JC-2: 5s default +
# MYMCP_SHUTDOWN_TIMEOUT_MS) as server.js; the wrapper require()s
# ./next-standalone-server.js. Previously the wrapper overwrote the
# standalone entry and then required ./.next/standalone/server.js, which
# does not exist inside the image, so the container could not start.
RUN mv server.js next-standalone-server.js
COPY --chown=nextjs:nodejs server.js ./server.js

# Filesystem KV mount point. Compose/fly/bare-metal mount a volume here.
RUN mkdir -p /app/data && chown nextjs:nodejs /app/data
VOLUME ["/app/data"]

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# Container HEALTHCHECK uses the basic /api/health (public, ≤1.5s).
# ?deep=1 is for operator probes — never for orchestrator liveness.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health >/dev/null 2>&1 || exit 1

CMD ["node", "server.js"]
