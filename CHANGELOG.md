# EverClaw Changelog

All notable changes to EverClaw are documented here.

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
