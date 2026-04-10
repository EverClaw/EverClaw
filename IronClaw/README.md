# Morpheus Skill for IronClaw

Decentralized Morpheus inference (stake MOR, never pay per token) for your [IronClaw](https://github.com/iron-claw) agent.

**Works out-of-the-box with IronClaw's Rig framework / OpenAI-compatible provider.**

## Architecture

```
IronClaw Agent (Rust/Rig) → Morpheus Proxy (Node.js, port 8083) → Morpheus P2P Network → AI Model
```

The Morpheus proxy runs as a standalone Node.js sidecar — completely independent of IronClaw's Rust binary. IronClaw talks to it via standard OpenAI-compatible HTTP API, which Rig's `openai` provider handles natively.

## Quick Start

### 1. Install the Morpheus proxy

```bash
bash setup.sh
```

This installs the proxy + guardian into `~/.morpheus` and starts it as a background service.

### 2. Configure IronClaw

Add to your IronClaw environment (e.g. `~/.ironclaw/.env` or your shell profile):

```env
OPENAI_API_BASE=http://127.0.0.1:8083/v1
OPENAI_API_KEY=morpheus-local
```

Or configure directly in your Rig agent code:

```rust
use rig::providers::openai;

let client = openai::Client::from_url("http://127.0.0.1:8083/v1", "morpheus-local");
let agent = client
    .agent("glm-5")  // or "glm-4.7-flash", "gemma-4", "kimi-k2.5"
    .preamble("You are a helpful assistant.")
    .build();
```

### 3. Verify

```bash
curl http://127.0.0.1:8083/health
```

### 4. Stake MOR for unlimited P2P inference (optional)

The proxy works immediately via the Morpheus API Gateway (community-powered). For permanent access, stake MOR tokens:

```bash
cd ~/.morpheus
node scripts/everclaw-wallet.mjs setup
node scripts/everclaw-wallet.mjs swap eth 0.05
node scripts/everclaw-wallet.mjs approve
node scripts/everclaw-wallet.mjs stake
```

MOR tokens are **staked, not spent** — returned when you close the session. Stake once, use forever.

## Available Models

| Model | Best For | Tier |
|-------|----------|------|
| `glm-5` | Complex reasoning, coding, analysis (Opus 4.5-level) | HEAVY |
| `gemma-4` | General purpose, balanced | STANDARD |
| `glm-4.7-flash` | Fast responses, simple tasks | LIGHT |
| `kimi-k2.5` | Large context, multilingual | STANDARD |
| `qwen3-235b` | Research, complex analysis | STANDARD |

## Optional: WASM Status Tool

If you want a native status tool inside IronClaw's WASI sandbox:

```bash
cd tools-src/morpheus-status
cargo component build --release
# Copy the .wasm to your IronClaw tools directory
```

See [tools-src/morpheus-status/README.md](tools-src/morpheus-status/README.md) for details.

## What's Included

| File | Purpose |
|------|---------|
| `setup.sh` | One-command installer for Morpheus proxy + guardian |
| `ironclaw-skill/` | Rig-compatible skill for runtime Morpheus control |
| `tools-src/morpheus-status/` | WASI component for proxy health checks (Rust) |
| `examples/` | Rig agent code examples with Morpheus provider |

## How It Works

1. `setup.sh` installs the battle-tested Morpheus Node.js proxy + guardian sidecar
2. The proxy exposes a standard OpenAI-compatible API on `http://127.0.0.1:8083/v1`
3. IronClaw's Rig framework connects via its built-in `openai` provider (zero Rust changes)
4. The proxy handles all Morpheus complexity: session management, MOR staking, auto-renewal, model routing, retries
5. Guardian monitors health and self-heals (billing-aware escalation, direct curl probes)

## Included Features

- **Gateway Guardian v5** — Self-healing watchdog with direct curl inference probes
- **Model Router** — Open-source first: routes all tiers to Morpheus by default
- **Multi-Key Auth Rotation** — Configure multiple API keys; auto-rotates when credits drain
- **Smart Session Archiver** — Automatically archives old sessions

See the main [Morpheus Skill README](../README.md) for full documentation.

## Contributing

PRs welcome for:
- IronClaw-specific Rig integration patterns
- WASI tool improvements
- Additional example agents
- CI/CD for the WASM build
- IronClaw config auto-detection

## License

MIT — same as Morpheus Skill and IronClaw.