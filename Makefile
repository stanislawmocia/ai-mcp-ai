.PHONY: setup build up down logs restart rebuild mcp-run mcp-session

# ── OS detection ──────────────────────────────────────────────────────────
UNAME_S := $(shell uname -s)
ifeq ($(UNAME_S),Darwin)
  TAILSCALE_SOCKET_VOL := -v /var/run/tailscale:/var/run/tailscale
  NETWORK_FLAG := -p 7432:7432
  DOCKER_ENV := -e MCP_COMM_DOCKER=1
else ifeq ($(OS),Windows_NT)
  TAILSCALE_SOCKET_VOL :=
  NETWORK_FLAG := -p 7432:7432
  DOCKER_ENV := -e MCP_COMM_DOCKER=1
else
  # Linux — use host networking for direct Tailscale IP binding
  TAILSCALE_SOCKET_VOL := -v /var/run/tailscale:/var/run/tailscale
  NETWORK_FLAG := --network host
  DOCKER_ENV := -e MCP_COMM_DOCKER=1
endif

# ── First-time setup ─────────────────────────────────────────────────────
setup:
	cp -n config.example.json config.json 2>/dev/null || true
	cp -n .env.example .env 2>/dev/null || true
	@echo ""
	@echo "==> Created config.json and .env from examples."
	@echo "==> Edit them, then run: make build && make up"
	@echo ""
ifeq ($(UNAME_S),Darwin)
	@echo "==> macOS detected: set TAILSCALE_IP in .env to your Tailscale IP"
	@echo "    Find it with: tailscale ip --4"
endif

# ── Docker build ─────────────────────────────────────────────────────────
build:
	docker compose build

# ── Start in background (HTTP receiver mode) ─────────────────────────────
up:
	docker compose up -d

# ── Stop ──────────────────────────────────────────────────────────────────
down:
	docker compose down

# ── Tail logs ─────────────────────────────────────────────────────────────
logs:
	docker compose logs -f

# ── Restart ───────────────────────────────────────────────────────────────
restart:
	docker compose restart

# ── Rebuild image and restart ─────────────────────────────────────────────
rebuild:
	docker compose down
	docker compose build --no-cache
	docker compose up -d
	@echo "==> Rebuilt and started. Logs: make logs"

# ── Run as MCP server via stdio (cross-platform) ─────────────────────────
# Use this in your MCP client config (Claude Code, Gemini CLI, etc.)
mcp-run:
	docker run --rm -i \
		$(NETWORK_FLAG) \
		$(TAILSCALE_SOCKET_VOL) \
		$(DOCKER_ENV) \
		-v $(PWD)/config.json:/app/config.json:ro \
		-v mcp_ai_comm_data:/data \
		--env-file .env \
		mcp-ai-comm:latest

# ── Run a named session with custom port ──────────────────────────────────
# Usage: make mcp-session SESSION_ID=agent1 PORT=7433
SESSION_ID ?= main
PORT ?= 7432
mcp-session:
	docker run --rm -i \
		$(NETWORK_FLAG) \
		$(TAILSCALE_SOCKET_VOL) \
		$(DOCKER_ENV) \
		-e MCP_COMM_SESSION_ID=$(SESSION_ID) \
		-e MCP_COMM_PORT=$(PORT) \
		-e MCP_COMM_DB_PATH=/data/comm-$(SESSION_ID).db \
		-v $(PWD)/config.json:/app/config.json:ro \
		-v mcp_ai_comm_data:/data \
		--env-file .env \
		mcp-ai-comm:latest
