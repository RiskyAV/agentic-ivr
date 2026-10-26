# syntax=docker/dockerfile:1
# Backend image: the agent server (PORT, default 4000) and the mock enterprise systems (127.0.0.1:4100).
# The web app is a static build deployed separately (Cloudflare Pages); it is not in this image.

ARG NODE_IMAGE=node:22-bookworm-slim

# --- build: install everything and type-check the backend workspaces -------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/domain/package.json packages/domain/
COPY apps/mock-systems/package.json apps/mock-systems/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund
COPY packages packages
COPY apps/mock-systems apps/mock-systems
COPY apps/server apps/server
# The workspace only emits declarations (TypeScript runs through tsx), so this step is the type check.
RUN npx tsc -b packages/shared packages/domain apps/mock-systems apps/server

# --- runtime: production dependencies only, non-root ----------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=4000 \
    MOCK_PORT=4100 \
    MOCK_BASE_URL=http://127.0.0.1:4100 \
    EVENT_LOG_DIR=/app/.data/events
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/domain/package.json packages/domain/
COPY apps/mock-systems/package.json apps/mock-systems/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --no-audit --no-fund \
      --workspace @app/server --workspace @app/mock-systems --include-workspace-root \
 && npm cache clean --force
COPY --from=build /app/packages/shared/src packages/shared/src
COPY --from=build /app/packages/domain/src packages/domain/src
COPY --from=build /app/apps/mock-systems/src apps/mock-systems/src
COPY --from=build /app/apps/server/src apps/server/src
COPY scripts/start.sh scripts/start.sh
RUN mkdir -p /app/.data/events && chown -R node:node /app/.data
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["scripts/start.sh"]
