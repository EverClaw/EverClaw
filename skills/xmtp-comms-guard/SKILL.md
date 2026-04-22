---
name: xmtp-comms-guard
description: "Security middleware for all XMTP communications in EverClaw. Enforces guarded client usage with validation, integrity checks, and fail-closed security policies. Integrates approval flows for sensitive operations. Use when integrating XMTP messaging, configuring communication security, or auditing guarded client enforcement."
---

# xmtp-comms-guard — Skill Integration Guide (V6)

**Type:** Critical Security
**Version:** 6.0.0
**Required peer dependencies:** bagman, pii-guard, prompt-guard

## Mandatory Usage

All XMTP communication MUST go through the guarded client:

```ts
import { createGuardedXmtpClient } from "xmtp-comms-guard";
const { client, middleware } = await createGuardedXmtpClient(rawClient, userWallet);
```

Raw `@xmtp/client` imports are blocked by ESLint rules and SkillGuard scan.

## Three-Shift Integration

Three-Shift = EverClaw's standard approval flow with three options:
- **Approve** — allow the action
- **Redact** — downgrade/sanitize
- **Block** — deny the action

Used for: peer revocation review, key rotation re-approval, introduction chain re-evaluation.

## Enforcement Model

Enforcement is convention-based + build-time gates:
- **ESLint rule** blocks `@xmtp/client` direct imports
- **SkillGuard scan** detects raw client usage patterns
- No runtime interception of raw imports (honestly documented)

See `enforcement.md` for full details.

## Fail-Closed Conditions

The skill refuses to operate when:
- Hash chain integrity check fails on startup
- SQLCipher encryption check fails
- Nonce cache detects replay
- Unknown topic in message
- Unknown sensitivity level
- Message exceeds 64KB
- Protocol version is not "6.0"
- Peer not in registry or blocked

## Threat Model

Covered in `threat-model.md`:
- Malicious external agent → blocked by schema + checks
- Compromised internal agent → blocked by middleware + SkillGuard gates
- Host compromise → limited by Bagman + HMAC chain + fail-closed
- Replay attacks → nonce cache (90s TTL) + hash chain
- Data exfiltration → PII Guard + trust context rules
