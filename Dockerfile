# =============================================================================
# One image, used by every service.
#
# All nine services share a workspace, so building nine near-identical images
# would waste time and layer cache. Instead the image contains the whole
# monorepo and SERVICE_PATH decides which server.js the container runs.
# =============================================================================
FROM node:22-alpine AS deps

WORKDIR /app

# Copy only manifests first so `npm ci` is cached until a dependency changes.
COPY package.json package-lock.json* ./
COPY packages/shared/package.json      packages/shared/
COPY services/api-gateway/package.json           services/api-gateway/
COPY services/user-service/package.json          services/user-service/
COPY services/catalog-service/package.json       services/catalog-service/
COPY services/playback-service/package.json      services/playback-service/
COPY services/watch-history-service/package.json services/watch-history-service/
COPY services/subscription-service/package.json  services/subscription-service/
COPY services/billing-service/package.json       services/billing-service/
COPY services/notification-service/package.json  services/notification-service/
COPY services/recommendation-service/package.json services/recommendation-service/

RUN npm ci --omit=dev --no-audit --no-fund

# -----------------------------------------------------------------------------
FROM node:22-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache curl tini

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY packages ./packages
COPY services ./services
COPY db ./db
COPY scripts ./scripts

# Never run application code as root.
USER node

# SERVICE_PATH is set per-service in docker-compose.yml.
ENV SERVICE_PATH=services/api-gateway/src/server.js

# tini reaps zombies and forwards SIGTERM, so graceful shutdown actually works.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "node $SERVICE_PATH"]
