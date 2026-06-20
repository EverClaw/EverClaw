# Bitcoin Claw

> AI agent for Bitcoin ecosystem

## Overview

Bitcoin Claw is a flavor of the [EverClaw](https://everclaw.xyz) decentralized AI agent ecosystem, powered by Morpheus Network inference.

**Domain:** bitcoinclaw.ai  
**Default Model:** GLM-5 (via Morpheus decentralized inference)

## What This Flavor Does

This flavor provides the common Morpheus infrastructure (wallet, proxy, session management, security) with a persona and configuration tailored for: AI agent for Bitcoin ecosystem.

## Installation

```bash
curl -sSL https://bitcoinclaw.ai/install.sh | bash
```

Or clone and set up manually:

```bash
git clone https://github.com/profbernardoj/bitcoinclaw.ai.git
cd bitcoinclaw.ai
npm install
node scripts/setup.mjs
```

## Part of EverClaw

This repo is one of 28+ flavor repos in the EverClaw ecosystem. Each flavor shares the same core Morpheus infrastructure but with a unique identity and focus.

- **Core Infrastructure:** Morpheus proxy, session management, wallet, security tiers
- **Unique to this flavor:** Persona, default workflows, and domain-specific configuration

## License

MIT

---

> **Note:** This repository is automatically composed from the [morpheus-skill monorepo](https://github.com/profbernardoj/morpheus-skill). Please submit PRs and issues against the monorepo, not this flavor repo.
