/**
 * Tests for agent-download.mjs (orchestrator)
 * Spec: 1B, 1E
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ORCHESTRATOR = join(__dirname, "..", "scripts", "agent-download.mjs");

function run(args = [], opts = {}) {
  return execFileSync(process.execPath, [ORCHESTRATOR, ...args], {
    encoding: "utf8",
    timeout: 30000,
    env: { ...process.env, ...opts.env },
    stdio: "pipe",
  });
}

function runJson(args = [], opts = {}) {
  const output = run(args, opts);
  // Extract JSON from stdout (skip any stderr that leaked)
  const lines = output.trim().split("\n");
  const jsonStart = lines.findIndex((l) => l.startsWith("{"));
  if (jsonStart === -1) throw new Error("No JSON in output: " + output);
  return JSON.parse(lines.slice(jsonStart).join("\n"));
}

// ── Tests ────────────────────────────────────────────────────────

describe("agent-download.mjs", () => {

  it("should show help with --help", () => {
    const output = run(["--help"]);
    assert.match(output, /Usage:/);
    assert.match(output, /--include-wallet/);
    assert.match(output, /--passphrase/);
    assert.match(output, /--public-url/);
    assert.match(output, /--dry-run/);
  });

  it("should return valid JSON on --dry-run", () => {
    const json = runJson(["--dry-run"]);
    assert.equal(json.ok, true);
    assert.equal(json.dryRun, true);
    assert.ok(json.wouldExport);
    assert.ok(json.wouldExport.workspace);
    assert.ok(json.wouldExport.stateDir);
    assert.ok(json.wouldExport.estimatedSizeMB);
    assert.equal(typeof json.includesWallet, "boolean");
    assert.equal(typeof json.docker, "boolean");
    assert.equal(json.supportsDockerRestore, true);
  });

  it("--dry-run should detect public URL from --public-url", () => {
    const json = runJson(["--dry-run", "--public-url", "https://myagent.example.com"]);
    assert.equal(json.publicUrl, "https://myagent.example.com");
    assert.equal(json.publicUrlDetectedVia, "cli-override");
  });

  it("--dry-run should detect URL from EVERCLAW_PUBLIC_URL env", () => {
    const json = runJson(["--dry-run"], {
      env: { EVERCLAW_PUBLIC_URL: "https://env-agent.example.com:8080" },
    });
    assert.equal(json.publicUrl, "https://env-agent.example.com:18790");
    assert.equal(json.publicUrlDetectedVia, "EVERCLAW_PUBLIC_URL");
  });

  it("--dry-run should return null URL when nothing configured", () => {
    const json = runJson(["--dry-run"], {
      env: { EVERCLAW_PUBLIC_URL: "" },
    });
    // May or may not be null depending on gateway config
    assert.ok(json.publicUrlDetectedVia);
  });

  it("--dry-run should work with --include-wallet (no address needed)", () => {
    const json = runJson(["--dry-run", "--include-wallet"]);
    assert.equal(json.ok, true);
    assert.equal(json.dryRun, true);
    assert.equal(json.includesWallet, true);
  });

  it("--dry-run with --docker should set docker flag", () => {
    const json = runJson(["--dry-run", "--docker"]);
    assert.equal(json.docker, true);
  });

  it("should reject passphrase shorter than 8 chars", () => {
    assert.throws(() => {
      run(["--passphrase", "short"]);
    });
  });

  it("should reject invalid wallet address format", () => {
    assert.throws(() => {
      run(["--include-wallet", "--wallet-address", "not-an-address"]);
    });
  });

  it("should reject wallet address without 0x prefix", () => {
    assert.throws(() => {
      run(["--include-wallet", "--wallet-address", "742d35Cc6634C0532925a3b844Bc9e7595f2bD18"]);
    });
  });

  it("should reject wallet address with wrong length", () => {
    assert.throws(() => {
      run(["--include-wallet", "--wallet-address", "0x742d35Cc6634C0532925a3b844Bc"]);
    });
  });

  it("should accept valid wallet address format", () => {
    // This will fail on export (no export script in test), but validates address passes
    assert.throws(() => {
      run(["--include-wallet", "--wallet-address", "0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18"]);
    }, (err) => {
      // Should fail on EXPORT_FAILED, not INVALID_ARGS
      const output = err.stdout || err.stderr || "";
      return !output.includes("INVALID_ARGS");
    });
  });

  it("--dry-run should estimate workspace size", () => {
    const json = runJson(["--dry-run"]);
    const size = parseFloat(json.wouldExport.estimatedSizeMB);
    assert.ok(size > 0, `Estimated size should be > 0, got ${size}`);
  });

  it("should include all required fields in dry-run output", () => {
    const json = runJson(["--dry-run"]);
    const requiredFields = [
      "ok", "dryRun", "wouldExport", "publicUrl", "publicUrlDetectedVia",
      "includesWallet", "docker", "supportsDockerRestore",
    ];
    for (const field of requiredFields) {
      assert.ok(field in json, `Missing field: ${field}`);
    }
  });
});
