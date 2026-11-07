#!/bin/sh
# Rebuild and restart the V-Farms automation app (127.0.0.1:3200, and
# vfarms-crm-app:3000 on the nginx network). Run from /root/vfarms_automation.
set -e
cd "$(dirname "$0")/../.."
HOST_BIND=127.0.0.1 HOST_PORT=3200 docker compose -p vfarms-automation \
  -f docker-compose.yml -f deploy/websites/docker-compose.server.yml \
  --env-file .env.local up -d --build "$@" app
