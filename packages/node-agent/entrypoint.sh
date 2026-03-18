#!/bin/sh
exec node dist/bin/cli.js \
  --name "${NODE_NAME:-node}" \
  --hub "${HUB_URL:-http://localhost:7433}" \
  --token "${HUB_TOKEN}" \
  --port "${AGENT_PORT:-7432}"
