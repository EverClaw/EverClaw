# EverClaw Changelog

All notable changes to EverClaw are documented here.

## [2026.4.28.0145] - 2026-04-28

### Changed — OpenClaw Pin v2026.4.23 → v2026.4.25

- **Dockerfile:** OpenClaw build target updated from `v2026.4.23` to `v2026.4.25`
- **docker-compose.yml:** Image tag and build arg updated

### Upstream Highlights (OpenClaw v2026.4.23 → v2026.4.25)

#### New Features
- **TTS overhaul:** `/tts latest` read-aloud, `/tts chat on|off` session-scoped auto-TTS, per-agent voice overrides, 6 new TTS providers (Azure Speech, Xiaomi, Local CLI, Inworld, Volcengine, ElevenLabs v3)
- **Plugin cold registry:** Persisted registry eliminates broad manifest scans, faster boot, deterministic provider discovery
- **OpenTelemetry expansion:** Spans across model calls, token usage, tool loops, harness runs, exec, delivery, context assembly, memory pressure; Prometheus scrape plugin; W3C traceparent propagation
- **Browser automation:** Iframe-aware role snapshots, safe tab URLs, CDP readiness tuning for slow hosts, headless one-shot launch, `doctor --deep` probing
- **Control UI:** PWA install + Web Push notifications, Crestodian TUI first-run setup, context mode selector
- **Google Meet:** Calendar-backed attendance export workflows, meeting record tools

#### Fixes
- **DeepSeek V4:** Venice passthrough fix for `reasoning_content` replay turns (eliminates need for local patch)
- **Cron hardening:** Jobs interrupted by restart recorded as failed, one-shots disabled after interruption
- **Install hardening:** Windows/macOS/Linux/Docker improvements, Node service restarts, LaunchAgent token rotation, mixed-version gateway verification
- **Bonjour/mDNS:** Broken plugin self-disables after repeated failures (EverClaw also auto-disables preemptively)

#### Security
- Device token scope containment (pairing-only sessions can't mutate operator tokens)
- Configured redaction patterns now applied to persisted session transcripts
- Gateway rejects older binary from mutating newer-version services

(References: https://github.com/openclaw/openclaw/releases/tag/v2026.4.24, https://github.com/openclaw/openclaw/releases/tag/v2026.4.25)

## [2026.4.25.1719] - 2026-04-25

### Added — BACK-006: First-Run Security Guidance Banner

- **Feature:** Docker containers now show a one-time security guidance banner on first startup, recommending localhost access and explaining HTTPS reverse proxy options (Caddy, Traefik, Nginx, SSH tunnel).
- **Sentinel:** Banner is suppressed on subsequent starts via `~/.openclaw/.first-run-complete` marker file. If the marker cannot be created (read-only volume), a warning is logged and the banner reappears.
- **Port-aware:** Banner uses `OPENCLAW_GATEWAY_PORT` env var (default 18789) for all URLs and SSH tunnel examples.
- **Files:** `packages/core/scripts/docker-entrypoint.sh` (+27/-2)
- **SOP-001:** Stages 0-7 complete. Grok 4.20: 2 rounds → Perfect. Cross-model (Claude Opus 4.6): Perfect. PII scan: clean.

## [2026.4.25.0441] - 2026-04-25

### Fixed — BACK-015: install-with-deps.sh False-Positive Dependency Reporting

- **Bug:** `verify_installed()` return values were discarded in `install_dep()` for `curl`, `git`, `npm`, and `OpenClaw` cases. The function could return 0 (success) even when dependency installation failed, causing confusing output where users saw checkmarks but dependencies were missing.
- **Fix:** All `verify_installed` calls now propagate their return values via `|| return 1`:
  - `curl`: added `|| return 1` after verify call
  - `git` (macOS with brew): moved verify inside brew branch with `|| return 1`
  - `git` (macOS without brew): changed to `log_err` + `return 1` (was `log_warn` only)
  - `git` (Linux): moved verify inside Linux branch with `|| return 1`
  - `npm`: restructured as early-return-on-success, install path with `|| return 1`
  - `OpenClaw`: added `|| return 1` after verify call
- **Files:** `packages/core/scripts/install-with-deps.sh` (17 insertions, 14 deletions)
- **SOP-001:** Stages 0-7 complete. Grok 4.20: Perfect. Cross-model (DeepSeek V4 Pro): Perfect.

## [2026.4.25.0259] - 2026-04-25

### Fixed — Monorepo Path Issues

- **npm test now works from monorepo root:** Added symlink `tests -> packages/core/tests` so the test glob in package.json finds tests in the monorepo. Previously `npm test` found 0 tests because `tests/` only existed in `packages/core/`.
- **version-stamp.sh finds package.json in monorepo:** Added monorepo detection that looks for package.json at the repo root (two levels up from REPO_DIR) when running from packages/core/. Previously the script could only find 3/4 files (SKILL.md, Dockerfile, docker-compose.yml in packages/core/) but missed package.json at repo root.

**Note:** users running macOS should run `git config core.symlinks true` to ensure the symlink works correctly on checkout. Windows users should enable Developer Mode for symlink support.

## [2026.4.25.0136] - 2026-04-25

### Fixed — Monorepo Bootstrap Wrapper

- **Added wrapper** at `scripts/bootstrap-gateway.mjs` that forwards to `packages/core/scripts/bootstrap-gateway.mjs`
- **Issue:** Users cloning the monorepo (`EverClaw/EverClaw`) got `MODULE_NOT_FOUND` when running `npm run bootstrap` because the actual script lives in `packages/core/scripts/`
- **Fix:** Thin ESM wrapper at monorepo root forwards CLI args to the real script in `packages/core/`
- **Composed flavor repos unaffected:** `flavor-compose.sh` copies `packages/core/scripts/` to output root (not monorepo root `scripts/`), so flavor installs already had the real script

## [2026.4.24.1832] - 2026-04-24

### Changed — OpenClaw Pin v2026.4.21 → v2026.4.23

- **Dockerfile:** OpenClaw build target updated to `v2026.4.23`
- **docker-compose.yml:** Image tag and build arg updated

### Upstream Highlights (OpenClaw v2026.4.21 → v2026.4.23)

#### New Features
- **Image Generation:** gpt-image-2 via Codex OAuth (no API key needed), OpenRouter image models, quality/format hints
- **Subagents:** Optional forked context for `sessions_spawn` — child inherits parent transcript
- **Tools:** Per-call `timeoutMs` for image, video, music, and TTS generation
- **Memory:** Configurable `memorySearch.local.contextSize` (4096 default) for constrained hosts
- **Dependencies:** Pi packages updated to 0.70.0
- **Codex Harness:** Structured debug logging for harness selection decisions

#### Fixes
- **Block Streaming:** Suppress duplicate replies after partial block-delivery aborts
- **Slack:** Classify MPIM group DMs as group chat, suppress verbose tool progress in rooms
- **Telegram:** Parse markdown image syntax into outbound media payloads
- **WhatsApp:** Unified outbound media normalization across sends and auto-replies
- **WebChat:** Surface non-retryable provider failures (billing, auth, rate-limit) with model-switch hints
- **Memory CLI:** Local embedding provider resolution for standalone commands
- **Codex/Windows:** Resolve npm-installed codex.cmd shims through PATHEXT
- **Media Understanding:** Honor explicit imageModel config before native-vision skips
- **Image Attachments:** Preserve for text-only models via media ref offloading

#### Security
- **Teams:** Cross-bot token replay blocked via verified appid/azp
- **Android:** Loopback-only cleartext gateway connections required
- **Pairing:** Private-IP or loopback required for cleartext mobile pairing
- **QA Channel:** Non-HTTP(S) inbound attachment URLs rejected
- **Claude CLI:** `bypassPermissions` derived from OpenClaw exec policy
- **Plugins:** Setup-api lookup hardening

(Reference: https://github.com/openclaw/openclaw/releases/tag/v2026.4.23)


## [2026.4.22.1820] - 2026-04-22

### Changed — Skill Frontmatter & Cleanup

Cherry-picked improvements from community PR #15 (yogesh-tessl):

- **Added YAML frontmatter** to 5 skills: `agent-chat`, `night-shift`, `pii-guard`, `prompt-guard`, `xmtp-comms-guard`
  - Structured `name` and `description` with `Use when` clauses for agent discovery
  - Consistent double-quoted string format across all skills
  - EverClaw branding standardized across all descriptions
- **Removed duplicate section** from `agent-chat/SKILL.md`: second "Daemon Management" block (88 lines) was identical to the first
- **Preserved all security content** in `prompt-guard/SKILL.md`: inline detection patterns, changelogs, and incident context retained (rejected PR's removal of these)


## [2026.4.22.1638] - 2026-04-22

### Changed — Monorepo Restructure

**Architecture overhaul:** Reorganized flat repo into monorepo with composed flavor deployment.

- **New `packages/core/`:** All common Morpheus infrastructure (scripts, tests, references, docs, templates, Docker, config)
- **New `flavors/`:** 29 thin per-flavor directories with `flavor.json` + `README.md` + optional templates
- **New `scripts/flavor-compose.sh`:** Composes core + flavor overlay into a deployable repo
- **Rewritten `scripts/ecosystem-sync.sh`:** Canonical remotes get full monorepo; flavor remotes get composed artifacts
- **New `archive/`:** Deprecated content (alternative installers, marketing, analytics, one-time tools)
- **Removed `claw-repos/`:** Per-flavor duplicated directories eliminated (was 28 × full copy)
- **Moved `everclaw-docker/` and `everclaw-key-api/`:** Now under `packages/core/` for automatic inclusion in composed flavors
- All flavor READMEs note they are generated from the monorepo
- Root README updated with monorepo architecture, "Adding a New Flavor" guide
- Uses `rsync` for robust core copying (new files auto-included), `jq` for JSON parsing

## [2026.4.22.1314] - 2026-04-22

### Changed — OpenClaw Pin v2026.4.15 → v2026.4.21

- **Dockerfile:** OpenClaw build target updated to `v2026.4.21`
- **docker-compose.yml:** Image tag and build arg updated

### Upstream Highlights (OpenClaw v2026.4.15 → v2026.4.21)

#### New Features
- **Image generation:** Defaults to `gpt-image-2` (OpenAI)
- **Skill Workshop plugin:** Captures workflow corrections as reusable skills
- **Kimi K2.6:** Added to Fireworks provider catalog
- **Preview streaming:** Discord, Slack, Telegram show tool progress in live edits
- **QQBot:** Self-contained engine with QR-code onboarding

#### Performance
- **Plugin startup:** Discord 98% faster, Telegram 14s faster, Matrix 1.8s faster
- **Bundled plugin loading:** 82-90% faster via native Jiti

#### Fixes
- **ACP/subagents:** Parent→child echo loop fix on `sessions_send`
- **Subagents:** Terminal failures no longer freeze or replay stale output
- **Security:** External content strips chat-template special tokens (Qwen/ChatML, Llama, Gemma, Mistral)
- **npm:** Fixed `node-domexception` deprecation warning chain

(Reference: https://github.com/openclaw/openclaw/releases/tag/v2026.4.21)

## [2026.4.19.0439] - 2026-04-19

### Added — Per-Agent Inference Quota Management

- **`buddy-quotas.mjs`** (960 lines) — CLI + library for per-agent inference quota tracking
  - Per-agent token counters in `~/.everclaw/quotas/usage/{agent-id}.json`
  - Configurable daily/monthly limits with per-agent overrides
  - Alert threshold (default 80%) with host notification
  - Graceful degradation to lighter model at 90% (configurable)
  - Three cutoff actions: `degrade`, `block`, `warn`
  - Automatic daily/monthly rollover with 30-day history retention
  - Provider + model breakdown tracking (morpheus/venice/ollama)
  - Export/import for data portability
  - `initializeAgent()` / `removeAgentData()` for provision/deprovision integration
  - Lock-free file-per-agent design (zero contention between concurrent bots)
  - Zero npm dependencies (Node built-ins only)
- **50 tests** — library + CLI coverage including rollover, validation, thresholds, export roundtrip

### Grok 4.20 Audit
- 3 rounds → **Perfect** (both files)
- R1: Fixed redundant ternary, defensive config guard, robust filename parsing
- R2: Fixed test SCRIPT path resolution, removed dead config mutation code
- R3: Perfect — zero remaining issues

## [2026.4.18.0201] - 2026-04-18

### Added — MOR Staking Session Management

- **On-chain session pagination:** `session.sh cleanup` and `morpheus-session-mgr.mjs cleanup` enumerate ALL sessions via Diamond contract `getUserSessions(addr, offset, limit)` — the proxy-router `/sessions/user` endpoint has a hidden ~100 session limit
- **Stale session cleanup:** Automatically closes orphaned sessions, keeps only the latest per model. Frees locked MOR.
- **Pre-open cleanup:** `session.sh open` now runs cleanup before opening new sessions (best-effort, requires `cast`)
- **GLM-5 + GLM-5.1:web:** Added to model ID map in `session.sh`
- **Staking monitor cron pack:** `cron-packs/packs/staking-monitor.json` — nightly cleanup + 6-hourly balance alerts
- **Troubleshooting entries:** "Insufficient MOR" and "Sessions not showing" root-cause docs with pagination fix

### Fixed

- **Port consistency:** `morpheus-session-mgr.mjs` uses `API_BASE` (default 8082) everywhere — no more mixed 8082/8083 references
- **Bash 3.2 compatibility:** `session.sh cleanup` uses indexed arrays (no `declare -A`), works on macOS default bash
- **cast output parsing:** Properly strips quotes from `cast call` output (was silently returning 0 sessions)
- **Cookie parsing:** Handles both `user:pass` and plain-password cookie formats
- **[REDACTED] placeholders:** All removed from troubleshooting.md, replaced with "Morpheus" / "proxy-router"
- **Stale MOR rate:** Updated default from 633 to 1268 MOR/day

### Security

- Zero PII — no personal addresses, only public contract addresses (Diamond, MOR token) and on-chain model IDs
- All user-specific values from environment variables
- Grok 4.2 reasoning audit: 5 rounds, 4/4 files rated **Perfect**

## [2026.4.17.0050] - 2026-04-17

### Changed — OpenClaw Pin v2026.4.14 → v2026.4.15

- **Dockerfile:** OpenClaw build target updated to `v2026.4.15`
- **docker-compose.yml:** Image tag and build arg updated

### Upstream Highlights (OpenClaw v2026.4.14 → v2026.4.15)

#### New Features
- **Anthropic/models:** Claude Opus 4.7 defaults, opus aliases, bundled image understanding
- **Google/TTS:** Gemini text-to-speech in bundled google plugin
- **Control UI/Overview:** Model Auth status card (OAuth health + rate-limit pressure)
- **Memory/LanceDB:** Cloud storage support for durable memory indexes
- **GitHub Copilot/memory search:** Copilot embedding provider for memory search
- **Agents/local models:** `localModelLean: true` flag drops heavyweight tools for weaker setups
- **Packaging/plugins:** Localized bundled plugin runtime deps, leaner published builds

#### Fixes
- **Ollama/chat:** Provider prefix stripped from model IDs (fixes 404 on `ollama/` refs)
- **Dreaming/memory-core:** Storage mode defaults to `separate` (daily files no longer dominated by dream blocks)
- **Gateway/skills:** Snapshot version bumped on config writes (removed skills take effect immediately)
- **Agents/tool-loop:** Unknown-tool loop guard enabled by default (stops "Tool not found" loops)
- **Cron/announce:** NO_REPLY leak fixed (isolated cron replies no longer leak summary text)
- **Agents/replay recovery:** 401 "input item ID" now gives /new guidance
- **Agents/failover:** HTML provider error pages treated as transport failures
- **Agents/tools:** Host tilde paths resolve correctly when OPENCLAW_HOME differs
- **Speech/TTS:** Auto-enable bundled providers, route directive tokens through correct provider
- **Agents/CLI transcripts:** CLI-backed turns persist to session history
- **BlueBubbles/catchup:** Retry ceiling for persistently-failing messages
- **OpenAI Codex/models:** Stale transport metadata self-heals to canonical Codex endpoint
- **WhatsApp/web-session:** Auth race fix on reconnect

#### Security
- **Gateway/tools:** MEDIA: trust anchor on exact registered built-in tool names
- **Gateway/webchat:** localRoots containment on audio embedding
- **Matrix/pairing:** DM pairing-store blocked from room control commands
- **Docker/build:** pnpm v10+ native bindings path fix

(Reference: https://github.com/openclaw/openclaw/releases/tag/v2026.4.15)

## [2026.4.14.1520] - 2026-04-14

### Changed — OpenClaw Pin v2026.4.12 → v2026.4.14

- **Dockerfile:** OpenClaw build target updated to `v2026.4.14`
- **docker-compose.yml:** Image tag and build arg updated

### Upstream Highlights (OpenClaw v2026.4.12 → v2026.4.14)

#### New Features
- **OpenAI Codex/models:** Forward-compat support for GPT-5.4-pro (pricing, limits, catalog visibility)
- **Telegram/forum topics:** Human topic names surfaced in agent context and persisted across restarts

#### Fixes
- **Ollama/timeout:** Configured embedded-run timeout forwarded to undici stream timeout (no more premature cutoff)
- **Ollama/streaming:** `stream_options.include_usage` sent for streaming completions (prevents bogus token counts and premature compaction)
- **Ollama/slug generation:** Session-memory slug honors `timeoutSeconds` override (no more 15s abort)
- **Memory/embeddings:** Non-OpenAI provider prefixes preserved during normalization (fixes "Unknown memory embedding provider")
- **Media/transcription:** `.aac` filenames remapped to `.m4a` for MIME-sensitive endpoints
- **Agents/context engine:** Tool-loop sessions compact from first delta, preserving ingest fallback
- **Agents/subagents:** Registry lazy-runtime stub emitted on stable dist path (ERR_MODULE_NOT_FOUND fix)
- **Gateway/update:** Unified service entrypoint resolution for update/reinstall/doctor
- **Browser/SSRF:** Navigation restored under default policy; strict mode preserved for legacy configs
- **UI/chat:** marked.js → markdown-it (ReDoS prevention)

#### Security Hardening
- Gateway tool rejects dangerous config flag changes from model-facing calls
- Media attachments fail closed on realpath errors
- Heartbeat forces owner downgrade for untrusted hook:wake events
- Browser SSRF policy enforced on snapshot/screenshot/tab routes
- MS Teams sender allowlist on SSO signin
- Config redacts sourceConfig/runtimeConfig alias fields

(Reference: https://github.com/openclaw/openclaw/releases/tag/v2026.4.14)

## [2026.4.14.0206] - 2026-04-14

### Changed — OpenClaw Pin v2026.4.11 → v2026.4.12

- **Dockerfile:** OpenClaw build target updated to `v2026.4.12`
- **docker-compose.yml:** Image tag and build arg updated

### Upstream Highlights (OpenClaw v2026.4.11 → v2026.4.12)

#### New Features
- **Active Memory plugin:** Dedicated memory sub-agent that auto-pulls relevant context/preferences before replies. Configurable modes, `/verbose` inspection.
- **Codex provider:** Bundled provider for `codex/gpt-*` models with native auth, threads, and compaction
- **LM Studio provider:** Bundled provider for local/self-hosted OpenAI-compatible models with auto-discovery
- **macOS Talk Mode:** Experimental local MLX speech provider for Talk Mode
- **Exec policy CLI:** `openclaw exec-policy` command for syncing exec approvals with config
- **Plugin loading overhaul:** Manifest-declared activation scopes, narrower loading boundaries
- **Per-provider allowPrivateNetwork:** Trusted self-hosted endpoints opt-in
- **Gateway commands.list RPC:** Remote clients can discover runtime commands

#### Fixes
- **Security:** busybox/toybox removed from safe bins, empty approver list fix, shell-wrapper injection block, placeholder credential startup block
- **Dreaming:** Promotion threshold raised (fixes zero-candidate stalls), light-sleep confidence from all signals, narrative cleanup hardened, no re-ingesting own transcripts
- **Memory/QMD:** Better recall defaults, Unicode slug fix, nested daily notes support, direct memory dir watching (fixes macOS + Node 25 glob issue)
- **Agents:** Orphaned user text carried into next prompt (fixes mid-run dropped messages), Anthropic replay safety
- **Gateway:** Keepalive ticks no longer droppable, sidecar-gated startup, cron config persistence across reloads
- **WhatsApp:** Fallback to first mediaUrls entry (fixes silently dropped attachments)
- **CLI update:** Stale chunk import fix after self-update

(Reference: https://github.com/openclaw/openclaw/releases/tag/v2026.4.12)

## [2026.4.12.1825] - 2026-04-12

### Changed — OpenClaw Pin v2026.4.9 → v2026.4.11

- **Dockerfile:** OpenClaw build target updated to `v2026.4.11`
- **docker-compose.yml:** Image tag and build arg updated

### Upstream Highlights (OpenClaw v2026.4.10–v2026.4.11)

#### New Features
- **Dreaming/memory-wiki:** ChatGPT import ingestion with Imported Insights and Memory Palace diary subtabs for inspecting imported chats and compiled wiki pages directly from the UI
- **Control UI/webchat:** `[embed ...]` rich output tag, structured chat bubbles for media/reply/voice directives, external embed URL gating
- **video_generate:** URL-only asset delivery, typed providerOptions, reference audio inputs, per-asset role hints, adaptive aspect-ratio support
- **Plugin manifests:** Activation and setup descriptors for declarative auth/pairing/config flows
- **Ollama:** Context-window and capability metadata caching during model discovery
- **Microsoft Teams:** Reaction support with delegated OAuth
- **Feishu:** Richer document comment sessions with reactions and typing feedback

#### Fixes
- **Agent timeouts:** Explicit run timeouts honored in LLM idle watchdog — slow models work until configured limit
- **ACP child relay:** Internal progress chatter from spawned child runs no longer leaks into parent stream
- **Agent failover:** Cross-provider fallback scoped to current attempt instead of stale session history
- **Audio transcription:** Pinned DNS disabled only for OpenAI-compatible multipart requests
- **WhatsApp:** Default account honored, react routed through gateway, image attachment paths preserved
- **Telegram:** Topic-scoped session initialization stays on canonical transcript path
- **Codex OAuth:** Upstream authorize URL scopes no longer rewritten
- **macOS Talk Mode:** Microphone permission continues startup without double-toggle

## [2026.4.9.1656] - 2026-04-09

### Fixed — Morpheus Gateway Error Unwrapping (Issues #1 & #2)

- **Issue #1: LiteLLM wraps 429 rate limits as HTTP 400** — Venice backend rate limits were returned as HTTP 400 with `providerModelError` wrapper, preventing OpenClaw's retry/fallback chain from triggering.
  - **Fix:** `normalizeLitellmError()` detects wrapped 429 errors (via `code === "429"`, `"RateLimitError"`, `"overloaded"`, `"throttling_error"`) and rewrites to proper HTTP 429.
  - **Impact:** OpenClaw now retries with backoff and triggers model-group fallbacks correctly.

- **Issue #2: LiteLLM "division by zero" server errors wrapped as HTTP 400** — Internal LiteLLM bugs (RPM/TPM math errors when backend reports 0) returned as HTTP 400.
  - **Fix:** Same unwrapping logic detects `code === "500"` or `"division by zero"` and returns HTTP 503 (service unavailable - retryable).

- **New `callGatewayWithRetry()` wrapper** — All 4 gateway call sites now retry transient errors (429, 500, 502, 503) with exponential backoff (1s → 2s → 4s, capped at 10s) before giving up.

- **Streaming safe** — Successful SSE streams pass through immediately; only failed requests trigger retry logic.

- **Zero breaking changes** — Non-provider errors, genuine 400s, and streaming success paths unchanged.

## [2026.4.9.1449] - 2026-04-09 — Windows Detection & OpenClaw URL Fix

### Fixed
- **Windows (Git Bash / MSYS / Cygwin) now shows helpful error** — Instead of a generic "Unsupported OS" message, Windows users are directed to install WSL 2 with a link to Microsoft docs. Consistent messaging across all 4 installer scripts (`install-with-deps.sh`, `install.sh`, `restore-agent.sh`, `setup-ollama.sh`). Thanks to Kyrin for the report.
- **Dead `get.openclaw.ai` URL replaced** — All references updated to the current `openclaw.ai/install.sh` with `--install-method git`. The old `get.openclaw.ai` domain no longer resolves (NXDOMAIN). Fixed in `restore-agent.sh`, `SKILL.md`, and `docs/getting-started/installation.md`.

### Added
- **Explicit platform requirements in docs** — Prerequisites section in SKILL.md and installation.md now clearly states: "Supported platforms: macOS, Linux, Windows via WSL 2."

## [2026.4.9.1353] - 2026-04-09 — OpenClaw v2026.4.9 Pin

### Changed
- **OpenClaw pin** `v2026.4.8` → `v2026.4.9`
  - Dreaming REM backfill lane + `rem-harness --path` for historical daily notes (MemPalace users can now replay old diary entries into Dreams without a second memory stack)
  - Agent idle timeout now correctly inherits `agents.defaults.timeoutSeconds` (we ship 300s) — eliminates false idle-timeout kills for Morpheus P2P users during slow inference; watchdog disabled for cron runs
  - npm packaging fixes for channel plugin deps (validates our Issue #17 Docker workaround)
  - Security & stability: Browser SSRF recheck, dotenv runtime-control blocking, node exec event sanitization, NO_REPLY token stripping, and auto-fallback model override cleared on `/reset`

**Notes**
Pure version pin bump. No breaking changes, no template modifications, no code changes required in EverClaw. Dry run confirmed clean with zero conflicts.

## [2026.4.9.1327] - 2026-04-09 — Docker Channel Plugin Fix

### Fixed
- **Docker image missing channel plugin dependencies** (Issue #17) — OpenClaw v2026.4.8 loads all bundled channel plugins at startup (Telegram, Discord, Slack, Feishu, etc.) but their runtime deps (`grammy`, `@buape/carbon`, `@slack/web-api`, `@larksuiteoapi/node-sdk`, etc.) were not installed in the Docker image. Root cause: OpenClaw's `postinstall-bundled-plugins.mjs` script detects source checkouts (via `src/` + `extensions/` dirs) and skips dep installation. Since the Dockerfile builds from a git clone, these dirs exist and the postinstall silently skips. Fix: remove `src/` and `extensions/` (build-only artifacts, not needed at runtime) after `pnpm build`, then run the postinstall script. This also reduces image size. Thanks to @robkay01 (Bobski) for the detailed bug report.

## [2026.4.8.1910] - 2026-04-08

### Changed
- **OpenClaw pin v2026.4.5 → v2026.4.8** — Dockerfile `OPENCLAW_VERSION` and `docker-compose.yml` `EVERCLAW_VERSION` env updated. SKILL.md version header and diagnostics examples updated to match.
