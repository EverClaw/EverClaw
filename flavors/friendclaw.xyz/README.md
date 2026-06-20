# Friend Claw

> AI companion and social assistant

## Overview

Friend Claw is a flavor of the [EverClaw](https://everclaw.xyz) decentralized AI agent ecosystem, powered by Morpheus Network inference.

**Domain:** friendclaw.xyz  
**Default Model:** GLM-5 (via Morpheus decentralized inference)

## What This Flavor Does

This flavor provides the common Morpheus infrastructure (wallet, proxy, session management, security) with a persona and configuration tailored for: AI companion and social assistant.

## Installation

```bash
curl -sSL https://friendclaw.xyz/install.sh | bash
```

Or clone and set up manually:

```bash
git clone https://github.com/profbernardoj/friendclaw.xyz.git
cd friendclaw.xyz
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
