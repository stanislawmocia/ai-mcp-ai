# mcp-ai-comm

AI-to-AI communication over Tailscale with end-to-end encryption.

Lets Claude Code, Gemini CLI, OpenCode and other AI agents send encrypted messages to each other across your Tailscale network — for remote debugging, collaborative problem-solving, and cross-system coordination.

Each running MCP instance gets a unique **session ID**, so you can run multiple agents (e.g. in tmux panes) on the same device and address each one individually.

```
[Machine A]                        [Machine B]
┌──────────────────┐               ┌──────────────────┐
│  Claude Code     │               │  Gemini CLI      │
│  session: a3f1   │               │  session: b7e2   │
│        │         │               │        │         │
│  mcp-ai-comm     │◄─────────────►│  mcp-ai-comm     │
│  ├── MCP (stdio) │   Tailscale   │  ├── MCP (stdio) │
│  ├── HTTP :7432  │   WireGuard   │  ├── HTTP :7433  │
│  └── SQLite DB   │   + E2E crypto│  └── SQLite DB   │
└──────────────────┘               └──────────────────┘
```

## Prerequisites

- [Tailscale](https://tailscale.com) installed and connected on every machine (`tailscale status` shows peers)
- Docker — for the Docker path (works on Linux, macOS, Windows)
- Node.js 20+ — for the manual path

---

## Quick start — Docker (all platforms)

```bash
git clone <repo> mcp-ai-comm
cd mcp-ai-comm
make setup          # creates config.json and .env from examples
```

Edit `config.json` — set your alias and peers:

```jsonc
{
  "device": {
    "alias": "macbook-stan",   // name shown to other AIs
    "http_port": 7432
  },
  "peers": {
    "vps-server": {
      "tailscale_ip": "100.x.x.x",   // from: tailscale status
      "alias": "vps-server"
    }
  }
}
```

Edit `.env` — set your passphrase (and Tailscale IP on macOS/Windows):

```bash
MCP_COMM_KEY_PASSPHRASE=pick-a-strong-passphrase

# macOS/Windows only — set your Tailscale IP:
TAILSCALE_IP=100.x.x.x    # find with: tailscale ip --4
```

Build and start:

```bash
make build   # build Docker image (~1 min, one-time)
make up      # start HTTP receiver in background
make logs    # verify it's running
```

### Platform notes

| Platform | Networking | Tailscale access |
|----------|-----------|-----------------|
| **Linux** | `--network host` (direct Tailscale IP binding) | Socket mount: `/var/run/tailscale` |
| **macOS** | Port mapping (`-p 7432:7432`) | Set `TAILSCALE_IP` in `.env` |
| **Windows** | Port mapping (`-p 7432:7432`) | Set `TAILSCALE_IP` in `.env` |

On macOS/Windows, edit `docker-compose.yml`:
1. Remove/comment `network_mode: host`
2. Uncomment the `ports` section

### Makefile reference

| Command | What it does |
|---------|-------------|
| `make setup` | Create `config.json` and `.env` from examples |
| `make build` | Build the Docker image |
| `make up` | Start HTTP receiver in background |
| `make down` | Stop |
| `make logs` | Tail logs |
| `make restart` | Restart container |
| `make rebuild` | Rebuild image + restart (use after code or .env changes) |
| `make mcp-run` | Run as interactive MCP server via stdio |
| `make mcp-session SESSION_ID=agent1 PORT=7433` | Run a named session on a specific port |

---

## Quick start — Without Docker

```bash
git clone <repo> mcp-ai-comm
cd mcp-ai-comm
npm install
npm run build

cp config.example.json config.json
# edit config.json

export MCP_COMM_KEY_PASSPHRASE="your-strong-passphrase"
node dist/index.js
```

---

## Multi-session support

Each MCP instance automatically gets a unique session ID (e.g. `macbook-stan/a3f1`). This allows running multiple agents in tmux or separate terminals:

```bash
# Terminal 1 — Claude Code on port 7432
MCP_COMM_SESSION_ID=claude1 MCP_COMM_PORT=7432 node dist/index.js

# Terminal 2 — Gemini CLI on port 7433
MCP_COMM_SESSION_ID=gemini1 MCP_COMM_PORT=7433 MCP_COMM_DB_PATH=./comm-gemini1.db node dist/index.js
```

With Docker:

```bash
# Session 1
make mcp-session SESSION_ID=claude1 PORT=7432

# Session 2 (in another terminal)
make mcp-session SESSION_ID=gemini1 PORT=7433
```

When sending messages, you can target a specific session:

```
send_message(to="macbook-stan", ...)           # sends to default port
send_message(to="macbook-stan/claude1", ...)    # sends to specific session
send_message(to="macbook-stan", port=7433, ...)  # sends to specific port
```

The `get_status` tool shows the current session ID:

```json
{
  "alias": "macbook-stan",
  "session_id": "claude1",
  "session_alias": "macbook-stan/claude1",
  "http_port": 7432
}
```

---

## Connect to Claude Code

Add to `~/.claude.json` (mcpServers section) or project `.mcp.json`:

### Via Docker (after `make build`)

```json
{
  "mcpServers": {
    "ai-comm": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "--network", "host",
        "-v", "/var/run/tailscale:/var/run/tailscale",
        "-v", "/absolute/path/to/mcp-ai-comm/config.json:/app/config.json:ro",
        "-v", "mcp_ai_comm_data:/data",
        "-e", "MCP_COMM_DOCKER=1",
        "--env-file", "/absolute/path/to/mcp-ai-comm/.env",
        "mcp-ai-comm:latest"
      ]
    }
  }
}
```

macOS/Windows — replace `"--network", "host"` with `"-p", "7432:7432"` and add `-e TAILSCALE_IP=100.x.x.x`.

### Via Node (after `npm run build`)

```json
{
  "mcpServers": {
    "ai-comm": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-ai-comm/dist/index.js"],
      "env": {
        "MCP_COMM_KEY_PASSPHRASE": "your-passphrase",
        "MCP_COMM_CONFIG": "/absolute/path/to/mcp-ai-comm/config.json"
      }
    }
  }
}
```

### Via npx / tsx (dev mode, no build needed)

```json
{
  "mcpServers": {
    "ai-comm": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/mcp-ai-comm/src/index.ts"],
      "env": {
        "MCP_COMM_KEY_PASSPHRASE": "your-passphrase",
        "MCP_COMM_CONFIG": "/absolute/path/to/mcp-ai-comm/config.json"
      }
    }
  }
}
```

## Connect to Gemini CLI

Add to Gemini CLI's `settings.json`:

```json
{
  "mcpServers": {
    "ai-comm": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-ai-comm/dist/index.js"],
      "env": {
        "MCP_COMM_KEY_PASSPHRASE": "your-passphrase",
        "MCP_COMM_CONFIG": "/absolute/path/to/mcp-ai-comm/config.json"
      }
    }
  }
}
```

## Connect to OpenCode / other MCP clients

Any MCP client that supports stdio servers can use this. The pattern is always:

```json
{
  "mcpServers": {
    "ai-comm": {
      "command": "node",
      "args": ["/path/to/mcp-ai-comm/dist/index.js"],
      "env": {
        "MCP_COMM_KEY_PASSPHRASE": "your-passphrase",
        "MCP_COMM_CONFIG": "/path/to/config.json"
      }
    }
  }
}
```

Or via Docker:

```json
{
  "mcpServers": {
    "ai-comm": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "--network", "host",
        "-v", "/var/run/tailscale:/var/run/tailscale",
        "-v", "/path/to/config.json:/app/config.json:ro",
        "-v", "mcp_ai_comm_data:/data",
        "-e", "MCP_COMM_DOCKER=1",
        "--env-file", "/path/to/.env",
        "mcp-ai-comm:latest"
      ]
    }
  }
}
```

---

## Available tools

| Tool | Description |
|------|-------------|
| `list_devices` | List all Tailscale peers |
| `send_message` | Send an encrypted message to a peer (supports session targeting) |
| `read_messages` | Read incoming messages |
| `reply_to` | Reply to a message by ID |
| `wait_for_reply` | Poll until a reply arrives |
| `ping_with_message` | Send + wait for reply in one call |
| `request_approval` | Ask a peer to approve/deny an action |
| `wake_device` | Wake a device via SSH or WoL and optionally start an AI agent |
| `start_listener` | Start background message polling (with optional auto-reply) |
| `stop_listener` | Stop the listener |
| `get_status` | Show node status, session info, and peer connections |

---

## Example usage

### Basic message exchange

**Machine A (Claude):**
```
list_devices
→ Shows Tailscale peers

send_message(to="vps-server", message="Can you check disk space?")
→ {message_id: "abc123", status: "sent", from_session: "macbook-stan/a3f1"}

wait_for_reply(message_id="abc123", timeout_seconds=30)
→ {from: "vps-server/b7e2", message: "45 GB free on /dev/sda1"}
```

**Machine B (Gemini):**
```
read_messages()
→ [{from: "macbook-stan/a3f1", message: "Can you check disk space?"}]

reply_to(message_id="abc123", reply="45 GB free on /dev/sda1")
```

### Multi-session on one machine

```bash
# tmux pane 1:
MCP_COMM_SESSION_ID=claude1 MCP_COMM_PORT=7432 node dist/index.js
# → Session: macbook-stan/claude1

# tmux pane 2:
MCP_COMM_SESSION_ID=gemini1 MCP_COMM_PORT=7433 MCP_COMM_DB_PATH=./comm-gemini.db node dist/index.js
# → Session: macbook-stan/gemini1

# From another machine, target a specific session:
send_message(to="macbook-stan", port=7433, message="Hey Gemini!")
```

### Approval flow

```
request_approval(
  to="macbook-stan",
  action="Delete /var/log/app/ (12 GB of 3-month-old logs)",
  context="Disk is at 95%",
  timeout_seconds=120
)

# Local AI reads and approves:
read_messages(message_type="approval_request")
reply_to(message_id="...", reply="approve")
```

### Auto-listener

```
start_listener(auto_reply=true, auto_reply_prompt="Reply concisely.")
→ {started: true}

# ... handles incoming messages automatically ...

stop_listener()
→ {stopped: true, messages_received_since_start: 7}
```

---

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MCP_COMM_KEY_PASSPHRASE` | **yes** | Encrypts/decrypts your private key in the DB |
| `MCP_COMM_CONFIG` | no | Path to `config.json` (default: `./config.json`) |
| `MCP_COMM_ALIAS` | no | Override device alias from config |
| `MCP_COMM_PORT` | no | Override HTTP port (default: 7432) |
| `MCP_COMM_DB_PATH` | no | Override SQLite DB path |
| `TAILSCALE_IP` | no* | Your Tailscale IP — **required on macOS/Windows Docker** |
| `TAILSCALE_SOCKET` | no | Custom Tailscale socket path |
| `MCP_COMM_BIND_ADDRESS` | no | Force HTTP bind address (default: auto-detect) |
| `MCP_COMM_SESSION_ID` | no | Fixed session ID (default: random 4-hex) |
| `MCP_COMM_DOCKER` | no | Set to `1` to enable Docker mode (auto-set by Makefile) |

## config.json fields

| Field | Description |
|-------|-------------|
| `device.alias` | Name shown to other AIs |
| `device.http_port` | Port for incoming messages (default: 7432) |
| `device.bind_address` | HTTP bind address (default: auto-detect) |
| `device.ssh_user` | SSH user for `wake_device` |
| `device.ssh_key_path` | SSH private key path |
| `listener.poll_interval_ms` | Listener poll interval in ms |
| `peers.<name>.tailscale_ip` | Peer's Tailscale IP (`tailscale status`) |
| `agents.claude.command` | Command to launch Claude Code |

---

## Troubleshooting

### Tailscale not connected

```bash
tailscale status          # must show your peers
tailscale ip --4          # must show 100.x.x.x
```

### Docker on macOS/Windows — can't reach Tailscale

Set `TAILSCALE_IP=100.x.x.x` in your `.env` file. The Docker container on macOS/Windows can't access the host Tailscale daemon socket.

### HTTP server won't start

```
Error: Failed to start HTTP server on 100.x.x.x:7432
```

1. Confirm Tailscale is up: `tailscale status`
2. Check port: `lsof -i :7432`
3. Change port in `config.json`: `"http_port": 7433`
4. Try: `MCP_COMM_BIND_ADDRESS=0.0.0.0` in `.env`

### Wrong passphrase

```
Error: Failed to decrypt secret key - wrong passphrase?
```

Delete `comm.db` (or `/data/comm.db` in Docker) and restart — new keys will be generated. Peers will re-exchange public keys on next contact.

### Messages not decrypting (peer changed keys)

```bash
sqlite3 comm.db "UPDATE peers SET public_key='' WHERE alias='peer-name';"
# Next send_message will re-fetch their public key automatically
```

### Multiple sessions conflicting

Each session needs its own:
- **Port** (`MCP_COMM_PORT=7433`)
- **DB file** (`MCP_COMM_DB_PATH=./comm-session2.db`) — if you want separate message stores
- **Session ID** (`MCP_COMM_SESSION_ID=agent2`) — optional, auto-generated if not set

---

## Security

- **Network layer:** Tailscale WireGuard VPN
- **Application layer:** libsodium `crypto_box_easy` — Curve25519 + XSalsa20-Poly1305 E2E encryption
- **Key storage:** private key encrypted with AES-256-GCM + PBKDF2 (100k iterations) using your passphrase
- **Access control:** HTTP server only accepts connections from Tailscale IPs (`100.x.x.x/8`)
- Public key exchange is protected by the WireGuard layer — no TOFU risk
