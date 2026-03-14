.PHONY: setup build up down logs restart rebuild mcp-run

# First-time setup
setup:
	cp -n config.example.json config.json || true
	cp -n .env.example .env || true
	@echo ""
	@echo "==> Edit config.json and .env, then run: make up"

# Build the image
build:
	docker compose build

# Start in background (HTTP receiver mode)
up:
	docker compose up -d

# Stop
down:
	docker compose down

# Tail logs
logs:
	docker compose logs -f

# Restart
restart:
	docker compose restart

# Rebuild image and restart (use after changing .env or code)
rebuild:
	docker compose down
	docker compose build --no-cache
	docker compose up -d
	@echo "==> Rebuilt and started. Logs: make logs"

# Run as MCP server via stdio (for Claude Code config)
# Usage: make mcp-run  — or paste the docker run command into claude_desktop_config.json
mcp-run:
	docker run --rm -i \
		--network host \
		-v /var/run/tailscale:/var/run/tailscale \
		-v $(PWD)/config.json:/app/config.json:ro \
		-v mcp_ai_comm_data:/data \
		--env-file .env \
		mcp-ai-comm:latest
