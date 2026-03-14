# mcp-ai-comm

AI-to-AI communication over Tailscale with end-to-end encryption.

Lets Claude Code, Gemini CLI and other AI agents send encrypted messages to each other across your Tailscale network — for remote debugging, collaborative problem-solving, and cross-system coordination.

```
[Machine A]                        [Machine B]
┌──────────────────┐               ┌──────────────────┐
│  Claude Code     │               │  Gemini CLI      │
│        │         │               │        │         │
│  mcp-ai-comm     │◄─────────────►│  mcp-ai-comm     │
│  ├── MCP (stdio) │   Tailscale   │  ├── MCP (stdio) │
│  ├── HTTP :7432  │   WireGuard   │  ├── HTTP :7432  │
│  └── SQLite DB   │   + E2E crypto│  └── SQLite DB   │
└──────────────────┘               └──────────────────┘
```

## Prerequisites

- [Tailscale](https://tailscale.com) installed and connected on every machine (`tailscale status` shows peers)
- Docker — for the Docker path
- Node.js 20+ — for the manual path

---

## Option A — Docker (recommended)

### 1. Clone and prepare config

```bash
git clone <repo> mcp-ai-comm
cd mcp-ai-comm
make setup
```

This copies `config.example.json → config.json` and `.env.example → .env`.

### 2. Edit config.json

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

### 3. Edit .env

```bash
MCP_COMM_KEY_PASSPHRASE=pick-a-strong-passphrase
```

> Keep this passphrase consistent on the same machine. Changing it requires deleting `comm.db`.

### 4. Build and start

```bash
make build   # build the Docker image (~1 min, one-time)
make up      # start HTTP receiver in the background
make logs    # tail logs to verify it's running
```

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

---

## Option B — Without Docker

```bash
git clone <repo> mcp-ai-comm
cd mcp-ai-comm
npm install
npm run build

cp config.example.json config.json
# edit config.json

export MCP_COMM_KEY_PASSPHRASE="your-strong-passphrase"
```

---

## Connect to Claude Code

Pick one of the methods below and add it to `~/.claude/claude_desktop_config.json` (or `~/.config/claude/claude_desktop_config.json`):

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
        "--env-file", "/absolute/path/to/mcp-ai-comm/.env",
        "mcp-ai-comm:latest"
      ]
    }
  }
}
```

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

---

## Available tools

| Tool | Description |
|------|-------------|
| `list_devices` | List all Tailscale peers |
| `send_message` | Send an encrypted message to a peer |
| `read_messages` | Read incoming messages |
| `reply_to` | Reply to a message by ID |
| `wait_for_reply` | Poll until a reply arrives |
| `ping_with_message` | Send + wait for reply in one call |
| `request_approval` | Ask a peer to approve/deny an action |
| `wake_device` | Wake a device via SSH or WoL and optionally start an AI agent |
| `start_listener` | Start background message polling (with optional auto-reply) |
| `stop_listener` | Stop the listener |
| `get_status` | Show node status and peer connections |

---

## Example usage

### Basic message exchange

**Machine A (Claude):**
```
list_devices
→ Shows Tailscale peers

send_message(to="vps-server", message="Can you check disk space?")
→ {message_id: "abc123", status: "sent"}

wait_for_reply(message_id="abc123", timeout_seconds=30)
→ {from: "vps-server", message: "45 GB free on /dev/sda1"}
```

**Machine B (Gemini):**
```
read_messages()
→ [{from: "macbook-stan", message: "Can you check disk space?"}]

reply_to(message_id="abc123", reply="45 GB free on /dev/sda1")
```

### Approval flow

```
# Remote AI requests approval:
request_approval(
  to="macbook-stan",
  action="Delete /var/log/app/ (12 GB of 3-month-old logs)",
  context="Disk is at 95%",
  timeout_seconds=120
)

# Local Claude reads and approves:
read_messages(message_type="approval_request")
reply_to(message_id="...", reply="approve")

# Remote AI receives:
{approved: true, responded_by: "macbook-stan"}
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
| `MCP_COMM_PORT` | no | Override HTTP port |
| `MCP_COMM_DB_PATH` | no | Override SQLite DB path |

## config.json fields

| Field | Description |
|-------|-------------|
| `device.alias` | Name shown to other AIs |
| `device.http_port` | Port for incoming messages (default: 7432) |
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
tailscale ip              # must show 100.x.x.x
```

### HTTP server won't start

```
Error: Failed to start HTTP server on 100.x.x.x:7432
```

1. Confirm Tailscale is up: `tailscale status`
2. Check port: `lsof -i :7432`
3. Change port in `config.json`: `"http_port": 7433`

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

---

## Security

- **Network layer:** Tailscale WireGuard VPN
- **Application layer:** libsodium `crypto_box_easy` — Curve25519 + XSalsa20-Poly1305 E2E encryption
- **Key storage:** private key encrypted with AES-256-GCM + PBKDF2 (100k iterations) using your passphrase
- **Access control:** HTTP server only accepts connections from Tailscale IPs (`100.x.x.x/8`)
- Public key exchange is protected by the WireGuard layer — no TOFU risk
