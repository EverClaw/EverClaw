# SOP-003 — Code Development & Deployment Pipeline (Generalized)

Last updated: May 28, 2026

**Public version** — All organization-specific and personal workspace details have been removed. This document describes a rigorous engineering process suitable for external teams.

**Adaptation Note for Third Parties**

This document is a generalized derivative of an internal SOP. While organization-specific details have been removed, some illustrative examples reference common tools (package manifests, container images, git-based release workflows). External teams should treat the review loops, stage gates, and distribution steps as **patterns** and replace them with their own quality gates, tools, and release processes.

**How to Use This Document**

This SOP presents one rigorous approach to software development. Third-party teams should adopt the principles (research before building, risk analysis, independent validation, PII scanning, etc.) while replacing the specific mechanisms (rating scale, exact stage gates, CalVer format, tooling commands) with equivalents that fit their environment and culture.

---

## Change-Class Router (READ FIRST)

Before starting any work, classify the change. This decides which pipeline path you run so you neither over-process a one-liner nor under-audit a real feature.

| Change Class | Examples | Pipeline Path |
|--------------|----------|---------------|
| **Trivial** | Version pin bump, dependency update, typo fix, comment edit, CHANGELOG-only | **Lightweight path** — skip or abbreviate Stages 0–1 and 3–5; focus on review, PII scan, docs, deploy |
| **Standard** | Bug fix, small feature, config change, installer update | **Full pipeline** (this document) |
| **Complex / Breaking** | New architecture, breaking API change, security-critical refactor, multi-surface feature | **Full pipeline** with enhanced research (Stage 0) and additional validation passes |

**Rule of thumb:** If the diff contains *only* version strings, docs, or comments → lightweight path. If the diff changes *behavior* → full pipeline. If unsure, default to the full pipeline (more auditing is the safer error).

Teams should define their own lightweight-path SOP for trivial changes and reference it here.

---

## Core Principles

All public development must occur in clean, dedicated repositories with no personal configuration, contacts, or internal paths committed.

- Use only placeholder values (`[NAME]`, `user@example.com`, `~/`, etc.)
- Never commit real names, emails, phone numbers, API keys, or internal file paths
- Maintain separate private backup repositories for personal work

---

## Convergence Protocol (ANTI-STUCK — applies to ALL review/audit loops)

Every review loop in this SOP (Stage 2 implementation review, Stage 4 independent validation, Stage 5 coverage review) is **bounded**. The goal is high-quality code without reviewers or agents spinning forever on cosmetic nits.

### 1. Finding Classification (REQUIRED on every review pass)

The reviewer must classify each finding into exactly one bucket:

| Class | Definition | Gating? |
|-------|------------|---------|
| **Correctness** | Wrong behavior, logic error, off-by-one, type mismatch, broken edge case | **BLOCKING** |
| **Security** | New attack surface, secret exposure, injection, unsafe defaults | **BLOCKING** |
| **Style** | Naming, formatting, readability, "polish", "nice to have" | **NON-blocking** (logged, not gating) |

### 2. Gate Definition

**"Passing" = zero BLOCKING findings** (zero Correctness + zero Security issues).

- Correctness and Security findings **must be fixed before proceeding** (zero-deferral applies to these two classes).
- Style findings are **logged to a tracked follow-up** (e.g., a backlog issue, a follow-ups file, or a ticket) and do **not** block the release.
- This prevents infinite oscillation where fixing one nit introduces another.

### 3. Iteration Cap

- **Maximum 3 review iterations per stage.**
- If the gate is not cleared by iteration 3, **STOP and escalate** to the project lead / stakeholder with:
  - The remaining findings, classified (Blocking vs Style)
  - What was attempted each iteration
  - A recommendation (ship with tracked follow-ups / keep iterating / redesign)

### 4. Time-Box Escalation

- If **any single stage runs longer than a defined time limit** (recommended: 20–30 minutes for automated reviews, 1–2 hours for human reviews) without clearing its gate, **STOP and escalate** rather than continuing to spin.
- Escalation must include: current stage, what's blocking, iterations attempted, elapsed time, and a recommended next step.
- This is a hard timeout — it fires even if the iteration cap hasn't been hit.

### 5. Documented "Blocked" State

When escalating (cap hit OR time-box hit), the team enters an explicit **BLOCKED** state:
- Record the blocked state in the project log with stage, reason, and remaining work.
- Do **not** silently retry or loop. Wait for stakeholder direction.
- Resume only after stakeholder responds.

> **Why this matters:** Reasoning models and thorough human reviewers can almost always find "one more improvement." Without a cap + time-box + blocking/non-blocking split, "fix all issues" becomes an unbounded loop. This protocol keeps the quality bar high on what matters (correctness + security) while guaranteeing forward progress.

---

## Versioning Scheme — CalVer (YYYY.MM.DD.HHMM)

All releases use Calendar Versioning in UTC with a four-digit time suffix.

**Format:** `YYYY.MM.DD.HHMM` (24-hour UTC clock, always four digits for HHMM).

**Padding rules:** Months and days are written without leading zeros. The time component (HHMM) is always exactly four digits, using leading zeros when necessary.

**Examples:**
- 2026 March 9 at 09:05 UTC → `2026.3.9.0905`
- 2026 March 20 at 12:00 UTC → `2026.3.20.1200`
- 2026 March 20 at 19:35 UTC → `2026.3.20.1935`

**Surface formats:**
| Surface | Format | Example | Notes |
|---------|--------|---------|-------|
| Git tag | `vYYYY.MM.DD.HHMM` | `v2026.3.20.1935` | Prefixed with `v` |
| Package manifest (e.g., `package.json`) | `YYYY.MM.DD.HHMM` | `2026.3.20.1935` | No `v`, always four-digit time |
| Changelog | `vYYYY.MM.DD.HHMM` | `v2026.3.20.1935` | Matches git tag |
| Container image tags (e.g., Docker) | `YYYY.MM.DD.HHMM` | `2026.3.20.1935` | No `v` |

**Rules:**
- Time is always UTC
- The version reflects the exact moment the release is tagged
- Use automated tooling where possible to generate versions
- Avoid manually editing version numbers when practical

---

## Pipeline Stages

| Stage | Name | Description | Gate |
|-------|------|-------------|------|
| 0 | **Research** | Survey landscape, evaluate options, produce research brief | Stakeholder reviews brief, picks direction |
| 1 | **Planning** | Requirements, architecture, surface analysis, regression plan | Stakeholder approval |
| 2 | **Implementation & Review** | Implement + iterate with rigorous review until passing (zero blocking) | **Passing per Convergence Protocol** |
| 3 | **Dependency Check & Regression Testing** | Detect new deps, update installer if needed; verify no regressions | Installer covers all deps; no regressions found |
| 4 | **Independent Validation** | Different reviewer validates for blindspots | **Passing per Convergence Protocol** |
| 5 | **Testing & Coverage Review** | Run tests + review coverage | **No new failures vs baseline + passing coverage** |
| 6 | **PII & Secrets Scan** | Scan for leaked keys, addresses, personal data | 0 findings |
| 7 | **Documentation** | Update docs, CHANGELOG, README | Docs reviewed |
| 8 | **Primary Deploy** | Push to primary repo | Clean push |
| 9 | **Tagging & Release** | Version bump, git tag, create release | Release verified |
| 10 | **Distribution** | Update all package registries, mirrors, and distribution channels | All surfaces updated |

---

## Stage Details

### Stage 0 — Research

- Survey the landscape: existing solutions, SDKs, packages, protocols, prior art.
- Search package registries, code hosting platforms, docs, and community resources for candidate tools.
- Read documentation, changelogs, GitHub issues for each candidate.
- Evaluate trade-offs: pros/cons/risks for each option.
- Check compatibility with your stack (runtime version, existing deps, patterns).
- Identify dependencies, licensing, maintenance status, breaking change history.
- Produce a **Research Brief** saved to project documentation:
  - Problem statement and context
  - Options evaluated (with pros/cons table)
  - Compatibility notes (runtime version, existing deps, patterns)
  - Recommended approach + rationale
  - Open questions / blockers
  - Links to docs and references
  - Date and researcher ID
- Stakeholder reviews the brief and picks a direction.
- Only then does Stage 1 (Planning) begin.
- **Skip condition:** If the problem space is well-understood and no external deps are involved, stakeholder can approve skipping directly to Stage 1.

### Stage 1 — Planning

- Define what's being built or fixed.
- Write specs, architecture decisions, scope.
- Identify affected files and dependencies.
- Stakeholder approves before coding begins.

#### Deployment Surface Analysis (RECOMMENDED)

Before implementation, identify all supported deployment environments (containers, native packages, installers, cloud functions, etc.) and document whether the change must be implemented uniformly or requires surface-specific adaptations.

For every change, document:
```
Surfaces affected: [Container, native install, cloud, ...]
Surface-specific changes needed:
  - Container: <what changes>
  - Native: <what changes>
  - Installer: <what changes>
Cross-surface: <what changes apply to all>
```

#### Regression Risk Analysis (RECOMMENDED)

Document which existing features or code paths could be impacted by the change. Create a checklist of tests to re-verify before release:
```
Regression risks:
  - [Existing features/flows that touch the same code paths]
  - [Edge cases that worked before and must still work after]
Regression tests to run in Stage 3:
  - [ ] <test> — verifies <existing behavior> still works
```

### Progress Updates

For team or collaborative projects, provide regular status updates to stakeholders at logical checkpoints (end of major stages or after significant work). Include current stage, progress, and blockers.

### Stage 2 — Implementation & Rigorous Review

#### Step 2.1: Initial Implementation
- Implement changes against live codebase.
- Commit to working branch with descriptive messages.
- Ensure code compiles/parses clean (no syntax errors).
- Follow existing code style and patterns.

#### Step 2.2: Review Process

All changes must undergo thorough review (human or AI-assisted) focusing on correctness, security, edge cases, quality, and regressions.

**The reviewer MUST classify each finding** per the Convergence Protocol:
- **Correctness** (blocking) — wrong behavior, logic errors, broken edge cases
- **Security** (blocking) — new attack surfaces, vulnerabilities
- **Style** (non-blocking) — naming, formatting, readability, polish

Review checklist:
1. **Correctness** — Does it solve the stated problem?
2. **Security** — Any new attack surfaces or vulnerabilities?
3. **Edge cases** — Are error paths handled?
4. **Code quality** — Naming, structure, DRY, readability
5. **Regressions** — Could this break existing functionality?

#### Step 2.3: Review & Iteration Loop (bounded by Convergence Protocol)

```
iteration = 0
while iteration < 3:
    iteration += 1
    review = reviewer.review(changes)
    blocking = review.findings(class in [Correctness, Security])
    if blocking == 0:
        log_style_findings_to_backlog(review.style_findings)
        break  # ✅ Stage 2 COMPLETE — passing (zero blocking)
    for fix in blocking:
        apply_fix(fix)
    commit("fix: address review blocking findings")
# If 3 iterations OR time-box exceeded: STOP + escalate (BLOCKED state)
```

#### Gate to Stage 3

**Required:** Zero blocking (Correctness + Security) findings. Style findings logged to tracked follow-ups. See Convergence Protocol for cap/time-box/escalation rules.

### Stage 3 — Dependency Check & Regression Testing

- **Detect new dependencies** in all changed files:
  - Check package manifest for new runtime dependencies
  - Check for new peer dependencies
  - Check for new system-level dependencies (external binaries)
- **Update installer** if new deps found:
  - Add dependency installation commands
  - Add system-level dependency checks/installers
  - Test installer on clean environment (container or fresh VM)
- **Verify installer covers all deps** before proceeding

**CI/build alignment check (RECOMMENDED when any version is bumped):**
- Verify build configuration versions match what CI passes as build arguments.
- Verify CI does NOT hardcode versions that override build configs.
- Verify pinned tags/versions actually exist upstream.
- **Skip condition:** If no new dependencies added AND no version bumps, mark dependency check as PASS.

#### Regression Testing (RECOMMENDED)

Execute the regression test checklist from Stage 1. This catches regressions before they reach production.

**Process:**
1. Review the Stage 1 risk list — confirm all identified risks are covered.
2. Run each regression test and document results (PASS/FAIL).
3. Test affected deployment surfaces.
4. Verify existing behavior is preserved.
5. Document any new regressions found — fix before proceeding.

**Minimum checklist:**
- [ ] Changed scripts pass syntax check
- [ ] Existing unit tests still pass
- [ ] Changed function's callers still work
- [ ] Happy path works end-to-end
- [ ] Error paths don't hard-fail unexpectedly

**Gate:** All regression tests PASS. Any FAIL must be fixed and re-tested before proceeding.

**Skip condition:** If the change is documentation-only with zero code changes, regression testing may be skipped with a note.

### Stage 4 — Independent Validation

**Purpose:** Obtain validation from a second independent reviewer to catch blind spots missed by the first reviewer.

Stage 4 requires validation from a **different reviewer or review process** than was used in Stage 2. The same Convergence Protocol applies (classification, 3-iteration cap, time-box, BLOCKED state).

- Send patches to a different reviewer or review tool.
- Reviewer checks against live code and sends classified findings back.
- **Bounded by the Convergence Protocol** — max 3 iterations, time-box, escalate to BLOCKED if not cleared.
- **Check for:**
  - Correctness (does the change actually resolve the stated problem?)
  - Variable name accuracy (match live code, not pseudocode)
  - Security implications and new attack surfaces
  - Edge cases and regressions
  - Logic errors, off-by-one, type mismatches
- Gate: **Passing = zero blocking findings.** Document audit findings in project documentation.

```
# Same bounded loop as Stage 2:
iteration = 0
while iteration < 3:
    iteration += 1
    review = independent_reviewer.review(changes)
    blocking = review.findings(class in [Correctness, Security])
    if blocking == 0:
        log_style_findings_to_backlog(review.style_findings)
        break  # ✅ Stage 4 COMPLETE
    apply_fixes(blocking)
# If 3 iterations OR time-box exceeded: STOP + escalate (BLOCKED state)
```

#### Why Independent Validation?

Different reviewers have different blind spots. Two independent "passing" reviews from different perspectives = higher confidence than one. If using AI-assisted review, use a different model or tool for validation than for Stage 2.

### Stage 5 — Testing & Coverage Review

#### Step 5.1: Run Tests
- Run all unit tests.
- Run integration tests if applicable.
- Test edge cases identified during validation.
- Verify on target platforms.

**Gate is "NO NEW FAILURES vs baseline"** — Capture the pre-change baseline (stash changes, run tests, record pass/fail counts), then compare post-change. The count of failures must be ≤ baseline and no previously-passing test may regress.

> **Note on pre-existing failures:** If your test suite has known pre-existing failures, the gate is "no *new* failures" rather than "all tests pass." Track a separate effort to reduce the failure count to zero. Once the suite is clean, tighten the gate to "all tests pass."

#### Step 5.2: Coverage Review (bounded by Convergence Protocol)

After tests pass, review test coverage for completeness. Classify gaps per the Convergence Protocol (Correctness/Security = blocking, Style = non-blocking):

1. **Coverage gaps** — Are all code paths tested?
2. **Edge cases** — Are boundary conditions tested?
3. **Error paths** — Are failure modes tested?
4. **Regression tests** — Are Stage 1 risks covered?
5. **Test quality** — Are assertions meaningful? Are mocks appropriate?

Add missing tests for blocking gaps. Log style-level gaps to follow-ups. Same 3-iteration cap and time-box apply.

```
# Same bounded loop as Stage 2:
iteration = 0
while iteration < 3:
    iteration += 1
    coverage_review = reviewer.review_coverage(test_files)
    blocking_gaps = coverage_review.findings(class in [Correctness, Security])
    if blocking_gaps == 0:
        log_style_gaps_to_backlog(coverage_review.style_findings)
        break  # ✅ Stage 5 coverage COMPLETE
    add_tests(blocking_gaps)
# If 3 iterations OR time-box exceeded: STOP + escalate (BLOCKED state)
```

#### Gate to Stage 6

**Required:** No new test failures vs baseline + zero blocking coverage gaps. Style gaps logged to follow-ups.

### Stage 6 — PII & Secrets Scan

- Scan all changed files for:
  - Private keys, wallet addresses, API keys
  - Personal data (names, emails, phone numbers)
  - Hardcoded secrets or credentials
- Use automated scanner + manual review.
- **0 findings required** to proceed.

#### Patterns to Check

| Pattern | Description | Example |
|---------|-------------|---------|
| API keys | Provider-specific prefixes | Keys starting with known prefixes (e.g., `sk_`, `AKIA`, `ghp_`, etc.) |
| Private keys | PEM blocks or long hex strings | `-----BEGIN PRIVATE KEY-----` or 64+ hex chars |
| Credentials | Hardcoded passwords/tokens | `password = "..."` in source |
| Personal data | Real PII | Real names, emails, addresses, phone numbers |

#### Sensitive Information Storage Rules

| Secret Type | Recommended Storage | Never Store In | Rotation Policy |
|-------------|----------------------|----------------|----------------|
| API keys, tokens | Secrets manager or environment variables | Git, source files, logs | On compromise or scheduled |
| Long-lived credentials | Dedicated vault or HSM | Any persistent file in repository | Regular rotation |
| Personal data | Only when required with explicit consent and proper controls | Source code or repositories | N/A |

#### If Keys Found in Files

1. **STOP** — do not proceed with deploy.
2. **Rotate immediately** — generate new keys from the provider dashboard.
3. **Scrub from git history** using a history-rewriting tool (e.g., `git filter-repo`, BFG Repo-Cleaner, or equivalent).
4. **Force push all branches** to all remotes.
5. **Store new keys securely**, update config.
6. **Document incident** in project log.

### Stage 7 — Documentation

- **Update docs** with new features, CLI commands, config options, API changes, dependency requirements.
- **Update CHANGELOG.md** with version number, date, summary of changes (Added/Fixed/Changed/Security), links to issues/PRs.
- **Update README.md** if installation, commands, or prerequisites changed.
- **Update architecture docs** if modules, data flow, or integrations changed.
- **Review** all doc changes for accuracy.
- **Skip condition:** If no user-facing changes, mark as PASS and proceed.

### Stage 8 — Primary Deploy

- Push to primary repository (origin).
- Push to organization repository if applicable.
- Verify all pushes succeeded.

### Stage 9 — Tagging & Release

- Update version information across all relevant surfaces (manifests, documentation, build configurations) using your project's established tooling or process.
- Update CHANGELOG with release notes (use tag format: `vYYYY.MM.DD.HHMM`).
- Create a signed or annotated tag for the release version.
- Push the tag to your primary remote(s).
- **Create a release** using your platform's release tool (e.g., GitHub Releases, GitLab Releases, or equivalent).
- Verify release artifacts are available.

**Version format:** See "Versioning Scheme" section above.

### Stage 10 — Distribution

- Update the project in all official distribution channels and package registries.
- Verify that all published artifacts exactly match the tagged release in the primary repository.
- Confirm version consistency across all surfaces.

---

## Rollback / Abort Procedure

If a release goes bad after deployment, follow these steps based on how far the release progressed:

### If caught BEFORE distribution (Stage 8 or earlier)
- `git reset --hard <last-good-commit>` on the primary branch.
- Delete the local tag: `git tag -d <bad-tag>`.
- Force-push primary repos back to the last known good state if already pushed.

### If caught AFTER distribution (Stages 9–10)
1. **Delete the release** from the platform using your platform's release management tooling.
2. **Delete the tag everywhere** — remove the bad tag from all remotes and locally. Most platforms support remote tag deletion via push.
3. **Roll code back:** Reset to last known good commit, then re-push to all remotes. Force-push if history diverged.
4. **Published artifacts:** If a bad package/image was published to a registry (npm, Docker Hub, etc.), re-tag the last known good version as `:latest` or equivalent, or yank/unpublish the bad version if the registry supports it. Do NOT leave the default/latest tag pointing at a broken build.
5. **Verify** all distribution surfaces reflect the rolled-back state.
6. **Document** the abort: what shipped, what broke, what was rolled back.

### Forward-fix vs rollback
Prefer a **forward fix** (new patch release) when the bad release is already widely pulled and the bug is non-critical. Use **rollback** for security issues, secret leaks, or broken-on-startup regressions.

---

## Zero-Deferral Policy (scoped by Convergence Protocol)

No **Correctness** or **Security** finding may be deferred — fix it now. **Style** findings are logged to a tracked backlog/follow-up and do not gate the release (see Convergence Protocol). This replaces the older blanket "fix every nit now" rule, which caused unbounded review loops.

---

## Quick Reference

```
0. Research → 1. Plan (+surfaces +regression) → 2. Implement + Review [→passing/bounded] → 3. Deps + Regression → 4. Independent Validation [→passing/bounded] → 5. Test (no new failures) + Coverage → 6. PII → 7. Docs → 8. Deploy → 9. Tag & Release → 10. Distribute
```
Review gates are **passing = zero blocking**, bounded by the Convergence Protocol (3-iteration cap, time-box, escalate to BLOCKED).

---

## Summary

This SOP enforces:

1. **Triage first** — The Change-Class Router prevents over-processing trivial changes and under-auditing complex ones
2. **Research first** — Understand the landscape before building
3. **Planning with risk analysis** — Identify regression risks and deployment surfaces before coding
4. **Rigorous, bounded review** — Iterate until passing with classified findings; never spin forever (Convergence Protocol)
5. **Independent validation** — Different reviewer catches different blind spots
6. **Regression testing** — Stage 1 risks are verified in Stage 3
7. **PII protection** — No secrets ever reach git history
8. **Documentation** — Keep docs in sync with code
9. **Rollback readiness** — Every release can be safely reverted
10. **Distribution** — Ensure consistent release across all channels

The result is a shipping pipeline that catches bugs early, prevents technical debt accumulation, guarantees forward progress (no infinite review loops), and ensures production releases are thoroughly verified before deployment.

---

## History

- **April 30, 2025** — SOP-003 created as generalized public derivative of an internal development SOP.
- **May 28, 2026** — Major revision aligned with internal SOP overhaul: (1) Added **Change-Class Router** for triage (trivial vs standard vs complex). (2) Added **Convergence Protocol** — all review loops bounded with Blocking/Style classification, 3-iteration cap, time-box escalation, and documented BLOCKED state. (3) Stage 5 test gate changed to **no new failures vs baseline** with note on pre-existing failures. (4) Added **Rollback/Abort Procedure** (pre-distribution vs post-distribution, forward-fix guidance). (5) **Zero-Deferral Policy** scoped to blocking findings only (Style logged to follow-ups, not gating). (6) Stage 2/4/5 review loops explicitly bounded with pseudocode. (7) Stage 1 planning templates expanded (deployment surface analysis, regression risk format). (8) Summary section updated with triage and rollback principles.
