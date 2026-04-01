/**
 * tests/issue-12-unsafe-defaults.mjs — Tests for Issue #12 fixes
 *
 * 4A: GitHub API rate limit detection in install.sh (shell-based, tested via grep)
 * 4B: Unlimited approval requires --unlimited flag (everclaw-wallet.mjs)
 * 4C: Binary backup before overwrite (install.sh)
 * 4D: Safe threshold === 1 validation (safe-transfer.mjs)
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = join(__dirname, "..", "scripts");

// --- Helper: Read source files ---
const installSh = readFileSync(join(SCRIPTS_DIR, "install.sh"), "utf-8");
const walletMjs = readFileSync(join(SCRIPTS_DIR, "everclaw-wallet.mjs"), "utf-8");
const safeMjs = readFileSync(join(SCRIPTS_DIR, "safe-transfer.mjs"), "utf-8");

// ============================================================
// 4A — GitHub API rate limit detection (install.sh)
// ============================================================
describe("Issue #12 — 4A: GitHub API rate limit handling", () => {
  it("should use --fail flag on GitHub API curl", () => {
    assert.ok(
      installSh.includes('--fail'),
      "install.sh should use curl --fail to detect HTTP errors"
    );
  });

  it("should capture HTTP status code from curl", () => {
    assert.ok(
      installSh.includes('%{http_code}'),
      "install.sh should capture HTTP status code with -w"
    );
  });

  it("should detect 403 rate limit response", () => {
    assert.ok(
      installSh.includes('"403"'),
      "install.sh should check for HTTP 403 (rate limit)"
    );
  });

  it("should detect 429 rate limit response", () => {
    assert.ok(
      installSh.includes('"429"'),
      "install.sh should check for HTTP 429 (too many requests)"
    );
  });

  it("should provide actionable rate limit error message", () => {
    assert.ok(
      installSh.includes("rate limit exceeded"),
      "install.sh should display rate limit error message"
    );
  });

  it("should suggest GITHUB_TOKEN for authenticated requests", () => {
    assert.ok(
      installSh.includes("GITHUB_TOKEN"),
      "install.sh should mention GITHUB_TOKEN for higher rate limits"
    );
  });

  it("should use GITHUB_TOKEN header when available", () => {
    assert.ok(
      installSh.includes('Authorization: Bearer ${GITHUB_TOKEN}'),
      "install.sh should use Bearer token auth when GITHUB_TOKEN is set"
    );
  });

  it("should detect network failure (empty/000 HTTP code)", () => {
    assert.ok(
      installSh.includes('"000"'),
      "install.sh should detect curl network failure (HTTP 000)"
    );
    assert.ok(
      installSh.includes("network failure"),
      "install.sh should show network failure message"
    );
  });

  it("should check rate limit on asset list fetch too", () => {
    assert.ok(
      installSh.includes("ASSETS_HTTP_CODE"),
      "install.sh should capture HTTP status for asset list fetch"
    );
  });
});

// ============================================================
// 4B — Unlimited approval requires explicit --unlimited flag
// ============================================================
describe("Issue #12 — 4B: Unlimited approval safety gate", () => {
  it("should not default to maxUint256 without --unlimited flag", () => {
    // The old pattern: `const amount = amountStr ? parseEther(amountStr) : maxUint256`
    // The new pattern should gate unlimited behind CI_ALLOW_UNLIMITED (--unlimited flag)
    assert.ok(
      !walletMjs.includes("const amount = amountStr ? parseEther(amountStr) : maxUint256"),
      "Should not have the old unconditional maxUint256 default"
    );
  });

  it("should require --unlimited flag for unlimited approval", () => {
    assert.ok(
      walletMjs.includes("FLAG_UNLIMITED"),
      "Should reference FLAG_UNLIMITED (set by --unlimited flag)"
    );
  });

  it("should error when no amount and no --unlimited flag", () => {
    assert.ok(
      walletMjs.includes("No approval amount specified"),
      "Should display error when no amount is provided without --unlimited"
    );
  });

  it("should parse --unlimited from argv", () => {
    assert.ok(
      walletMjs.includes('"--unlimited"'),
      "Should parse --unlimited from command line arguments"
    );
  });

  it("should show bounded amount example in error", () => {
    assert.ok(
      walletMjs.includes("approve 1000"),
      "Error message should suggest a bounded amount example"
    );
  });

  it("should update help text to show --unlimited flag", () => {
    assert.ok(
      walletMjs.includes("approve --unlimited"),
      "Help text should document --unlimited flag"
    );
  });

  it("should have defense-in-depth guard against flag-as-amount", () => {
    assert.ok(
      walletMjs.includes('amountStr.startsWith("--")'),
      "Should guard against flags leaking through as amountStr"
    );
  });

  it("should reject conflicting amount + --unlimited", () => {
    assert.ok(
      walletMjs.includes("Cannot specify both an amount and --unlimited"),
      "Should error when both amount and --unlimited are provided"
    );
  });

  it("should use FLAG_UNLIMITED not CI_ALLOW_UNLIMITED", () => {
    assert.ok(
      walletMjs.includes("FLAG_UNLIMITED"),
      "Should use FLAG_UNLIMITED (clear naming, not CI-specific)"
    );
    assert.ok(
      !walletMjs.includes("CI_ALLOW_UNLIMITED"),
      "Should not use old CI_ALLOW_UNLIMITED name"
    );
  });
});

// ============================================================
// 4C — Binary backup before overwrite (install.sh)
// ============================================================
describe("Issue #12 — 4C: Binary backup before overwrite", () => {
  it("should check for existing proxy-router before overwriting", () => {
    // Should have backup logic for proxy-router in standalone binary path
    const backupCount = (installSh.match(/proxy-router\.bak/g) || []).length;
    assert.ok(
      backupCount >= 1,
      `install.sh should create proxy-router.bak before overwrite (found ${backupCount} references)`
    );
  });

  it("should check for existing mor-cli before overwriting", () => {
    const backupCount = (installSh.match(/mor-cli\.bak/g) || []).length;
    assert.ok(
      backupCount >= 1,
      `install.sh should create mor-cli.bak before overwrite (found ${backupCount} references)`
    );
  });

  it("should use timestamped backup names", () => {
    assert.ok(
      installSh.includes('date +%Y%m%d%H%M%S'),
      "install.sh should use timestamp in backup filename for uniqueness"
    );
  });

  it("should back up in both Strategy 1 (binary) and Strategy 2 (zip) paths", () => {
    // Count the number of backup blocks — should be at least 3
    // (proxy-router strategy 1, mor-cli strategy 1, strategy 2 zip)
    const backupBlocks = (installSh.match(/Backing up existing/g) || []).length;
    assert.ok(
      backupBlocks >= 3,
      `install.sh should have backup logic in both strategies (found ${backupBlocks} backup blocks)`
    );
  });
});

// ============================================================
// 4D — Safe threshold === 1 validation (safe-transfer.mjs)
// ============================================================
describe("Issue #12 — 4D: Safe threshold validation", () => {
  it("should assert threshold === 1n (not just >= 1)", () => {
    assert.ok(
      safeMjs.includes("threshold !== 1n"),
      "safe-transfer.mjs should check threshold !== 1n"
    );
  });

  it("should error with clear message for multi-sig Safes", () => {
    assert.ok(
      safeMjs.includes("script requires exactly 1"),
      "Should explain that the script needs threshold of exactly 1"
    );
  });

  it("should mention the transaction would revert on-chain", () => {
    assert.ok(
      safeMjs.includes("revert on-chain"),
      "Error message should warn about on-chain revert"
    );
  });

  it("should suggest Safe web interface for multi-sig", () => {
    assert.ok(
      safeMjs.includes("app.safe.global"),
      "Should suggest Safe web UI for multi-sig transactions"
    );
  });

  it("should show confirmation when threshold is valid", () => {
    assert.ok(
      safeMjs.includes("Threshold is 1 (single-signer execution)"),
      "Should print confirmation when threshold === 1"
    );
  });
});
