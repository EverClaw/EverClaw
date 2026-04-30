# SOP-003 — Code Development & Deployment Pipeline (Generalized)

Last updated: 2025-04-30

**Public version** — All organization-specific and personal workspace details have been removed. This document describes a rigorous engineering process suitable for external teams.

**Adaptation Note for Third Parties**

This document is a generalized derivative of an internal SOP. While most organization-specific details have been removed, some elements (particularly the version bumping mechanics, references to `package.json`, Docker, and GitHub-specific tooling) still reflect the source environment. External teams should treat the review loops, stage gates, and distribution steps as **illustrative patterns** and replace them with their own quality gates, tools, and release processes.

**How to Use This Document**

This SOP presents one rigorous approach to software development. Third-party teams should adopt the principles (research before building, risk analysis, independent validation, PII scanning, etc.) while replacing the specific mechanisms (rating scale, exact stage gates, CalVer format, tooling commands) with equivalents that fit their environment and culture.

---

## Core Principles

All public development must occur in clean, dedicated repositories with no personal configuration, contacts, or internal paths committed.

- Use only placeholder values (`[NAME]`, `user@example.com`, `~/`, etc.)
- Never commit real names, emails, phone numbers, API keys, or internal file paths
- Maintain separate private backup repositories for personal work

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
| package.json (or equivalent manifest) | `YYYY.MM.DD.HHMM` | `2026.3.20.1935` | No `v`, always four-digit time |
| CHANGELOG.md | `vYYYY.MM.DD.HHMM` | `v2026.3.20.1935` | Matches git tag |
| Docker tags | `YYYY.MM.DD.HHMM` | `2026.3.20.1935` | No `v` |

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
| 1 | **Planning** | Requirements, architecture, design decisions | Stakeholder approval |
| 2 | **Implementation & Review** | Implement + iterate with rigorous review | All review criteria met with zero open issues |
| 3 | **Dependency Check & Regression Testing** | Detect new deps, update installer if needed; verify no regressions | Installer covers all deps; no regressions found |
| 4 | **Independent Validation** | Different reviewer validates for blindspots | All review criteria met with zero open issues |
| 5 | **Testing & Coverage Review** | Run tests + review coverage | All tests pass + complete coverage |
| 6 | **PII & Secrets Scan** | Scan for leaked keys, addresses, personal data | 0 findings |
| 7 | **Documentation** | Update docs, CHANGELOG, README | Docs reviewed |
| 8 | **Primary Deploy** | Push to primary repo | Clean push |
| 9 | **Tagging & Release** | Version bump, git tag, create release | Release verified |
| 10 | **Distribution** | Update all package registries, mirrors, and distribution channels | All surfaces updated |

---

## Stage Details

### Stage 0 — Research

- Survey the landscape: existing solutions, SDKs, packages, protocols, prior art
- Search package registries, GitHub, docs, and community resources for candidate tools
- Read documentation, changelogs, GitHub issues for each candidate
- Evaluate trade-offs: pros/cons/risks for each option
- Check compatibility with your stack (runtime version, existing deps, patterns)
- Identify dependencies, licensing, maintenance status, breaking change history
- Produce a **Research Brief** saved to project documentation
- **Research Brief structure:**
  - Problem statement and context
  - Options evaluated (with pros/cons table)
  - Compatibility notes (runtime version, existing deps, patterns)
  - Recommended approach + rationale
  - Open questions / blockers
  - Links to docs and references
  - Date and researcher ID
- Stakeholder reviews the brief and picks a direction
- Only then does Stage 1 (Planning) begin
- **Skip condition:** If the problem space is well-understood and no external deps are involved, stakeholder can approve skipping directly to Stage 1

### Stage 1 — Planning

- Define what's being built or fixed
- Write specs, architecture decisions, scope
- Identify affected files and dependencies
- Stakeholder approves before coding begins

#### Deployment Surface Analysis (Recommended)

Before implementation, identify all supported deployment environments (containers, native packages, installers, cloud functions, etc.) and document whether the change must be implemented uniformly or requires surface-specific adaptations.

#### Regression Risk Analysis (Recommended)

Document which existing features or code paths could be impacted by the change. Create a short checklist of tests that must be re-verified before release.

### Progress Updates

For team or collaborative projects, provide regular status updates to stakeholders at logical checkpoints (end of major stages or after significant work). Include current stage, progress, and blockers.

### Stage 2 — Implementation & Rigorous Review

#### Step 2.1: Initial Implementation
- Implement changes against live codebase
- Commit to working branch with descriptive messages
- Ensure code compiles/parses clean (no syntax errors)
- Follow existing code style and patterns

#### Step 2.2: Review Process

All changes must undergo thorough review (human or AI-assisted) focusing on correctness, security, edge cases, quality, and regressions.

Reviews must be passed with no remaining issues. All feedback, including minor items, must be addressed before proceeding. Deferred work is not permitted.

Review checklist:
1. **Correctness** — Does it solve the stated problem?
2. **Security** — Any new attack surfaces or vulnerabilities?
3. **Edge cases** — Are error paths handled?
4. **Code quality** — Naming, structure, DRY, readability
5. **Regressions** — Could this break existing functionality?

#### Step 2.3: Review & Iteration Loop

```
while review does not pass quality gate:
    Apply all feedback (including minor items)
    Commit changes with descriptive message
    Re-review changes
```

#### Gate to Stage 3

**Required:** All feedback addressed and changes pass independent review with zero open issues.

**Forbidden:** Deferring any identified fixes to future work.

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
- **Skip condition:** If no new dependencies added AND no version bumps, mark dependency check as PASS

#### Regression Testing (Recommended)

Execute the regression test checklist from Stage 1. This catches regressions before they reach production.

**Process:**
1. Review the Stage 1 risk list — confirm all identified risks are covered
2. Run each regression test and document results (PASS/FAIL)
3. Test affected deployment surfaces
4. Verify existing behavior is preserved
5. Document any new regressions found — fix before proceeding

**Minimum checklist:**
- [ ] Changed scripts pass syntax check
- [ ] Existing unit tests still pass
- [ ] Changed function's callers still work
- [ ] Happy path works end-to-end
- [ ] Error paths don't hard-fail unexpectedly

**Skip condition:** If the change is documentation-only with zero code changes, regression testing may be skipped with a note.

### Stage 4 — Independent Validation

**Purpose:** Obtain validation from a second independent reviewer to catch blind spots missed by the first reviewer. The same standard of zero outstanding issues applies. Use your organization's normal review and approval mechanisms.

Stage 4 requires validation from a different reviewer or review process than was used in Stage 2.

- Send patches to a different reviewer or review tool
- Reviewer checks against live code and sends findings back
- **Loop until all changes pass** — same standard as Stage 2
- **Check for:**
  - Correctness (does the change actually resolve the stated problem?)
  - Variable name accuracy (match live code, not pseudocode)
  - Security implications and new attack surfaces
  - Edge cases and regressions
  - Logic errors, off-by-one, type mismatches
- **Iterate patches** until all changes pass review
- Document audit findings in project documentation

### Stage 5 — Testing & Coverage Review

#### Step 5.1: Run Tests
- Run all unit tests
- Run integration tests if applicable
- Test edge cases identified during validation
- Verify on target platforms

#### Step 5.2: Coverage Review

After tests pass, review test coverage for completeness:

1. **Coverage gaps** — Are all code paths tested?
2. **Edge cases** — Are boundary conditions tested?
3. **Error paths** — Are failure modes tested?
4. **Regression tests** — Are Stage 1 risks covered?
5. **Test quality** — Are assertions meaningful? Are mocks appropriate?

Evaluate coverage for completeness against the checklist below.

For rating below "Perfect", add missing tests before proceeding.

#### Step 5.3: Coverage Review & Remediation

- Run the full test suite
- Review test coverage against the checklist above
- Add or improve tests for any gaps
- Repeat until all tests pass and coverage meets the defined quality standard for the project

#### Gate to Stage 6

**Required:** All tests pass and test coverage meets the project's quality standard.

**Forbidden:** Knowingly shipping with untested code paths.

### Stage 6 — PII & Secrets Scan

- Scan all changed files for:
  - Private keys, wallet addresses, API keys
  - Personal data (names, emails, phone numbers)
  - Hardcoded secrets or credentials
- Use automated scanner + manual review
- **0 findings required** to proceed

#### Patterns to Check

| Pattern | Description | Example |
|---------|-------------|---------|
| API keys | Provider-specific prefixes | `sk_live_`, `AKIA`, `ghp_` |
| Private keys | PEM blocks or long hex | `-----BEGIN PRIVATE KEY-----` |
| Credentials | Hardcoded passwords/tokens | `password = "..."` in source |
| Personal data | Real PII | Real names, emails, addresses, phone numbers |

#### Sensitive Information Storage Rules

| Secret Type | Recommended Storage | Never Store In | Rotation Policy |
|-------------|----------------------|----------------|----------------|
| API keys, tokens | Secrets manager or environment variables | Git, source files, logs | On compromise or scheduled |
| Long-lived credentials | Dedicated vault or HSM | Any persistent file in repository | Regular rotation |
| Personal data | Only when required with explicit consent and proper controls | Source code or repositories | N/A |

#### If Keys Found in Files

1. **STOP** — do not proceed with deploy
2. **Rotate immediately** — generate new keys from the provider dashboard
3. **Scrub from git history** using `git filter-repo` or BFG Repo-Cleaner
4. **Force push all branches** to all remotes
5. **Store new keys securely**, update config
6. **Document incident** in project log

### Stage 7 — Documentation

- **Update docs** with:
  - New features, CLI commands, config options
  - API changes or breaking changes
  - Dependency requirements
- **Update CHANGELOG.md** with:
  - Version number and date
  - Summary of changes (Added/Fixed/Changed/Security)
  - Link to relevant issues/PRs
- **Update README.md** if:
  - Installation process changed
  - New commands or workflows added
  - Prerequisites changed
- **Update architecture docs** if:
  - New modules or components
  - Data flow or process changes
  - Integration changes
- **Review** all doc changes for accuracy
- **Skip condition:** If no user-facing changes, mark as PASS and proceed

### Stage 8 — Primary Deploy

- Push to primary repository (origin)
- Push to organization repository if applicable
- Verify all pushes succeeded

### Stage 9 — Tagging & Release

- Update version information across all relevant surfaces (manifests, documentation, build configurations) using your project's established tooling or process
- Update CHANGELOG with release notes (use tag format: `vYYYY.MM.DD.HHMM`)
- Create git tag: `git tag -a "<version>" -m "release message"`
- Push tag: `git push origin main --tags`
- **Create release:** Use platform's release tool (e.g., `gh release create`)
- Verify release artifacts are available

**Version format:** See "Versioning Scheme" section above.

### Stage 10 — Distribution

- Update the project in all official distribution channels and package registries
- Verify that all published artifacts exactly match the tagged release in the primary repository
- Confirm version consistency across all surfaces

---

## Summary

This SOP enforces:

1. **Research first** — Understand the landscape before building
2. **Planning with risk analysis** — Identify risks before coding
3. **Rigorous review** — Iterate until passing, no exceptions
4. **Independent validation** — Different reviewer catches different blind spots
5. **Regression testing** — Stage 1 risks are verified in Stage 3
6. **PII protection** — No secrets ever reach git history
7. **Documentation** — Keep docs in sync with code
8. **Distribution** — Ensure consistent release across all channels

The result is a shipping pipeline that catches bugs early, prevents technical debt accumulation, and ensures production releases are thoroughly verified before deployment.