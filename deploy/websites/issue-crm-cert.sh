#!/usr/bin/env bash
# Let's Encrypt certificate for crm.vfarms.in (needs the DNS A record
# crm.vfarms.in -> this server first). Usage: LE_EMAIL=you@example.com ./issue-crm-cert.sh
set -euo pipefail

DOMAIN="crm.vfarms.in"
EMAIL="${LE_EMAIL:?set LE_EMAIL}"
HERE="$(cd "$(dirname "$0")" && pwd)"
CERT_DIR="/opt/cueai/certs/nginx/vfarms-crm"

"$HERE/install-crm-vhost.sh"
certbot certonly --webroot -w /opt/cueai/nginx/html -d "$DOMAIN" \
  --email "$EMAIL" --agree-tos --no-eff-email --keep-until-expiring --non-interactive \
  --deploy-hook "cp -f /etc/letsencrypt/live/$DOMAIN/fullchain.pem $CERT_DIR/fullchain.pem && cp -f /etc/letsencrypt/live/$DOMAIN/privkey.pem $CERT_DIR/privkey.pem && chmod 600 $CERT_DIR/privkey.pem && docker exec cueai-nginx-1 nginx -s reload"
cp -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" "$CERT_DIR/fullchain.pem"
cp -f "/etc/letsencrypt/live/$DOMAIN/privkey.pem" "$CERT_DIR/privkey.pem"
chmod 600 "$CERT_DIR/privkey.pem"
docker exec cueai-nginx-1 nginx -s reload
echo "TLS ready: https://$DOMAIN/"
