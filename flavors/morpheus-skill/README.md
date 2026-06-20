# Morpheus Skill (Canonical)

> The canonical Morpheus decentralized AI agent skill for OpenClaw

## Overview

This is the default/canonical flavor of the EverClaw ecosystem. It provides the full Morpheus infrastructure without domain-specific customization.

**Domain:** morpheusclaw.com  
**Default Model:** GLM-5 (via Morpheus decentralized inference)

## This Is The Source

The `morpheus-skill` repo is the monorepo that contains:
- `packages/core/` — All shared Morpheus infrastructure
- `flavors/` — Per-flavor configs and persona files
- `scripts/` — Ecosystem management scripts

All other flavor repos are composed from `packages/core/` + their specific `flavors/<name>/` directory.

## License

MIT

---

> **Note:** This repository is automatically composed from the [morpheus-skill monorepo](https://github.com/profbernardoj/morpheus-skill). Please submit PRs and issues against the monorepo, not this flavor repo.
