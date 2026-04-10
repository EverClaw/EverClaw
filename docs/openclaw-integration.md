# Morpheus Skill — OpenClaw Integration

**Install on OpenClaw for decentralized inference via Morpheus.**

OpenClaw uses [agentskills.io](https://agentskills.io) format for skills. Morpheus Skill installs as a standard OpenClaw skill and provides the full Morpheus inference stack.

## Architecture

```
OpenClaw Agent → Morpheus Skill → Morpheus Proxy (port 8083) → Morpheus P2P Network → AI Model
                                                                     ↓
                                                              MOR Staking (your tokens)
```

## Quick Start

### 1. Install the skill

```bash
git clone https://github.com/profbernardoj/morpheus-skill.git ~/.openclaw/workspace/skills/morpheus-skill
```

### 2. Run setup

```bash
cd ~/.openclaw/workspace/skills/morpheus-skill
node scripts/setup.mjs --key YOUR_MOR_KEY --apply --test --restart
```

This:
- Installs dependencies
- Configures the model router
- Starts the proxy + guardian services
- Applies config to OpenClaw

### 3. Verify

```bash
curl http://127.0.0.1:8083/health
# {"status":"ok"}
```

### 4. Use

OpenClaw automatically uses the configured model router. Your agent now runs on Morpheus inference.

## Configuration

### Model Tiers

Edit `templates/openclaw-config-mac.json` (or `openclaw-config-linux.json`):

```json
{
  "models.router.tiers": {
    "LIGHT": "mor-gateway/glm-4.7-flash",
    "STANDARD": "mor-gateway/gemma-4-26b",
    "HEAVY": "mor-gateway/glm-5"
  },
  "agents.defaults.model": "mor-gateway/glm-5",
  "agents.defaults.fallbacks": [
    "morpheus/glm-5",
    "mor-gateway/kimi-k2-5",
    "ollama/gemma-4-26b"
  ]
}
```

### Gateway vs P2P

- **Gateway mode:** Uses Morpheus API Gateway (no local wallet required)
- **P2P mode:** Uses staked MOR for unlimited inference (requires wallet setup)

## Staking MOR

> Scripts retain their original `everclaw-` names for backward compatibility with the underlying engine.

```bash
node scripts/everclaw-wallet.mjs setup
node scripts/everclaw-wallet.mjs swap eth 0.05
node scripts/everclaw-wallet.mjs approve
node scripts/everclaw-wallet.mjs stake
```

**MOR is staked, not spent** — returned when you close sessions.

## Services Installed

| Service | Port | Purpose |
|---------|------|---------|
| Proxy | 8083 | OpenAI-compatible API |
| Guardian | LaunchDaemon | Health monitoring + self-healing |

## LaunchDaemon (macOS)

Services auto-start via LaunchDaemon:

```bash
# Check status
launchctl list | grep morpheus

# Restart proxy
launchctl kickstart gui/$(id -u)/com.morpheus.proxy

# Restart guardian
launchctl kickstart gui/$(id -u)/ai.openclaw.guardian
```

## Systemd (Linux)

```bash
# Check status
systemctl status morpheus-proxy

# Restart
sudo systemctl restart morpheus-proxy
```

## Troubleshooting

### Proxy not starting

```bash
tail -f ~/.morpheus/logs/proxy.log
```

### Guardian alerts

```bash
tail -f ~/.morpheus/logs/guardian.log
```

### Config not applied

```bash
node scripts/setup.mjs --apply --test --restart
```

## License

MIT — same as Morpheus Skill.