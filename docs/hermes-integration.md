# Morpheus Skill — Hermes Agent Integration

**Install on Hermes Agent for decentralized inference via Morpheus.**

Hermes Agent uses the [agentskills.io](https://agentskills.io) format — the same standard OpenClaw uses. This means Morpheus Skill works natively with Hermes.

## Architecture

```
Hermes Agent (Python/Node) → Morpheus Proxy (port 8083) → Morpheus P2P Network → AI Model
                                                              ↓
                                                       MOR Staking (your tokens)
```

The proxy runs as a sidecar. Hermes talks to it via OpenAI-compatible HTTP API.

## Quick Start

### 1. Install the skill

```bash
git clone https://github.com/profbernardoj/morpheus-skill.git ~/.hermes/skills/morpheus-skill
```

### 2. Start the proxy

```bash
cd ~/.hermes/skills/morpheus-skill
bash scripts/setup-proxy.sh
```

This installs:
- Node.js proxy on port 8083
- Gateway Guardian watchdog
- MOR wallet setup scripts

### 3. Configure Hermes

Add to your `~/.hermes/config.yaml`:

```yaml
model:
  default: glm-5
  fallback_chain:
    - glm-5
    - gemma-4
    - glm-4.7-flash

providers:
  morpheus:
    base_url: http://127.0.0.1:8083/v1
    api_key: morpheus-local
```

Or set environment variables:

```bash
export OPENAI_API_BASE=http://127.0.0.1:8083/v1
export OPENAI_API_KEY=morpheus-local
```

### 4. Verify

```bash
curl http://127.0.0.1:8083/health
# {"status":"ok"}
```

### 5. Use in Hermes

```bash
hermes chat -m glm-5 "Hello, how are you?"
```

Hermes automatically routes to the proxy, which routes to Morpheus.

## Staking MOR (Unlimited P2P Inference)

The proxy works via the Morpheus API Gateway during setup. For permanent access, stake MOR:

> Scripts retain their original `everclaw-` names for backward compatibility with the underlying engine.

```bash
cd ~/.hermes/skills/morpheus-skill
node scripts/everclaw-wallet.mjs setup
node scripts/everclaw-wallet.mjs swap eth 0.05
node scripts/everclaw-wallet.mjs approve
node scripts/everclaw-wallet.mjs stake
```

**MOR is staked, not spent** — returned when you close sessions.

## Skills Available

Once installed, Hermes can invoke:

- `/morpheus-status` — Check proxy health and session status
- `/morpheus-stake` — Stake MOR tokens from within Hermes
- `/morpheus-models` — List available models

## Platforms

| Platform | Host Address |
|----------|-------------|
| macOS | `host.docker.internal` |
| Linux | `172.17.0.1` (docker0 bridge) |
| Windows (WSL) | `host.docker.internal` |

## Systemd Service (Linux)

```bash
# Install as systemd service
sudo bash scripts/install-systemd.sh

# Enable and start
sudo systemctl enable morpheus-proxy
sudo systemctl start morpheus-proxy
```

## Troubleshooting

### Proxy not starting

```bash
# Check logs
tail -f ~/.morpheus/logs/proxy.log

# Restart
bash scripts/setup-proxy.sh --restart
```

### Health check failing

```bash
# Direct curl test
curl -v http://127.0.0.1:8083/health

# Check Guardian
tail -f ~/.morpheus/logs/guardian.log
```

### MOR staking issues

```bash
# Check wallet
node scripts/everclaw-wallet.mjs status

# Re-stake
node scripts/everclaw-wallet.mjs stake
```

## License

MIT — same as Morpheus Skill.