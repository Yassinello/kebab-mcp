FROM node:22-alpine AS base

# deps stage: full install (dev + prod) — needed by builder.
# TECH-AUDIT T6: the previous layout stripped dev deps here, leaving the
# builder stage without typescript / next / eslint. The fix is to keep
# full deps at build time and re-install --omit=dev in the runner.
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

# runner stage: prod-only deps, non-root, healthcheck, SIGTERM-aware entry.
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs

# prod-only deps — reinstall from scratch so dev deps are stripped.
COPY --from=builder /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev

# copy Next standalone + static + public.
# The standalone extract emits its OWN server.js at /app/server.js —
# we overwrite it with the SIGTERM wrapper below.
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# SIGTERM wrapper (JC-2: 5s fixed default + MYMCP_SHUTDOWN_TIMEOUT_MS).
# Copied LAST so it overwrites the standalone server.js entry.
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
