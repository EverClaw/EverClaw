# 🟢 Morpheus Skill — Freedom of Intelligence for Every Agent

**Freedom of intelligence for every agent. Powered by MorpheusAI.**

Install on any agent platform that supports [agentskills.io](https://agentskills.io):

- OpenClaw
- Hermes Agent
- IronClaw (Rust/Rig)
- NanoClaw (Docker)
- Any platform that reads Markdown skills

## What You Get

- **30+ open-source models:** GLM-5, Gemma 4, GLM-4.7-flash, Kimi K2.5, Qwen3
- **Inference you own:** Staked MOR tokens, not rented, not per-token
- **Zero centralized dependency:** Default to Morpheus P2P, fallback to Gateway, then local Ollama
- **Works with your existing agent:** No re-platforming required

## Model Tiers

| Tier | Model | Best For |
|------|-------|----------|
| HEAVY | GLM-5 | Complex reasoning, coding, analysis |
| STANDARD | Gemma 4 | General purpose, balanced |
| LIGHT | GLM-4.7-flash | Fast responses, simple tasks |

## Quick Start

### For OpenClaw

```bash
# Install the skill
git clone https://github.com/profbernardoj/morpheus-skill.git ~/.openclaw/workspace/skills/morpheus-skill

# Configure and start
cd ~/.openclaw/workspace/skills/morpheus-skill
node scripts/setup.mjs --key YOUR_MOR_KEY --apply --test --restart
```

### For Hermes Agent

```bash
# Install the skill
git clone https://github.com/profbernardoj/morpheus-skill.git ~/.hermes/skills/morpheus-skill

# Start the proxy
cd ~/.hermes/skills/morpheus-skill
bash scripts/setup-proxy.sh
```

### For IronClaw

```bash
cd morpheus-skill/IronClaw
bash setup.sh
# Configure IronClaw to use: http://127.0.0.1:8083/v1
```

See [IronClaw/README.md](IronClaw/README.md) for full integration guide.

### For NanoClaw

```bash
cd morpheus-skill/NanoClaw
bash setup.sh
# NanoClaw talks to host proxy via Docker networking
```

See [NanoClaw/README.md](NanoClaw/README.md) for Docker hybrid mode details.

## Staking MOR for Unlimited P2P Inference

The proxy works via the Morpheus API Gateway (community-powered) during setup. For permanent unlimited access, stake MOR tokens:

```bash
node scripts/everclaw-wallet.mjs setup
node scripts/everclaw-wallet.mjs swap eth 0.05
node scripts/everclaw-wallet.mjs approve
node scripts/everclaw-wallet.mjs stake
```

**MOR is staked, not spent** — returned when you close sessions. Stake once, use forever.

## Architecture

```
Your Agent (any platform) → Morpheus Proxy (port 8083) → [Morpheus P2P Gateway] → AI Model
                                                            ↓
                                                     MOR Staking (your tokens)
```

The proxy is a sidecar — your agent talks to it via OpenAI-compatible HTTP API. Platform-agnostic.

## Platform-Specific Docs

- [OpenClaw Integration](docs/openclaw-integration.md)
- [Hermes Agent Integration](docs/hermes-integration.md)
- [IronClaw Integration](IronClaw/README.md) — Rust/Rig sidecar
- [NanoClaw Integration](NanoClaw/README.md) — Docker hybrid mode
- [PicoClaw Integration](PicoClaw/README.md) — Lightweight proxy
- [TinyClaw Integration](TinyClaw/README.md) — Minimal footprint
- [ZeroClaw Integration](ZeroClaw/README.md) — Zero-config gateway
- [NullClaw Integration](NullClaw/README.md) — Null route testing

## Available Models

| Model | Best For | Tier | Opus-Level |
|-------|----------|------|------------|
| GLM-5 | Complex reasoning, coding, analysis | HEAVY | Opus 4.5-level |
| Gemma 4 | General purpose, balanced, hardware-adaptive | STANDARD | GPT-4-level |
| GLM-4.7-flash | Fast responses, simple tasks | LIGHT | GPT-3.5-level |
| Kimi K2.5 | Large context, multilingual | STANDARD | Claude-sonnet-level |
| Qwen3 235B | Research, complex analysis | STANDARD | GPT-4-level |

## Included Features

When you install Morpheus Skill, you get:

- **Three-Shift Task Planning** — Morning/Afternoon/Night shift system proposes prioritized task plans with approval workflow
- **Gateway Guardian v5** — Self-healing watchdog with direct curl inference probes, billing-aware escalation, DIEM credit monitoring
- **Smart Session Archiver** — Automatically archives old sessions when size exceeds threshold
- **Model Router** — Open-source first: routes all tiers to Morpheus by default
- **Multi-Key Auth Rotation** — Configure multiple API keys; auto-rotates when credits drain
- **Hardware-Aware Local Fallback** — Gemma 4 family (E2B/E4B/26B/31B) auto-selected based on available RAM/GPU

## What's New

### v2026.4.10 — Morpheus Skill Rebrand

- **Universal positioning:** Works across any agent platform that supports agentskills.io
- **Platform-agnostic:** OpenClaw, Hermes Agent, IronClaw, NanoClaw, future platforms
- **New SOUL.md:** Sovereignty-focused personality ("freedom of intelligence")
- **New IDENTITY.md:** Skill identity, not agent identity
- **Hermes Agent support:** Same SKILL.md works for both OpenClaw and Hermes
- **Updated README:** Universal positioning with platform-specific installation sections

See [CHANGELOG.md](CHANGELOG.md) for full history.

## Migrating from Morpheus Agent

If you previously installed `morpheus-agent`, update in 3 steps:

```bash
# 1. Update git remote
cd ~/.openclaw/workspace/skills/morpheus-agent  # or ~/.hermes/skills/morpheus-agent
git remote set-url origin https://github.com/profbernardoj/morpheus-skill
git pull

# 2. Rename the directory
cd ..
mv morpheus-agent morpheus-skill

# 3. Done — all scripts, config, and services are unchanged
```

## Community

- [Morpheus Discord](https://discord.gg/morpheus)
- [mor.org](https://mor.org)
- [GitBook](https://gitbook.mor.org)
- [MorpheusSkill.com](https://MorpheusSkill.com)

## Powered By

Morpheus Network + [EverClaw](https://everclaw.com) inference engine.

> Morpheus Skill is powered by the battle-tested EverClaw inference engine. Wallet and setup scripts retain their original `everclaw-` names for backward compatibility.

## License

MIT