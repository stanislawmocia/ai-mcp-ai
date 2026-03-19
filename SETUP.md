# MeshMind Hub — Setup Guide

## Prerequisites

- **Docker** + **Docker Compose** (v2)
- **Tailscale** — all machines connected to same tailnet
- **Bun** (optional, for local dev without Docker)

---

## 1. Hub Server — one-time setup

```bash
# Clone repo
git clone <repo-url> meshmind && cd meshmind

# Create .env
cp .env.example .env
# Edit .env — at minimum set HUB_TOKEN:
#   openssl rand -hex 32

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

Set `NODE_NAME` in `.env` to whatever you want this machine called in the mesh (default: `hp-server`).

---

## 2. Add a new machine to the mesh

Clone the repo on the remote machine, then:

```bash
HUB_URL=http://<hub-tailscale-ip>:7433 \
HUB_TOKEN=<YOUR_HUB_TOKEN> \
NODE_NAME=alienware \
docker compose -f docker-compose.node.yml up -d --build
```

Or without Docker:

```bash
cd packages/node-agent
bun install
bun run src/bin/cli.ts \
  --name alienware \
  --hub http://<hub-tailscale-ip>:7433 \
  --token <YOUR_HUB_TOKEN> \
  --port 7432
```

> **Docker socket** — the node-agent mounts `/var/run/docker.sock` so `exec_on` can run `docker` commands. This requires the user running Docker to have socket access.

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

On any device (with Claude Code installed and connected to the same Tailscale network):

```bash
claude mcp add --transport sse meshmind http://<hub-tailscale-ip>:7434/sse
```

Claude Code will open a browser window for a one-time OAuth authorization flow. The hub auto-approves it — real security is handled by Tailscale (only devices on your tailnet can reach port 7434). After authorization, Claude has access to all MeshMind tools.

To verify the connection:

```bash
claude /mcp
# Should show: meshmind — connected
```

> **Note:** The `headers` approach (Authorization: Bearer) does not work with Claude Code — it requires OAuth 2.0 for remote SSE MCP servers. The hub implements a no-op OAuth server for this purpose.

### Connect from browser-based IDEs (Cursor, Windsurf, VSCode)

MCP SSE endpoint: `http://<hub-tailscale-ip>:7434/sse`

**Cursor** — `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "meshmind": {
      "url": "http://<hub-tailscale-ip>:7434/sse"
    }
  }
}
```

**Windsurf** — `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "meshmind": {
      "serverUrl": "http://<hub-tailscale-ip>:7434/sse"
    }
  }
}
```

**VSCode (GitHub Copilot / Claude extension)** — `.vscode/mcp.json`:

```json
{
  "servers": {
    "meshmind": {
      "type": "sse",
      "url": "http://<hub-tailscale-ip>:7434/sse"
    }
  }
}
```

On first connection the client opens a browser for the OAuth flow — hub auto-approves. Subsequent connections are automatic. Tailscale ensures only machines on your tailnet can reach port 7434.

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

## 5. Command restrictions (exec_on)

Each node-agent can restrict which shell commands are allowed via two env variables. Set them in `.env` (hub's local node) or pass them when starting a remote node.

### EXEC_ALLOWLIST — whitelist

Only the listed binaries are permitted. Everything else is rejected.

```env
EXEC_ALLOWLIST=docker,git,ls,cat,head,tail,curl,wget,uname,df,free,ps
```

### EXEC_DENYLIST — blacklist

These binaries are always blocked, regardless of allowlist.

```env
EXEC_DENYLIST=rm,dd,mkfs,fdisk,chmod,chown,reboot,shutdown,poweroff
```

### Rules

- Both variables are **optional** — leave empty to allow all commands (default).
- `EXEC_DENYLIST` is checked **before** `EXEC_ALLOWLIST`.
- Matching is by **binary name only** — paths and arguments are ignored (`/usr/bin/docker ps` → checks `docker`).
- A blocked command returns exit code `1` with an error message in stderr.

### Remote node with restrictions

```bash
HUB_URL=http://<hub-tailscale-ip>:7433 \
HUB_TOKEN=<TOKEN> \
NODE_NAME=alienware \
EXEC_ALLOWLIST=docker,nvidia-smi,git \
EXEC_DENYLIST=rm,shutdown \
docker compose -f docker-compose.node.yml up -d --build
```

After changing `.env`, restart the node-agent to apply:

```bash
docker compose --profile with-local-node up -d node-agent-local
```

---

## 6. CLI Commands

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

## 7. Development (local, without Docker)

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
