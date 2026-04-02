/**
 * Tests for restore-agent.sh
 * Spec: 1C, 1E
 * Note: Tests the bash script via execFileSync("bash", ...)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESTORE_SCRIPT = join(__dirname, "..", "scripts", "restore-agent.sh");
const TEST_ARCHIVE = "/tmp/everclaw-test-restore.tar.zst.age";

function runBash(args = [], opts = {}) {
  return execFileSync("bash", [RESTORE_SCRIPT, ...args], {
    encoding: "utf8",
    timeout: 15000,
    env: { ...process.env, HOME: process.env.HOME, ...opts.env },
    stdio: "pipe",
  });
}

// ── Tests ────────────────────────────────────────────────────────

describe("restore-agent.sh", () => {

  it("should show help with --help", () => {
    const output = runBash(["--help"]);
    assert.match(output, /Usage:/);
    assert.match(output, /--docker/);
    assert.match(output, /--passphrase/);
    assert.match(output, /--force/);
    assert.match(output, /--dry-run/);
  });

  it("should pass bash syntax check", () => {
    execFileSync("bash", ["-n", RESTORE_SCRIPT], { encoding: "utf8" });
  });

  it("should fail with unknown option", () => {
    assert.throws(() => {
      runBash(["--invalid-option"]);
    });
  });

  it("should return valid JSON on --dry-run --json with archive", () => {
    writeFileSync(TEST_ARCHIVE, "fake-archive-content");
    try {
      const output = runBash(["--dry-run", "--json", TEST_ARCHIVE]);
      // Extract JSON (skip banner on stderr)
      const jsonMatch = output.match(/\{[\s\S]*\}/);
      assert.ok(jsonMatch, "Should contain JSON output");
      const json = JSON.parse(jsonMatch[0]);
      assert.equal(json.ok, true);
      assert.equal(json.dryRun, true);
      assert.ok(json.archive);
      assert.ok(json.targetPlatform);
      assert.equal(typeof json.encrypted, "boolean");
      assert.equal(typeof json.existingInstallation, "boolean");
      assert.ok(Array.isArray(json.depsInstalled));
      assert.ok(Array.isArray(json.depsMissing));
      assert.equal(typeof json.docker, "boolean");
      assert.equal(json.supportsDockerRestore, true);
      assert.equal(typeof json.includesWallet, "boolean");
      assert.ok(json.migrationNotePath);
    } finally {
      try { unlinkSync(TEST_ARCHIVE); } catch { /* ignore */ }
    }
  });

  it("--dry-run should detect encrypted archive by extension", () => {
    writeFileSync(TEST_ARCHIVE, "test");
    try {
      const output = runBash(["--dry-run", "--json", TEST_ARCHIVE]);
      const json = JSON.parse(output.match(/\{[\s\S]*\}/)[0]);
      assert.equal(json.encrypted, true);
    } finally {
      try { unlinkSync(TEST_ARCHIVE); } catch { /* ignore */ }
    }
  });

  it("--dry-run should detect unencrypted archive", () => {
    const unencrypted = "/tmp/everclaw-test-restore.tar.zst";
    writeFileSync(unencrypted, "test");
    try {
      const output = runBash(["--dry-run", "--json", unencrypted]);
      const json = JSON.parse(output.match(/\{[\s\S]*\}/)[0]);
      assert.equal(json.encrypted, false);
    } finally {
      try { unlinkSync(unencrypted); } catch { /* ignore */ }
    }
  });

  it("--dry-run should report missing deps", () => {
    writeFileSync(TEST_ARCHIVE, "test");
    try {
      const output = runBash(["--dry-run", "--json", TEST_ARCHIVE]);
      const json = JSON.parse(output.match(/\{[\s\S]*\}/)[0]);
      // age is likely missing on test systems
      const allDeps = [...json.depsInstalled, ...json.depsMissing];
      assert.ok(allDeps.includes("age") || allDeps.includes("zstd"), "Should check for age or zstd");
    } finally {
      try { unlinkSync(TEST_ARCHIVE); } catch { /* ignore */ }
    }
  });

  it("should fail gracefully when archive not found", () => {
    assert.throws(() => {
      runBash(["--dry-run", "--json", "/tmp/nonexistent-everclaw-backup.tar.zst.age"]);
    });
  });

  it("--dry-run with --docker should set docker mode", () => {
    writeFileSync(TEST_ARCHIVE, "test");
    try {
      const output = runBash(["--dry-run", "--json", "--docker", TEST_ARCHIVE]);
      const json = JSON.parse(output.match(/\{[\s\S]*\}/)[0]);
      assert.equal(json.docker, true);
      assert.equal(json.mode, "docker");
    } finally {
      try { unlinkSync(TEST_ARCHIVE); } catch { /* ignore */ }
    }
  });

  it("should require passphrase in non-TTY mode", () => {
    writeFileSync(TEST_ARCHIVE, "test");
    try {
      assert.throws(() => {
        runBash([TEST_ARCHIVE], { env: { TERM: "" } });
      }, /[Pp]assphrase/);
    } finally {
      try { unlinkSync(TEST_ARCHIVE); } catch { /* ignore */ }
    }
  });

  it("should show version in banner", () => {
    writeFileSync(TEST_ARCHIVE, "test");
    try {
      const output = runBash(["--dry-run", TEST_ARCHIVE]);
      assert.match(output, /v2026/);
    } finally {
      try { unlinkSync(TEST_ARCHIVE); } catch { /* ignore */ }
    }
  });

  it("human-readable dry-run should show target platform", () => {
    writeFileSync(TEST_ARCHIVE, "test");
    try {
      const output = runBash(["--dry-run", TEST_ARCHIVE]);
      assert.match(output, /Platform:/);
      assert.match(output, /Dependencies:/);
    } finally {
      try { unlinkSync(TEST_ARCHIVE); } catch { /* ignore */ }
    }
  });
});
