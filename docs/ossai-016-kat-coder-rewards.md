# OSSAI-016 — KAT-Coder RL Reward Patterns for OpenClaw Agent Behavior

**Date:** 2026-08-12
**Task:** OSSAI-016 (P2) — Implement KAT-Coder RL reward patterns for OpenClaw agent behavior
**Source:** backlog lane (SOP-025) → READY.md gate (no production push)
**Status:** IMPLEMENTED + AUDITED (Stage 2 Grok Excellent, Stage 3 no-new-failures, Stage 4 audit pending closure)

## Objective
Turn the Kwaipilot KAT-Coder-V2.5-Dev RL post-mortem (OSSAI-272 / OSSAI-008; 69.4% SWE-bench
Verified) into a **deterministic, testable reward-signal reference library** for OpenClaw agent
behavior analysis. The study found a binary 0-1 reward caused agentic collapse by epoch 2
(70+ parallel tool calls per turn, context explosion, invalid trajectories); hierarchical
rewards + model-specific penalties restored stability (10 epochs; abnormal tool labels
9.34% → 0.28%, single-turn repetition 0.34% → 0%). This item makes those patterns usable.

## Delivered (local only, commit `fd4af60cd`)
- `scripts/lib/rewards.mjs` — pure, zero-dependency reward signal functions
- `tests/rewards.mjs` — 27 unit tests (all pass)
- `docs/ossai-016-plan.md` — Stage 1 plan + design

## API
- `parallelToolCallPenalty({toolCalls, threshold=8, penaltyScale}) -> [0,1]`
  Saturating curve `1 - 1/(1+0.25·excess)` — leading indicator (highest default weight 0.70).
- `failedToolCallPenalty({toolCalls, failureScale}) -> [0,1]`
  Failure fraction; recognizes `failed`, `status: error|failed|failure` (case-insensitive),
  non-empty string `error`, non-null object `error`, `ok===false`.
- `emptyToolBlockPenalty({toolBlocks, penaltyScale}) -> [0,1]`
  Blocks with empty/malformed/all-empty toolCalls. id/name trimmed; args-empty-but-named = NOT empty.
- `repetitionPenalty({text, minRun=6, penaltyScale}) -> [0,1]`
  Longest consecutive-token run; caps input at 100K chars; saturates near 1 for ~5×minRun.
- `hierarchicalCredit({failed, partialProgress, progressWeight, failurePenalty=0.5}) -> [0,1]`
  Partial credit for meaningful progress on failed trajectories, bounded by (1-failurePenalty).
- `scoreTrajectory(turn, weights?) -> {reward, components, breakdown}`
  `clamp(base - Σ(weight·penalty) + creditApplied, -1, 1)`. Sanitizes NaN and negatives
  (clamp coerces to finite; numOpt floors options). Penalty weights are independent (sum ≠ 1).
- `COMPONENTS`, `DEFAULT_WEIGHTS` exported.

## Design notes
- Zero runtime deps (Node built-ins only); additive/opt-in; no entrypoint/config/Docker touched.
- NaN/negative input hardening via `numOpt` + `clamp` finite-coercion (Grok C8/C9).
- Failed-call detection tightened to non-empty error strings / non-null objects / ok:false (Grok C1).
- Input cap 100K chars on repetition (Grok S2).

## Verification
- Stage 2 Grok 4.5: **Excellent** (0 blocking after C1/C3/C8/C9 fixes) — tests **Good** (all covering gaps added).
- Stage 4 Cross-Model (independent set of eyes): found **1 blocking Correctness defect** — `scoreTrajectory` did not sanitize `weights` (NaN weights pinned reward to the floor; **negative penalty weights flipped penalties into rewards**, e.g. a fully-failed turn could get max reward). FIXED: every weight is now sanitized via `numOpt(...,0)` so penalty/credit weights floor at 0 and can never invert sign; `base` allows negatives. Locked by 2 new regression tests. Prototype pollution confirmed SAFE (object spread uses CreateDataProperty). Minor bound fix: `hierarchicalCredit` now clamps to `(1-fp)` so the "can't fully recover the failure penalty" guarantee holds even at weight > 1.
- Stage 3 / Stage 5: full suite 337 tests / 318 pass / 19 fail — **all 19 fail pre-existing in `security-tier.test.mjs`** (baseline debt, not introduced). 29 rewards tests, all pass.
- Stage 6 PII: 0 findings.

## Final audit state
**All audit gates PERFECT (zero blocking).** Commit `52fd4036f` (local only, backlog lane → READY.md gate).

## Not in scope (tracked separately)
- Actual RL training loop, sandboxing, TIS/TITO infra — [REDACTED] model-development concerns.
- A hosted KAT-Coder endpoint (OSSAI-008 follow-up).

## Follow-ups (non-blocking)
- [ ] Wire `scoreTrajectory` into a live agent-transcript analyzer if [REDACTED] pursues agentic RL.
