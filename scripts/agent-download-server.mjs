#!/usr/bin/env node

/**
 * agent-download-server.mjs — Temporary file server for agent download
 *
 * Serves a single encrypted archive file via HTTP with:
 * - Single-use UUIDv4 token authentication
 * - CORS support (3-tier: config → Origin → localhost)
 * - 15-minute auto-shutdown
 * - PID file for process management
 * - Streaming file delivery (no memory buffering)
 *
 * Spec: memory/planning/agent-download-server-1A-spec.md (v1A-rev2)
 */

import { createServer } from "node:http";
import { createReadStream, existsSync, statSync, unlinkSync, writeFileSync, readFileSync } from "node:fs";
import { basename, resolve, join, dirname } from "node:path";
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Import secure file deletion from shared lib
import { shredFile } from "./lib/encryption.mjs";

// ── Constants ────────────────────────────────────────────────────────
const PORT = 18790;
const TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const PID_FILE = "/tmp/everclaw-download-server.pid";
const LOCALHOST_ORIGINS = ["http://localhost:18789", "https://localhost:18789"];

// ── CLI Parsing ──────────────────────────────────────────────────────
const { values: args } = parseArgs({
  options: {
    token:            { type: "string" },
    file:             { type: "string" },
    "public-base-url": { type: "string", default: "" },
    help:             { type: "boolean", short: "h", default: false },
  },
  strict: true,
});

if (args.help) {
  console.log(`Usage: node agent-download-server.mjs --token <uuid> --file <path> [--public-base-url <url>]

Options:
  --token <uuid>            Single-use download token (UUIDv4)
  --file <path>             Path to the encrypted archive file
  --public-base-url <url>   Public URL hint (logged, not used by server)
  -h, --help                Show this help`);
  process.exit(0);
}

if (!args.token || !args.file) {
  console.error("ERROR: --token and --file are required");
  process.exit(1);
}

const TOKEN = args.token;
const FILE_PATH = resolve(args.file);

if (!existsSync(FILE_PATH)) {
  console.error(`ERROR: File not found: ${FILE_PATH}`);
  process.exit(1);
}

const FILE_STAT = statSync(FILE_PATH);
const FILE_NAME = basename(FILE_PATH);
const FILE_SIZE = FILE_STAT.size;

if (FILE_SIZE > 1024 * 1024 * 1024) {
  console.error(`WARNING: Large file (${(FILE_SIZE / 1024 / 1024 / 1024).toFixed(2)} GB). Streaming delivery recommended.`);
}

// ── State ────────────────────────────────────────────────────────────
let tokenUsed = false;
let shutdownTimer = null;

// ── PID File ─────────────────────────────────────────────────────────

function cleanStalePid() {
  if (!existsSync(PID_FILE)) return;
  try {
    const oldPid = parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
    if (isNaN(oldPid)) {
      unlinkSync(PID_FILE);
      return;
    }
    // Check if process is alive
    try {
      process.kill(oldPid, 0);
      // Process alive — another server is running
      console.error(`ERROR: Another download server is running (PID ${oldPid}). Kill it first or wait for timeout.`);
      process.exit(4);
    } catch {
      // Process dead — stale PID file, clean it up
      console.error(`Cleaning stale PID file (PID ${oldPid} is dead)`);
      unlinkSync(PID_FILE);
    }
  } catch {
    // PID file unreadable, remove it
    try { unlinkSync(PID_FILE); } catch { /* ignore */ }
  }
}

function writePid() {
  writeFileSync(PID_FILE, String(process.pid), { mode: 0o600 });
}

function removePid() {
  try { unlinkSync(PID_FILE); } catch { /* ignore */ }
}

cleanStalePid();
writePid();

// ── CORS (3-tier) ─────────────────────────────────────────────────────

function loadGatewayOrigin() {
  // Tier 1: Read gateway.remote.url from openclaw.json
  try {
    const configPath = join(homedir(), ".openclaw", "openclaw.json");
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      const remoteUrl = config?.gateway?.remote?.url;
      if (remoteUrl) {
        // Extract origin (scheme + host, no path)
        const url = new URL(remoteUrl);
        return url.origin;
      }
    }
  } catch { /* ignore parse errors */ }
  return null;
}

const gatewayOrigin = loadGatewayOrigin();

function getAllowedOrigin(requestOrigin) {
  if (!requestOrigin) return null;

  // Tier 1: Gateway config origin
  if (gatewayOrigin && requestOrigin === gatewayOrigin) return requestOrigin;

  // Tier 2: Dynamic — reflect Origin if it looks like the same host
  // (covers Tailscale, port differences, etc.)
  try {
    const reqUrl = new URL(requestOrigin);
    if (gatewayOrigin) {
      const gwUrl = new URL(gatewayOrigin);
      if (reqUrl.hostname === gwUrl.hostname) return requestOrigin;
    }
  } catch { /* invalid origin URL */ }

  // Tier 3: Always allow localhost:18789
  if (LOCALHOST_ORIGINS.includes(requestOrigin)) return requestOrigin;

  return null;
}

function setCorsHeaders(res, req) {
  const origin = req.headers.origin;
  const allowed = getAllowedOrigin(origin);
  if (allowed) {
    res.setHeader("Access-Control-Allow-Origin", allowed);
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Vary", "Origin");
  }
}

// ── Cleanup & Shutdown ─────────────────────────────────────────────

function cleanup(deleteArchive = true) {
  if (shutdownTimer) clearTimeout(shutdownTimer);
  removePid();
  if (deleteArchive) {
    try {
      shredFile(FILE_PATH);
      console.error(`Securely deleted archive: ${FILE_PATH}`);
    } catch {
      // Fallback: plain unlink if shred fails
      try { unlinkSync(FILE_PATH); } catch { /* already gone */ }
      console.error(`Deleted archive (plain unlink): ${FILE_PATH}`);
    }
  }
}

function shutdown(reason, deleteArchive = true) {
  console.error(`Shutting down: ${reason}`);
  cleanup(deleteArchive);
  process.exit(0);
}

// ── HTTP Server ─────────────────────────────────────────────────────

const server = createServer((req, res) => {
  setCorsHeaders(res, req);

  // Preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health / status check (support both endpoints)
  if (req.url === "/health" || req.url === "/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, tokenUsed, pid: process.pid }));
    return;
  }

  // Only GET and HEAD allowed
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  // Extract token from URL path: /<token>
  const requestToken = (req.url || "").replace(/^\//, "").split("?")[0];

  // Validate token
  if (requestToken !== TOKEN) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid token" }));
    return;
  }

  // Token already used (single-use)
  if (tokenUsed) {
    res.writeHead(410, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Download link already used. Request a new backup." }));
    return;
  }

  // Mark token as used BEFORE starting download
  tokenUsed = true;

  // HEAD request — just return headers
  if (req.method === "HEAD") {
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${FILE_NAME}"`,
      "Content-Length": FILE_SIZE,
    });
    res.end();
    // Don't shutdown on HEAD — let the actual GET happen
    tokenUsed = false;
    return;
  }

  // GET — stream the file
  console.error(`Download started: ${FILE_NAME} (${(FILE_SIZE / 1024 / 1024).toFixed(1)} MB)`);

  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename="${FILE_NAME}"`,
    "Content-Length": FILE_SIZE,
  });

  const stream = createReadStream(FILE_PATH);

  stream.on("error", (err) => {
    console.error(`Stream error: ${err.message}`);
    res.destroy();
    shutdown("stream error");
  });

  stream.pipe(res);

  res.on("finish", () => {
    console.error(`Download complete: ${FILE_NAME}`);
    shutdown("download complete");
  });

  res.on("close", () => {
    if (!res.writableFinished) {
      console.error("Client disconnected before download finished");
      // Don't delete archive if download was incomplete — user may retry
      // But token is used, so they need a new export
      shutdown("client disconnected");
    }
  });
});

// ── Start Server ────────────────────────────────────────────────────

server.listen(PORT, "0.0.0.0", () => {
  console.error(`Download server listening on port ${PORT}`);
  console.error(`Token: ${TOKEN}`);
  console.error(`File: ${FILE_NAME} (${(FILE_SIZE / 1024 / 1024).toFixed(1)} MB)`);
  console.error(`PID: ${process.pid}`);
  console.error(`Auto-shutdown in ${TIMEOUT_MS / 60000} minutes`);
  if (args["public-base-url"]) {
    console.error(`Public URL hint: ${args["public-base-url"]}`);
  }
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`ERROR: Port ${PORT} is already in use`);
    removePid();
    process.exit(4);
  }
  console.error(`Server error: ${err.message}`);
  cleanup(false);
  process.exit(4);
});

// ── Auto-Shutdown Timer ────────────────────────────────────────────

shutdownTimer = setTimeout(() => {
  shutdown("timeout (15 minutes)");
}, TIMEOUT_MS);

// Don't let the timer keep the process alive if server closes
shutdownTimer.unref?.();

// ── Graceful Shutdown ──────────────────────────────────────────────

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
