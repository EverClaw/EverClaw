# OSSAI-016 — KAT-Coder RL Reward Patterns for OpenClaw Agent Behavior

**Date:** 2026-08-12
**Task:** Implement KAT-Coder RL reward patterns for OpenClaw agent behavior (P2 backlog, OSSAI-016)
**Owner:** agent (Looping Agent, SOP-025) · Model: DeepSeek V4 Flash (P2P, per SOP-008)

## 1. Problem statement
The OSSAI-272 / OSSAI-008 track captured Kwaipilot's **KAT-Coder-V2.5-Dev** RL post-mortem
(69.4% SWE-bench Verified): binary reward caused **agentic collapse** (70+ parallel tool calls
per turn, context explosion, invalid trajectories) by epoch 2; hierarchical rewards +
model-specific penalties restored stability (10 epochs, abnormal tool labels 9.34% → 0.28%,
single-turn repetition 0.34% → 0%).
This item makes those patterns **actionable for OpenClaw agent behavior** — a deterministic,
reference implementation of the reward/penalty signals plus a design doc, so the patterns are
not just a scanned finding but a usable, testable library.

## 2. Scope
- **In-scope:** a new `scripts/lib/rewards.mjs` implementing, as deterministic scoring
  functions over an agent trajectory:
  1. `parallelToolCallPenalty` — dampen excessive concurrent tool calls in a turn (the
     primary collapse driver).
  2. `failedToolCallPenalty` — penalize failed tool executions.
  3. `emptyToolBlockPenalty` — penalize empty `[TOOL]`/`tool_calls` blocks (the vendor's
     "empty tool-call blocks" signal → in OpenClaw terms, a tool_calls entry with no args,
     or an assistant turn that emits only an empty tool wrapper).
  4. `repetitionPenalty` — penalize large amounts of repeated content in a single turn.
  5. `hierarchicalCredit` — hierarchical reward: give partial credit for meaningful progress
     on unsuccessful trajectories (fewer failures + progress markers → higher residual credit).
  Plus a `scoreTrajectory(turn)` composer that folds all signals into a single scalar reward
  with tunable weights, bounded, with the KAT-Coder caveat surfaced (binary reward collapses).
- **Not in-scope:** actual RL training loop, sandboxing, TIS/TITO infra, live model training.
  Those are [REDACTED] model-development concerns tracked separately.

## 3. Modality check
```
Modalities affected: NONE (runtime). New library is a reference/behavior-scoring module,
                     additive + opt-in. No entrypoint, config template, Docker, or installer
                     path touched. Mirrors OSSAI-010 (asset-classifier / memory-hub) pattern.
Modality-specific changes needed:
  - Docker: none
  - Native: none
  - Installer: none
Cross-modality: none — pure library + tests + docs (cosmetic/docs-only surfaces, SOP-005-class
                library addition but full SOP-001 audit because it adds real behavior scoring).
```

## 4. Regression test plan
```
Regression risks:
  - None (additive new module, no existing code path touched, zero new runtime deps).
Regression tests to run in Stage 3:
  - [x] `bash -n` / `node --check` syntax on new file + test
  - [x] full `node --test tests/*.mjs` suite — no new failures vs baseline
```

## 5. Design (API)
All functions are **pure, deterministic, dependency-free** (Node built-ins only), operating on
a normalized "turn" shape so they're usable against real OpenClaw tool-call transcripts or a
test fixture:

- `parallelToolCallPenalty({ toolCalls, threshold, penaltyScale }) -> number in [0,1]`
  Excess = `max(0, toolCalls.length - threshold)`, scaled non-linearly to avoid the binary
  cliff the vendor observed (cap at 1.0). Excess of `threshold` → start; each additional call
  adds a geometrically dampened increment toward the cap.
- `failedToolCallPenalty({ toolCalls, failureScale }) -> number in [0,1]`
  Proportion of failed calls (by explicit `failed` flag or a `status`/`error` marker)
  times `failureScale`, clamped.
- `emptyToolBlockPenalty({ toolBlocks }) -> number in [0,1]`
  Blocks that are empty (no args, no id, no name, or a tool_calls array with all-empty calls).
- `repetitionPenalty({ text, minRun }) -> number in [0,1]`
  Longest repeated n-gram/run length over whitespace-normalized tokens; penalizes a single
  continuous repetition run (the vendor's "single-turn continuous repetition 0.34% → 0%").
- `hierarchicalCredit({ failed, partialProgress, progressWeight, failurePenalty }) -> number`
  Partial credit for unsuccessful trajectories that still made measurable progress.
- `scoreTrajectory(turn, weights?) -> { reward, components, breakdown }`
  Composer: `base - Σ(penalty*weight) + hierarchicalCredit*creditWeight`, clamped to
  `[-1, 1]` for stable RL, with per-signal weights reflecting KAT-Coder's observed dominance
  of the parallel-tool-call signal.
- `COMPONENTS`, `DEFAULT_WEIGHTS` exported constants for composability/pinning.

Defaults tuned to the KAT-Coder finding (parallel tool-call collapse is the leading indicator),
so the default weight on `parallelToolCallPenalty` is highest.

## 6. Files
- `dev/everclaw/scripts/lib/rewards.mjs` (new)
- `dev/everclaw/tests/rewards.mjs` (new)
- `dev/everclaw/docs/ossai-016-kat-coder-rewards.md` (new) — the design/reference doc
- `dev/everclaw/CHANGELOG.md` (entry)
- README unaffected (no install/commands changed)

Commits stay **local only** (backlog lane → READY.md gate). No push to any remote.
