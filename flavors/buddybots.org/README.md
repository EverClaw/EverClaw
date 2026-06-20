# Buddy Bots

> Multi-agent Buddy Bot provisioning, coordination, and management

## Overview

Buddy Bots is a flavor of the [EverClaw](https://everclaw.xyz) decentralized AI agent ecosystem, powered by Morpheus Network inference.

**Domain:** buddybots.org  
**Default Model:** GLM-5 (via Morpheus decentralized inference)

## What This Flavor Does

Buddy Bots extends the common Morpheus infrastructure with a complete multi-agent management system:

- **Provisioning** — Spawn and configure new buddy agents with unique identities
- **Registry** — Track and discover buddy agents across the network
- **Coordination** — Bot-to-bot messaging with 10 coordination message types
- **Host Management** — Auto-provision hosts for buddy agents
- **Export/Import** — Portable agent workspaces with XMTP identity and registry entries
- **Quotas** — Per-agent token tracking with daily/monthly limits and alerts

## Flavor-Specific Scripts

This flavor includes scripts beyond the common core:

| Script | Purpose |
|--------|---------|
| `scripts/buddy-provision.mjs` | Spawn and configure buddy agents |
| `scripts/buddy-registry.mjs` | Agent registry (discover, list, manage) |
| `scripts/buddy-coordinate.mjs` | Bot-to-bot coordination messaging |
| `scripts/buddy-host.mjs` | Host auto-provisioning for agents |
| `scripts/buddy-export.mjs` | Export/import agent workspaces |
| `scripts/buddy-quotas.mjs` | Per-agent token tracking and limits |
| `buddy-bots-install.sh` | Standalone Buddy Bots installer |

## Quick Start

```bash
# Install Buddy Bots
bash buddy-bots-install.sh

# Or use the common setup with Buddy Bots overlay
node scripts/setup.mjs --key YOUR_KEY --apply --test --restart
```

## Related

- [EverClaw Monorepo](https://github.com/profbernardoj/morpheus-skill) — Source of truth
- [Morpheus Network](https://mor.org) — Decentralized inference network

---

> **Note:** This repository is automatically composed from the [morpheus-skill monorepo](https://github.com/profbernardoj/morpheus-skill). Please submit PRs and issues against the monorepo, not this flavor repo.
