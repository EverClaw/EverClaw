
## v2026.10.23.0148 — web_search provider sanitizer (SEC-WAVE fleet incident fix) — 2026-10-23

**Problem:** OpenClaw v2026.7.1-2 hard-fails gateway boot when `tools.web.search.provider` references a provider whose plugin is not bundled in the image (`parallel-free` from external @openclaw/parallel-plugin; tavily/exa/perplexity). Crash-looped 2 fleet leases on 2026.10.21.2345 and reproduced on every restore/upgrade carrying such configs.

**Fix:** docker-entrypoint.sh boot-time sanitizer (allowlist: searxng/kimi/firecrawl — the only bundled providers, verified via openclaw doctor --lint). Shared repair_json_config() helper (atomic, JSON-guarded). jq 1.6-safe explicit-root form. 23-test regression suite pins filter + wrapper + allowlist.

**Audit:** SOP-001 full pipeline. Grok 4.20-reasoning ×3 rounds (final Excellent/Excellent, zero blocking). Claude Opus 4.8 cross-model (SHIP, zero blocking, all deviations fail-safe). Grok coverage review ×2 (final Excellent). Zero new test failures vs baseline. 0 PII findings. RSI-894725 streak spot-check passed.

**Deploy:** main pushed to everclaw-org + origin; ecosystem sync 30/30; GHCR image 2026.10.23.0148 (multi-arch, CI-verified + remote digest). GitHub releases on both canonical repos.

**Staging (10.5):** canary buffer lease 01a13b98 upgraded to 0148 — ACTIVE/ready, Tier 1 matrix green (health 200, login, SSO reject 401, models 200, CIG fail-closed 403 on unauth chat, no update banner).

**Production application:**
- OPENCLAW_IMAGE secret bumped → 2026.10.23.0148 (digest 67d5f6c4…).
- PROSPERO: restored WITH DATA to lease 01a1668b-ef13 (FQDN openclaw-d92b792.barney-morpheus4.manifest0.net), image 0148, health 200, CIG detected. **End-to-end poison test PASSED: his restored config (parallel-free) crashed image 2345 (fail_count 1) and boots clean on 0148 — the sanitizer works.** Restore Step 8.5 /update 404'd (lease mid-transition); completed via proven promote+upgrade-container path.
- MOUSE: live lease 01a1660f-8654 upgraded to 0148 in place (health 200, CIG green, same FQDN). Data restore blocked by restore-deployment race (see follow-up); data retained in lease 01a0a972 until 2026-12-23.

**Follow-ups:** (1) restore-deployment Step 7 race — first /restore fails transiently → manifest-upload fallback provisions lease → 409 permanent (2/2 for mouse, 0/1 for prospero; fix = retry /restore on transient WITHOUT manifest upload); (2) orphan lease from mouse's 21:35 attempt (fresh 0148, no DB row — logs API inaccessible to CLI token; flag for ops sweep); (3) style items in memory/projects/everclaw/followups.md.
