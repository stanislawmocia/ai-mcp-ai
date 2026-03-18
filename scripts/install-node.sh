#!/bin/bash
# ──────────────────────────────────────────────────
# MeshMind Node Agent — Install on a new machine
# ──────────────────────────────────────────────────
# Adds this machine to the MeshMind mesh.
# Prerequisites: Docker, Tailscale (connected)
#
# Usage:
#   curl -fsSL <raw-url>/scripts/install-node.sh | bash -s -- \
#     --hub http://100.x.x.x:7433 \
#     --token YOUR_TOKEN \
#     --name my-machine
#
# Or clone the repo and run:
#   ./scripts/install-node.sh --hub http://100.x.x.x:7433 --token YOUR_TOKEN --name my-machine
# ──────────────────────────────────────────────────

set -euo pipefail

# Defaults
HUB_URL=""
HUB_TOKEN=""
NODE_NAME=""
AGENT_PORT="7432"
INSTALL_DIR="$HOME/.meshmind"

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --hub)     HUB_URL="$2"; shift 2 ;;
    --token)   HUB_TOKEN="$2"; shift 2 ;;
    --name)    NODE_NAME="$2"; shift 2 ;;
    --port)    AGENT_PORT="$2"; shift 2 ;;
    --dir)     INSTALL_DIR="$2"; shift 2 ;;
    *)         echo "Unknown option: $1"; exit 1 ;;
  esac
done

# Validate
if [ -z "$HUB_URL" ] || [ -z "$HUB_TOKEN" ]; then
  echo "Error: --hub and --token are required"
  echo "Usage: $0 --hub http://100.x.x.x:7433 --token YOUR_TOKEN --name my-machine"
  exit 1
fi

# Auto-detect node name from hostname
if [ -z "$NODE_NAME" ]; then
  NODE_NAME=$(hostname -s)
  echo "Auto-detected node name: $NODE_NAME"
fi

echo ""
echo "  MeshMind Node Agent Installer"
echo "  ─────────────────────────────"
echo "  Hub URL:    $HUB_URL"
echo "  Node name:  $NODE_NAME"
echo "  Port:       $AGENT_PORT"
echo "  Install to: $INSTALL_DIR"
echo ""

# Check prereqs
for cmd in docker curl; do
  if ! command -v "$cmd" &> /dev/null; then
    echo "Error: $cmd is required but not installed."
    exit 1
  fi
done

# Check Tailscale
if command -v tailscale &> /dev/null; then
  TS_IP=$(tailscale ip -4 2>/dev/null || echo "unknown")
  echo "  Tailscale IP: $TS_IP"
else
  echo "  Warning: Tailscale not found. Make sure this machine is reachable from the hub."
fi

# Create install dir
mkdir -p "$INSTALL_DIR"

# Write docker-compose
cat > "$INSTALL_DIR/docker-compose.yml" << COMPOSE
services:
  node-agent:
    image: oven/bun:1-alpine
    network_mode: host
    working_dir: /app
    command: ["bun", "run", "/app/entrypoint.js"]
    environment:
      NODE_NAME: $NODE_NAME
      HUB_URL: $HUB_URL
      HUB_TOKEN: $HUB_TOKEN
      AGENT_PORT: "$AGENT_PORT"
    volumes:
      - agent_logs:/tmp/meshmind-agents
      - ./node-agent:/app
    restart: unless-stopped

volumes:
  agent_logs:
COMPOSE

# Download the node-agent package (or build from source)
echo ""
echo "Pulling node-agent..."

# If repo is available locally, build from source
if [ -f "packages/node-agent/package.json" ]; then
  echo "Building from local source..."
  cd packages/node-agent
  if command -v bun &> /dev/null; then
    bun install && bun x tsc
  else
    npm install && npx tsc
  fi
  cp -r dist "$INSTALL_DIR/node-agent/"
  cp -r node_modules "$INSTALL_DIR/node-agent/"
  cp package.json "$INSTALL_DIR/node-agent/"
  cp entrypoint.sh "$INSTALL_DIR/node-agent/"
  cd - > /dev/null
else
  echo "For remote install, clone the repo first:"
  echo "  git clone <repo-url> && cd meshmind"
  echo "  ./scripts/install-node.sh --hub $HUB_URL --token $HUB_TOKEN --name $NODE_NAME"
  exit 1
fi

# Write env file for easy management
cat > "$INSTALL_DIR/.env" << ENV
NODE_NAME=$NODE_NAME
HUB_URL=$HUB_URL
HUB_TOKEN=$HUB_TOKEN
AGENT_PORT=$AGENT_PORT
ENV

# Write management scripts
cat > "$INSTALL_DIR/start.sh" << 'SCRIPT'
#!/bin/bash
cd "$(dirname "$0")"
docker compose up -d
SCRIPT
chmod +x "$INSTALL_DIR/start.sh"

cat > "$INSTALL_DIR/stop.sh" << 'SCRIPT'
#!/bin/bash
cd "$(dirname "$0")"
docker compose down
SCRIPT
chmod +x "$INSTALL_DIR/stop.sh"

cat > "$INSTALL_DIR/logs.sh" << 'SCRIPT'
#!/bin/bash
cd "$(dirname "$0")"
docker compose logs -f
SCRIPT
chmod +x "$INSTALL_DIR/logs.sh"

echo ""
echo "  Installation complete!"
echo "  ─────────────────────"
echo ""
echo "  Start:    $INSTALL_DIR/start.sh"
echo "  Stop:     $INSTALL_DIR/stop.sh"
echo "  Logs:     $INSTALL_DIR/logs.sh"
echo ""
echo "  Or manually:"
echo "    cd $INSTALL_DIR && docker compose up -d"
echo ""

# Auto-start
read -p "  Start node-agent now? [Y/n] " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]] || [ -z "$REPLY" ]; then
  cd "$INSTALL_DIR"
  docker compose up -d
  echo ""
  echo "  Node agent started! Check hub: curl -H 'Authorization: Bearer $HUB_TOKEN' $HUB_URL/nodes"
fi
