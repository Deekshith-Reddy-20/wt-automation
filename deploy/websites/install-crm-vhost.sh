#!/usr/bin/env bash
# Add/refresh the crm.vfarms.in block in the shared cueai-nginx config.
# Only edits the managed block, validates with `nginx -t` and reloads;
# on a failed test the previous config is restored. Never restarts containers.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SNIPPET="$HERE/crm.snippet.conf"
CONF="/opt/cueai/nginx/conf.d/default.conf"
CERT_DIR="/opt/cueai/certs/nginx/vfarms-crm"
NGINX_CTR="cueai-nginx-1"

mkdir -p "$CERT_DIR" /opt/cueai/nginx/html/.well-known/acme-challenge
if [[ ! -f "$CERT_DIR/fullchain.pem" ]]; then
  echo "No Let's Encrypt cert yet; using the server's placeholder cert until issue-crm-cert.sh runs."
  cp -f /opt/cueai/certs/nginx/server.crt "$CERT_DIR/fullchain.pem"
  cp -f /opt/cueai/certs/nginx/server.key "$CERT_DIR/privkey.pem"
  chmod 600 "$CERT_DIR/privkey.pem"
fi

BACKUP="$CONF.bak.crm.$(date +%Y%m%d%H%M%S)"
cp -a "$CONF" "$BACKUP"

python3 - "$CONF" "$SNIPPET" <<'PY'
import pathlib, sys
conf, snip = map(pathlib.Path, sys.argv[1:3])
text = conf.read_text()
start, end = "# --- BEGIN VFARMS_CRM_VHOST", "# --- END VFARMS_CRM_VHOST ---"
if start in text and end in text:
    text = text[: text.index(start)].rstrip() + "\n" + text[text.index(end) + len(end):].lstrip("\n")
conf.write_text(text.rstrip() + "\n\n" + snip.read_text().rstrip() + "\n")
PY

if ! docker exec "$NGINX_CTR" nginx -t; then
  cp -a "$BACKUP" "$CONF"
  echo "nginx -t failed; previous config restored ($BACKUP)" >&2
  exit 1
fi
docker exec "$NGINX_CTR" nginx -s reload
echo "OK: crm.vfarms.in -> vfarms-crm-app:3000 (backup: $BACKUP)"
