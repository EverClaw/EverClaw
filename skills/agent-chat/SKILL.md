# agent-chat

XMTP real-time agent-to-agent and user-to-agent messaging for EverClaw.

## Overview

Always-on daemon providing E2E-encrypted messaging via XMTP's MLS protocol. Runs as a separate process managed by launchd (macOS) or systemd (Linux), communicating with OpenClaw through a filesystem bridge.

## Version

0.2.0

## Dependencies

- `@xmtp/agent-sdk` ^2.3.0
- `xmtp-comms-guard` ^6.0.0 (peer)
- Node.js >= 20.0.0

## Quick Start

```bash
# 1. Generate XMTP identity (one-time)
node skills/agent-chat/setup-identity.mjs

# 2. Install daemon as system service
bash scripts/setup-agent-chat.sh

# 3. Check status
bash scripts/setup-agent-chat.sh --status
```

## Daemon Management

The `setup-agent-chat.sh` script installs the XMTP daemon as a persistent system service.

### Commands

```bash
# Install and start daemon (auto-detects OS)
bash scripts/setup-agent-chat.sh

# Check daemon status
bash scripts/setup-agent-chat.sh --status

# View recent logs
bash scripts/setup-agent-chat.sh --logs

# Restart daemon
bash scripts/setup-agent-chat.sh --restart

# Uninstall daemon
bash scripts/setup-agent-chat.sh --uninstall

# Install without starting
bash scripts/setup-agent-chat.sh --skip-start
```

### Platform Support

| Platform | Service Manager | Location | Logs |
|----------|----------------|----------|------|
| macOS | launchd | `~/Library/LaunchAgents/com.everclaw.agent-chat.plist` | `~/.everclaw/logs/agent-chat.*` |
| Linux | systemd (user) | `~/.config/systemd/user/everclaw-agent-chat.service` | `journalctl --user -u everclaw-agent-chat` |

**Note:** Linux uses user-level systemd (no sudo required). All services run as your user account.

### Manual Commands

**macOS (launchd):**
```bash
# Check if loaded
launchctl list | grep everclaw

# View logs
tail -f ~/.everclaw/logs/agent-chat.log

# Stop/start
launchctl bootout gui/$(id -u)/com.everclaw.agent-chat
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.everclaw.agent-chat.plist
```

**Linux (systemd):**
```bash
# Check status
systemctl --user status everclaw-agent-chat

# View logs
journalctl --user -u everclaw-agent-chat -f

# Stop/start
systemctl --user stop everclaw-agent-chat
systemctl --user start everclaw-agent-chat
```

## Architecture

- **Process model**: Separate always-on daemon (not in-process with OpenClaw)
- **IPC**: Filesystem bridge (`~/.everclaw/xmtp/outbox/` → `inbox/`)
- **Message format**: V6 JSON inside XMTP text content type
- **Consent**: Configurable per-agent (`open`/`handshake`/`strict`)
- **Middleware chain**: Consent → CommsGuard V6 → Router

## Identity Model

Two-tier:
- **28 flavor canonical wallets** — project-controlled, `open` consent
- **Per-user wallets** — generated at install, `handshake` consent

XMTP wallet is messaging-only — no funds. Separate from MOR staking wallet.

## CLI Reference

```bash
# Identity status
node skills/agent-chat/cli.mjs status

# Daemon health
node skills/agent-chat/cli.mjs health

# List peer groups
node skills/agent-chat/cli.mjs groups

# Trust a peer (allow messages)
node skills/agent-chat/cli.mjs trust-peer 0x... --as colleague --name "Agent Name"

# List trusted peers
node skills/agent-chat/cli.mjs peers list

# Send a message (via outbox)
node skills/agent-chat/cli.mjs send 0x... "Hello, agent!"
```

## Files

| File | Purpose |
|------|---------|
| `daemon.mjs` | Entry point for launchd/systemd |
| `cli.mjs` | CLI commands |
| `setup-identity.mjs` | One-time key generation |
| `src/agent.mjs` | Agent creation + middleware wiring |
| `src/identity.mjs` | Secret/identity loading |
| `src/consent.mjs` | 3-policy consent gate |
| `src/router.mjs` | Message routing (COMMAND/DATA dispatch) |
| `src/bridge.mjs` | Filesystem outbox watcher |
| `src/health.mjs` | Health file writer |
| `src/groups.mjs` | Group conversation mapping |
| `src/payer.mjs` | Fee stub (network currently free) |
| `src/index.mjs` | Public API re-exports |

## Daemon Management

The agent-chat daemon runs as a user-level service (no sudo required):

- **macOS**: launchd (`~/Library/LaunchAgents/com.everclaw.agent-chat.plist`)
- **Linux**: systemd user service (`~/.config/systemd/user/everclaw-agent-chat.service`)

### Setup

```bash
# Auto-detect OS and install daemon
bash scripts/setup-agent-chat.sh

# Or specify OS explicitly
bash scripts/setup-agent-chat.sh --macos
bash scripts/setup-agent-chat.sh --linux
```

### Commands

```bash
# Check daemon status
bash scripts/setup-agent-chat.sh --status

# View daemon logs
bash scripts/setup-agent-chat.sh --logs

# Restart daemon
bash scripts/setup-agent-chat.sh --restart

# Uninstall daemon
bash scripts/setup-agent-chat.sh --uninstall

# Preview without changes
bash scripts/setup-agent-chat.sh --dry-run

# Help
bash scripts/setup-agent-chat.sh --help
```

### Manual Control

**macOS (launchd):**
```bash
# Status
launchctl list | grep everclaw

# Stop
launchctl bootout gui/$(id -u)/com.everclaw.agent-chat

# Start
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.everclaw.agent-chat.plist

# Logs
tail -f ~/.everclaw/logs/agent-chat.log
```

**Linux (systemd):**
```bash
# Status
systemctl --user status everclaw-agent-chat

# Stop
systemctl --user stop everclaw-agent-chat

# Start
systemctl --user start everclaw-agent-chat

# Logs
journalctl --user -u everclaw-agent-chat -f
```

### Logs and Health

- **Logs**: `~/.everclaw/logs/agent-chat.log` (macOS) or `journalctl --user -u everclaw-agent-chat` (Linux)
- **Health file**: `~/.everclaw/xmtp/health.json`
- **Identity**: `~/.everclaw/xmtp/` (chmod 700)

### First-Time Setup

Before starting the daemon, generate your XMTP identity:

```bash
node skills/agent-chat/setup-identity.mjs
```

This creates the messaging-only wallet in `~/.everclaw/xmtp/` (separate from your MOR staking wallet).

## Security

- Keys stored in `~/.everclaw/xmtp/.secrets.json` (chmod 600)
- Directory secured: `~/.everclaw/xmtp/` (chmod 700)
- Path traversal protection on inbox writes
- CommsGuard V6 validates all structured messages
- Plain text messages bypass comms-guard (acceptable for agent-to-agent v1)

## Troubleshooting

### Daemon won't start

1. Check Node.js version: `node --version` (need >= 20.0.0)
2. Verify identity exists: `ls ~/.everclaw/xmtp/.secrets.json`
3. Check logs: `bash scripts/setup-agent-chat.sh --logs`
4. Reinstall: `bash scripts/setup-agent-chat.sh --uninstall && bash scripts/setup-agent-chat.sh`

### Messages not sending

1. Check peer is trusted: `node skills/agent-chat/cli.mjs peers list`
2. Check daemon health: `node skills/agent-chat/cli.mjs health`
3. Check outbox queue: `ls ~/.everclaw/xmtp/outbox/`
4. Check daemon is running: `bash scripts/setup-agent-chat.sh --status`

### XMTP installation limit

XMTP limits the number of installations per identity. If you see warnings about installation limits:

1. Check installations: `node skills/agent-chat/cli.mjs status`
2. Revoke old installations via XMTP console (if available)
3. Generate new identity: `node skills/agent-chat/setup-identity.mjs` (creates new address)