#!/usr/bin/env node
/**
 * Morpheus Session Manager — EverClaw
 *
 * Operational tooling for Morpheus P2P session management.
 * Wraps lessons learned from session debugging into a single CLI.
 *
 * Commands:
 *   status    — Show session health, balance, provider info
 *   balance   — Check MOR balance (router + safe)
 *   fund      — Transfer MOR from Safe to Router wallet
 *   models    — List available P2P models
 *   sessions  — List active sessions with stake info
 *   estimate  — Estimate max session duration from balance
 *   logs      — Show recent session-related log entries
 *
 * Usage:
 *   node morpheus-session-mgr.mjs status
 *   node morpheus-session-mgr.mjs balance
 *   node morpheus-session-mgr.mjs fund 500 [--execute]
 *   node morpheus-session-mgr.mjs models
 *   node morpheus-session-mgr.mjs estimate
 */

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import { execSync } from "node:child_process";

// --- Configuration ---
const API_BASE = process.env.MORPHEUS_API_BASE || "http://127.0.0.1:8082";
const RPC_URL = process.env.EVERCLAW_RPC || "https://base-mainnet.public.blastapi.io";
const MOR_TOKEN = "0x7431aDa8a591C955a994a21710752EF9b882b8e3";
const ROUTER_WALLET = process.env.MORPHEUS_WALLET_ADDRESS;
const SAFE_ADDRESS = process.env.MORPHEUS_SAFE_ADDRESS;

function requireWallet() {
  if (!ROUTER_WALLET) {
    console.error("❌ MORPHEUS_WALLET_ADDRESS env var required for on-chain queries");
    process.exit(1);
  }
}

function requireWalletAndSafe() {
  requireWallet();
  if (!SAFE_ADDRESS) {
    console.error("❌ MORPHEUS_SAFE_ADDRESS env var required");
    process.exit(1);
  }
}
const DAILY_STAKE_RATE = parseFloat(process.env.MORPHEUS_DAILY_STAKE || "1268"); // MOR per day at current pricing
const DIAMOND_CONTRACT = "0x6aBE1d282f72B474E54527D93b979A4f64d3030a";

// --- Helpers ---

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    client.get(url, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString()));
        } catch {
          resolve(Buffer.concat(chunks).toString());
        }
      });
    }).on("error", reject);
  });
}

function rpcCall(method, params) {
  return new Promise((resolve, reject) => {
    const url = new URL(RPC_URL);
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
    const client = RPC_URL.startsWith("https") ? https : http;
    const req = client.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          resolve(data.result);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function getMorBalance(address) {
  const sig = "0x70a08231" + address.slice(2).toLowerCase().padStart(64, "0");
  const result = await rpcCall("eth_call", [{ to: MOR_TOKEN, data: sig }, "latest"]);
  return Number(BigInt(result)) / 1e18;
}

async function getEthBalance(address) {
  const result = await rpcCall("eth_getBalance", [address, "latest"]);
  return Number(BigInt(result)) / 1e18;
}

function formatMor(n) {
  return n.toFixed(2);
}

// --- Commands ---

async function cmdStatus() {
  console.log("\n🔍 Morpheus Session Manager — Status\n");
  requireWalletAndSafe();

  // Proxy health
  let health;
  try {
    health = await httpGet(`${API_BASE}/health`);
  } catch (e) {
    console.error("❌ Proxy not responding at", API_BASE);
    console.error("   Is morpheus-proxy running?\n");
    process.exit(1);
  }

  // Balance check
  const [routerMor, safeMor, routerEth] = await Promise.all([
    getMorBalance(ROUTER_WALLET),
    getMorBalance(SAFE_ADDRESS),
    getEthBalance(ROUTER_WALLET),
  ]);

  const totalMor = routerMor + safeMor;
  const maxConcurrentSessions = Math.floor(routerMor / DAILY_STAKE_RATE);

  // Display
  console.log("📊 Balances:");
  console.log(`   Router EOA:    ${formatMor(routerMor)} MOR  |  ${routerEth.toFixed(5)} ETH`);
  console.log(`   Safe Reserve:  ${formatMor(safeMor)} MOR`);
  console.log(`   Total:         ${formatMor(totalMor)} MOR`);
  console.log(`   Concurrent 1-day sessions: ~${maxConcurrentSessions} (at ~${DAILY_STAKE_RATE} MOR stake each)`);
  console.log(`   Note: MOR is STAKED, not spent — returned after each session closes\n`);

  // Session info
  const sessions = health.activeSessions || [];
  if (sessions.length > 0) {
    console.log("📡 Active Sessions:");
    for (const s of sessions) {
      const expiresIn = Math.max(0, (new Date(s.expiresAt).getTime() - Date.now()) / 3600000);
      console.log(`   ${s.model}: ${s.sessionId?.slice(0, 16)}... (expires in ${expiresIn.toFixed(1)}h)`);
    }
  } else {
    console.log("📡 No active sessions");
  }
  console.log("");

  // Fallback status
  if (health.fallbackMode) {
    const remaining = health.fallbackRemaining || 0;
    console.log(`⚠️  FALLBACK MODE: Using Gateway API (${Math.floor(remaining / 60)}min remaining)`);
  } else {
    console.log("✅ P2P Mode: Active");
  }

  if (health.consecutiveFailures > 0) {
    console.log(`   Consecutive failures: ${health.consecutiveFailures} (threshold: ${health.fallbackThreshold || 3})`);
  }

  console.log(`   Gateway configured: ${health.gatewayConfigured ? "yes" : "no"}`);

  // Warnings
  console.log("");
  if (routerMor < 500) {
    console.log("⚠️  Router MOR below threshold (500). Run: node morpheus-session-mgr.mjs fund 2000 --execute");
  }
  if (routerEth < 0.005) {
    console.log("⚠️  Router ETH low for gas. Send ETH to", ROUTER_WALLET);
  }
  if (routerMor < DAILY_STAKE_RATE) {
    console.log("🚨 Router can't open a new session! Fund immediately.");
  }
  console.log("");
}

async function cmdBalance() {
  console.log("\n💰 MOR Balance Report\n");
  requireWalletAndSafe();

  const [routerMor, safeMor, routerEth] = await Promise.all([
    getMorBalance(ROUTER_WALLET),
    getMorBalance(SAFE_ADDRESS),
    getEthBalance(ROUTER_WALLET),
  ]);

  console.log(`   Router EOA (${ROUTER_WALLET.slice(0, 10)}...):  ${formatMor(routerMor)} MOR  |  ${routerEth.toFixed(5)} ETH`);
  console.log(`   Safe (${SAFE_ADDRESS.slice(0, 10)}...):          ${formatMor(safeMor)} MOR`);
  console.log(`   Total:                              ${formatMor(routerMor + safeMor)} MOR`);
  console.log(`\n   Stake per 1-day session: ~${DAILY_STAKE_RATE} MOR (returned after close)`);
  console.log(`   Max concurrent sessions (router): ~${Math.floor(routerMor / DAILY_STAKE_RATE)}`);
  console.log(`   Max concurrent sessions (total):  ~${Math.floor((routerMor + safeMor) / DAILY_STAKE_RATE)}`);
  console.log(`\n   Note: MOR is STAKED, not consumed. All staked MOR returns after session close.\n`);
}

async function cmdModels() {
  console.log("\n📋 Available P2P Models\n");

  let health;
  try {
    health = await httpGet(`${API_BASE}/health`);
  } catch {
    console.error("❌ Proxy not responding\n");
    process.exit(1);
  }

  const models = health.availableModels || [];
  if (models.length === 0) {
    console.log("   No models available. Is the router running?\n");
    return;
  }

  const reasoning = ["kimi-k2-thinking"];
  const general = ["kimi-k2.5", "glm-4.7", "qwen3-235b", "gpt-oss-120b"];
  const fast = ["glm-4.7-flash"];
  const web = ["kimi-k2.5:web"];

  for (const m of models) {
    let tag = "general";
    if (reasoning.includes(m)) tag = "reasoning 🧠";
    else if (fast.includes(m)) tag = "fast ⚡";
    else if (web.includes(m)) tag = "web 🌐";
    console.log(`   ${m.padEnd(25)} ${tag}`);
  }
  console.log(`\n   Total: ${models.length} models available on P2P`);
  console.log(`   Note: glm-5 is NOT available on P2P (use Gateway)\n`);
}

async function cmdEstimate() {
  console.log("\n📐 Session Duration Estimate\n");
  requireWalletAndSafe();

  const routerMor = await getMorBalance(ROUTER_WALLET);
  const safeMor = await getMorBalance(SAFE_ADDRESS);

  console.log(`   Router balance: ${formatMor(routerMor)} MOR`);
  console.log(`   Safe balance:   ${formatMor(safeMor)} MOR`);
  console.log(`   Daily rate:     ~${DAILY_STAKE_RATE} MOR/day\n`);

  const durations = [
    { label: "6 hours", seconds: 21600, stake: DAILY_STAKE_RATE * 0.25 },
    { label: "12 hours", seconds: 43200, stake: DAILY_STAKE_RATE * 0.5 },
    { label: "1 day", seconds: 86400, stake: DAILY_STAKE_RATE },
    { label: "3 days", seconds: 259200, stake: DAILY_STAKE_RATE * 3 },
    { label: "7 days", seconds: 604800, stake: DAILY_STAKE_RATE * 7 },
  ];

  console.log("   Duration    Stake Needed    Router Can?    With Safe?");
  console.log("   ─────────   ────────────    ───────────    ──────────");
  for (const d of durations) {
    const canRouter = routerMor >= d.stake ? "✅ yes" : "❌ no ";
    const canTotal = (routerMor + safeMor) >= d.stake ? "✅ yes" : "❌ no ";
    console.log(`   ${d.label.padEnd(11)}  ${formatMor(d.stake).padStart(8)} MOR    ${canRouter}         ${canTotal}`);
  }

  const maxDays = routerMor / DAILY_STAKE_RATE;
  const maxSeconds = Math.floor(maxDays * 86400);
  console.log(`\n   Max single session from router: ~${maxDays.toFixed(1)} days (${maxSeconds}s)`);
  console.log(`   Recommended MORPHEUS_SESSION_DURATION: ${Math.min(maxSeconds, 604800)}`);
  console.log(`\n   Note: MOR is STAKED and returned after session close.`);
  console.log(`   Longer sessions lock more MOR but it all comes back.\n`);
}

async function cmdFund() {
  const amount = process.argv[3];
  const execute = process.argv.includes("--execute");

  if (!amount || isNaN(parseFloat(amount))) {
    console.error("Usage: node morpheus-session-mgr.mjs fund <amount> [--execute]");
    console.error("Example: node morpheus-session-mgr.mjs fund 2000 --execute\n");
    process.exit(1);
  }

  // Delegate to safe-transfer.mjs
  const scriptDir = new URL(".", import.meta.url).pathname;
  const cmd = `node ${scriptDir}safe-transfer.mjs ${amount} ${execute ? "--execute" : ""}`;
  console.log(`\n🏦 Delegating to safe-transfer.mjs...\n`);

  try {
    execSync(cmd, { stdio: "inherit" });
  } catch (e) {
    process.exit(e.status || 1);
  }
}

async function cmdSessions() {
  console.log("\n📡 Active Sessions (on-chain, paginated)\n");
  requireWallet();

  const allIds = await getAllSessionIds();
  if (allIds.length === 0) {
    console.log("   No sessions found on-chain.\n");
    return;
  }

  console.log(`   Total on-chain sessions: ${allIds.length}\n`);

  const now = Math.floor(Date.now() / 1000);
  let openCount = 0;

  for (const sid of allIds) {
    const session = await getSessionDetail(sid);
    if (!session || session.closedAt !== 0) continue;

    openCount++;
    const expiresIn = Math.max(0, (session.endsAt - now) / 3600);
    const stakeMor = Number(BigInt(session.stake)) / 1e18;
    const modelShort = session.modelId.slice(0, 18) + "...";
    const status = session.endsAt < now ? "⚠️  EXPIRED" : "✅ ACTIVE";

    console.log(`   ${status}: ${sid.slice(0, 22)}...`);
    console.log(`      Model: ${modelShort}`);
    console.log(`      Stake: ${stakeMor.toFixed(2)} MOR`);
    console.log(`      Expires in: ${expiresIn.toFixed(1)}h\n`);
  }

  if (openCount === 0) {
    console.log("   No open sessions (all closed).\n");
  } else {
    console.log(`   Open sessions: ${openCount}\n`);
  }
}

/**
 * Enumerate ALL on-chain sessions via Diamond contract pagination.
 * The proxy-router /sessions/user endpoint has a hidden limit (~100).
 * Sessions beyond that offset are invisible. Always paginate on-chain.
 */
async function getAllSessionIds() {
  const allIds = [];
  let offset = 0;
  const batchSize = 100;

  while (true) {
    try {
      const result = execSync(
        `cast call "${DIAMOND_CONTRACT}" ` +
        `"getUserSessions(address,uint256,uint256)(bytes32[])" ` +
        `"${ROUTER_WALLET}" "${offset}" "${batchSize}" ` +
        `--rpc-url "${RPC_URL}"`,
        { encoding: "utf-8", timeout: 30000 }
      ).trim();

      const ids = result
        .replace(/[\[\]]/g, "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.startsWith("0x"));

      if (ids.length === 0) break;
      allIds.push(...ids);
      if (ids.length < batchSize) break;
      offset += batchSize;
    } catch {
      break;
    }
  }

  return allIds;
}

/**
 * Get session detail from proxy-router by session ID.
 * Returns { closedAt, stake, endsAt, modelId, openedAt } or null.
 */
async function getSessionDetail(sessionId) {
  try {
    const cookiePass = getCookiePass();
    const url = new URL(`/blockchain/sessions/${sessionId}`, API_BASE);
    const auth = Buffer.from(`admin:${cookiePass}`).toString("base64");

    return new Promise((resolve) => {
      http.get(url, { headers: { Authorization: `Basic ${auth}` }, timeout: 10000 }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString());
            const s = data.session || {};
            resolve({
              closedAt: parseInt(s.ClosedAt || s.closedAt || "1"),
              stake: String(s.Stake || s.stake || "0"),
              endsAt: parseInt(s.EndsAt || s.endsAt || "0"),
              modelId: s.ModelAgentId || s.modelAgentId || "unknown",
              openedAt: parseInt(s.OpenedAt || s.openedAt || "0"),
            });
          } catch {
            resolve(null);
          }
        });
      }).on("error", () => resolve(null));
    });
  } catch {
    return null;
  }
}

function getCookiePass() {
  const cookiePath = `${process.env.HOME}/morpheus/.cookie`;
  if (!fs.existsSync(cookiePath)) return "";
  const raw = fs.readFileSync(cookiePath, "utf-8").trim();
  return raw.includes(":") ? raw.split(":").pop() : raw;
}

/**
 * Close stale sessions. Keeps only the latest session per model.
 * This MUST run before opening new sessions to prevent MOR accumulation.
 *
 * Root cause: The proxy-router /sessions/user has a hidden pagination
 * limit (~100 sessions). Sessions beyond that offset are invisible,
 * so new sessions keep opening without closing old ones, silently
 * locking MOR in stale sessions.
 */
async function cmdCleanup() {
  console.log("\n🧹 Session Cleanup (close stale, keep latest per model)\n");
  requireWallet();

  // Verify cast is available
  try {
    execSync("which cast", { encoding: "utf-8" });
  } catch {
    console.error("❌ 'cast' (foundry) required for on-chain session queries.");
    console.error("   Install: curl -L https://foundry.paradigm.xyz | bash && foundryup\n");
    process.exit(1);
  }

  const allIds = await getAllSessionIds();
  console.log(`   Total on-chain sessions: ${allIds.length}`);

  if (allIds.length === 0) {
    console.log("   Nothing to clean up.\n");
    return;
  }

  // Find all open sessions and their details
  const openSessions = [];
  let closedCount = 0;

  for (const sid of allIds) {
    const session = await getSessionDetail(sid);
    if (!session || session.closedAt !== 0) {
      closedCount++;
      continue;
    }
    openSessions.push({ id: sid, ...session });
  }

  console.log(`   Already closed: ${closedCount}`);
  console.log(`   Currently open: ${openSessions.length}`);

  if (openSessions.length === 0) {
    console.log("\n   ✅ No open sessions to clean up.\n");
    return;
  }

  // Find the best (latest-expiring) session per model
  const bestPerModel = new Map();
  for (const s of openSessions) {
    const existing = bestPerModel.get(s.modelId);
    if (!existing || s.endsAt > existing.endsAt) {
      bestPerModel.set(s.modelId, s);
    }
  }

  // Close stale sessions (not the best per model)
  let staleClosed = 0;
  const cookiePass = getCookiePass();

  console.log("");
  for (const s of openSessions) {
    const best = bestPerModel.get(s.modelId);
    const stakeMor = Number(BigInt(s.stake)) / 1e18;

    if (best && s.id === best.id) {
      console.log(`   ✅ KEEP: ${s.id.slice(0, 22)}... (${stakeMor.toFixed(0)} MOR, latest for model)`);
      continue;
    }

    // Close this stale session
    process.stdout.write(`   🗑️  CLOSE: ${s.id.slice(0, 22)}... (${stakeMor.toFixed(0)} MOR) → `);
    try {
      const closeUrl = new URL(`/blockchain/sessions/${s.id}/close`, API_BASE);
      const auth = Buffer.from(`admin:${cookiePass}`).toString("base64");
      const tx = await new Promise((resolve, reject) => {
        const req = http.request(closeUrl, {
          method: "POST",
          headers: { Authorization: `Basic ${auth}` },
          timeout: 30000,
        }, (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            try {
              const data = JSON.parse(Buffer.concat(chunks).toString());
              resolve(data.tx || "submitted");
            } catch {
              resolve("submitted");
            }
          });
        });
        req.on("error", reject);
        req.end();
      });
      console.log(`tx: ${String(tx).slice(0, 22)}...`);
      staleClosed++;

      // Space out transactions to avoid nonce issues
      if (staleClosed < openSessions.length - bestPerModel.size) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    } catch (e) {
      console.log(`error: ${e.message}`);
    }
  }

  console.log(`\n   Cleanup complete: ${staleClosed} stale sessions closed.`);
  if (staleClosed > 0) {
    console.log(`   ~${(staleClosed * DAILY_STAKE_RATE).toFixed(0)} MOR returning to wallet.\n`);
  } else {
    console.log("");
  }
}

async function cmdLogs() {
  console.log("\n📋 Recent Session Logs\n");

  const logPaths = [
    `${process.env.HOME}/morpheus/proxy/proxy.log`,
    `${process.env.HOME}/morpheus/data/logs/router-stdout.log`,
  ];

  for (const logPath of logPaths) {
    if (!fs.existsSync(logPath)) continue;
    console.log(`--- ${logPath} ---`);
    try {
      const lines = fs.readFileSync(logPath, "utf-8").split("\n");
      const sessionLines = lines.filter(
        (l) => /session|stake|balance|error|fail|opened|expired/i.test(l)
      ).slice(-15);
      for (const line of sessionLines) {
        console.log(`   ${line.trim()}`);
      }
    } catch {
      console.log("   (could not read)");
    }
    console.log("");
  }
}

function showHelp() {
  console.log(`
Morpheus Session Manager — EverClaw

Usage: node morpheus-session-mgr.mjs <command>

Commands:
  status     Show session health, balance, provider info
  balance    Check MOR balance (router + safe)
  fund       Transfer MOR from Safe to Router (delegates to safe-transfer.mjs)
  models     List available P2P models
  sessions   List active sessions (on-chain paginated)
  cleanup    Close stale sessions, keep latest per model
  estimate   Estimate max session duration from current balance
  logs       Show recent session-related log entries

Environment:
  MORPHEUS_WALLET_ADDRESS    Your proxy-router wallet (required for on-chain queries)
  MORPHEUS_SAFE_ADDRESS      Your SAFE multisig address
  EVERCLAW_RPC               Base RPC endpoint (default: public blastapi)
  MORPHEUS_DAILY_STAKE       MOR per 1-day session (default: 1268)

Examples:
  node morpheus-session-mgr.mjs status
  node morpheus-session-mgr.mjs cleanup            # ALWAYS run before opening sessions
  node morpheus-session-mgr.mjs fund 2000 --execute
  node morpheus-session-mgr.mjs estimate
`);
}

// --- Main ---
const command = process.argv[2];

switch (command) {
  case "status": await cmdStatus(); break;
  case "balance": await cmdBalance(); break;
  case "models": await cmdModels(); break;
  case "sessions": await cmdSessions(); break;
  case "estimate": await cmdEstimate(); break;
  case "fund": await cmdFund(); break;
  case "cleanup": await cmdCleanup(); break;
  case "logs": await cmdLogs(); break;
  case "help":
  case "--help":
  case "-h":
  default:
    showHelp();
    break;
}
