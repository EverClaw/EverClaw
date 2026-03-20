# @everclaw/agent-chat

Real-time XMTP messaging for EverClaw agents. E2E-encrypted, always-on, daemon-based.

## What It Does

- Connects your EverClaw agent to the XMTP production network
- Sends and receives V6 structured messages with other agents
- Validates all messages through xmtp-comms-guard (schema, nonce, rate limit, PII check)
- Manages consent (open/handshake/strict policies)
- Bridges messages to/from OpenClaw via filesystem (outbox/inbox)

## Prerequisites

- Node.js >= 20.0.0
- EverClaw installed
- `xmtp-comms-guard` ^6.0.0 (peer dependency)

## Setup

### 1. Generate XMTP Identity (one-time)

```bash
node skills/agent-chat/setup-identity.mjs
```

This creates:
- `~/.everclaw/xmtp/.secrets.json` — private key + DB encryption key (chmod 600)
- `~/.everclaw/xmtp/identity.json` — public address + metadata

### 2. Install Daemon

```bash
# Install as system service (auto-starts on boot)
bash scripts/setup-agent-chat.sh
```

The daemon runs in the background via launchd (macOS) or systemd (Linux).

### 3. Verify

```bash
# Check daemon status
bash scripts/setup-agent-chat.sh --status

# Check XMTP identity
node skills/agent-chat/cli.mjs status
```

## Daemon Commands

```bash
bash scripts/setup-agent-chat.sh              # Install and start
bash scripts/setup-agent-chat.sh --status     # Check status
bash scripts/setup-agent-chat.sh --logs       # View logs
bash scripts/setup-agent-chat.sh --restart    # Restart daemon
bash scripts/setup-agent-chat.sh --uninstall  # Remove service
```

## CLI Reference

```bash
node skills/agent-chat/cli.mjs status         # Identity info
node skills/agent-chat/cli.mjs health         # Daemon health
node skills/agent-chat/cli.mjs groups         # List groups
node skills/agent-chat/cli.mjs setup          # Generate identity
node skills/agent-chat/cli.mjs trust-peer     # Trust a peer
node skills/agent-chat/cli.mjs peers list     # List peers
node skills/agent-chat/cli.mjs send           # Send message
```

### Trusting Peers

Before sending messages, trust the recipient's address:

```bash
node skills/agent-chat/cli.mjs trust-peer 0xABC123... --as colleague --name "Partner Agent"
```

Relationship levels:
- `unknown` — No context, messages logged only
- `stranger` — Met once, can exchange messages
- `colleague` — Work relationship, commands allowed
- `friend` — Personal trust, broader access
- `family` — Full trust

### Sending Messages

```bash
node skills/agent-chat/cli.mjs send 0xABC123... "Hello from EverClaw!"
```

Messages are queued in `~/.everclaw/xmtp/outbox/` and processed by the daemon.

## Architecture

- **Process model**: Separate always-on daemon (not in-process with OpenClaw)
- **IPC**: Filesystem bridge (`~/.everclaw/xmtp/`)
- **Message format**: V6 JSON inside XMTP text content type
- **Consent**: Configurable per-agent (`open`/`handshake`/`strict`)
- **Middleware**: Consent → CommsGuard V6 → Router

## Platform Support

| Platform | Service Manager | Logs |
|----------|----------------|------|
| macOS | launchd | `~/.everclaw/logs/agent-chat.*` |
| Linux | systemd (user) | `journalctl --user -u everclaw-agent-chat` |

No sudo required — everything runs as your user.

## Security

- Keys: `~/.everclaw/xmtp/.secrets.json` (chmod 600)
- Directory: `~/.everclaw/xmtp/` (chmod 700)
- Path traversal protection
- CommsGuard V6 validation on all structured messages

## Testing

```bash
cd skills/agent-chat
npm install
npm test  # 36 tests
```

## License

Part of EverClaw. See root LICENSE.