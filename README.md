# MeshMind Hub

Distributed AI orchestration over Tailscale. One Claude instance that sees all your machines — execute commands, spawn sub-agents, share context between sessions.

```
Terminal (Claude + MCP client)
  → hub-mcp (:7434, MCP SSE)
    → hub-core (:7433, REST + SQLite)
      → node-agent (:7432, on each machine via Tailscale)
```

## Quick Start

### Hub server (one-time setup)

```bash
# 1. Clone and configure
git clone <repo-url> meshmind && cd meshmind
cp .env.example .env          # set HUB_TOKEN (use: openssl rand -hex 32)

# 2. Start
docker compose up -d

# 3. Verify
curl http://localhost:7433/health
curl http://localhost:7434/health
```

### Add a machine to the mesh

Na nowej maszynie (wymaga Docker + Tailscale):

```bash
git clone <repo-url> meshmind && cd meshmind

HUB_URL=http://<hub-tailscale-ip>:7433 \
HUB_TOKEN=<twój-token> \
NODE_NAME=<nazwa-maszyny> \
docker compose -f docker-compose.node.yml up -d
```

Weryfikacja z huba:

```bash
curl -H "Authorization: Bearer <TOKEN>" http://localhost:7433/nodes
```

### Connect Claude Code (terminal, CLI)

Na dowolnym urządzeniu z Claude Code + Tailscale:

```bash
claude mcp add --transport sse meshmind http://<hub-tailscale-ip>:7434/sse
```

Claude otworzy przeglądarkę na jednorazowy OAuth flow (auto-akceptuje — bezpieczeństwo zapewnia Tailscale). Po autoryzacji wszystkie narzędzia MeshMind są dostępne w Claude.

### Connect z przeglądarki / IDE (Cursor, Windsurf, VSCode)

MCP endpoint: `http://<hub-tailscale-ip>:7434/sse`

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

**VSCode (GitHub Copilot)** — `.vscode/mcp.json` w projekcie lub `settings.json`:

```json
{
  "mcp": {
    "servers": {
      "meshmind": {
        "type": "sse",
        "url": "http://<hub-tailscale-ip>:7434/sse"
      }
    }
  }
}
```

> Każdy klient, który obsługuje MCP over SSE, może się podpiąć pod ten sam endpoint. Hub implementuje no-op OAuth 2.0 — pierwszy request otworzy przeglądarkę z formularzem autoryzacji (auto-akceptuje). Tailscale zapewnia, że tylko maszyny w twojej sieci mogą w ogóle dobić do portu 7434.

## MCP Tools

| Tool | Description |
|------|-------------|
| `list_nodes` | List all connected machines |
| `node_info` | Details and capabilities of a node |
| `exec_on` | Run a shell command on any node |
| `spawn_agent` | Start an AI agent (claude-code, python, bash...) on a node |
| `agent_send` | Send input to an interactive agent session |
| `agent_read` | Read agent output (ring buffer) |
| `agent_kill` | Kill an agent session |
| `list_agents` | List all sessions across all nodes |
| `check_connection` | Test TCP connectivity between nodes |
| `set_context` / `get_context` | Shared key-value store with optional TTL |

## Ports

| Port | Service | Where |
|------|---------|-------|
| 7432 | node-agent | Each machine |
| 7433 | hub-core | Hub server |
| 7434 | hub-mcp | Hub server |

## Requirements

- Docker + Docker Compose v2
- Tailscale (all machines on the same tailnet)
- Bun (optional — for local dev without Docker)

See [SETUP.md](SETUP.md) for detailed instructions.
