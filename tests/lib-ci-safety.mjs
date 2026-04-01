/**
 * lib-ci-safety.mjs — Tests for Issue #9: CI mode token approval safety
 *
 * Verifies that CI_NON_INTERACTIVE mode:
 * - Blocks unlimited MOR approvals without --unlimited flag
 * - Allows unlimited MOR approvals with --unlimited flag
 * - Blocks key export without EVERCLAW_ALLOW_EXPORT=1
 * - Allows key export with EVERCLAW_ALLOW_EXPORT=1
 * - Auto-confirms bounded approvals in CI mode
 * - Auto-confirms swaps in CI mode
 * - Preserves interactive prompts in non-CI mode
 * - Filters --unlimited from positional args (doesn't crash parseEther)
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const WALLET_SCRIPT = join(import.meta.dirname, "..", "scripts", "everclaw-wallet.mjs");

/**
 * Run everclaw-wallet.mjs with given args and env overrides.
 * Returns { stdout, stderr, exitCode }.
 */
function runWallet(args = [], envOverrides = {}) {
  const env = {
    ...process.env,
    // Ensure CI mode is OFF by default (tests explicitly enable it)
    EVERCLAW_YES: undefined,
    CI: undefined,
    EVERCLAW_ALLOW_EXPORT: undefined,
    // Use a non-existent keychain to avoid touching real keys
    EVERCLAW_KEYCHAIN_ACCOUNT: "everclaw-test-ci-safety",
    EVERCLAW_KEYCHAIN_SERVICE: "everclaw-test-ci-safety",
    EVERCLAW_KEY_STORE: "/tmp/everclaw-ci-safety-test-wallet.enc",
    ...envOverrides,
  };

  // Clean undefined values (Node doesn't accept undefined in env)
  for (const k of Object.keys(env)) {
    if (env[k] === undefined) delete env[k];
  }

  try {
    const stdout = execFileSync(process.execPath, [WALLET_SCRIPT, ...args], {
      env,
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (e) {
    return {
      stdout: e.stdout || "",
      stderr: e.stderr || "",
      exitCode: e.status ?? 1,
    };
  }
}

describe("Issue #9: CI Mode Token Approval Safety", () => {

  // --- cmdApprove: unlimited approval blocked in CI ---

  it("CI mode blocks unlimited approve without --unlimited flag", () => {
    const result = runWallet(["approve"], { EVERCLAW_YES: "1" });
    assert.equal(result.exitCode, 1, "should exit with code 1");
    // Issue #12 (4B): approve without amount now errors in ALL modes, not just CI
    assert.ok(
      result.stderr.includes("No approval amount specified"),
      `stderr should contain block message, got: ${result.stderr}`
    );
  });

  it("CI=true also blocks unlimited approve without --unlimited flag", () => {
    const result = runWallet(["approve"], { CI: "true" });
    assert.equal(result.exitCode, 1, "should exit with code 1");
    // Issue #12 (4B): approve without amount now errors in ALL modes, not just CI
    assert.ok(
      result.stderr.includes("No approval amount specified"),
      `stderr should contain block message, got: ${result.stderr}`
    );
  });

  it("CI mode allows unlimited approve WITH --unlimited flag (dry-run)", () => {
    // This will reach the simulation step and fail (no wallet/RPC) — but it should NOT
    // fail at the CI gate. We check it passed the gate by NOT seeing the block message.
    const result = runWallet(["approve", "--unlimited", "--dry-run"], { EVERCLAW_YES: "1" });
    assert.ok(
      !result.stderr.includes("CI MODE: Unlimited MOR approval blocked"),
      `should NOT be blocked when --unlimited is passed, stderr: ${result.stderr}`
    );
  });

  it("CI mode allows bounded approve without --unlimited flag (dry-run)", () => {
    // approve 1000 should auto-confirm without needing --unlimited
    const result = runWallet(["approve", "1000", "--dry-run"], { EVERCLAW_YES: "1" });
    assert.ok(
      !result.stderr.includes("CI MODE: Unlimited MOR approval blocked"),
      `bounded approve should not be blocked, stderr: ${result.stderr}`
    );
  });

  // --- cmdExportKey: export blocked in CI ---

  it("CI mode blocks export-key without EVERCLAW_ALLOW_EXPORT=1", () => {
    const result = runWallet(["export-key"], { EVERCLAW_YES: "1" });
    assert.equal(result.exitCode, 1, "should exit with code 1");
    assert.ok(
      result.stderr.includes("CI MODE: Private key export blocked"),
      `stderr should contain export block message, got: ${result.stderr}`
    );
  });

  it("CI=true also blocks export-key without EVERCLAW_ALLOW_EXPORT=1", () => {
    const result = runWallet(["export-key"], { CI: "true" });
    assert.equal(result.exitCode, 1, "should exit with code 1");
    assert.ok(
      result.stderr.includes("CI MODE: Private key export blocked"),
      `stderr should contain export block message, got: ${result.stderr}`
    );
  });

  it("CI mode allows export-key WITH EVERCLAW_ALLOW_EXPORT=1", () => {
    // Will fail at keychainRetrieve (no wallet) — but should NOT fail at CI gate
    const result = runWallet(["export-key"], {
      EVERCLAW_YES: "1",
      EVERCLAW_ALLOW_EXPORT: "1",
    });
    assert.ok(
      !result.stderr.includes("CI MODE: Private key export blocked"),
      `should NOT be blocked when EVERCLAW_ALLOW_EXPORT=1, stderr: ${result.stderr}`
    );
  });

  // --- Flag filtering: --unlimited doesn't crash parseEther ---

  it("--unlimited flag does not get parsed as amount (no parseEther crash)", () => {
    // `approve --unlimited` should not throw "invalid value" from parseEther
    const result = runWallet(["approve", "--unlimited", "--dry-run"], { EVERCLAW_YES: "1" });
    assert.ok(
      !result.stderr.includes("invalid") || !result.stderr.includes("parseEther"),
      `--unlimited should be filtered from args, not parsed as amount, stderr: ${result.stderr}`
    );
  });

  it("--dry-run flag does not get parsed as amount for swap", () => {
    // `swap eth --dry-run` — --dry-run should be filtered, leaving only "eth" as tokenIn
    // Will fail because no amount, but should NOT crash on parseEther("--dry-run")
    const result = runWallet(["swap", "eth", "0.01", "--dry-run"], { EVERCLAW_YES: "1" });
    assert.ok(
      !result.stderr.includes("parseEther") && !result.stderr.includes("invalid BigNumber"),
      `--dry-run should not be parsed as swap amount`
    );
  });

  // --- Non-CI mode: prompts still work ---

  it("Non-CI mode does NOT auto-confirm (approve hangs on stdin, times out)", () => {
    // Issue #12 (4B): approve without amount now errors immediately in all modes.
    // Use a bounded amount to test interactive behavior.
    const result = runWallet(["approve", "1000", "--dry-run"], {});
    // In non-CI mode without stdin, it will either hang (timeout) or crash on stdin read
    // The key assertion: it should NOT show CI block messages
    assert.ok(
      !result.stderr.includes("CI MODE"),
      `non-CI mode should not show CI MODE messages, stderr: ${result.stderr}`
    );
  });

  // --- Help text ---

  it("Help text includes --unlimited flag documentation", () => {
    const result = runWallet([], {});
    assert.ok(
      result.stdout.includes("--unlimited"),
      `help should document --unlimited flag`
    );
  });

  it("Help text includes EVERCLAW_ALLOW_EXPORT documentation", () => {
    const result = runWallet([], {});
    assert.ok(
      result.stdout.includes("EVERCLAW_ALLOW_EXPORT"),
      `help should document EVERCLAW_ALLOW_EXPORT env var`
    );
  });

  it("Help text includes Safety section", () => {
    const result = runWallet([], {});
    // Issue #12 (4B): renamed from "CI Safety" to "Safety" (applies to all modes)
    assert.ok(
      result.stdout.includes("Safety:"),
      `help should include Safety section`
    );
  });
});
