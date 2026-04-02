#!/usr/bin/env node

/**
 * agent-download.mjs — Export orchestrator for agent download
 *
 * Coordinates the full "download your agent" flow:
 * 1. Generates a secure passphrase (or accepts one)
 * 2. Calls everclaw-export.mjs to create the encrypted archive
 * 3. Detects the public-facing URL for download
 * 4. Spawns agent-download-server.mjs as a detached background process
 * 5. Outputs structured JSON with everything the agent/user needs
 *
 * Spec: memory/planning/agent-download-orchestrator-1B-spec.md (v1B-rev1)
 */

import { randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir, tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Constants ────────────────────────────────────────────────────────
const SERVER_SCRIPT = join(__dirname, "agent-download-server.mjs");
const EXPORT_SCRIPT = join(__dirname, "everclaw-export.mjs");
const PID_FILE = "/tmp/everclaw-download-server.pid";
const TIMEOUT_MINUTES = 15;
const ONE_GB = 1024 * 1024 * 1024;

// ── CLI Parsing ──────────────────────────────────────────────────────
const { values: args } = parseArgs({
  options: {
    "include-wallet":  { type: "boolean", default: false },
    "wallet-address":  { type: "string" },
    passphrase:        { type: "string" },
    "public-url":      { type: "string" },
    "output-dir":      { type: "string", default: tmpdir() },
    docker:            { type: "boolean", default: false },
    "dry-run":         { type: "boolean", default: false },
    json:              { type: "boolean", default: true },
    quiet:             { type: "boolean", short: "q", default: false },
    verbose:           { type: "boolean", short: "v", default: false },
    help:              { type: "boolean", short: "h", default: false },
  },
  strict: true,
});

if (args.help) {
  console.log(`Usage: node agent-download.mjs [options]

Options:
  --include-wallet         Include wallet private key in backup
  --wallet-address <addr>  Wallet address for non-TTY confirmation
  --passphrase <str>       Use provided passphrase (default: auto-generate)
  --public-url <url>       Override public URL detection
  --output-dir <path>      Where to write archive (default: /tmp)
  --docker                 Target is Docker-to-Docker migration
  --dry-run                Show what would happen without doing it
  --json                   Output JSON to stdout (default: true)
  -q, --quiet              Suppress stderr progress
  -v, --verbose            Detailed stderr logging
  -h, --help               Show this help`);
  process.exit(0);
}

// ── Helpers ──────────────────────────────────────────────────────────

function log(msg) {
  if (!args.quiet) console.error(msg);
}

function debug(msg) {
  if (args.verbose) console.error(`[debug] ${msg}`);
}

function outputJson(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

function errorJson(error, message, suggestion, exitCode) {
  outputJson({ ok: false, error, message, suggestion, exitCode });
  process.exit(exitCode);
}

function isDocker() {
  try {
    return existsSync("/.dockerenv") || readFileSync("/proc/1/cgroup", "utf8").includes("docker");
  } catch {
    return false;
  }
}

// ── Public URL Detection (3-tier) ────────────────────────────────────

function detectPublicUrl() {
  // Tier 1: CLI override
  if (args["public-url"]) {
    debug(`URL Tier 1: CLI override → ${args["public-url"]}`);
    return { url: args["public-url"], via: "cli-override" };
  }

  // Tier 2: Gateway config
  try {
    const configPath = join(homedir(), ".openclaw", "openclaw.json");
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      const remoteUrl = config?.gateway?.remote?.url;
      if (remoteUrl) {
        const parsed = new URL(remoteUrl);
        // Always use port 18790 (download server port), keep scheme + hostname from gateway
        const baseUrl = `${parsed.protocol}//${parsed.hostname}:18790`;
        debug(`URL Tier 2: gateway.remote.url → ${baseUrl}`);
        return { url: baseUrl, via: "gateway.remote.url" };
      }
    }
  } catch (err) {
    debug(`URL Tier 2 failed: ${err.message}`);
  }

  // Tier 3: Environment variable
  const envUrl = process.env.EVERCLAW_PUBLIC_URL;
  if (envUrl) {
    try {
      const parsed = new URL(envUrl);
      // Always use port 18790 (download server port), keep scheme + hostname from env
      const baseUrl = `${parsed.protocol}//${parsed.hostname}:18790`;
      debug(`URL Tier 3: EVERCLAW_PUBLIC_URL → ${baseUrl}`);
      return { url: baseUrl, via: "EVERCLAW_PUBLIC_URL" };
    } catch (err) {
      debug(`URL Tier 3 failed: ${err.message}`);
    }
  }

  // Fallback: localhost (dev/testing)
  debug("URL detection: no public URL found");
  return { url: null, via: "none" };
}

// ── Passphrase Generation ─────────────────────────────────────────

function generatePassphrase() {
  // 6-word passphrase from crypto-random word selection
  const words = [
    "alpha", "bravo", "charlie", "delta", "echo", "foxtrot",
    "golf", "hotel", "india", "juliet", "kilo", "lima",
    "mike", "november", "oscar", "papa", "quebec", "romeo",
    "sierra", "tango", "uniform", "victor", "whiskey", "xray",
    "yankee", "zulu", "anvil", "beacon", "cipher", "drift",
    "ember", "flame", "glacier", "harbor", "ivory", "jasper",
    "kernel", "lantern", "marble", "nebula", "orbit", "prism",
    "quartz", "ridge", "summit", "timber", "umbra", "vortex",
    "willow", "zenith", "aurora", "basalt", "coral", "dune",
    "falcon", "grove", "helix", "inlet", "jade", "keystone",
    "lunar", "mesa", "north", "opal", "peak", "rapids",
    "slate", "thorn", "unity", "vale", "wren", "apex",
    "blaze", "crest", "dawn", "frost", "gale", "hawk",
    "iron", "jewel", "knoll", "lark", "mist", "nexus",
    "oak", "pine", "raven", "spark", "tide", "vault",
    "wave", "birch", "cliff", "delta", "elm", "flint",
    "glen", "haven", "isle", "junction",
  ];
  const result = [];
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  for (let i = 0; i < 6; i++) {
    result.push(words[bytes[i] % words.length]);
  }
  return result.join("-");
}

function getPassphrase() {
  if (args.passphrase) {
    if (args.passphrase.length < 8) {
      errorJson("INVALID_ARGS", "Passphrase must be at least 8 characters", "Use a longer passphrase or omit to auto-generate", 1);
    }
    return args.passphrase;
  }
  return generatePassphrase();
}

// ── Archive Naming ───────────────────────────────────────────────

function getArchivePath() {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  let base = `everclaw-backup-${date}.tar.zst.age`;
  let fullPath = join(args["output-dir"], base);

  // Handle collision
  let counter = 1;
  while (existsSync(fullPath)) {
    base = `everclaw-backup-${date}-${counter}.tar.zst.age`;
    fullPath = join(args["output-dir"], base);
    counter++;
  }
  return fullPath;
}

// ── Export Execution ─────────────────────────────────────────────

function runExport(archivePath, passphrase) {
  const exportArgs = [
    EXPORT_SCRIPT,
    "--output", archivePath,
    "--passphrase-from-env",
    "--verify",
    "--no-stop",  // Keep services running during export (Gateway, proxy-router, guardian)
  ];

  if (args["include-wallet"]) {
    exportArgs.push("--include-wallet");
    if (args["wallet-address"]) {
      exportArgs.push("--wallet-address", args["wallet-address"]);
    }
  }

  if (args.quiet) exportArgs.push("--quiet");

  const env = {
    ...process.env,
    EVERCLAW_BACKUP_PASSPHRASE: passphrase,
  };

  debug(`Running export: node ${exportArgs.join(" ")}`);
  log("Creating encrypted backup...");

  try {
    execFileSync(process.execPath, exportArgs, {
      env,
      stdio: args.verbose ? "inherit" : "pipe",
      timeout: 10 * 60 * 1000, // 10 minute timeout for export
    });
  } catch (err) {
    const msg = err.stderr ? err.stderr.toString().trim() : err.message;
    errorJson("EXPORT_FAILED", `Export failed: ${msg}`, "Check disk space and dependencies (age, zstd, tar)", 3);
  }

  // Verify archive exists
  if (!existsSync(archivePath)) {
    errorJson("EXPORT_FAILED", "Archive file not created", "Check everclaw-export.mjs output", 3);
  }

  return statSync(archivePath);
}

// ── Server Spawn ───────────────────────────────────────────────────

function spawnServer(archivePath, token, publicUrl) {
  const serverArgs = [
    SERVER_SCRIPT,
    "--token", token,
    "--file", archivePath,
  ];

  if (publicUrl) {
    serverArgs.push("--public-base-url", publicUrl);
  }

  debug(`Spawning server: node ${serverArgs.join(" ")}`);
  log("Starting download server...");

  const server = spawn(process.execPath, serverArgs, {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });

  server.unref();

  return server.pid;
}

function verifyServer() {
  // Wait 500ms for server to write PID file
  const start = Date.now();
  while (Date.now() - start < 1500) {
    if (existsSync(PID_FILE)) {
      try {
        const pid = parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
        if (!isNaN(pid)) {
          // Check if process is alive
          process.kill(pid, 0);
          debug(`Server verified: PID ${pid}`);
          return pid;
        }
      } catch {
        // Process not alive yet, keep waiting
      }
    }
    // Busy-wait in small increments
    const waitUntil = Date.now() + 100;
    while (Date.now() < waitUntil) { /* spin */ }
  }
  return null;
}

// ── Wallet Pre-Check ──────────────────────────────────────────────

function walletPreCheck() {
  if (!args["include-wallet"]) return;

  // In Docker / non-TTY: require --wallet-address
  if (!process.stdin.isTTY && !args["wallet-address"]) {
    errorJson(
      "WALLET_NO_ADDRESS",
      "--include-wallet requires --wallet-address in non-TTY environments (Docker)",
      "Ask the user for their wallet address first, then pass --wallet-address 0x...",
      6
    );
  }

  // Validate address format if provided
  if (args["wallet-address"]) {
    const addr = args["wallet-address"];
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
      errorJson(
        "INVALID_ARGS",
        `Invalid wallet address: ${addr}`,
        "Wallet address must be 0x followed by 40 hex characters",
        1
      );
    }
  }
}

// ── Dry Run ──────────────────────────────────────────────────────

function dryRun() {
  const { url, via } = detectPublicUrl();

  // Estimate workspace size
  let estimatedMB = "unknown";
  const workspaceDirs = [
    join(homedir(), ".openclaw"),
    join(homedir(), ".morpheus"),
    join(homedir(), ".everclaw"),
  ];

  let totalBytes = 0;
  for (const dir of workspaceDirs) {
    if (existsSync(dir)) {
      try {
        // Quick estimate using du
        const output = execFileSync("du", ["-sb", dir], { encoding: "utf8", timeout: 5000 });
        totalBytes += parseInt(output.split("\t")[0], 10) || 0;
      } catch {
        // du -sb not available on macOS, try -sk
        try {
          const output = execFileSync("du", ["-sk", dir], { encoding: "utf8", timeout: 5000 });
          totalBytes += (parseInt(output.split("\t")[0], 10) || 0) * 1024;
        } catch { /* skip */ }
      }
    }
  }
  estimatedMB = (totalBytes / 1024 / 1024).toFixed(1);

  outputJson({
    ok: true,
    dryRun: true,
    wouldExport: {
      workspace: join(homedir(), ".openclaw", "workspace"),
      stateDir: join(homedir(), ".openclaw"),
      morpheus: join(homedir(), ".morpheus"),
      everclaw: join(homedir(), ".everclaw"),
      estimatedSizeMB: estimatedMB,
    },
    publicUrl: url,
    publicUrlDetectedVia: via,
    includesWallet: args["include-wallet"],
    docker: args.docker,
    supportsDockerRestore: true,
  });
  process.exit(0);
}

// ── Main ──────────────────────────────────────────────────────────

function main() {
  // Dry-run first (before wallet pre-check so --dry-run --include-wallet works in non-TTY)
  if (args["dry-run"]) {
    dryRun();
    return;
  }

  // Wallet pre-check (only for real exports)
  walletPreCheck();

  // Generate passphrase
  const passphrase = getPassphrase();
  debug(`Passphrase generated (${passphrase.split("-").length} words)`);

  // Determine archive path
  const archivePath = getArchivePath();
  debug(`Archive path: ${archivePath}`);

  // Run export
  const archiveStat = runExport(archivePath, passphrase);
  const sizeBytes = archiveStat.size;
  const sizeMB = (sizeBytes / 1024 / 1024).toFixed(1);
  log(`Archive created: ${basename(archivePath)} (${sizeMB} MB)`);

  // Size warning
  const sizeWarning = sizeBytes > ONE_GB
    ? `This is a full workspace backup. ${(sizeBytes / ONE_GB).toFixed(1)} GB total.`
    : null;

  // Detect public URL
  const { url: detectedUrl, via } = detectPublicUrl();

  // Generate token
  const token = randomUUID();
  debug(`Token: ${token}`);

  // Spawn server
  spawnServer(archivePath, token, detectedUrl);

  // Verify server is running
  const serverPid = verifyServer();
  if (!serverPid) {
    // Server failed — clean up archive
    try { unlinkSync(archivePath); } catch { /* ignore */ }
    errorJson(
      "SERVER_SPAWN_FAILED",
      "Download server failed to start",
      "Check if port 18790 is in use: lsof -i :18790",
      4
    );
  }

  // Build download URL
  const downloadUrl = detectedUrl ? `${detectedUrl}/${token}` : null;

  // Build expiry
  const expiresAt = new Date(Date.now() + TIMEOUT_MINUTES * 60 * 1000).toISOString();

  // Output JSON
  const result = {
    ok: true,
    downloadUrl,
    ...(downloadUrl === null && {
      publicUrlHint: "Could not auto-detect public URL. Please reply with your full agent URL (e.g. https://myagent.example.com) and I'll give you a working link.",
    }),
    passphrase,
    filename: basename(archivePath),
    sizeBytes,
    sizeMB,
    sizeWarning,
    supportsDockerRestore: true,
    expiresIn: `${TIMEOUT_MINUTES} minutes`,
    expiresAt,
    includesWallet: args["include-wallet"],
    token,
    serverPid,
    docker: args.docker,
    publicUrlDetectedVia: via,
  };

  outputJson(result);
  process.exit(0);
}

main();
