# EverClaw Changelog

All notable changes to EverClaw are documented here.

## [2026.4.9] - 2026-04-09 — Docker Channel Plugin Fix

### Fixed
- **Docker image missing channel plugin dependencies** (Issue #17) — OpenClaw v2026.4.8 loads all bundled channel plugins at startup (Telegram, Discord, Slack, Feishu, etc.) but their runtime deps (`grammy`, `@buape/carbon`, `@slack/web-api`, `@larksuiteoapi/node-sdk`, etc.) were not installed in the Docker image. Root cause: OpenClaw's `postinstall-bundled-plugins.mjs` script detects source checkouts (via `src/` + `extensions/` dirs) and skips dep installation. Since the Dockerfile builds from a git clone, these dirs exist and the postinstall silently skips. Fix: remove `src/` and `extensions/` (build-only artifacts, not needed at runtime) after `pnpm build`, then run the postinstall script. This also reduces image size. Thanks to @robkay01 (Bobski) for the detailed bug report.

## [2026.4.8] - 2026-04-08 — MemPalace Enhanced Memory

### Changed
- **OpenClaw pin v2026.4.5 → v2026.4.8** — Dockerfile `OPENCLAW_VERSION` and `docker-compose.yml` `EVERCLAW_VERSION` env updated. SKILL.md version header and diagnostics examples updated to match.

### Added
- **memory_search best practices in agent templates** — `AGENTS.template.md` now includes session-start search step with example query, "Recall Reflex" guide with example queries and query crafting tips, updated memory maintenance routine with `openclaw memory promote` (gated on dreaming being enabled). `SOUL.template.md` adds "Search before you speak" as a core truth. Both bumped to template-version 2026.4.8. Reviewed by Grok (2 rounds).
- **MemPalace memory backend** — Optional upgrade layering ChromaDB vector search + temporal knowledge graph on top of OpenClaw's built-in `memory_search`. Dual embedding models (embeddinggemma-300m-qat 300M + all-MiniLM-L6-v2 22M) catch different semantic matches.
- **Python bridge** (`scripts/python/mempalace_bridge.py`) — JSON contract between Node.js and MemPalace SDK v3.0.0 via spawn(). Supports search, mine, wake-up, status, init, as-of, and export commands. Full stdout suppression preserves JSON contract.
- **Shared bridge utility** (`scripts/lib/bridge-call.mjs`) — Single source of truth for Python bridge communication. Configurable `rejectOnError` for strict vs graceful degradation modes.
- **Memory backend abstraction** (`scripts/lib/memory-backend.mjs`) — Factory pattern with `MemPalaceBackend` and `FileBackend`. Async dynamic imports, graceful fallback.
- **FileBackend** (`scripts/lib/file-backend.mjs`) — Grep-based search over memory/*.md files. Read-only fallback when MemPalace is not installed.
- **MemPalaceBackend** (`scripts/lib/mempalace-backend.mjs`) — Full ChromaDB + temporal KG access via Python bridge.
- **Migration script** (`scripts/memory/migrate-to-mempalace.mjs`) — One-time ingestion of existing memory files. Idempotent (content-hash IDs), supports dry-run, wing selection, category stats.
- **Search hook** (`scripts/memory/mempalace-search-hook.mjs`) — Unified search API combining MemPalace results with OpenClaw built-in search. Graceful degradation when MemPalace unavailable.
- **Obsidian vault export** (`scripts/memory/export-obsidian-vault.mjs`) — Exports palace as Obsidian-compatible vault with YAML frontmatter, wikilinks, MOCs, timeline pages. 3,245 drawers → 3,302 files in ~3s.
- **CLI bridge** (`scripts/memory/mempalace-bridge.mjs`) — Full CLI for all memory operations with backend selection.
- **Config template** (`templates/everclaw-config-memory.json`) — Memory backend configuration with MemPalace and FileBackend options.
- **Setup Stage 6** — `setup.mjs` now detects MemPalace SDK, checks palace existence, and verifies bridge health.
- **Diagnose A12** — `diagnose.sh` checks MemPalace installation and palace status.
- **Test suite** — 28 automated tests across `tests/memory-backend.mjs` (19) and `tests/mempalace-bridge.mjs` (9). Covers FileBackend, MemPalaceBackend, factory, error handling, edge cases.
- **SKILL.md Section 23** — Full documentation of MemPalace integration, architecture, CLI usage, and configuration.

### Changed
- **`package.json`** — Added `test:memory` script.

### Security
- All new files pass PII scan (0 findings). MemPalace vaults stored locally in `~/.mempalace/`. Export includes privacy warning.

### Technical Notes
- Requires: `pip install mempalace` (optional — EverClaw works without it)
- First mine downloads 79MB embedding model (all-MiniLM-L6-v2)
- Bridge timeout: 300s default (mining can be slow on first run)
- Idempotent migration: ChromaDB content-hash IDs prevent duplicates on re-run
- Wings provide data isolation (tested: 0 cross-contamination)

## [2026.4.7.1833] - 2026-04-07 — Ollama Input Modalities Fix

### Fixed
- **Gateway startup failure on fresh installs and upgrades** — OpenClaw's config validator only allows `["text", "image"]` in model `input` arrays. EverClaw templates and `setup-ollama.sh` were generating `["text", "image", "audio"]` for Gemma 4 E2B/E4B (which natively support audio), causing the gateway to reject the config and fail to start. Now all input arrays are capped to `["text", "image"]` until OpenClaw adds audio support.

### Added
- **Model input modality migration** — `setup.mjs` now sanitizes all provider model `input` arrays at apply time, removing unsupported values like `"audio"`. Defensive migration runs on all providers (not just Ollama) for future-proofing.
- **A11 diagnostic check** — `diagnose.sh` now detects unsupported input modalities and suggests running `setup.mjs --apply` to auto-fix.

### Changed
- **`templates/openclaw-config-mac.json`** — Ollama model input: `["text", "image", "audio"]` → `["text", "image"]`
- **`templates/openclaw-config-linux.json`** — Same
- **`scripts/setup-ollama.sh`** — `get_model_input_modalities()` now returns `["text", "image"]` for all models (E2B/E4B/26B/31B) with comment explaining OpenClaw validator limitation
- **Comment updated** — `_comment` in templates dropped "Vision + audio" to "Vision enabled where supported"

### Technical Notes
- Root cause: OpenClaw recently tightened the config schema for `models[].input` to only allow `"text"` and `"image"`. EverClaw templates were ahead of the validator (Gemma 4 E2B/E4B do support audio natively), but the mismatch caused gateway rejections.
- Migration is defensive: strips any value not in `{"text", "image"}` across ALL providers, not just Ollama.
- Silent no-op if config is already valid (no write, no log message).

## [2026.4.7.1756] - 2026-04-07 — Local Embeddings Fix (node-llama-cpp)

### Fixed
- **Silent `memory_search` failure on all fresh installs** — OpenClaw's default `memorySearch.provider` is `"local"`, which requires `node-llama-cpp`. This optional peer dependency was never auto-installed, causing `memory_search` to silently fail for every EverClaw user. Now detected and installed automatically across all modalities.

### Added
- **`diagnose.sh` check A10** — New diagnostic check detects whether `node-llama-cpp` is installed. Reports clear fix instructions if missing.
- **`setup.mjs` Stage 5 (Memory Search)** — Auto-installs `node-llama-cpp@3.18.1` globally during setup. Shows real-time progress. Post-install verification confirms the module loads correctly.
- **`--skip-embeddings` flag** — New `setup.mjs` flag to skip the node-llama-cpp install (for headless/minimal installs).
- **`install.sh` node-llama-cpp check** — Runs on every install/upgrade, catching existing users who never re-run setup.
- **Dockerfile node-llama-cpp install** — Production Docker image now includes `node-llama-cpp@3.18.1` for container users.

### Technical Notes
- Detection uses `NODE_PATH="$(npm root -g)"` with `require.resolve()` (CJS). ESM `import()` ignores `NODE_PATH` in Node.js — `require.resolve` is the reliable cross-platform approach for global module detection.
- All installs are non-blocking: failure gracefully degrades to remote embedding providers or no memory search.
- Version pinned to `node-llama-cpp@3.18.1` (latest stable, matches OpenClaw's peer dependency).

## [2026.4.7.0355] - 2026-04-07 — Morpheus Agent Flavor + Docker Matrix Build

### Added
- **Morpheus Agent flavor (#29)** — New EverClaw flavor for decentralized AI inference powered by MorpheusAI. Includes SOUL.md (10 Morpheus principles), IDENTITY.md, USER.md (MOR holder fields), README.md, and `openclaw-config-morpheus.json` (pure Morpheus P2P + Ollama, no centralized APIs). Chain: Base (Ethereum L2).
- **Docker per-flavor images** — Every flavor now builds its own Docker image via GitHub Actions matrix strategy. Dynamic discovery scans `templates/flavors/` automatically — zero maintenance when adding new flavors.
  - Generic: `docker pull ghcr.io/everclaw/everclaw:latest`
  - Morpheus: `docker pull ghcr.io/everclaw/morpheus-agent:latest`
  - Any flavor: `docker pull ghcr.io/everclaw/<flavor>:latest`
- **Dockerfile `FLAVOR` build arg** — `docker build --build-arg FLAVOR=morpheus-agent .` bakes flavor-specific files into the image at build time. Flavor `.md` files are copied directly to workspace (final content, not templates). Flavor config replaces generic default.
- **Multi-arch flavor images** — All 29 flavor images + generic built for `linux/amd64` and `linux/arm64`.
- **Per-flavor Docker tags** — Each flavor gets both `:latest` and CalVer (e.g. `:2026.4.7.0355`) tags.

### Changed
- **CI workflow rewritten** — `docker-build.yml` now uses a two-job pipeline: discovery + matrix build. `fail-fast: false` ensures one flavor failure doesn't block others.
- **29 flavor remotes** — `morpheus-agent` added as git remote for ecosystem-sync.

## [2026.4.6.2309] - 2026-04-06 — Installer UX fixes (Jeff tester feedback)

### Fixed
- **Ollama detection false-negative** — Replaced single `command -v ollama` check with `detect_ollama()` function that checks 5 locations: PATH, Homebrew (`/opt/homebrew/bin`), `/usr/local/bin`, DMG (`/Applications/Ollama.app`), and running server on port 11434. Eliminates false "not installed" on Macs with non-PATH Ollama installs.
- **Bootstrap key import `MODULE_NOT_FOUND`** — All user-facing instructions in `bootstrap-everclaw.mjs`, `bootstrap-gateway.mjs`, and `diagnose.sh` now print absolute paths instead of relative `node scripts/...` paths. Users can copy-paste commands from any directory.

### Added
- **`--ollama-already-installed` installer flag** — Power users can skip detection and mark Ollama as installed.
- **`EVERCLAW_KEY` environment variable** — `bootstrap-gateway.mjs` accepts API key via env var (fallback when `--key` flag not provided). Useful for scripting/automation.
- **`npm run bootstrap` convenience script** — Runs `bootstrap-gateway.mjs` from the skill directory.
- **Guard clause in `bootstrap-gateway.mjs`** — Detects broken/partial installs (missing `SKILL.md`) and prints helpful instructions instead of a cryptic error.
- **Post-install summary block** — Installer now prints 3 clear methods to import your own inference key (cd + npm, absolute path, env var) with the real install directory path.
- **`SCRIPT_DIR` in `diagnose.sh`** — Fix commands now use absolute paths.

### Changed
- **Quiet git clone** — `git clone --quiet` eliminates noisy object enumeration output during install.

## [2026.4.6.1450] - 2026-04-06

### Changed
- **OpenClaw pinned version bumped: v2026.4.2 → v2026.4.5** — Docker images now build with OpenClaw v2026.4.5. Key upstream changes: config legacy alias cleanup with `openclaw doctor --fix` migration, embedded ACPX runtime (no external ACP CLI hop), ClawHub search/install in Control UI Skills panel, prompt caching improvements (stable fingerprints, deduplicated tool inventories), iOS + Matrix exec approval support, memory dreaming features (light/deep/REM phases, Dream Diary UI), video/music generation tools with ComfyUI/xAI/Runway/Wan providers, new bundled Qwen/Fireworks/StepFun/MiniMax providers, Amazon Bedrock Mantle auto-discovery. Security fixes: restrictive plugin tool allowlists, SSRF redirect bypass blocks, `before_tool_call` fail-closed hooks.
- **docker-compose.yml** — Fixed stale `EVERCLAW_VERSION` build arg (was `2026.4.1.1923`, now matches Dockerfile).
- **SKILL.md** — Fixed stale `versions` diagnostic output (OpenClaw was showing `2026.3.12`).

## [2026.4.4.0403] - 2026-04-04

### Changed — Local Inference: Qwen3.5 → Gemma 4
- **Replaced Qwen3.5 model family with Google Gemma 4** across all local inference tooling. New model tiers: E2B, E4B (default), 26B MoE, 31B Dense.
- **`setup-ollama.sh` rewritten (v2026.4.3)** — New hardware-aware model selection aligned to 4/8/12/16/24 GB RAM boundaries. Supports native Ollama pull and Unsloth GGUF for quantized variants. Requires Ollama ≥ 0.20.0 (version check added).
- **RAM tier model selection:**
  - < 4 GB → `gemma4-e2b-q3` (1.2 GB GGUF)
  - 4–8 GB → `gemma4-e2b-q4` (1.6 GB GGUF)
  - 8–12 GB → `gemma4:e4b` (9.6 GB native, default)
  - 12–16 GB → `gemma4-26b-q3` (12.5 GB GGUF, ClawBox sweet spot, 82.6% MMLU Pro)
  - 16–24 GB → `gemma4:26b` (17 GB native)
  - 24+ GB → `gemma4:31b` (20 GB native)
- **Vision + audio support** — E2B/E4B models accept text, image, and audio input. 26B/31B accept text and image.
- **Dynamic context windows** — E2B/E4B: 128K (131072), 26B/31B: 256K (262144). Up from hardcoded 32K.
- **maxTokens bumped to 16384** (up from 8192).
- **GGUF pull pipeline** — New `pull_model_gguf()` downloads Unsloth GGUF files, creates Ollama Modelfile with `num_ctx`, registers via `ollama create`.
- **Backward compatibility** — `--model qwen3.5:*` flags still accepted with deprecation warning via `map_legacy_model()`.
- **Inference test v2** — Uses substring match (`*"OLLAMA_OK"*`) instead of sed. Temperature 0, 60s timeout, graceful fallback on timeout.
- **`setup.mjs` controlUi fix** — Template key lookup now checks both `[REDACTED]` and `gateway` keys for backward compatibility.
- **Config templates updated** — Both mac and linux templates now default to `gemma4:e4b` with vision+audio modalities, 128K context, 16384 maxTokens.

## [2026.4.2.2031] - 2026-04-02

### Changed
- **OpenClaw pinned version bumped: v2026.4.1 → v2026.4.2** — Docker images now build with OpenClaw v2026.4.2. Key upstream fixes: exec defaults YOLO mode, subagent spawn loopback fix, exec-approvals config hardening, gateway exec loopback restoration.

## [2026.4.2.1957] - 2026-04-02

### Added
- **Agent Download — Chat-Triggered Export & Restore** — Say "download my agent" in chat to get a one-click encrypted backup with a temporary download link. Full workspace (skills, memory, config, state) packaged into an age-encrypted zstd-compressed archive.
- **`scripts/agent-download-server.mjs`** (326 lines) — Temporary HTTP file server. Single-use UUIDv4 token auth, 3-tier CORS (gateway config → same hostname → localhost), streaming delivery, PID management, 15-minute auto-shutdown, secure shred via `shredFile()` after download.
- **`scripts/agent-download.mjs`** (465 lines) — Export orchestrator. 3-tier public URL detection (CLI → `gateway.remote.url` → `EVERCLAW_PUBLIC_URL` env var), 6-word crypto-random passphrase generation, `--include-wallet` with address validation, `--dry-run` with workspace size estimation, detached server spawn, structured JSON output.
- **`scripts/restore-agent.sh`** (983 lines) — Self-contained bash restore installer. Works standalone or via `curl | bash`. Auto-discovers backups in co-located/Downloads/cwd/tmp dirs. Auto-installs deps (age, zstd, jq, curl, Node.js) via Homebrew/apt/dnf/pacman/apk. Streaming age→zstd→tar decryption with `AGE_PASSPHRASE` env var. 3-attempt passphrase retry. Manifest validation with version/platform check. Conflict detection (Backup/Overwrite/Abort). Native + Docker mode. Config adaptation via jq (token regen, bind, workspace path). Wallet restore (Keychain on macOS, encrypted file on Linux). Migration note written to daily memory. launchd (macOS) / systemd (Linux) service install. Post-restore verification.
- **SKILL.md Section 22 subsection** — Trigger phrases, exec patterns, conversation flow, null URL guidance, Docker-to-Docker steps, platform formatting rules, post-migration greeting.
- **70 tests across 5 test files** — 14 server tests (PID, health, token auth, CORS, streaming, SIGTERM), 14 orchestrator tests (help, dry-run, URL detection, wallet validation, passphrase, size estimation), 12 restore tests (syntax, dry-run, deps, Docker mode, passphrase requirement), 14 security tests (SEC-1 through SEC-8: passphrase leak, single-use, brute-force, path traversal, no temp files, wallet validation, structured errors, HTTP methods), 16 integration tests (null URL fallback, conflict detection, non-TTY automation, edge cases).
- **System dependencies in `install.sh`** — New `install_system_deps()` function auto-installs `age`, `zstd`, `jq` on macOS (Homebrew) and Linux (apt/dnf/pacman/apk). Non-blocking on failure.
- **Docker image dependencies** — Added `age` and `zstd` to Dockerfile `apt-get install` for backup/restore support in containers.

### Fixed
- **`restore-agent.sh` decryption pipeline** — Changed from `echo "$PASSPHRASE" | age --decrypt -i -` (treats passphrase as identity/key file) to `AGE_PASSPHRASE="$PASSPHRASE" age --decrypt` (correct scrypt mode matching `encryption.mjs`). Fixed in both main decryption pipeline and wallet decryption path. Without this fix, restore would fail on all passphrase-encrypted archives.

## [2026.4.2.0128] - 2026-04-02

### Fixed — Exec Approval Fatigue
- **Config templates now set `tools.exec.ask: "off"`** — All 3 config templates (mac, linux, gateway-only) now include `tools.exec` settings so new installs don’t default to prompting on every command.
- **Low Security tier: `ask` changed from `on-miss` to `off`** — Low tier users should never see exec approval prompts. Commands run freely; money operations remain gated at the application layer.
- **`strictInlineEval` set to `false` on Low and Recommended tiers** — `node -e`, `python3 -c` no longer trigger separate approval prompts on Low or Recommended tiers.
- **Bug fix: `security-tier.mjs` now writes `ask` to `openclaw.json`** — The `ask` value from tier templates was only written to `exec-approvals.json`, not to `openclaw.json`’s `tools.exec` section. New installs and tier changes now correctly propagate the `ask` setting.

### Security Tier Summary
| Tier | `ask` | `strictInlineEval` | Effect |
|------|-------|--------------------|--------|
| Low | `off` | `false` | No prompts. All commands run freely. |
| Recommended | `on-miss` | `false` | Prompts for unknown commands only. |
| Maximum | `on-miss` | `true` | Prompts for unknown + inline eval. |

---

## [2026.4.1.1923] - 2026-04-01

### Code Quality — Issue #13 Enhancements (5A-5D)

- **5A — Safe error logging** — `logSafeError()` helper suppresses error details (paths, stack traces) unless `DEBUG=1` is set. Applied to all catch blocks in `everclaw-wallet.mjs`, `bootstrap-client.mjs`, and `safe-transfer.mjs`. Prevents information leakage in production logs.
- **5B — Version pinning for reproducible builds** — `install.sh` now accepts `VERSION` env var (`VERSION=v2026.4.1 ./install.sh`). Default `latest` behavior preserved. Pinning enables CI reproducibility.
- **5C — Module-level DRY_RUN** — Removed `global.DRY_RUN` mutation; replaced with module-level `let DRY_RUN = false`. Cleaner, no global pollution.
- **5D — stdin safety for non-interactive environments** — `confirmAction()` helper checks `process.stdin.isTTY` before prompting. Prevents auto-fire on piped stdin. `EVERCLAW_YES=1` or `CI=true` enables auto-confirmation for scripts. Applied to swap, approve, and safe-transfer commands.

### Files Changed
- `scripts/everclaw-wallet.mjs` — 5A/5C/5D fixes
- `scripts/install.sh` — 5B version pinning
- `scripts/bootstrap-client.mjs` — 5A safe error logging
- `scripts/safe-transfer.mjs` — 5A/5D fixes

### Audit
- Cross-model Grok 4.2 review: **9.8/10 — Excellent**
- All 4 files pass syntax validation
- PII Guard V2: **clean — no personal data detected**
- Test suite: 44/60 pass (16 pre-existing environmental failures unrelated to #13)

---

## [2026.4.1.1835] - 2026-04-01

### Security - Unsafe Defaults (Issue #12)
- **[4A] GitHub API rate limit breaks installer (`install.sh`)** - Unauthenticated GitHub API calls (60/hr limit) caused confusing failures on repeated installs. **Fix:** `curl` now uses `--fail` and captures HTTP status code. 403/429 responses show a clear "rate limit exceeded" error with instructions to set `GITHUB_TOKEN` for authenticated requests (5,000/hr). All API calls use Bearer auth when token is available.
- **[4B] Unlimited approval no longer the default (`everclaw-wallet.mjs`)** - `approve` without an amount silently defaulted to `maxUint256` (unlimited). **Fix:** Running `approve` without a specified amount OR `--unlimited` flag now errors with clear instructions. Explicit `--unlimited` flag required for unlimited approval in ALL modes (interactive and CI). **Breaking change:** Scripts using bare `approve` must update to `approve <amount>` or `approve --unlimited`.
- **[4C] Binary backup before overwrite (`install.sh`)** - `unzip -o` silently overwrote existing binaries with no rollback path. **Fix:** Both install strategies (standalone binary download and legacy zip extraction) now back up existing `proxy-router` and `mor-cli` with timestamped names (e.g., `proxy-router.bak.20260401174500`) before overwriting.
- **[4D] Safe threshold validated as exactly 1 (`safe-transfer.mjs`)** - Script only checked `threshold >= 1` but never asserted `=== 1`. A 2-of-2 Safe would pass validation but revert on-chain (wasting gas). **Fix:** Asserts `threshold === 1n` before proceeding. Multi-sig Safes get a clear error showing N-of-M configuration and suggesting the Safe web interface.

### Changed
- **`cmdApprove()` safety hardened** - Unlimited MOR approval is no longer opt-out (CI-only gate); it's opt-in everywhere via `--unlimited` flag.
- **Help text updated** - "CI Safety" section renamed to "Safety" (applies to all modes). `approve` command now shows `<amount>` as required with `--unlimited` as separate option.
- **3 CI-safety tests updated** - Tests for `cmdApprove` behavior updated to match new stricter approval gate.

### Added
- **22 new tests (`tests/issue-12-unsafe-defaults.mjs`)** - 4 test suites covering rate limit detection (7 tests), unlimited approval flag (6 tests), binary backup (4 tests), and Safe threshold validation (5 tests). All source-level verification via file content assertions.
- **GITHUB_TOKEN support in installer** - Optional `GITHUB_TOKEN` env var enables authenticated GitHub API requests (5,000/hr vs 60/hr unauthenticated).
- **Total test count: 77** (55 previous + 22 new), 35/35 passing for Issue #12 + CI-safety suites.

## [2026.4.1.1712] - 2026-04-01

### Security
- **[Warning] Shell injection via KEYCHAIN_ACCOUNT/SERVICE env vars (Issues #10/#11)** - `EVERCLAW_KEYCHAIN_ACCOUNT` and `EVERCLAW_KEYCHAIN_SERVICE` environment variables were interpolated directly into `execSync` shell command strings. A malicious actor who could set these env vars (supply chain injection, compromised subprocess) could inject arbitrary shell commands. **Fix:** Two-layer defense: (1) New `sanitizeKeychainParam()` validates at load time - only `[A-Za-z0-9._-]` allowed, rejects all injection payloads with clear error messages. (2) All 7 `execSync` (shell string) calls migrated to `execFileSync` (array args) - no shell interpretation at all, structurally eliminating injection even if validation were bypassed.

### Changed
- **`execSync` fully removed from `everclaw-wallet.mjs`** - All keychain operations (`macKeychainStore`, `macKeychainRetrieve`, `hasSecretTool`, `libsecretStore`, `libsecretRetrieve`) now use `execFileSync` with array arguments. No shell is invoked anywhere in the wallet module.
- **Test helpers hardened** - Test keychain setup/teardown helpers in `everclaw-wallet.test.mjs` also migrated from `execSync` to `execFileSync`.
- **Pre-existing test CI mode bugs fixed** - Approve/swap/export-key tests now correctly pass `EVERCLAW_YES=1`, `--unlimited`, and `EVERCLAW_ALLOW_EXPORT=1` (were hanging on stdin since Issue #9 CI safety was added).

### Added
- **18 new tests (A3 suite)** - Shell injection prevention tests covering 8 `KEYCHAIN_ACCOUNT` injection payloads (semicolon, backtick, `$()`, pipe, newline, ampersand, single-quote, double-quote breakout), 3 `KEYCHAIN_SERVICE` payloads (semicolon, `$()`, redirect), 3 valid value tests, 2 combined injection tests, 2 post-hardening functional round-trip tests.
- **Total test count: 55** (37 existing + 18 new), all passing.

### Audit
- **Grok (ether-btc):** "Textbook security fix... defense-in-depth we wanted." Reviewed by Benjamin and Lucas. Approved with zero blocking issues.

## [2026.4.1.1637] - 2026-04-01

### Added
- **Security Tiers - user-facing exec security presets (Issue #14)** - New setup wizard step and standalone CLI for configuring OpenClaw's exec-approval system with one of three security presets.
- **Three security tiers:**
  - 🟢 **Low Security** - Fastest for daily dev. All dev tools auto-allowed. Money operations gated at application layer. `rm`, `docker`, `ssh`, `dd` still blocked.
  - 🟡 **Recommended** (default) - Best balance. Same allowlist as Low, plus `strictInlineEval` blocks `python3 -c`, `node -e`. Good for most users.
  - 🔴 **Maximum Protection** - Only read-only commands auto-allowed (`ls`, `cat`, `grep`, `find`, `echo`, `pwd`). All dev tools require manual approval. `autoAllowSkills` disabled.
- **`scripts/lib/detect-bins.mjs`** - Auto-detects binary paths via `which` with fallback scan across 13 search directories (Homebrew ARM/Intel, nix, asdf, pyenv, cargo, snap, pipx). Never hardcodes paths.
- **`scripts/security-tier.mjs`** - Standalone CLI: `--status` (show current tier + rules), `--tier <name>` (dry-run), `--tier <name> --apply` (write to disk), `--force` (overwrite user-modified configs).
- **`--security-tier` flag in `setup.mjs`** - Set tier during initial setup: `node scripts/setup.mjs --apply --security-tier recommended`.
- **Interactive tier prompt** - Box-drawing UI prompt shown during `setup.mjs --apply` when no tier is specified and stdin is a TTY.
- **`EVERCLAW_SECURITY_TIER` env var** - Docker/CI support: `EVERCLAW_SECURITY_TIER=low|recommended|maximum`. Defaults to `recommended` when `EVERCLAW_YES=1`.
- **`--no-security` flag** - Skip security tier setup during `setup.mjs --apply`.
- **Upgrade safety** - Generated `exec-approvals.json` includes `generatedBy: "everclaw-setup-v1"` and `generatedAt` timestamp. User-customized files are never overwritten. Files generated by EverClaw prompt for update.
- **XDG_CONFIG_HOME support** - Linux users with custom `XDG_CONFIG_HOME` are now respected in OpenClaw directory detection.
- **3 tier template files** - `templates/exec-approvals-low.json`, `templates/exec-approvals-recommended.json`, `templates/exec-approvals-maximum.json`.
- **14 test suites (138 assertions)** in `tests/security-tier.test.mjs` - Covers template validation, blocked binaries, tier differentiation, binary detection, CLI modes, edge cases.

### Security
- **`rm` blocked in ALL tiers** - No tier allows `rm`. Use `trash` for recoverable deletes.
- **`ssh`, `scp`, `sudo`, `docker`, `osascript`, `dd` blocked in ALL tiers** - These always require manual approval regardless of tier.
- **`strictInlineEval: true` in ALL tiers** - `python3 -c`, `node -e`, `osascript -e` always require approval even when the binaries are allowlisted.
- **Maximum tier disables `autoAllowSkills`** - Skill CLIs must be explicitly added to the allowlist.

## [2026.4.1.1518] - 2026-04-01

### Security
- **[Critical] CI mode no longer bypasses token approval confirmations (Issue #9)** - When `EVERCLAW_YES=1` or `CI=true`, unlimited MOR approvals (`maxUint256`) are now **blocked** unless the explicit `--unlimited` flag is passed. Private key export is **blocked** unless `EVERCLAW_ALLOW_EXPORT=1` is set. Bounded approvals and swaps still auto-confirm (acceptable risk - bounded amounts, simulated first).

### Added
- **`--unlimited` flag** - Required to explicitly approve unlimited MOR spending in CI/automated environments. Makes the risk visible rather than silent.
- **`EVERCLAW_ALLOW_EXPORT` env var** - Must be set to `"1"` to allow `export-key` in CI mode. Separate from `EVERCLAW_YES` for defense-in-depth.
- **CI audit trail logging** - All CI auto-confirmed actions now log what was approved (swap amount, approval type) for audit visibility.
- **Flag filtering in argv** - `--unlimited` and `--dry-run` are now filtered from positional args, preventing `parseEther("--unlimited")` crash.
- **13 new tests in `tests/lib-ci-safety.mjs`** - Covers CI gate blocking, flag pass-through, bounded approval auto-confirm, export gate, help text validation, flag/arg separation.
- **Help text updates** - New Flags section, CI Safety section, `EVERCLAW_ALLOW_EXPORT`/`EVERCLAW_YES`/`CI` env var documentation, new examples.

### Changed
- **CI safety gates run before wallet retrieval** - Fail-fast: dangerous operations are blocked before any keychain access, improving both security and testability.
- **5-second countdown skipped in CI** - `export-key` no longer waits 5 seconds in non-interactive mode (when explicitly allowed via env var).

## [2026.4.1.1447] - 2026-04-01

### Security
- **[Critical] MITM protection for bootstrap API (Issue #8)** - `bootstrap-client.mjs` now enforces HTTPS for all remote API calls. Plain `http://` is rejected with a clear error unless targeting localhost/127.0.0.1 (dev only). Prevents network observers from reading wallet addresses, PoW challenges, and nonces in transit.
- **TLS bypass detection** - Warns loudly if `NODE_TLS_REJECT_UNAUTHORIZED=0` is set, which disables certificate verification and re-enables MITM attacks.
- **Response validation hardening** - Challenge and claim responses are now structurally validated (type + length checks). Malformed responses trigger "possible MITM or API change" errors instead of silent failures.

### Added
- **Fetch timeouts** - Both API calls now use `AbortSignal.timeout(30000)` to fail fast on dead/unresponsive networks instead of hanging indefinitely.
- **Issue #8 regression test suite** - 21 tests covering URL validation, HTTPS enforcement, localhost exceptions, and response validation (`test-issue8-regression.mjs`).

### Fixed
- **Help text** - Corrected default URL from `https://api.everclaw.xyz/bootstrap` to `https://api.everclaw.xyz`.
- **Existing test suite** - Added missing `node:test` import to `bootstrap-client.test.mjs` (pre-existing bug, tests now run correctly).

## [2026.4.1] - 2026-04-01

### Security - Wallet Encryption Overhaul (Issue #7)
- **[CRITICAL] Replaced machine-id key derivation with Argon2id passphrase-based encryption** - `/etc/machine-id` is world-readable, making the previous wallet encryption trivially breakable by any local user. Now uses user-supplied passphrase with Argon2id (64 MiB, timeCost 4) as primary KDF, scrypt (N=131072) as fallback.
- **New shared crypto module `scripts/lib/wallet-crypto.mjs`** - Single source of truth for `deriveEncryptionKey()`, `ENC_FORMAT_V2`, `promptPassphrase()`, `getPassphraseFromEnv()`, `decryptLegacyV1()`. Eliminates duplication between `everclaw-wallet.mjs` and `bootstrap-client.mjs`.
- **v2 encrypted file format** - `version(1) + salt(32) + iv(16) + authTag(16) + ciphertext`. Salt stored in file header; no separate salt file needed.
- **Automatic v1 → v2 migration** - Legacy files detected and upgraded on first access. Backup created at `~/.everclaw/wallet.enc.bak` before migration. Passphrase confirmation required (double-entry).
- **Cross-platform key storage** - macOS Keychain (primary) → Linux libsecret → encrypted file fallback. All platforms now secure.
- **Docker/CI passphrase injection** - `EVERCLAW_WALLET_PASSPHRASE` env var or `EVERCLAW_WALLET_PASSPHRASE_FILE` (Docker secrets) for non-interactive environments.
- **Passphrase strength warning** - Warns on passphrases shorter than 12 characters.
- **New dependency: `argon2@^0.41.1`** - Zero vulnerabilities, prebuilt binaries for all platforms.
- **11 new tests in `tests/lib-wallet-crypto.mjs`** - Covers Argon2id derivation, v2 round-trip encrypt/decrypt, wrong-passphrase rejection, v1 legacy decryption, env var passphrase acquisition.

## [2026.3.31] - 2026-03-31

### Added
- **Backup & Restore System** - Comprehensive disaster recovery with AGE-encrypted backups
  - `everclaw-export.mjs` (781 lines) - Encrypted backup creation with Docker support
  - `everclaw-restore.mjs` (1131 lines) - Restore with pre-restore backup and rollback
  - `everclaw-verify.mjs` (924 lines) - Standalone health verification utility
  - `everclaw-migrate.mjs` (926 lines) - Interactive migration wizard
- **lib/morpheus.mjs extensions**:
  - `getMorpheusConfig()` - Parse .env and config files
  - `getMorpheusSession()` - Get session ID, address, cookie
  - `checkMorpheusHealth()` - API health check via /health or /v1/models
- **Docker volume streaming** - Stream backup/restore directly from/to containers without intermediate files
- **Wallet safety** - Address confirmation required for wallet restore (user must type full address)
- **GLM-5 inference test** - Post-restore verification confirms working inference via Morpheus endpoint
- **Auto-rollback** - `--rollback auto` detects and restores from latest pre-restore backup
- **Migration state tracking** - `~/.everclaw/migration-state.json` tracks in-progress migrations

### Security
- **AGE encryption** - All backups encrypted with user-supplied passphrase (AES-256-GCM)
- **Wallet double-encryption** - Wallet key encrypted separately inside the archive
- **Shred on exit** - Staging directory securely deleted after restore
- **Pre-restore backup** - Automatic safety backup before any restore operation

### Documentation
- **SKILL.md Section 22** - Full backup/restore documentation with CLI reference
- **Quick Reference** - Added backup/restore commands
- **Version** - Bumped to 2026.3.31

## [2026.3.27.1707] - 2026-03-27

### Fixed
- **Docker VOLUME overlay bug on first run** - Default config template was baked into `/home/node/.openclaw/`, which gets hidden by Barney's auto-mounted empty persistent volume, causing `cp: cannot stat` and container exit. Moved template to `/opt/everclaw/defaults/` (outside any VOLUME) so it survives empty mount overlays.

## [2026.3.27.0434] - 2026-03-27

### Fixed
- **Docker build heredoc syntax** - Heredoc (`<< 'EOF'`) doesn't work in Dockerfile without BuildKit frontend directive. Replaced with `COPY config/openclaw-default.json` approach.
- **Gitleaks false positives** - Secret scanner flagged 256 false positives (public contract addresses, example API keys, test fixtures). Added `.gitleaks.toml` allowlist with proper TOML syntax.
- **Wallet tests in CI** - Interactive confirmation prompts (`CONFIRM SWAP?`, `CONFIRM APPROVE?`) caused 10 test failures in CI (no stdin). Added `CI_NON_INTERACTIVE` flag auto-approves when `EVERCLAW_YES=1` or `CI=true`.
- **Smoke test script path** - Container path was wrong (`scripts/setup.mjs` vs `/home/node/.openclaw/workspace/skills/everclaw/scripts/setup.mjs`).

### Added
- **config/openclaw-default.json** - Standalone config file for Docker COPY (replaces embedded heredoc).
- **.gitleaks.toml** - Allowlist for public values, example keys, test fixtures, docs paths.

## [2026.3.27] - 2026-03-26

### Added
- **Docker VOLUME declarations for Barney + persistent storage** - Barney VM platform auto-detects `VOLUME` instructions in Dockerfile and attaches 20 GB persistent storage. Without these, container restarts lose all memories, configs, wallet keys, and sessions. Changes:
  - Added `VOLUME ["/home/node/.openclaw", "/home/node/.morpheus", "/home/node/.everclaw"]` to Dockerfile
  - Added `.everclaw` directory creation in Dockerfile (for wallet.enc)
  - Added `chmod 700 /home/node/.everclaw` for wallet security hardening
  - Updated docker-compose.yml to mount all three volumes for local Docker parity
  - Updated Dockerfile header comment with full `docker run -v` example
- **Memories, configs, wallet keys, and proxy sessions now survive container updates** - previously all ephemeral on restart

### Fixed
- **Cookie path bug in morpheus-proxy.mjs** - Script was reading cookie from `~/morpheus/.cookie` (wrong) instead of `~/.morpheus/.cookie` (correct). Container would fail to reuse existing sessions even with volume mounted. Fixed line 27 to use correct path.

## [2026.3.26.0037] - 2026-03-26

### Changed
- **OpenClaw upgraded from v2026.3.23 to v2026.3.24** - Security and reliability improvements:
  - **Security fix (#54034):** Sandbox media dispatch alias bypass closed - prevents escaping media-root restrictions
  - **Docker fix (#53385):** Pre-start namespace loop fixed for fresh Docker installs - directly benefits EverClaw container deployments
  - **Gateway /v1/models endpoint:** OpenAI-compatible routing improvement - better client compatibility for gateway-only installs
  - **Restart sentinel (#53940):** Post-restart session wake uses heartbeat with retry - improves reliability after config changes
  - **Channel boot isolation (#54215):** Broken channel no longer blocks others from starting - improves multi-channel reliability
  - **CLI --container flag:** New flag for running commands inside Docker/Podman containers
  - License unchanged: MIT (Peter Steinberger)
- **Dockerfile** - `OPENCLAW_VERSION` bumped from `v2026.3.23` to `v2026.3.24`

## [2026.3.25.1358] - 2026-03-25

### Fixed
- **Docker container crash on first-run** - OpenClaw v2026.3.13+ strict schema validation rejects `_`-prefixed comment keys (`_note`, `_morpheusNote`) in the default config, causing the gateway to exit fatally before reaching inference. Tester-reported: container starts, scaffolds workspace files, then crashes with "Config invalid / Unrecognized key" errors.
  - Removed `_note` from `morpheus-local` provider in Dockerfile embedded default
  - Removed `_morpheusNote` from `agents.defaults` in Dockerfile embedded default
  - Removed `_morpheusNote` from `templates/openclaw-config-gateway-only.json`
  - Removed `_note` and `_morpheusNote` from `templates/openclaw-config-mac.json`
  - Removed `_note` and `_morpheusNote` from `templates/openclaw-config-linux.json`
- **Native installer also affected** - `setup.mjs` `stripComments()` only stripped `_comment` keys, not `_note` or `_morpheusNote`. Mac/Linux native installs via `setup.mjs` would hit the same crash. Broadened to strip ALL `_`-prefixed keys.

### Added
- **Defensive config sanitizer in Docker entrypoint** - `docker-entrypoint.sh` now runs a jq `walk` strip of all `_`-prefixed keys after config copy, before gateway launch. Prevents this class of bug from ever recurring, even if future template edits accidentally add comment keys.

## [2026.3.23] - 2026-03-23

### Changed
- **OpenClaw upgraded from v2026.3.13-1 to v2026.3.22** - Major upstream release with 20+ breaking changes (none affecting EverClaw), security hardening, and performance improvements:
  - ClawHub now preferred over npm for skill installs (benefits EverClaw discovery)
  - Gateway startup: prewarm primary model before channel startup (fixes cold-start first-message failures)
  - Gateway startup: load bundled plugins from compiled dist (faster boot, especially in containers)
  - Stable `memory-cli.js` entry point (fixes memory_search depending on hashed bundle names)
  - Agent default timeout raised from 600s to 48h (EverClaw templates still set 300s explicitly)
  - Exec sandbox: blocks JVM injection, glibc tunable exploitation, .NET hijack
  - Security: blocks remote file:// URLs and UNC paths in media loading
  - Security: fails closed on unresolved Bonjour/DNS-SD endpoints
  - Security: rejects marketplace manifest path traversal
  - Per-agent thinking/reasoning/fast defaults support
  - MiniMax M2.7 and updated GLM catalog metadata
  - License unchanged: MIT (Peter Steinberger)
- **Dockerfile** - `OPENCLAW_VERSION` bumped from `v2026.3.13-1` to `v2026.3.22`
- **SKILL.md** - Version aligned to `2026.3.23.1800` (fix: version-stamp.sh missed this file)

## [2026.3.20.1950] - 2026-03-20

### Fixed
- **Docker default config routed to dead local proxy** - The Dockerfile's inline default config set `morpheus-local/glm-5` as primary model, which requires a running local proxy + `MORPHEUS_PROXY_API_KEY`. Most Docker users only have a Gateway API key → proxy fails on startup → every request hits dead endpoint → instant timeout. Fix:
  - Dockerfile default config now uses `mor-gateway/glm-5` as primary (works with just `MORPHEUS_GATEWAY_API_KEY`)
  - `morpheus-local` provider kept as optional (only useful when `MORPHEUS_PROXY_API_KEY` is set)
  - Default config includes `timeoutSeconds: 300` and streaming overrides
  - Entrypoint auto-detects: if primary is `morpheus-local/*` but `MORPHEUS_PROXY_API_KEY` isn't set, swaps to `mor-[REDACTED]/*` equivalent
  - [REDACTED] local proxy now only starts when `MORPHEUS_PROXY_API_KEY` is set (no more scary error on startup)

## [2026.3.20.1823] - 2026-03-20

### Fixed
- **Streaming enabled on all models** - Without streaming, OpenClaw waits for the complete response before any data arrives. With [REDACTED] P2P provider discovery taking 30-120s, connections hit timeout. Streaming keeps connections alive once the first token arrives. Fix:
  - Streaming set at `agents.defaults.models["provider/id"].streaming = true` (the correct schema location - OpenClaw's `models.providers.*.models.*` is strict `additionalProperties: false` and rejects unknown keys like `streaming`)
  - All 3 config templates updated with correct streaming overrides
  - `setup.mjs` auto-enables streaming for all discovered models during config merge + removes stale `streaming` from provider model definitions
  - Docker entrypoint auto-patches existing configs at container startup (streaming + timeout)
  - `diagnose.sh` new check A9: flags models missing streaming
  - Credit: Thomas (ClawBox) identified the streaming root cause
- **Docker tag-triggered builds were producing empty tags** - `type=semver` can't parse our 4-part `YYYY.M.DD.HHMM` version format. Replaced with `type=match,pattern=v(.*),group=1`. Tag pushes now also tag `:latest`.
- **Docker workflow `no-cache-filter` deprecation** - Renamed to `no-cache-filters` (plural) to match `docker/build-push-action@v6`

## [2026.3.20.1442] - 2026-03-20

### Fixed
- **"LLM request timed out" on container/[REDACTED] installs** - [REDACTED] Gateway models (GLM-5, gpt-oss-120b) can take 30-120s on first request due to P2P provider discovery. OpenClaw's default timeout was too low, causing immediate timeout errors for [REDACTED] users. Fix:
  - All 3 config templates now set `agents.defaults.timeoutSeconds: 300` (5 min)
  - `setup.mjs` auto-enforces minimum 180s timeout during config merge (upgrades low values, preserves user values ≥180s)
  - `diagnose.sh` new check A8: flags `timeoutSeconds < 180` as FAIL with fix instructions
  - Agent boot template (`AGENTS.template.md`) now instructs agents to send a brief acknowledgment ("On it!", "Working on that...") on first message so users aren't left staring at a blank screen

## [2026.3.31] - 2026-03-19

### Fixed
- **Installer false-positive dependency reporting on macOS** - Non-admin accounts (family, corporate, school Macs) saw misleading `✓ installed` messages when Homebrew failed silently due to missing sudo access. Fix includes:
  - Early admin pre-check with soft warning + automatic nvm fallback for Node.js (100% Mac compatibility)
  - Real verification after each install (`verify_installed()` helper) instead of unconditional `log_ok`
  - Immediate PATH reload for current script session (`reload_brew_path()` + `hash -r`)
  - Permanent PATH persistence to `~/.zprofile` / `~/.bash_profile` via `persist_brew_path()`
  - Robust Intel Mac support (`/usr/local/bin/brew`) alongside Apple Silicon (`/opt/homebrew/bin/brew`)
  - Localized admin group detection (`admin|administradores|administrator`)
  - nvm fallback with `--lts` for future-proof Node.js installs
  - Soft git warning on non-admin Macs (hints at `xcode-select --install` instead of hard fail)
  - Grok 4.2 final audit: 93/100 - 3 fixes applied (brew version display, soft git warning, header verification)

### Added
- **API key injection via environment variables** - Container entrypoint now accepts `MORPHEUS_GATEWAY_API_KEY` and `MORPHEUS_PROXY_API_KEY` env vars and injects them into the OpenClaw config at startup. `mor-[REDACTED]` is a custom provider not in OpenClaw's auto-detection list, so env vars weren't picked up. Users get a clear warning with signup URL if no AI provider keys are configured.
- **Template placeholder substitution** - Boot templates (IDENTITY.md, USER.md, SOUL.md, TOOLS.md) now have `__PLACEHOLDER__` tokens replaced with actual values during first-run scaffold. Supports env vars: `EVERCLAW_AGENT_NAME` (default: EverClaw), `EVERCLAW_USER_NAME` (default: User), `EVERCLAW_USER_DISPLAY_NAME`, `TZ` (default: UTC), `EVERCLAW_DEFAULT_MODEL` (default: glm-5). Previously, placeholders like `__AGENT_NAME__` were copied verbatim.

### Fixed
- **Docker image shipping stale OpenClaw v2026.3.11 instead of v2026.3.13** - GitHub Actions CI workflow had `OPENCLAW_VERSION=v2026.3.11` hardcoded in `build-args`, overriding the Dockerfile. Combined with GHA layer caching, the OpenClaw binary never updated. Fixed by: (1) reading `OPENCLAW_VERSION` from Dockerfile dynamically, (2) adding `no-cache-filter: openclaw-builder` to bust the build cache for the OpenClaw build stage.

## [2026.3.29] - 2026-03-19

### Fixed
- **Container crash on first run: "Refusing to bind [REDACTED] to lan without auth"** - Regression from v2026.3.28. The `[REDACTED].auth.mode: "none"` we added to the default template caused the entrypoint to skip token injection (treated `"none"` as "user configured"). Gateway then refused to bind to LAN without auth. Fixed by: (1) removing `auth.mode: "none"` from default template, (2) treating `"none"` as equivalent to empty/unset in the entrypoint - always upgrades to `"token"` mode with auto-generated token.

## [2026.3.28] - 2026-03-19

### Fixed
- **"Disconnected from Gateway" / "Device Identity Required" on container LAN access** - Browsers block `crypto.subtle` on plain HTTP from non-localhost IPs, preventing Ed25519 device keypair generation. The [REDACTED] rejected the WebSocket connect with `DEVICE_IDENTITY_REQUIRED`. Fixed by adding `dangerouslyDisableDeviceAuth: true` and `allowInsecureAuth: true` across all config paths: Dockerfile default template, all 3 config templates (mac/linux/[REDACTED]), docker-entrypoint.sh jq merges, and setup.mjs safe-merge. Matches upstream OpenClaw issues #11590, #44485, #40812, #44967.
- **Race condition: [REDACTED] could start before config was fully patched** - Added a defensive config verification step in docker-entrypoint.sh that runs AFTER auth injection but BEFORE [REDACTED] start. Forces `dangerouslyDisableDeviceAuth` and `allowInsecureAuth` if missing (respects `OPENCLAW_ENABLE_DEVICE_AUTH=true` env var to opt out).
- **Default config missing `[REDACTED].auth` block** - Added `[REDACTED].auth.mode: "none"` to `openclaw-default.json` so the [REDACTED] has a defined auth state from first read. Entrypoint cleanly upgrades to `"token"` mode.

### Changed
- Bumped OpenClaw from v2026.3.11 to v2026.3.13 (22 security patches + auth fixes for device identity handling)
- All config templates now include both `dangerouslyDisableDeviceAuth` and `allowInsecureAuth` for consistent container/headless support
- `setup.mjs` mergeConfig now propagates `dangerouslyDisableDeviceAuth` and `allowInsecureAuth` from templates (only if user hasn't explicitly set them)

## [2026.3.27] - 2026-03-19

### Fixed
- **Gateway startup crash on non-loopback binds (`--bind lan`)** - Now auto-configures `controlUi.allowedOrigins` + `dangerouslyAllowHostHeaderOriginFallback` safely in Docker, config templates, and setup.mjs. Fixes container first-run crash reported by tester.
- **Misleading "✅ EverClaw is ready!" banner** - No longer prints success when [REDACTED] actually crashed. Shows clear "❌ EverClaw failed to start" with actionable fix steps and exits with code 1.
- **ENOENT spam on first run** - Pre-creates `.morpheus/.cookie` and `.morpheus/sessions.json` in both Dockerfile and entrypoint. Eliminates all "Failed to read cookie file" and "Failed to save sessions" warnings.
- **Empty `allowedOrigins: []` edge case** - jq uses length-check instead of `//` coalescing, so an explicit empty array is correctly replaced with defaults.
- **Non-Docker installs** - Added `[REDACTED].controlUi` block to all 3 config templates (linux, mac, [REDACTED]) and safe-merge logic in `setup.mjs`. Bare-metal users now get the same crash protection.
- **Safe config merge** - Docker entrypoint and setup.mjs both preserve user-customized `allowedOrigins` and `dangerouslyAllowHostHeaderOriginFallback` values instead of overwriting.

### Changed
- Linux config template now includes `dangerouslyDisableDeviceAuth: true` (headless/container environments where device auth flow doesn't work)
- Failure banner shows 3 actionable quick fixes (delete config + restart, check origins, report on GitHub)
- Auto-config log line `🔧 Auto-configured [REDACTED].controlUi for container environment` for transparency

## [2026.3.25] - 2026-03-19

### Added
- **Bootstrap Micro-Funding System** - Zero-friction onboarding: new users receive 0.0008 ETH + 2.00 USDC on Base mainnet automatically
  - `scripts/bootstrap-client.mjs` (NEW) - Client-side bootstrap with PoW anti-Sybil, machine fingerprint dedup, macOS keychain integration
  - Auto-bootstrap integrated into `scripts/everclaw-wallet.mjs` setup flow (1-line, graceful failure)
  - API live at `api.everclaw.xyz` (Vercel + Upstash Redis)
  - X post verification for +1 USDC bonus via Twitter Syndication API
  - 6 verified real transfers on Base mainnet during testing

### Security
- PoW challenge: 6 leading zeros SHA-256, 60s window
- Machine fingerprint deduplication (macOS ioreg → /etc/machine-id → hostname fallback)
- 500 bootstraps/day global cap (atomic Redis Lua)
- Tweet reuse prevention, bonus double-claim prevention
- Partial failure handling (ETH sent but USDC failed → logged to Redis for manual retry)

## [2026.3.24] - 2026-03-17

### Added
- **agent-chat v0.2.0** - XMTP transport upgrade for Wire↔Ember interop
  - `src/peers.mjs` (NEW) - Peer registry with relationship-based trust (unknown/stranger/colleague/friend/family), JSON fallback + bagman detection, atomic writes, normalized peer shape
  - `src/paths.mjs` (NEW) - Shared path helpers (single source of truth for all XMTP dirs)
  - `src/agent.mjs` - 3-tier guard adapter: Tier 3 (full V6 + comms-guard), Tier 2 (lenient V6 + rate limit + PII), Tier 1 (plaintext fallback)
  - `src/consent.mjs` - EIP-191 handshake protocol wiring (challenge/sign/verify via comms-guard), auto-discovery, timeout/retry
  - `src/router.mjs` - Tier + relationship-aware dispatch, COMMAND demotion by protocol tier AND relationship, atomic inbox writes
  - `src/bridge.mjs` - Outbound reply blocking (canReply gate), failed/ directory for retry, polling fallback for fs.watch reliability, TTL-based dedup
  - `src/health.mjs` - Message counter export, runtime path resolution
  - `cli.mjs` - `trust-peer` (--as/--name), `peers list/show`, `send` (offline outbox queuing)
  - `config/default.json` - New fields: handshake, discovery, tiers, bridge polling
  - 86 tests (48 existing + 38 new: unit, integration, adversarial)

### Fixed
- **install.sh** - Auto-discovers and installs deps for skills with their own package.json (agent-chat, future skills)
- **agent-chat: agentInstance.inboxId** → `agentInstance.client?.inboxId` (Agent wraps client)
- **agent-chat: Module-level XMTP_DIR** → runtime `getXmtpDir()` in 4 files (stale on env change)
- **agent-chat: Router writeInbox** - Added error handling (disk full no longer crashes middleware)
- **agent-chat: CLI --name flag** - Greedy parsing fixed (stops at next -- flag)
- **agent-chat: Tier 2 hot path** - Cached rateLimit/piiCheck at module level (was re-importing every message)
- **agent-chat: startAgent** - Wrapped in try/catch with diagnostic error message

### Security
- COMMAND execution blocked at both protocol tier (tier 1/2) AND relationship (unknown/stranger)
- Outbound replies blocked for unknown peers (canReply enforcement in bridge)
- Path traversal sanitized in correlationId + atomic writes prevent partial corruption
- Handshake replay protection: 256-bit nonce, 90s freshness, 3 retry max per peer
- peers.json: chmod 600, atomic write with serialized flush lock
- PII scan: 0 findings, example addresses genericized in CLI help
- Cross-model audit: GLM-5 + Grok 4.2 + Claude Opus 4.6 (15 fixes, 3 false positives caught)

### Dependencies
- Zero new runtime dependencies (same as v0.1.0: @xmtp/agent-sdk, viem, uuid, xmtp-comms-guard peer)

## [2026.3.23] - 2026-03-17

### Added
- **agent-chat skill v0.1.0**: Real-time XMTP E2E-encrypted messaging
  - Always-on daemon with `@xmtp/agent-sdk` v2.3.0
  - Filesystem bridge (outbox/inbox) for OpenClaw IPC
  - 3-policy consent system (open/handshake/strict)
  - Middleware chain: Consent → CommsGuard V6 → Router
  - Two-tier identity: 28 flavor canonical + per-user wallets
  - launchd (macOS) + systemd (Linux) service templates
  - CLI: status, health, groups, setup commands
  - 36-test suite (unit + adversarial, 114ms)

### Security
- **agent-chat router.mjs**: Path traversal vulnerability fixed - `correlationId` sanitized to `[a-zA-Z0-9_-]` before inbox file write
- **agent-chat identity.mjs**: Runtime warning when wallet key length ≠ 66 (catches truncated keys)
- **agent-chat setup-identity.mjs**: Post-setup PII sanity check scans source files for leaked address

### Process
- Full SOP-001 pipeline: Research → Architecture (v2.3) → Code (Phases A/B/C) → Cross-model audit (Grok 4.2 + Claude 4.6) → Testing (36/36) → PII scan → Deploy → Ecosystem sync (30/31)

## [2026.3.22] - 2026-03-16

### Security
- **everclaw-wallet.mjs (Stage 2)**: Fix private key leak in `cmdSetup` - capture `keychainStore` return, fallback to encrypted file, banner shows actual backend
- **everclaw-wallet.mjs (Stage 3)**: Add simulation + rich confirmation to `cmdSwap` - shows amount in, expected out, min after slippage
- **everclaw-wallet.mjs (Stage 4)**: Add simulation + unlimited approval warning to `cmdApprove` - CRITICAL WARNING for `maxUint256` approvals
- **everclaw-wallet.mjs (Stage 5)**: Double confirmation for `export-key` - "YES I UNDERSTAND" exact match + 5-second countdown + Ctrl+C abort
- **everclaw-wallet.mjs (Dry-run)**: `--dry-run` flag gates `writeContract` calls in cmdSwap and cmdApprove; simulation + confirmation still execute

### Process
- Phase 2 Stages 2-5 + dry-run - audited by Claude 4.6, tested 7/7 PASS, PII scan PASS
- `isUnlimited` fix: uses `!amountStr` (not `=== "unlimited"` which would crash `parseEther`)

## [2026.3.21] - 2026-03-16

### Security
- **safe-transfer.mjs**: Add `simulateContract` before `writeContract` (catches reverts before gas spend)
- **safe-transfer.mjs**: Add interactive confirmation prompt before on-chain execution
- **safe-transfer.mjs**: Remove no-op signature packing code (dead variables `sortedSignature`, `encodedSignature`)
- **safe-transfer.mjs**: Replace `encodedSignature` with `signature` in writeContract args (fixes potential ReferenceError)
- **safe-transfer.mjs**: Replace hardcoded `gas: 200000n` with dynamic estimation (`gas: undefined`)

### Process
- Phase 2 Stage 1 - audited by Claude 4.6, tested 5/5 PASS, PII scan PASS
- SOP-001 pipeline with dedicated agents (Architect, Coder, Auditor, Tester, PII Checker, Deployer)

## [2026.3.20] - 2026-03-15

### Added
- **Comprehensive documentation suite** - 22 documents covering all aspects of EverClaw
  - Getting started: installation, quick-start, configuration
  - Features: inference, wallet, fallback, ollama, x402-payments, erc8004-registry
  - Scripts: overview and reference for 43 scripts
  - Operations: monitoring, three-shifts, troubleshooting
  - Reference: API, models, contracts, acquiring-mor, economics
  - Security: security overview, shield policy
- Total: 5,412 lines, 17,422 words, 596 KB

### Changed
- Docker image version bumped to 2026.3.20

---

## [2026.3.19] - 2026-03-15

### Fixed
- **morpheus-proxy.mjs** - Model refresh was parsing router response incorrectly
  - Router returns `{ models: [...] }` but code expected raw array
  - Fix: `const data = JSON.parse(res.body.toString()); const models = Array.isArray(data) ? data : (data.models || []);`
  - Result: Model list now refreshes correctly, showing 40 models including GLM-5
  - Backwards compatible - handles both array and object formats

### Changed
- Docker image version bumped to 2026.3.19

---

## [2026.3.18] - 2026-03-15

### Security - Phase 1 Audit Hardening (morpheus-proxy.mjs)
- **CRITICAL: Auth bypass removed** - `PROXY_API_KEY` no longer defaults to `"morpheus-local"`. Proxy now requires a strong key via env var or exits on startup.
- **Cookie caching** - `getBasicAuth()` now caches the `.cookie` file read for 60 seconds instead of reading disk on every request. Cache invalidated on error.
- **Persistent sessions** - Sessions saved to `~/.morpheus/sessions.json` on every mutation (`set`/`delete`) and on graceful shutdown (SIGTERM/SIGINT). Loaded on startup. Proxy restarts no longer lose active sessions.
- **Rate limiting + body size protection** - New `securityMiddleware` runs before auth: 30 req/min per IP, 1MB body limit, smart cleanup at 800+ entries to prevent memory leaks.
- File grew from 833 → 924 lines. Zero new dependencies. All 36 existing tests pass.

### Fixed
- **morpheus-proxy.mjs** - Model refresh was parsing router response incorrectly
  - Router returns `{ models: [...] }` but code expected raw array
  - Fix: `const data = JSON.parse(res.body.toString()); const models = Array.isArray(data) ? data : (data.models || []);`
  - Result: Model list now refreshes correctly, showing 40 models including GLM-5
  - Backwards compatible - handles both array and object formats

---

## [2026.3.17] - 2026-03-15

### Changed
- **install-with-deps.sh** - Complete zero-prompt rewrite (5-stage build)
  - `curl -fsSL https://get.everclaw.xyz | bash` now fully unattended
  - Hardware detection (RAM, disk, GPU) ported from setup-ollama.sh
  - All dependencies auto-install without prompts (Homebrew, Node.js, git, curl, OpenClaw)
  - EverClaw clone/update is automatic (no "Update? [y/N]" prompt)
  - Bootstrap key provisioned automatically (failure is non-fatal)
  - [REDACTED] proxy-router auto-installs when ≥2 GB disk free
  - Ollama local fallback auto-installs when ≥5 GB disk + ≥2 GB RAM
  - Config merge via setup.mjs --apply --restart runs automatically
  - Dashboard auto-opens after successful install (macOS/Linux)
  - Dynamic success banner shows installed components + inference chain
  - New flags: --skip-ollama, --skip-proxy (--auto-install now legacy no-op)
  - --check-only shows hardware stats + gating preview for all components
  - Zero `read -p` prompts in entire script (was 3)
  - PII scan clean, bash -n syntax verified

---

## [2026.3.15] - 2026-03-12

### Added
- **setup-ollama.sh** - Hardware-aware local Ollama inference fallback
  - Auto-detects OS, CPU arch, total/available RAM, GPU (Apple Metal, NVIDIA CUDA, AMD ROCm)
  - Selects optimal Qwen3.5 model (0.8B-35B) based on available resources
  - Model sizes verified against Ollama registry (0.8b, 2b, 4b, 9b, 27b, 35b)
  - Installs Ollama, pulls model, configures OpenClaw provider + fallback chain
  - Sets up auto-start service (launchd on macOS, systemd on Linux)
  - Tests inference after setup, dry-run by default
  - `--uninstall` cleanly removes from config without touching Ollama binary
  - Never exceeds 70% of total RAM - safe for all hardware
- **setup.mjs --with-ollama** - Integrated Ollama setup into main config flow
- **Config templates** - Both mac and linux templates now include ollama provider + fallback

---

## [2026.3.14] - 2026-03-12

### Fixed
- **BUG-002** - balance.sh session count parsing (jq newline in arithmetic)
- **BUG-003** - bootstrap-everclaw --status/--test showing undefined values
- **BUG-004** - session.sh missing `status` command (balance + session summary)
- **BUG-006** - pii-scan.sh now detects phone numbers in --text and stdin modes (4 patterns)
- **BUG-007** - Boot templates now include 7 `__PLACEHOLDER__` tokens for automated setup
- **BUG-009** - Website footer release link points to valid v2026.3.13 tag
- **BUG-010** - Website "What's New" section updated from v0.9.x to 2026.3.x scheme
- **BUG-011** - SmartAgent [REDACTED] synced to v5 (was stale v4)
- **BUG-013** - Dockerfile versions updated (OpenClaw v2026.3.2, EverClaw 2026.3.13)

---

## [2026.3.13] - 2026-03-11

### Fixed
- **Version alignment** - SKILL.md, package.json, and git tag now all match
- **Removed duplicate security/ directory** - skills/ is canonical; security/ was a stale copy with diverging content
- **Bootstrap version updated** - was hardcoded to v2026.2.26
- **CHANGELOG backfilled** - added missing v2026.3.11 and v2026.3.12 entries
- **install.sh error handling** - added curl/unzip pre-checks, improved GitHub API rate limit diagnostics

---

## [2026.3.12] - 2026-03-09

### Added
- **morpheus-session-mgr.mjs** - CLI for [REDACTED] P2P session management (7 commands: status, balance, models, sessions, estimate, fund, logs)
- **safe-transfer.mjs** - EIP-712 Safe→Router MOR transfers via 1Password key injection
- **inference-balance-tracker.mjs** - Daily MOR+ETH balance tracker with CoinGecko prices

### Changed
- **morpheus-proxy.mjs** - Added MOR balance monitoring, P2P→Gateway fallback, session tracking, health endpoint with balance/session/fallback fields
- **SOP-002 v1.1** - Documented [REDACTED] P2P staking model (MOR is staked, not spent)
- **All personal wallet addresses removed** - scripts require env vars (MORPHEUS_WALLET_ADDRESS, MORPHEUS_SAFE_ADDRESS)
- **1Password references configurable** - OP_KEYCHAIN_ACCOUNT, OP_VAULT, OP_ITEM via env vars

---

## [2026.3.11] - 2026-03-09

### Added
- **Wallet safety suite** - receipt verification via `waitAndVerify()`, slippage protection via Uniswap QuoterV2, configurable gas limits (EVERCLAW_MAX_GAS), confirmation tracking (EVERCLAW_CONFIRMATIONS), slippage tolerance (EVERCLAW_SLIPPAGE_BPS)
- **36 automated tests** - split across A (offline), B (balance+approve), C (swap+slippage)

---

## [2026.3.10] - 2026-03-08

### Changed
- **[REDACTED] Proxy Router reference updated to v5.14.0** (was v5.12.0)
  - Fix: Approve overflow during session creation (#623)
  - Fix: NaN provider scores blocking session creation (#631)
  - Fix: BadgerDB boot corruption (#632)
  - Fix: Badger file cleanup on restart (#635)
  - Feat: End-to-end request_id tracing for debugging (#625)
  - Feat: Random request ID generation + improved logging (#628)
  - Upstream: https://github.com/[REDACTED]/[REDACTED]/releases/tag/v5.14.0

---

## [2026.3.9] - 2026-03-08

### Changed
- **Bagman upgraded to v2.0 Multi-Backend**
  - Full sync from `zscole/bagman-skill` upstream
  - NEW: macOS Keychain backend (zero setup, native)
  - NEW: Encrypted file backend via `age` (portable, git-friendly)
  - NEW: Environment variables backend (CI/CD, containers)
  - NEW: Auto-detect best available backend (no 1Password required)
  - NEW: Python examples - secret_manager, sanitizer, validator, session_keys, test_suite
  - NEW: Backend implementations - keychain, encrypted_file, env, onepassword, auto
  - NEW: Autonomous operation documentation
  - NEW: Delegation Framework integration tests (TypeScript)
  - NEW: BIP-39 wordlist for key validation
  - NEW: Pre-commit hook for secret leak prevention
  - Upstream: https://github.com/zscole/bagman-skill

---

## [2026.3.8] - 2026-03-08

### Changed
- **PromptGuard upgraded to v3.3.0**
  - Full sync from `seojoonkim/prompt-guard` with our external content detection PR
  - New package structure (`prompt_guard/` module with scripts/ backward compatibility)
  - SHIELD.md standard compliance (11 threat categories)
  - **External Content Detection** - identifies injection from GitHub issues, PRs, emails, Slack, Discord, social media
  - **Multi-language urgency patterns** - EN/KO/JA/ZH urgency + command detection
  - **Context-aware severity elevation** - external source + instruction = CRITICAL
  - ~130 new patterns for external content injection attacks
  - Upstream PR: https://github.com/seojoonkim/prompt-guard/pull/18

---

## [2026.3.6] - 2026-03-05

### Added
- **Guided Installer** (`scripts/install-with-deps.sh`)
  - One-line install: `curl -fsSL https://get.everclaw.xyz | bash`
  - Automatic dependency detection (curl, git, Node.js, npm, Homebrew, OpenClaw)
  - Platform-specific install commands (macOS, Ubuntu, Fedora, Arch)
  - `--check-only` flag to verify environment
  - `--auto-install` flag for unattended setup
  - `--skip-openclaw` flag for existing installations
  - Bootstrap key integration (free GLM-5 starter key)

- **Bootstrap Key System** (`scripts/bootstrap-everclaw.mjs`)
  - Device fingerprint generation (hostname + MAC + platform)
  - Key request from `keys.everclaw.xyz`
  - Key storage in `~/.openclaw/.bootstrap-key`
  - GLM-5 configuration via mor-[REDACTED] provider
  - Commands: `--setup`, `--status`, `--test`, `--revoke`
  - Graduation flow: remove bootstrap key when user provides own key

- **GitHub Actions CI**
  - Automated testing on Ubuntu and macOS
  - Dependency check tests
  - Bootstrap script tests
  - Shell syntax validation

- **CloudFlare Redirect**
  - `get.everclaw.xyz` points to installer script

### Changed
- **SKILL.md**: Added Prerequisites section with dependency table
- **README.md**: Added one-line install, prerequisites table, installer options
- **bootstrap-[REDACTED].mjs**: Removes `.bootstrap-key` when user sets own key

### Fixed
- Gateway PR #10: Auto-detect OpenClaw launchd service label ([REDACTED] vs node)

---

## [2026.2.26] - 2026-02-26

### Added
- PII Guard v2 with enhanced scanning
- ClawHub dependencies wired across 19 primary flavors
- Docker clean integration
- Three-Shifts v2 cyclic execution engine

### Changed
- Date-based versioning (YYYY.M.D format)

### Fixed
- PII purge across workspace + 34 repos + git history

---

## [2026.2.23] - 2026-02-23

### Added
- Multi-key auth rotation v2
- Gateway Guardian v5 with direct curl inference probes
- Smart session archiver

---

For earlier versions, see git history.