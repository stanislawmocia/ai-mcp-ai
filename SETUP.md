# MeshMind Hub — Setup Guide

## Prerequisites

- **Docker** + **Docker Compose** (v2)
- **Tailscale** — all machines connected to same tailnet
- **Bun** (optional, for local dev without Docker)

---

## 1. Hub Server (HP Server) — one-time setup

```bash
# Clone repo
git clone <repo-url> meshmind && cd meshmind

# Create .env
cp .env.example .env
# Edit .env — set a strong HUB_TOKEN (use: openssl rand -hex 32)

# Start hub-core + hub-mcp (always-on services)
docker compose up -d

# Verify
curl http://localhost:7433/health
curl http://localhost:7434/health
```

Hub is now running:
- `:7433` — hub-core (REST API, node registry, task broker, context store)
- `:7434` — hub-mcp (MCP SSE endpoint for Claude)

### Optional: run node-agent on the hub server too

```bash
docker compose --profile with-local-node up -d
```

---

## 2. Add a new machine to the mesh

### Option A: Install script (recommended)

On the new machine:

```bash
git clone <repo-url> meshmind && cd meshmind

./scripts/install-node.sh \
  --hub http://<hub-tailscale-ip>:7433 \
  --token <YOUR_HUB_TOKEN> \
  --name alienware
```

This creates `~/.meshmind/` with docker-compose and management scripts:
- `~/.meshmind/start.sh` — start the agent
- `~/.meshmind/stop.sh` — stop the agent
- `~/.meshmind/logs.sh` — view logs

### Option B: Manual docker-compose

```bash
HUB_URL=http://<hub-tailscale-ip>:7433 \
HUB_TOKEN=<token> \
NODE_NAME=alienware \
docker compose -f docker-compose.node.yml up -d
```

### Option C: Direct (no Docker)

```bash
cd packages/node-agent
bun install
bun run src/bin/cli.ts \
  --name alienware \
  --hub http://<hub-tailscale-ip>:7433 \
  --token <YOUR_HUB_TOKEN> \
  --port 7432
```

---

## 3. Verify the mesh

```bash
# From hub server
curl -H "Authorization: Bearer <TOKEN>" http://localhost:7433/nodes

# Or with CLI
export HUB_URL=http://localhost:7433
export HUB_TOKEN=<TOKEN>
hub status
```

You should see all connected nodes with their Tailscale IPs and available tools.

---

## 4. Connect Claude via MCP

Add to your Claude MCP config (`~/.claude/mcp.json` or IDE settings):

```json
{
  "mcpServers": {
    "meshmind": {
      "url": "http://<hub-tailscale-ip>:7434/sse",
      "headers": {
        "Authorization": "Bearer <YOUR_HUB_TOKEN>"
      }
    }
  }
}
```

### Available MCP tools

| Tool | Description |
|------|-------------|
| `list_nodes` | List all mesh nodes |
| `node_info` | Details about a node |
| `exec_on` | Execute command on remote node |
| `spawn_agent` | Start agent (claude-code, python, bash...) on node |
| `agent_send` | Send message to interactive agent session |
| `agent_read` | Read agent output (ring buffer) |
| `agent_kill` | Kill running agent |
| `list_agents` | List all agent sessions across mesh |
| `check_connection` | Test TCP connectivity between nodes |
| `set_context` / `get_context` | Shared context store with TTL |

---

## 5. CLI Commands

```bash
export HUB_URL=http://localhost:7433
export HUB_TOKEN=<TOKEN>

# Node management
hub status                         # list all nodes

# Remote execution
hub exec hp-server "uname -a"     # run command
hub exec alienware "nvidia-smi"   # check GPU

# Agent orchestration
hub spawn hp-server claude-code -w /home/user/project -p "fix the tests"
hub spawn alienware python -w /tmp --mode interactive
hub agents                         # list all sessions
hub logs <session-id>              # view output
hub logs <session-id> -f           # follow output
hub send <session-id> "print('hello')"  # send to interactive agent
hub kill <session-id>              # kill agent
```

---

## 6. Development (local, without Docker)

```bash
# Install deps
bun run install:all

# Terminal 1: hub-core
bun run dev:hub-core

# Terminal 2: hub-mcp
bun run dev:hub-mcp

# Terminal 3: node-agent
bun run dev:node-agent
```

---

## Architecture

```
Terminal (Claude + MCP client)
  → hub-mcp (:7434, MCP protocol over SSE)
    → hub-core (:7433, Fastify REST + SQLite)
      → node-agent (:7432 on each machine, via Tailscale)
        → AgentManager (spawns processes, stdin/stdout bridge)
```

## Ports

| Port | Service | Where |
|------|---------|-------|
| 7432 | node-agent | Each machine |
| 7433 | hub-core | Hub server |
| 7434 | hub-mcp | Hub server |
