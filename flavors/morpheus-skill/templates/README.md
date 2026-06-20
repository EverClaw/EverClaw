# 🟢 Morpheus Agent

**Your AI agent for securing freedom of intelligence powered by MorpheusAI**

The self-hosted AI agent for the [Morpheus](https://mor.org)
decentralized inference network.

Own your agent. Own your inference. Own your intelligence.

## Why Morpheus Agent?

- **You own it** — runs on your hardware, your data stays local
- **Decentralized inference** — powered by the Morpheus P2P network,
  not rented from a corporation
- **MOR-powered** — stake MOR tokens on Base (L2) for permanent
  inference access (not consumed, recycled)
- **Open source** — inspect, modify, fork. No black boxes.
- **30+ models** — GLM-5, Gemma 4, GLM-4.7 Flash, and more through
  the Morpheus Inference Marketplace

## Architecture

```
Your Machine → OpenClaw Agent → mor-gateway → P2P Network → Compute Providers
                               ↓
                          Ollama (Gemma 4) — local fallback
```

Built on the [EverClaw](https://everclaw.xyz) engine.

## Quick Start

### Option 1: Talk to Morpheus (Recommended)

Visit [MorpheusAgent.ai](https://morpheusagent.ai) or
[Agent.Mor.org](https://agent.mor.org) to start a guided setup.
Morpheus will walk you through everything. When you're ready,
use the Agent-Download skill to move your agent to your own machine.

### Option 2: Direct Install

```bash
curl -fsSL https://get.morpheusagent.ai | bash
```

### Option 3: ClawHub

```bash
clawhub install morpheus-agent
```

## What's Included

- 🧠 AI agent with conversational memory and file management
- 🔐 Self-sovereign wallet (MOR staking on Base L2, on-chain identity)
- 🌐 Morpheus P2P inference (no centralized API keys needed)
- 🏠 Local Ollama fallback (Gemma 4 — hardware-adaptive, works offline)
- 🛡️ Security tiers (Low/Recommended/Maximum exec permissions)
- 📦 Agent-Download (encrypted backup + restore to local machine)
- 🔄 Guardian auto-updates with signed releases
- 🐳 Docker support for headless/server deployments

## Models

| Tier | Model | Source | Use Case |
|------|-------|--------|----------|
| HEAVY | GLM-5 | Morpheus P2P | Complex reasoning, research |
| STANDARD | Gemma 4 (hardware-adaptive) | Local (Ollama) | Fast, private, offline |
| LIGHT | GLM-4.7 Flash | Morpheus P2P | Quick tasks, chat |

### Hardware-Adaptive Gemma 4 Selection

The local Ollama fallback automatically selects the best Gemma 4 model
for your hardware:

| RAM/GPU | Model | Size | Quality |
|---------|-------|------|---------|
| < 4 GB | gemma4-e2b-q3 | ~1.2 GB | Good — light tasks |
| 4–8 GB | gemma4-e2b-q4 | ~1.6 GB | Good — better quality |
| 8–12 GB | gemma4:e4b | ~9.6 GB | Strong — coding, most tasks (default) |
| 12–16 GB | gemma4-26b-q3 | ~12.5 GB | Excellent — 82.6% MMLU Pro |
| 16–24 GB | gemma4:26b | ~17 GB | Excellent — near-frontier |
| 24+ GB | gemma4:31b | ~20 GB | Frontier — matches cloud |

All models are open-source. No centralized APIs in default config.

## For MOR Holders

Your MOR stake isn't consumed — it's staked and returned. While
staked, you get ongoing access to the Morpheus Inference Marketplace.
Morpheus Agent connects directly to the P2P network so your agent
runs on the compute your stake provides.

[Learn about MOR staking →](https://mor.org)

## Skills

### Morpheus-Specific Skills

| Skill | Description | CLI |
|-------|-------------|-----|
| `/stake-status` | Query Base L2 for MOR stake, check active/inactive status, view pro-rata compute allocation | `morpheus-stake-status` |
| `/network-health` | Check Morpheus P2P network status, connected providers, latency scores | `morpheus-network-health` |
| `/inference-marketplace` | Browse available models, provider pricing, quality ratings | `morpheus-inference-market` |
| `/download-agent` | Export agent to local machine (age encryption, zstd compression) | `agent-download` |
| `/security-tier` | View or change exec permission level (Low/Recommended/Maximum) | `security-tier --status` |

### Inherited from EverClaw

All EverClaw skills available: wallet operations, memory management,
file operations, messaging integrations, Guardian auto-updates, etc.

## For Builders

Morpheus Agent is built on the EverClaw engine. Builder rewards
are available through the Morpheus Techno Capital Machine for
contributors who improve the agent, add skills, or extend the
network.

[Morpheus Builder Guide →](https://gitbook.mor.org)

## Chain

Morpheus uses **Base** (Ethereum L2) for all on-chain operations:
- MOR staking contract
- Stake status verification
- Compute provider registry

## Hardware Requirements

| Config | RAM | GPU | Local Model | Notes |
|--------|-----|-----|--------------|-------|
| Minimum | 4 GB | None | gemma4-e2b-q3 | P2P + light local fallback |
| Standard | 12 GB | 8 GB VRAM | gemma4:e4b | P2P + strong local |
| Recommended |24 GB | 16 GB VRAM | gemma4:26b or 31b | Full experience |

## OS Support

- macOS (arm64/x64)
- Linux (apt/dnf)
- Docker

## Community

- [Morpheus Discord](https://discord.gg/morpheusai)
- [Morpheus GitHub](https://github.com/MorpheusAIs)
- [Morpheus Gitbook](https://gitbook.mor.org)
- [mor.org](https://mor.org)

## Powered By

Built on the [EverClaw](https://everclaw.xyz) engine.
Running on [OpenClaw](https://openclaw.ai).

## License

MIT — same as EverClaw.