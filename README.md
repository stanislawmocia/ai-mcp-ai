# mcp-ai-comm

AI-to-AI communication system over Tailscale with end-to-end encryption.

Allows Claude Code, Gemini CLI and other AI agents to communicate securely across your Tailscale network — for remote debugging, collaborative problem-solving, and cross-system coordination.

## Architecture

```
[Local Machine]                    [Remote Server]
┌──────────────────┐               ┌──────────────────┐
│  Claude Code     │               │  Gemini CLI      │
│  + MCP Client    │               │  + MCP Client    │
│        │         │               │        │         │
│  mcp-ai-comm     │◄─────────────►│  mcp-ai-comm     │
│  ├── MCP Server  │   Tailscale   │  ├── MCP Server  │
│  ├── HTTP :7432  │   WireGuard   │  ├── HTTP :7432  │
│  ├── SQLite DB   │   + E2E Crypto│  ├── SQLite DB   │
│  └── Crypto Keys │               │  └── Crypto Keys │
└──────────────────┘               └──────────────────┘
```

**Security layers:**
1. **Network:** Tailscale WireGuard VPN — all traffic encrypted at the network level
2. **Application:** libsodium `crypto_box_easy` — Curve25519 + XSalsa20-Poly1305 E2E encryption
3. **Key storage:** AES-256-GCM encrypted secret key in SQLite (passphrase from env var)
4. **Access control:** HTTP server binds only to Tailscale IP (100.x.x.x)

## Installation

```bash
git clone <repo> mcp-ai-comm
cd mcp-ai-comm
npm install
npm run build
```

## Configuration

```bash
cp config.example.json config.json
# Edit config.json with your settings
```

Set the required environment variable for key encryption:

```bash
# Add to ~/.bashrc or ~/.zshrc
export MCP_COMM_KEY_PASSPHRASE="your-strong-passphrase-here"
```

> **Important:** Use the same passphrase on the same machine. If you change it, delete `comm.db` to regenerate keys.

### config.json fields

| Field | Description |
|-------|-------------|
| `device.alias` | Name for this node (shown to other AIs) |
| `device.http_port` | Port for incoming messages (default: 7432) |
| `device.ssh_user` | SSH username for wake_device |
| `device.ssh_key_path` | SSH private key path |
| `listener.poll_interval_ms` | How often to check for messages (ms) |
| `peers.<name>.tailscale_ip` | Tailscale IP of peer (from `tailscale status`) |
| `agents.claude.command` | Command to start Claude Code |

## Adding to Claude Code as MCP

Add to `~/.config/claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ai-comm": {
      "command": "node",
      "args": ["/path/to/mcp-ai-comm/dist/index.js"],
      "env": {
        "MCP_COMM_KEY_PASSPHRASE": "your-passphrase",
        "MCP_COMM_CONFIG": "/path/to/mcp-ai-comm/config.json"
      }
    }
  }
}
```

Or for development (no build needed):

```json
{
  "mcpServers": {
    "ai-comm": {
      "command": "npx",
      "args": ["tsx", "/path/to/mcp-ai-comm/src/index.ts"],
      "env": {
        "MCP_COMM_KEY_PASSPHRASE": "your-passphrase",
        "MCP_COMM_CONFIG": "/path/to/mcp-ai-comm/config.json"
      }
    }
  }
}
```

## Adding to Gemini CLI as MCP

Gemini CLI supports MCP via its `settings.json`. Add:

```json
{
  "mcpServers": {
    "ai-comm": {
      "command": "node",
      "args": ["/path/to/mcp-ai-comm/dist/index.js"],
      "env": {
        "MCP_COMM_KEY_PASSPHRASE": "your-passphrase",
        "MCP_COMM_CONFIG": "/path/to/mcp-ai-comm/config.json"
      }
    }
  }
}
```

> **Note:** Gemini CLI MCP support may vary by version. Check `gemini --help` for MCP configuration options.

## Available Tools

| Tool | Description |
|------|-------------|
| `list_devices` | List all Tailscale network devices |
| `send_message` | Send encrypted message to a device |
| `read_messages` | Read incoming messages |
| `wait_for_reply` | Wait (poll) for a reply |
| `ping_with_message` | Send + wait for reply in one call |
| `reply_to` | Reply to a specific message by ID |
| `request_approval` | Request approve/deny for an action |
| `wake_device` | Wake device via SSH or WoL + start AI agent |
| `start_listener` | Start background message polling |
| `stop_listener` | Stop listener |
| `get_status` | Get node status and connected peers |

## Example Usage

### Basic communication

**On Machine A (Claude):**
```
> list_devices
→ Shows all Tailscale peers

> send_message(to="vps-server", message="Hello from Claude! Can you check disk space?")
→ {message_id: "...", status: "sent"}

> wait_for_reply(message_id="...", timeout_seconds=30)
→ {from: "gemini-vps", message: "Disk space: 45GB free on /dev/sda1"}
```

**On Machine B (Gemini):**
```
> read_messages()
→ [{from: "macbook-claude", message: "Hello from Claude! Can you check disk space?"}]

> reply_to(message_id="...", reply="Disk space: 45GB free on /dev/sda1")
```

### Approval flow (risky actions)

**Remote AI (on server) asks for approval:**
```
> request_approval(
    to="macbook-stan",
    action="Delete all log files in /var/log/app/ (12GB)",
    context="Disk is 95% full, logs are from 3 months ago",
    timeout_seconds=120
  )
```

**Local AI/you approves:**
```
> read_messages(message_type="approval_request")
→ Shows the request

> reply_to(message_id="...", reply="approve")
```

**Remote AI gets:**
```json
{
  "approved": true,
  "action": "Delete all log files...",
  "responded_by": "macbook-stan"
}
```

### Wake a remote device and start AI

```
> wake_device(device="vps-server", method="ssh", start_agent=true, agent="gemini")
→ {woken: true, method_used: "ssh", agent_started: true}

> ping_with_message(to="vps-server", message="Are you awake and ready?")
→ {reply: {message: "Yes, Gemini here! Ready to help."}}
```

### Auto-listener

```
> start_listener(auto_reply=true, auto_reply_prompt="You are a helpful assistant. Reply concisely.")
→ {started: true, auto_reply: true}

# Now incoming messages get automatic replies
# Check stats later:
> stop_listener()
→ {stopped: true, messages_received_since_start: 7}
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MCP_COMM_KEY_PASSPHRASE` | **YES** | Passphrase to encrypt/decrypt private key in DB |
| `MCP_COMM_CONFIG` | No | Path to config.json (default: `./config.json`) |
| `MCP_COMM_ALIAS` | No | Override device alias |
| `MCP_COMM_PORT` | No | Override HTTP port |
| `MCP_COMM_DB_PATH` | No | Override DB path |

## Troubleshooting

### Tailscale not working

```bash
tailscale status        # Check Tailscale is connected
tailscale ip            # Should show 100.x.x.x address
ping 100.x.x.x          # Check connectivity to peer
```

### Peer offline when sending

```
Error: Failed to reach vps-server (100.x.x.x:7432)
```

1. Check if peer is in Tailscale: `tailscale status`
2. Wake the device: `wake_device(device="vps-server")`
3. Verify peer's MCP server is running

### Wrong passphrase / can't decrypt keys

```
Error: Failed to decrypt secret key - wrong passphrase?
```

If you forget the passphrase: delete `comm.db` and restart (new keys will be generated).
Peers will need to re-fetch your new public key on next contact.

### HTTP server won't start

```
Error: Failed to start HTTP server on 100.x.x.x:7432
```

1. Check Tailscale is up: `tailscale status`
2. Check port isn't in use: `ss -tlnp | grep 7432`
3. Change port in config.json: `"http_port": 7433`

### Messages not decrypting

This usually means a peer's public key changed (they regenerated keys). Solution:
```bash
# Delete peer's cached key in DB:
sqlite3 comm.db "UPDATE peers SET public_key='' WHERE alias='peer-name';"
# Next send_message will re-fetch their new key
```

## Security Notes

- Private key is encrypted with AES-256-GCM + PBKDF2(100k iterations) using your passphrase
- HTTP server only accepts connections from Tailscale IPs (100.x.x.x/8)
- All message content is E2E encrypted — the HTTP server cannot read message contents
- Nonces are randomly generated per message (XSalsa20 safe range for random nonces)
- Public key exchange is protected by Tailscale's WireGuard layer
