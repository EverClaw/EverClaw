---
name: buddy-bots
version: 0.1.0
description: Agent-to-agent social coordination. Create a group, every member gets their own buddy bot. Bots talk over XMTP to coordinate real-world actions on behalf of their humans. Built on EverClaw + XMTP + ERC-8004.
homepage: https://buddybots.org
metadata:
  openclaw:
    emoji: "🤝"
    requires:
      bins: ["curl", "node"]
      env:
        - name: WALLET_PRIVATE_KEY
          optional: true
          description: "Morpheus wallet private key — injected at runtime from macOS Keychain. NEVER stored on disk."
        - name: ETH_NODE_ADDRESS
          optional: true
          default: "https://base-mainnet.public.blastapi.io"
          description: "Base mainnet RPC endpoint for blockchain operations."
    credentials:
      - name: "Wallet Private Key"
        storage: "macOS Keychain (never on disk)"
        required: false
        description: "Required only for local P2P inference (MOR staking). Not needed for API Gateway mode."
      - name: "Morpheus API Gateway Key"
        storage: "openclaw.json providers config"
        required: false
        description: "Free API key from app.mor.org. Community bootstrap key included for initial setup."
    network:
      outbound:
        - host: "api.mor.org"
          purpose: "Morpheus API Gateway — model inference and session management"
        - host: "base-mainnet.public.blastapi.io"
          purpose: "Base L1 RPC — ERC-8004 agent registry"
        - host: "provider.mor.org"
          purpose: "Morpheus P2P network — direct inference via staked sessions"
        - host: "api.venice.ai"
          purpose: "Venice API — primary inference provider (when configured)"
      local:
        - port: 8082
          purpose: "Morpheus proxy-router — blockchain session management"
        - port: 8083
          purpose: "Morpheus-to-OpenAI proxy — translates OpenAI API to proxy-router"
    persistence:
      services:
        - name: "com.morpheus.router"
          purpose: "Proxy-router for Morpheus P2P inference"
          mechanism: "launchd KeepAlive (macOS)"
        - name: "com.morpheus.proxy"
          purpose: "OpenAI-compatible proxy translating to Morpheus"
          mechanism: "launchd KeepAlive (macOS)"
        - name: "ai.openclaw.guardian"
          purpose: "Gateway health watchdog with billing-aware escalation"
          mechanism: "launchd StartInterval (macOS)"
      directories:
        - "~/morpheus/ — proxy-router binary, config, session data"
        - "~/.openclaw/workspace/skills/everclaw/ — inference skill files"
        - "~/.openclaw/workspace/skills/buddy-bots/ — buddy bot provisioning and coordination"
        - "~/.openclaw/logs/ — guardian logs"
    install:
      method: "git clone (recommended)"
      note: "Buddy Bots uses the EverClaw installer with a Buddy Bots template. curl | bash installer available at get.buddybots.org."
    tags: ["buddy-bots", "social", "coordination", "xmtp", "agent-to-agent", "groups", "everclaw", "morpheus", "erc-8004", "privacy"]
---

<!-- ─── AGENT INSTRUCTIONS (read by OpenClaw agents) ─────────────── -->

## 🤖 Agent Setup Instructions

**If your human asks you to set up Buddy Bots, follow these steps exactly.**

### Quick Setup

```bash
node ~/.openclaw/workspace/skills/everclaw/scripts/setup.mjs --template buddy-bots --key <API_KEY> --apply --test --restart
```

### What Buddy Bots Adds

After EverClaw inference is running, Buddy Bots adds:

1. **Buddy Host Agent** — manages group onboarding, auto-provisions buddy bots for group members
2. **XMTP Identity per Bot** — each buddy bot gets its own E2E-encrypted XMTP identity
3. **Bot-to-Bot Coordination** — bots communicate over XMTP to coordinate actions on behalf of their humans
4. **Daily Proactive Pings** — bots check in daily with actionable suggestions
5. **Inference Quotas** — fair sharing of local inference across all buddy bots

### Architecture

```
Group Chat (Signal/WhatsApp/etc)
    ↕
Buddy Host Agent (group management)
    ↕
┌─────────────────┐  ┌─────────────────┐
│ Alice's Buddy Bot│  │ Bob's Buddy Bot │
│  (workspace-alice)│  │  (workspace-bob) │
│   chmod 700      │  │   chmod 700      │
└────────┬─────────┘  └────────┬─────────┘
         │ XMTP (E2E)          │ XMTP (E2E)
         └──────────┬──────────┘
                    │
         CommsGuard V6 (8-step security)
```

### Key Principles

- **No PII on chain.** ERC-8004 entries are just XMTP address + "Buddy Bot" + protocol version.
- **Workspace isolation.** Host agent cannot access buddy bot workspaces (chmod 700).
- **Short messages + CTA.** 1-2 sentences max. Always end with a call to action.
- **Daily proactive pings.** Bots create value, not just respond.
- **Local inference first.** Ollama + Gemma 4 for all bots on the same machine.

## 📋 Setup Stages

### Stage 1: EverClaw Inference

```bash
node ~/.openclaw/workspace/skills/everclaw/scripts/setup.mjs --template buddy-bots --apply --test --restart
```

### Stage 2: Buddy Bot Provisioning

```bash
node ~/.openclaw/workspace/skills/buddy-bots/scripts/buddy-provision.mjs --name "Alice" --phone "+15125551234" --trust-profile personal
```

### Stage 3: XMTP Agent Identity

```bash
node ~/.openclaw/workspace/skills/buddy-bots/scripts/setup-identity.mjs --agent-id alice
```

### Stage 4: Verify

```bash
node ~/.openclaw/workspace/skills/buddy-bots/scripts/buddy-provision.mjs --status
```

## 🔒 Security

- Buddy bot workspaces are chmod 700 — host agent cannot read them
- All bot-to-bot communication is E2E encrypted via XMTP
- CommsGuard V6: schema → nonce → peerAuth → rateLimit → PII → injection → trust → audit
- ERC-8004 entries contain zero PII — just address + "Buddy Bot" + version
- Local buddy registry never published or shared

## 💬 Buddy Bot Personality

Buddy Bots are friendly, concise, and action-oriented. Key traits:

- **1-2 sentences max.** No walls of text.
- **Always end with a CTA.** "Want me to grab tickets?" not "cool?"
- **Proactive, not reactive.** Surface coordination opportunities daily.
- **Match the channel vibe.** Casual in Signal, professional in Slack.
- **Never share PII.** Not even between bots without explicit consent.