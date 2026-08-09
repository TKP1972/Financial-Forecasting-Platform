# syntax=docker/dockerfile:1
#
# API image.
#
# Multi-stage so the runtime image carries no compiler, no source and no dev
# dependencies. Built from the repo root because the API depends on two
# workspace packages that must be compiled first.

# ---------------------------------------------------------------------------
# Stage 1: install every dependency, including dev, so we can compile.
# ---------------------------------------------------------------------------
# Debian slim rather than Alpine: Prisma's query engine needs OpenSSL, which is
# already present here. Alpine would require `apk add openssl`, and that fails
# outright on any network that intercepts TLS - a package install is a build
# dependency on the outside world that this image does not need.
FROM node:22-slim AS deps
WORKDIR /app

# Any extra root CAs the build needs, for networks that intercept TLS. Empty on
# a normal machine, in which case NODE_EXTRA_CA_CERTS points at an empty file
# and Node simply uses its bundled roots. See docker/certs/README.md.
COPY docker/certs/ /usr/local/share/ca-certificates/extra/
RUN cat /usr/local/share/ca-certificates/extra/*.crt > /usr/local/share/extra-ca.pem 2>/dev/null || \
    touch /usr/local/share/extra-ca.pem
ENV NODE_EXTRA_CA_CERTS=/usr/local/share/extra-ca.pem

# Copy only the manifests first: this layer is cached until a dependency
# actually changes, which is far less often than the source does.
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/engine/package.json ./packages/engine/
COPY packages/api/package.json ./packages/api/
COPY packages/web/package.json ./packages/web/

RUN npm ci --no-audit --no-fund

# ---------------------------------------------------------------------------
# Stage 2: compile the workspace packages the API needs.
# ---------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app

COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY packages/engine ./packages/engine
COPY packages/api ./packages/api

RUN npx prisma generate --schema packages/api/prisma/schema.prisma \
 && npm run build --workspace @ffp/shared \
 && npm run build --workspace @ffp/engine \
 && npx tsc -p packages/api/tsconfig.json

# ---------------------------------------------------------------------------
# Stage 3: production dependencies only.
# ---------------------------------------------------------------------------
FROM deps AS prod-deps
WORKDIR /app
RUN npm ci --omit=dev --no-audit --no-fund

# ---------------------------------------------------------------------------
# Stage 4: runtime.
# ---------------------------------------------------------------------------
FROM node:22-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
# The container's environment is injected by compose; there is no .env to read.
ENV SKIP_DOTENV=true

# Ownership is set on each COPY rather than with a trailing `chown -R`. A
# recursive chown rewrites every file and so duplicates the whole node_modules
# layer in the image - it was worth roughly 700 MB here.
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build --chown=node:node /app/node_modules/@prisma/client ./node_modules/@prisma/client

COPY --from=build --chown=node:node /app/packages/shared/dist ./packages/shared/dist
COPY --from=build --chown=node:node /app/packages/shared/package.json ./packages/shared/
COPY --from=build --chown=node:node /app/packages/engine/dist ./packages/engine/dist
COPY --from=build --chown=node:node /app/packages/engine/package.json ./packages/engine/
COPY --from=build --chown=node:node /app/packages/api/dist ./packages/api/dist
COPY --from=build --chown=node:node /app/packages/api/package.json ./packages/api/
COPY --from=build --chown=node:node /app/packages/api/prisma ./packages/api/prisma
COPY --chown=node:node package.json ./

# Run unprivileged. The node images ship a `node` user for exactly this.
USER node

EXPOSE 4000

# Signals are handled by Docker's own init (`init: true` in compose), so SIGTERM
# reaches the graceful shutdown handler rather than being swallowed by PID 1.
# That avoids installing tini and keeps the image free of package downloads.
CMD ["node", "packages/api/dist/server.js"]
