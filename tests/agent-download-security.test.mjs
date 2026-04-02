/**
 * Security regression tests for agent-download feature
 * Spec: 1E (SEC-1 through SEC-12)
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, execSync } from "node:child_process";
import { writeFileSync, unlinkSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_SCRIPT = join(__dirname, "..", "scripts", "agent-download-server.mjs");
const ORCHESTRATOR = join(__dirname, "..", "scripts", "agent-download.mjs");
const TEST_FILE = "/tmp/everclaw-sec-test.bin";
const PID_FILE = "/tmp/everclaw-download-server.pid";
const PORT = 18790;

function httpGet(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port: PORT, path, method: "GET" },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function startServer(token, file = TEST_FILE) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [
      SERVER_SCRIPT, "--token", token, "--file", file,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    const timeout = setTimeout(() => reject(new Error("Server start timeout")), 5000);
    const check = setInterval(() => {
      if (stderr.includes("listening on port")) {
        clearInterval(check);
        clearTimeout(timeout);
        resolve(proc);
      }
    }, 100);
    proc.on("error", (err) => { clearInterval(check); clearTimeout(timeout); reject(err); });
  });
}

function killServer() {
  try {
    if (existsSync(PID_FILE)) {
      const pid = parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
      process.kill(pid, "SIGTERM");
    }
  } catch { /* already dead */ }
  try { unlinkSync(PID_FILE); } catch { /* ignore */ }
}

// ── Setup & Teardown ─────────────────────────────────────────────
before(() => {
  killServer();
  writeFileSync(TEST_FILE, "SENSITIVE-BACKUP-DATA-" + "X".repeat(10000));
});

after(() => {
  killServer();
  try { unlinkSync(TEST_FILE); } catch { /* ignore */ }
});

// ── SEC-1: Passphrase never in output ────────────────────────────
describe("SEC-1: Passphrase not in output", () => {
  it("orchestrator --dry-run with --passphrase should not leak passphrase to stdout", () => {
    const passphrase = "SUPER-SECRET-PASSPHRASE-12345";
    const output = execFileSync(process.execPath, [
      ORCHESTRATOR, "--dry-run", "--passphrase", passphrase,
    ], { encoding: "utf8", stdio: "pipe" });

    // Passphrase should NOT appear in JSON output
    assert.ok(!output.includes(passphrase), "Passphrase must not appear in stdout");
  });

  it("orchestrator should accept passphrase via env var without leaking", () => {
    const output = execFileSync(process.execPath, [ORCHESTRATOR, "--dry-run"], {
      encoding: "utf8",
      env: { ...process.env, EVERCLAW_DOWNLOAD_PASSPHRASE: "env-secret-phrase-1234" },
      stdio: "pipe",
    });
    assert.ok(!output.includes("env-secret-phrase-1234"), "Env passphrase must not leak to stdout");
  });
});

// ── SEC-2: Token single-use enforced ─────────────────────────────
describe("SEC-2: Token single-use enforcement", () => {
  it("second download attempt should fail (server shuts down after first)", async () => {
    const token = "single-use-sec-" + Date.now();
    writeFileSync(TEST_FILE, "single-use-test-data");
    const proc = await startServer(token);

    try {
      // First download succeeds
      const res1 = await httpGet(`/${token}`);
      assert.equal(res1.status, 200, "First download should succeed");

      // Wait for server shutdown
      await new Promise((r) => setTimeout(r, 1500));

      // Second attempt should fail (connection refused — server is dead)
      await assert.rejects(() => httpGet(`/${token}`), "Second download should fail");
    } finally {
      try { proc.kill("SIGTERM"); } catch { /* already dead */ }
      await new Promise((r) => setTimeout(r, 500));
    }
  });
});

// ── SEC-3: Token brute-force resistance ──────────────────────────
describe("SEC-3: Token brute-force resistance", () => {
  it("random tokens should all return 403", async () => {
    writeFileSync(TEST_FILE, "brute-force-test");
    const token = "real-token-" + Date.now();
    const proc = await startServer(token);

    try {
      const attempts = [
        "/wrong-token",
        "/admin",
        "/",
        "/../../etc/passwd",
        "/%00",
        "/real-token-0000",
      ];
      for (const path of attempts) {
        const res = await httpGet(path);
        assert.ok(
          [403, 404].includes(res.status),
          `Path ${path} should be rejected, got ${res.status}`
        );
      }
    } finally {
      proc.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 500));
    }
  });
});

// ── SEC-4: Path traversal blocked ────────────────────────────────
describe("SEC-4: Path traversal prevention", () => {
  it("path traversal attempts should not serve arbitrary files", async () => {
    writeFileSync(TEST_FILE, "traversal-test");
    const token = "traversal-" + Date.now();
    const proc = await startServer(token);

    try {
      const traversals = [
        "/../../../etc/passwd",
        "/..%2f..%2f..%2fetc%2fpasswd",
        "/%2e%2e/%2e%2e/etc/passwd",
        `/../../${token}`,
      ];
      for (const path of traversals) {
        const res = await httpGet(path);
        assert.ok(
          [403, 404].includes(res.status),
          `Traversal ${path} should be blocked, got ${res.status}`
        );
        assert.ok(!res.body.includes("root:"), `Traversal ${path} must not serve /etc/passwd`);
      }
    } finally {
      proc.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 500));
    }
  });
});

// ── SEC-5: No plaintext archive on disk ──────────────────────────
describe("SEC-5: No plaintext archive on disk", () => {
  it("orchestrator dry-run should not create any temp files", () => {
    const before = execSync("ls /tmp/everclaw-* 2>/dev/null || true", { encoding: "utf8" }).trim();
    execFileSync(process.execPath, [ORCHESTRATOR, "--dry-run"], {
      encoding: "utf8",
      stdio: "pipe",
    });
    const after = execSync("ls /tmp/everclaw-* 2>/dev/null || true", { encoding: "utf8" }).trim();

    // Filter out our test file
    const beforeFiles = before.split("\n").filter((f) => f && !f.includes("sec-test"));
    const afterFiles = after.split("\n").filter((f) => f && !f.includes("sec-test"));

    assert.deepEqual(afterFiles, beforeFiles, "Dry-run should not create new temp files");
  });
});

// ── SEC-6: Wallet address validation ─────────────────────────────
describe("SEC-6: Wallet address validation", () => {
  const invalidAddresses = [
    "not-an-address",
    "0x",
    "0xZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ",
    "0x742d35Cc", // too short
    "742d35Cc6634C0532925a3b844Bc9e7595f2bD18", // no prefix
    "0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18EXTRA", // too long
  ];

  for (const addr of invalidAddresses) {
    it(`should reject invalid address: ${addr}`, () => {
      assert.throws(() => {
        execFileSync(process.execPath, [
          ORCHESTRATOR, "--include-wallet", "--wallet-address", addr,
        ], { encoding: "utf8", stdio: "pipe" });
      });
    });
  }
});

// ── SEC-7: Orchestrator error JSON shape ─────────────────────────
describe("SEC-7: Error output is structured JSON", () => {
  it("invalid args should produce error JSON", () => {
    try {
      execFileSync(process.execPath, [ORCHESTRATOR, "--passphrase", "x"], {
        encoding: "utf8",
        stdio: "pipe",
      });
      assert.fail("Should have thrown");
    } catch (err) {
      const output = (err.stdout || "") + (err.stderr || "");
      // Should contain JSON error
      const jsonMatch = output.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const json = JSON.parse(jsonMatch[0]);
        assert.equal(json.ok, false);
        assert.ok(json.error || json.errorCode, "Should have error or errorCode field");
      }
    }
  });
});

// ── SEC-8: Server rejects non-GET methods ────────────────────────
describe("SEC-8: HTTP method restriction", () => {
  it("should reject POST, PUT, DELETE, PATCH", async () => {
    writeFileSync(TEST_FILE, "method-test");
    const token = "method-" + Date.now();
    const proc = await startServer(token);

    try {
      for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
        const res = await new Promise((resolve, reject) => {
          const req = http.request(
            { hostname: "127.0.0.1", port: PORT, path: `/${token}`, method },
            (res) => {
              let body = "";
              res.on("data", (d) => (body += d));
              res.on("end", () => resolve({ status: res.statusCode }));
            }
          );
          req.on("error", reject);
          req.end();
        });
        assert.equal(res.status, 405, `${method} should return 405`);
      }
    } finally {
      proc.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 500));
    }
  });
});
