#!/bin/sh
# Choose HTTP or HTTPS based on what is actually mounted.
#
# Deliberately not a `TLS_ENABLED=true` flag. A flag can be set while the
# certificate is missing, and nginx then refuses to start with an error most
# people read as "the image is broken". Here the presence of the files *is* the
# switch, so the two can never disagree.
#
# Generate a development certificate with: pwsh ./scripts/generate-dev-cert.ps1
set -e

CERT=/etc/nginx/certs/server.crt
KEY=/etc/nginx/certs/server.key

if [ -s "$CERT" ] && [ -s "$KEY" ]; then
  echo "[web] certificate found; serving HTTPS on 443 and redirecting 80"
  cp /etc/nginx/available/nginx-tls.conf /etc/nginx/conf.d/default.conf
else
  echo "[web] no certificate at $CERT; serving plain HTTP on 80"
  echo "[web] this is fine for local development and NOT fine for anything shared"
  cp /etc/nginx/available/nginx-http.conf /etc/nginx/conf.d/default.conf
fi

exec "$@"
