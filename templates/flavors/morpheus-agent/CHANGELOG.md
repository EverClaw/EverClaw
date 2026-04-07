# Changelog

All notable changes to Morpheus Agent will be documented in this file.

## v2026.4.6 — Initial Release

### Added
- **SOUL.md** — Sovereignty-focused agent persona with 10 Morpheus principles
- **IDENTITY.md** — Morpheus Agent identity (decentralized, self-sovereign)
- **USER.md** — Template with MOR holder profile fields (staking, compute provider, builder status)
- **README.md** — Morpheus-branded documentation with architecture diagram, model tiers, skills catalog, hardware requirements
- **openclaw-config-morpheus.json** — Config template with pure Morpheus P2P + local Ollama defaults (no centralized APIs)
- **Model tiers** — HEAVY: GLM-5 (Morpheus P2P), STANDARD: Gemma 4 (hardware-adaptive local), LIGHT: GLM-4.7 Flash (Morpheus P2P)
- **Hardware-adaptive Gemma 4** — Auto-selects E2B/E4B/26B/31B based on user's RAM/GPU
- **Skills catalog** — `/stake-status`, `/network-health`, `/inference-marketplace`, `/download-agent`, `/security-tier`
- **Chain support** — Base (Ethereum L2) for all on-chain operations

### Architecture
- Built on the [EverClaw](https://everclaw.xyz) engine
- Running on [OpenClaw](https://openclaw.ai)
- Inherits: wallet, security tiers, agent-download, guardian, memory, Docker support
- Fallback chain: mor-gateway → morpheus P2P → Ollama local (no centralized defaults)
