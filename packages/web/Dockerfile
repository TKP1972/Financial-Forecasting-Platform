# syntax=docker/dockerfile:1
#
# Web image: build the SPA with Vite, serve the static output with nginx.
# Built from the repo root because the app imports the @ffp/shared workspace.

# Debian slim, matching the API image. Keeping both builders on the same libc
# avoids a class of musl-specific native-module and npm failures, and means the
# two images share base layers.
FROM node:22-slim AS build
WORKDIR /app

# Any extra root CAs the build needs, for networks that intercept TLS. Empty on
# a normal machine, in which case NODE_EXTRA_CA_CERTS points at an empty file
# and Node simply uses its bundled roots. See docker/certs/README.md.
COPY docker/certs/ /usr/local/share/ca-certificates/extra/
RUN cat /usr/local/share/ca-certificates/extra/*.crt > /usr/local/share/extra-ca.pem 2>/dev/null || \
    touch /usr/local/share/extra-ca.pem
ENV NODE_EXTRA_CA_CERTS=/usr/local/share/extra-ca.pem

COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/engine/package.json ./packages/engine/
COPY packages/api/package.json ./packages/api/
COPY packages/web/package.json ./packages/web/

# Install only what the front end actually needs. A plain `npm ci` would also
# pull the API's tree - Prisma, native argon2, ExcelJS - none of which is used
# here.
#
# The memory flags are not incidental: on a constrained builder npm exits with
# the unhelpful "Exit handler never called!" when it runs out of heap. Bounding
# its heap makes it collect garbage instead of ballooning, and limiting sockets
# caps how many tarballs are being unpacked concurrently.
ENV NODE_OPTIONS=--max-old-space-size=1536
RUN npm ci --no-audit --no-fund --no-progress --maxsockets 3 \
      --include-workspace-root \
      --workspace @ffp/shared \
      --workspace @ffp/web

COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY packages/web ./packages/web

# The app calls the API on a relative path and nginx proxies it, so there is no
# API URL to bake in. Declared only so `docker compose build` does not warn about
# an unconsumed build argument.
ARG VITE_API_URL=

RUN npm run build --workspace @ffp/shared \
 && npm run build --workspace @ffp/web

FROM nginx:1.27-alpine AS runtime

# Both server configurations ship in the image; the entrypoint picks one at boot
# depending on whether a certificate is mounted. Neither is written into
# conf.d at build time, so the image itself is not committed to either mode.
COPY packages/web/nginx-common.conf /etc/nginx/snippets/app.conf
COPY packages/web/nginx-http.conf /etc/nginx/available/nginx-http.conf
COPY packages/web/nginx-tls.conf /etc/nginx/available/nginx-tls.conf
COPY packages/web/docker-entrypoint.sh /docker-entrypoint-tls.sh
RUN chmod +x /docker-entrypoint-tls.sh

COPY --from=build /app/packages/web/dist /usr/share/nginx/html

EXPOSE 80 443

# Probe both listeners: on the TLS configuration port 80 only redirects, and
# --spider follows nothing, so checking 80 alone would pass while HTTPS was
# broken. --no-check-certificate because a development certificate is
# self-signed and the check here is liveness, not trust.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 \
   || wget -qO- --no-check-certificate https://127.0.0.1/ >/dev/null 2>&1 \
   || exit 1

ENTRYPOINT ["/docker-entrypoint-tls.sh"]
CMD ["nginx", "-g", "daemon off;"]
