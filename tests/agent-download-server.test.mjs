/**
 * Tests for agent-download-server.mjs
 * Spec: 1A, 1E (SEC-1 through SEC-12)
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_SCRIPT = join(__dirname, "..", "scripts", "agent-download-server.mjs");
const PID_FILE = "/tmp/everclaw-download-server.pid";
const TEST_FILE = "/tmp/everclaw-test-download.bin";
const TEST_TOKEN = "test-token-" + Date.now();
const PORT = 18790;

// Helper: HTTP request
function httpGet(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port: PORT, path, method: "GET", headers },
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

function httpHead(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port: PORT, path, method: "HEAD" },
      (res) => {
        res.on("data", () => {});
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function httpOptions(path, origin) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port: PORT, path, method: "OPTIONS", headers: { Origin: origin } },
      (res) => {
        res.on("data", () => {});
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

// Helper: start server and wait for ready
function startServer(token = TEST_TOKEN, file = TEST_FILE) {
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
  // Create a small test file
  writeFileSync(TEST_FILE, "Hello EverClaw backup test content!\n".repeat(100));
});

after(() => {
  killServer();
  try { unlinkSync(TEST_FILE); } catch { /* ignore */ }
});

// ── Tests ────────────────────────────────────────────────────────

describe("agent-download-server.mjs", () => {

  it("should show help with --help", () => {
    const output = execFileSync(process.execPath, [SERVER_SCRIPT, "--help"], { encoding: "utf8" });
    assert.match(output, /Usage:/);
    assert.match(output, /--token/);
    assert.match(output, /--file/);
  });

  it("should fail without --token and --file", () => {
    assert.throws(() => {
      execFileSync(process.execPath, [SERVER_SCRIPT], { encoding: "utf8", stdio: "pipe" });
    });
  });

  it("should fail with missing file", () => {
    assert.throws(() => {
      execFileSync(process.execPath, [SERVER_SCRIPT, "--token", "abc", "--file", "/tmp/nonexistent-file"], {
        encoding: "utf8", stdio: "pipe",
      });
    });
  });

  it("should create PID file on startup", async () => {
    const proc = await startServer();
    try {
      assert.ok(existsSync(PID_FILE), "PID file should exist");
      const pid = parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
      assert.ok(!isNaN(pid), "PID should be a number");
      assert.ok(pid > 0, "PID should be positive");
    } finally {
      proc.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 500));
    }
  });

  it("should respond to /health", async () => {
    writeFileSync(TEST_FILE, "health-test-content");
    const proc = await startServer();
    try {
      const res = await httpGet("/health");
      assert.equal(res.status, 200);
      const json = JSON.parse(res.body);
      assert.equal(json.ok, true);
      assert.equal(json.tokenUsed, false);
    } finally {
      proc.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 500));
    }
  });

  it("should respond to /status", async () => {
    writeFileSync(TEST_FILE, "status-test-content");
    const proc = await startServer();
    try {
      const res = await httpGet("/status");
      assert.equal(res.status, 200);
      const json = JSON.parse(res.body);
      assert.equal(json.ok, true);
    } finally {
      proc.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 500));
    }
  });

  it("should return 403 for wrong token", async () => {
    writeFileSync(TEST_FILE, "wrong-token-test");
    const proc = await startServer();
    try {
      const res = await httpGet("/wrong-token-value");
      assert.equal(res.status, 403);
      const json = JSON.parse(res.body);
      assert.match(json.error, /[Ii]nvalid token/);
    } finally {
      proc.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 500));
    }
  });

  it("should return 405 for POST", async () => {
    writeFileSync(TEST_FILE, "post-test");
    const proc = await startServer();
    try {
      const res = await new Promise((resolve, reject) => {
        const req = http.request(
          { hostname: "127.0.0.1", port: PORT, path: `/${TEST_TOKEN}`, method: "POST" },
          (res) => {
            let body = "";
            res.on("data", (d) => (body += d));
            res.on("end", () => resolve({ status: res.statusCode, body }));
          }
        );
        req.on("error", reject);
        req.end();
      });
      assert.equal(res.status, 405);
    } finally {
      proc.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 500));
    }
  });

  it("should serve file with correct token and shut down", async () => {
    const content = "download-test-content-" + Date.now();
    writeFileSync(TEST_FILE, content);
    const proc = await startServer();
    try {
      const res = await httpGet(`/${TEST_TOKEN}`);
      assert.equal(res.status, 200);
      assert.equal(res.body, content);
      assert.match(res.headers["content-disposition"], /attachment/);
      // Server should shut down after download
      await new Promise((r) => setTimeout(r, 1000));
      assert.ok(!existsSync(PID_FILE), "PID file should be cleaned up after download");
    } finally {
      try { proc.kill("SIGTERM"); } catch { /* already dead */ }
      await new Promise((r) => setTimeout(r, 500));
    }
  });

  it("should return 410 on second use of token", async () => {
    const content = "single-use-test-" + Date.now();
    writeFileSync(TEST_FILE, content);
    const token = "single-use-" + Date.now();
    const proc = await startServer(token);
    try {
      // First request succeeds
      const res1 = await httpGet(`/${token}`);
      assert.equal(res1.status, 200);
      // Server shuts down after first download, so second request should fail
      await new Promise((r) => setTimeout(r, 1000));
      // Server should be dead — connection refused
      await assert.rejects(() => httpGet(`/${token}`));
    } finally {
      try { proc.kill("SIGTERM"); } catch { /* already dead */ }
      await new Promise((r) => setTimeout(r, 500));
    }
  });

  it("should handle HEAD without consuming token", async () => {
    writeFileSync(TEST_FILE, "head-test-content");
    const proc = await startServer();
    try {
      const headRes = await httpHead(`/${TEST_TOKEN}`);
      assert.equal(headRes.status, 200);
      assert.ok(headRes.headers["content-length"]);
      // Token should NOT be consumed — health should show tokenUsed=false
      const healthRes = await httpGet("/health");
      const json = JSON.parse(healthRes.body);
      assert.equal(json.tokenUsed, false);
    } finally {
      proc.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 500));
    }
  });

  it("should handle CORS preflight for localhost origin", async () => {
    writeFileSync(TEST_FILE, "cors-test");
    const proc = await startServer();
    try {
      const res = await httpOptions("/", "http://localhost:18789");
      assert.equal(res.status, 204);
      assert.equal(res.headers["access-control-allow-origin"], "http://localhost:18789");
    } finally {
      proc.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 500));
    }
  });

  it("should NOT set CORS for unknown origins", async () => {
    writeFileSync(TEST_FILE, "cors-block-test");
    const proc = await startServer();
    try {
      const res = await httpGet("/health", { Origin: "https://evil.com" });
      assert.equal(res.status, 200);
      assert.equal(res.headers["access-control-allow-origin"], undefined);
    } finally {
      proc.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 500));
    }
  });

  it("should clean up PID file on SIGTERM", async () => {
    writeFileSync(TEST_FILE, "sigterm-test");
    const proc = await startServer();
    assert.ok(existsSync(PID_FILE));
    proc.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 1000));
    assert.ok(!existsSync(PID_FILE), "PID file should be removed after SIGTERM");
  });
});
