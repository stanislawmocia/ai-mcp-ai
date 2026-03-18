# MeshMind Hub

Distributed AI orchestration hub over Tailscale. One interface to talk to Claude — it sees all your machines via MCP and can execute commands, spawn sub-agents, check configs, and share context between sessions.

## Architecture

```
Terminal (Claude/Gemini/Cursor + MCP client)
  → hub-mcp (:7434, MCP protocol)
    → hub-core (:7433, Fastify REST)
      → node-agent (:7432 on each machine, via Tailscale)
```

## Project Structure

```
packages/
  node-agent/   — daemon on each machine (meshmind-node npm package)
  hub-core/     — central server: registry, broker, context store
  hub-mcp/      — MCP server exposing tools to Claude
cli/            — `hub` CLI command
```

## Commands

```bash
# Install all dependencies
npm run install:all

# Build everything
npm run build

# Dev mode (individual)
npm run dev:hub-core
npm run dev:hub-mcp
npm run dev:node-agent

# Docker
docker compose up -d
```

## Key Ports

- 7432 — node-agent (on each machine)
- 7433 — hub-core (on HP Server)
- 7434 — hub-mcp (MCP SSE endpoint)

## Auth

All services use `Bearer <HUB_TOKEN>` from `.env`.

## MCP Tools

- `list_nodes` — list all mesh nodes
- `node_info` — details about a node
- `exec_on` — execute command on remote node
- `spawn_agent` / `agent_send` / `agent_read` / `agent_kill` — Phase 2
- `check_connection` — test TCP connectivity between nodes
- `set_context` / `get_context` — shared context store with TTL
