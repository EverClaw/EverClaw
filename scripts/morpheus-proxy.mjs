#!/usr/bin/env node
/**
 * Morpheus → OpenAI-compatible proxy for OpenClaw
 *
 * Translates standard OpenAI /v1/chat/completions requests into
 * Morpheus proxy-router calls with proper Basic auth + session/model headers.
 *
 * Features:
 * - Auto-opens sessions on demand (lazy)
 * - Auto-renews sessions before expiry
 * - Maps model names to blockchain model IDs
 * - Health endpoint at GET /health
 * - Models endpoint at GET /v1/models (for OpenClaw discovery)
 * - MOR balance monitoring with threshold alerts
 * - Hybrid fallback: P2P → Gateway API when sessions fail
 */

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";

// --- Configuration ---
const PROXY_PORT = parseInt(process.env.MORPHEUS_PROXY_PORT || "8083", 10);
const PROXY_HOST = process.env.EVERCLAW_PROXY_HOST || "127.0.0.1";
const ROUTER_URL = process.env.MORPHEUS_ROUTER_URL || "http://localhost:8082";
const COOKIE_PATH = process.env.MORPHEUS_COOKIE_PATH || path.join(process.env.HOME, ".morpheus/.cookie");
const SESSION_DURATION = parseInt(process.env.MORPHEUS_SESSION_DURATION || "604800", 10); // 7 days default
const RENEW_BEFORE_SEC = parseInt(process.env.MORPHEUS_RENEW_BEFORE || "3600", 10); // renew 1 hour before expiry
// === STAGE 1: STRONG AUTH ENFORCEMENT (no weak default) ===
const PROXY_API_KEY = process.env.MORPHEUS_PROXY_API_KEY;
if (!PROXY_API_KEY || PROXY_API_KEY === "morpheus-local") {
  console.error("[morpheus-proxy] ❌ MORPHEUS_PROXY_API_KEY environment variable is required");
  console.error("  Export a strong key before starting the proxy.");
  process.exit(1);
}
console.log(`[morpheus-proxy] ✅ Strong auth enabled`);

// --- P0: Balance Monitoring & Fallback ---
const RPC_URL = process.env.EVERCLAW_RPC || "https://base-mainnet.public.blastapi.io";
const MOR_TOKEN = "0x7431aDa8a591C955a994a21710752EF9b882b8e3";
const MOR_BALANCE_THRESHOLD = parseFloat(process.env.MORPHEUS_MOR_THRESHOLD || "500"); // Alert below this
const WALLET_ADDRESS = process.env.MORPHEUS_WALLET_ADDRESS || ""; // Router's wallet address for balance check
const GATEWAY_URL = process.env.MORPHEUS_GATEWAY_URL || "https://api.mor.org/api/v1";
const GATEWAY_API_KEY = process.env.MOR_GATEWAY_API_KEY || process.env.MORPHEUS_GATEWAY_API_KEY || "";
const FALLBACK_THRESHOLD = parseInt(process.env.MORPHEUS_FALLBACK_THRESHOLD || "3", 10); // Failures before fallback
const FALLBACK_RETRY_MS = parseInt(process.env.MORPHEUS_FALLBACK_RETRY_MS || "21600000", 10); // 6 hours

// --- Gateway-only models (no P2P providers) ---
// When a request comes in for one of these and it's not in MODEL_MAP
// (i.e. no on-chain ID from the router), we forward directly to Gateway.
const GATEWAY_ONLY_MODELS = new Set([
  "glm-5",
  "glm-5:web",
  "MiniMax-M2.5",
]);

// --- Model ID map (blockchain model IDs) ---
// Hardcoded defaults used as fallback if the router is unreachable at startup.
// On startup (and periodically), refreshModelMap() overwrites this with
// live data from the router's /blockchain/models endpoint.
const MODEL_MAP = {
  "kimi-k2.5":         "0xbb9e920d94ad3fa2861e1e209d0a969dbe9e1af1cf1ad95c49f76d7b63d32d93",
  "kimi-k2.5:web":     "0xb487ee62516981f533d9164a0a3dcca836b06144506ad47a5c024a7a2a33fc58",
  "kimi-k2-thinking":  "0xc40b0a1ea1b20e042449ae44ffee8e87f3b8ba3d0be3ea61b86e6a89ba1a44e3",
  "glm-4.7-flash":     "0xfdc54de0b7f3e3525b4173f49e3819aebf1ed31e06d96be4eefaca04f2fcaeff",
  "glm-4.7":           "0xed0a2bc2a6e28cc87a9b55bc24b61f089f3c86b15d94e5776bc0312e0b4df34b",
  "qwen3-235b":        "0x2a71d1dfad6a7ead6e0c7f3d87d9a3c64e8bfa53f9a62fb71b83e7f49e3a6c0b",
  "llama-3.3-70b":     "0xc753061a5d2640decfbbc1d1d35744e6805015d30d32872f814a93784c627fc3",
  "gpt-oss-120b":      "0x2e7228fe07523d84307838aa617141a5e47af0e00b4eaeab1522bc71985ffd11",
};

// --- Dynamic model refresh ---
const MODEL_REFRESH_INTERVAL = parseInt(process.env.MORPHEUS_MODEL_REFRESH_INTERVAL || "300", 10); // 5 min default

async function refreshModelMap() {
  try {
    const res = await routerFetch("GET", "/blockchain/models");
    if (res.status !== 200) {
      console.warn(`[morpheus-proxy] Model refresh returned ${res.status}, keeping existing map`);
      return;
    }
    const data = JSON.parse(res.body.toString());
    const models = Array.isArray(data) ? data : (data.models || []);
    if (!Array.isArray(models) || models.length === 0) {
      console.warn("[morpheus-proxy] Model refresh returned empty list, keeping existing map");
      return;
    }
    let added = 0;
    for (const m of models) {
      const name = m.Name || m.name;
      const id = m.Id || m.id;
      if (name && id && !MODEL_MAP[name]) {
        MODEL_MAP[name] = id;
        added++;
      } else if (name && id) {
        // Update existing entry in case the on-chain ID changed
        MODEL_MAP[name] = id;
      }
    }
    console.log(`[morpheus-proxy] Refreshed MODEL_MAP: ${Object.keys(MODEL_MAP).length} models (${added} new)`);
  } catch (e) {
    console.warn(`[morpheus-proxy] Failed to refresh MODEL_MAP, using defaults: ${e.message}`);
  }
}

// --- State ---
// === STAGE 4: PERSISTENT SESSIONS (runtime saves + crash resilience) ===
const SESSIONS_FILE = path.join(process.env.HOME, ".morpheus/sessions.json");
let sessions = new Map();

function loadSessions() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf-8"));
      sessions = new Map(Object.entries(data));
      console.log(`[morpheus-proxy] ✅ Loaded ${sessions.size} persistent sessions`);
    }
  } catch (e) {
    console.warn(`[morpheus-proxy] Could not load sessions: ${e.message}`);
  }
}

function saveSessions() {
  try {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(Object.fromEntries(sessions), null, 2));
  } catch (e) {
    console.warn(`[morpheus-proxy] Failed to save sessions: ${e.message}`);
  }
}

loadSessions();

// === STAGE 5: SECURITY MIDDLEWARE (rate limit + body size + smart cleanup) ===
const RATE_LIMIT_WINDOW_MS = 60000;
const RATE_LIMIT_MAX_REQ = 30;
const MAX_BODY_SIZE = 1024 * 1024;
const rateLimitMap = new Map();

function getClientIP(req) {
  return (req.headers["x-forwarded-for"] || "").split(",")[0] || req.socket.remoteAddress || "unknown";
}

function securityMiddleware(req, res) {
  const contentLength = parseInt(req.headers["content-length"] || "0", 10);
  if (req.method === "POST" && contentLength > MAX_BODY_SIZE) {
    res.writeHead(413, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Payload Too Large" }));
    return false;
  }

  const ip = getClientIP(req);
  const now = Date.now();
  let record = rateLimitMap.get(ip) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
  if (now > record.resetAt) record = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
  record.count++;
  rateLimitMap.set(ip, record);

  if (rateLimitMap.size > 800) {
    for (const [key, val] of rateLimitMap) {
      if (now > val.resetAt) rateLimitMap.delete(key);
    }
  }

  if (record.count > RATE_LIMIT_MAX_REQ) {
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Too Many Requests" }));
    return false;
  }
  return true;
}

let morBalance = null; // Cached MOR balance
let morBalanceLastCheck = 0;
let consecutiveFailures = 0; // Track P2P failures for fallback
let fallbackMode = false; // True when using Gateway instead of P2P
let fallbackUntil = 0; // Timestamp when to retry P2P

// --- Helpers ---

// === STAGES 2+3: CACHED COOKIE (original function fully replaced) ===
let cachedBasicAuth = null;
let cookieLastRead = 0;
const COOKIE_CACHE_MS = 60000;

function getBasicAuth() {
  const now = Date.now();
  if (cachedBasicAuth && now - cookieLastRead < COOKIE_CACHE_MS) {
    return cachedBasicAuth;
  }
  try {
    const cookie = fs.readFileSync(COOKIE_PATH, "utf-8").trim();
    cachedBasicAuth = "Basic " + Buffer.from(cookie).toString("base64");
    cookieLastRead = now;
    return cachedBasicAuth;
  } catch (e) {
    console.error(`[morpheus-proxy] Failed to read cookie file: ${e.message}`);
    cachedBasicAuth = null;
    return null;
  }
}

function routerFetch(method, urlPath, body = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, ROUTER_URL);
    const headers = {
      "Authorization": getBasicAuth(),
      ...extraHeaders,
    };
    if (body) headers["Content-Type"] = "application/json";

    const req = http.request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body: raw });
      });
    });
    req.on("error", reject);
    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

// --- P0: Balance Monitoring ---

/**
 * Get wallet address (from env or router)
 */
async function getWalletAddress() {
  // Use configured address if available
  if (WALLET_ADDRESS) return WALLET_ADDRESS;

  // Try to get from router API
  try {
    const res = await routerFetch("GET", "/blockchain/wallet");
    if (res.status === 200) {
      const data = JSON.parse(res.body.toString());
      return data.address || data.Address;
    }
  } catch (e) {
    // Router doesn't expose wallet endpoint
  }
  return null;
}

/**
 * Fetch MOR balance from Base mainnet
 */
async function fetchMorBalance(address) {
  // ERC20 balanceOf(address)
  const balanceOfSig = "0x70a08231" + address.slice(2).padStart(64, "0");
  return new Promise((resolve, reject) => {
    const url = new URL("/", RPC_URL);
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: MOR_TOKEN, data: balanceOfSig }, "latest"],
    });

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
          if (data.result) {
            const balanceWei = BigInt(data.result);
            const balanceMor = Number(balanceWei) / 1e18;
            resolve(balanceMor);
          } else {
            reject(new Error(data.error?.message || "No balance result"));
          }
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

/**
 * Check and cache MOR balance, return cached if fresh
 */
async function checkMorBalance() {
  const CACHE_MS = 60000; // 1 minute cache
  if (morBalance && Date.now() - morBalanceLastCheck < CACHE_MS) {
    return morBalance;
  }

  try {
    const address = await getWalletAddress();
    if (!address) {
      console.warn("[morpheus-proxy] Could not get wallet address for balance check");
      return morBalance; // Return cached or null
    }
    morBalance = await fetchMorBalance(address);
    morBalanceLastCheck = Date.now();

    if (morBalance < MOR_BALANCE_THRESHOLD) {
      console.warn(`[morpheus-proxy] ⚠️  MOR balance low: ${morBalance.toFixed(2)} MOR (threshold: ${MOR_BALANCE_THRESHOLD})`);
    }

    return morBalance;
  } catch (e) {
    console.warn(`[morpheus-proxy] Balance check failed: ${e.message}`);
    return morBalance; // Return cached or null
  }
}

/**
 * Check if we should use Gateway fallback instead of P2P
 */
function shouldUseFallback() {
  // No gateway key configured = no fallback
  if (!GATEWAY_API_KEY) return false;

  // Already in fallback mode
  if (fallbackMode && Date.now() < fallbackUntil) return true;

  // Exceeded failure threshold
  if (consecutiveFailures >= FALLBACK_THRESHOLD) {
    fallbackMode = true;
    fallbackUntil = Date.now() + FALLBACK_RETRY_MS;
    console.warn(`[morpheus-proxy] 🔄 Switching to Gateway fallback for ${FALLBACK_RETRY_MS / 3600000}h (${consecutiveFailures} consecutive failures)`);
    return true;
  }

  return false;
}

/**
 * Reset fallback mode after successful P2P request
 */
function p2pSuccess() {
  if (consecutiveFailures > 0) {
    console.log(`[morpheus-proxy] ✅ P2P recovered, exiting fallback mode`);
  }
  consecutiveFailures = 0;
  fallbackMode = false;
}

/**
 * Record P2P failure for fallback tracking
 */
function p2pFailure() {
  consecutiveFailures++;
  console.warn(`[morpheus-proxy] ❌ P2P failure #${consecutiveFailures} (threshold: ${FALLBACK_THRESHOLD})`);
}

/**
 * Forward request to Morpheus Gateway API (fallback)
 */
async function forwardToGateway(body, isStreaming, res) {
  if (!GATEWAY_API_KEY) {
    throw new Error("Gateway API key not configured");
  }

  // Use string concat to preserve base path (e.g. /api/v1/chat/completions)
  const base = GATEWAY_URL.replace(/\/+$/, "");
  const url = new URL(`${base}/chat/completions`);
  const headers = {
    "Authorization": `Bearer ${GATEWAY_API_KEY}`,
    "Content-Type": "application/json",
  };

  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: "POST", headers }, (upstreamRes) => {
      if (isStreaming && upstreamRes.headers["content-type"]?.includes("text/event-stream")) {
        const outHeaders = {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        };
        res.writeHead(upstreamRes.statusCode, outHeaders);
        upstreamRes.on("data", (chunk) => res.write(chunk));
        upstreamRes.on("end", () => res.end());
        upstreamRes.on("error", (e) => {
          console.error(`[morpheus-proxy] Gateway stream error: ${e.message}`);
          res.end();
        });
        resolve({ streamed: true });
      } else {
        const chunks = [];
        upstreamRes.on("data", (c) => chunks.push(c));
        upstreamRes.on("end", () => {
          resolve({
            status: upstreamRes.statusCode,
            headers: upstreamRes.headers,
            body: Buffer.concat(chunks),
          });
        });
        upstreamRes.on("error", reject);
      }
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function openSession(modelId) {
  // P0: Check MOR balance before opening session
  const balance = await checkMorBalance();
  if (balance !== null && balance < MOR_BALANCE_THRESHOLD * 0.1) {
    // Less than 10% of threshold = critical, refuse session
    throw new Error(`MOR balance critically low (${balance.toFixed(2)} MOR), cannot open session`);
  }

  console.log(`[morpheus-proxy] Opening session for model ${modelId} (duration: ${SESSION_DURATION}s, balance: ${balance?.toFixed(2) || "unknown"} MOR)`);
  const res = await routerFetch("POST", `/blockchain/models/${modelId}/session`, {
    sessionDuration: SESSION_DURATION,
  });
  if (res.status !== 200) {
    const text = res.body.toString();
    // Check for balance-related errors
    if (text.includes("transfer amount exceeds balance") || text.includes("insufficient")) {
      p2pFailure();
      throw new Error(`Insufficient MOR balance for session: ${text.substring(0, 200)}`);
    }
    throw new Error(`Failed to open session (${res.status}): ${text}`);
  }
  const data = JSON.parse(res.body.toString());
  const sessionId = data.sessionID;
  const expiresAt = Date.now() + (SESSION_DURATION - RENEW_BEFORE_SEC) * 1000;
  sessions.set(modelId, { sessionId, expiresAt });
  saveSessions(); // ← runtime save
  console.log(`[morpheus-proxy] Session opened: ${sessionId} (expires ~${new Date(expiresAt).toISOString()})`);
  return sessionId;
}

async function getOrCreateSession(modelId) {
  // P0: Check if we should use Gateway fallback
  if (shouldUseFallback()) {
    return null; // Signal to use Gateway instead
  }

  const existing = sessions.get(modelId);
  if (existing && Date.now() < existing.expiresAt) {
    return existing.sessionId;
  }
  // Session expired or doesn't exist — open a new one
  if (existing) {
    console.log(`[morpheus-proxy] Session for ${modelId} expired, opening new one`);
  }
  return openSession(modelId);
}

function resolveModelId(modelName) {
  // Direct match
  if (MODEL_MAP[modelName]) return MODEL_MAP[modelName];
  // If it looks like a hex model ID already, use it
  if (modelName.startsWith("0x") && modelName.length === 66) return modelName;
  // Try lowercase
  const lower = modelName.toLowerCase();
  for (const [key, val] of Object.entries(MODEL_MAP)) {
    if (key.toLowerCase() === lower) return val;
  }
  return null;
}

// --- Request handler ---

// --- OpenAI-compatible error helper ---
// Returns errors in the exact format OpenAI uses so OpenClaw's failover
// engine classifies them correctly (server_error, not billing).
function oaiError(res, status, message, type = "server_error", code = null) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    error: {
      message,
      type,        // "server_error" | "invalid_request_error" | "rate_limit_error"
      code: code,  // null or string like "model_not_found"
      param: null,
    }
  }));
}

// --- Forward a single inference attempt ---
function forwardToRouter(body, sessionId, modelId, isStreaming, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const upstreamUrl = new URL("/v1/chat/completions", ROUTER_URL);
    const upstreamHeaders = {
      "Authorization": getBasicAuth(),
      "Content-Type": "application/json",
      "session_id": sessionId,
      "model_id": modelId,
    };

    const upstreamReq = http.request(upstreamUrl, {
      method: "POST",
      headers: upstreamHeaders,
      timeout: timeoutMs,
    }, (upstreamRes) => {
      // Collect full response to inspect for errors before piping
      if (isStreaming && upstreamRes.headers["content-type"]?.includes("text/event-stream")) {
        // For streaming, resolve immediately with the response to pipe through
        resolve({ status: upstreamRes.statusCode, stream: upstreamRes, headers: upstreamRes.headers });
      } else {
        const chunks = [];
        upstreamRes.on("data", (c) => chunks.push(c));
        upstreamRes.on("end", () => {
          resolve({ status: upstreamRes.statusCode, body: Buffer.concat(chunks), headers: upstreamRes.headers });
        });
        upstreamRes.on("error", (e) => reject(e));
      }
    });

    upstreamReq.on("error", (e) => reject(new Error(`upstream_connect: ${e.message}`)));
    upstreamReq.on("timeout", () => {
      upstreamReq.destroy();
      reject(new Error("upstream_timeout"));
    });

    upstreamReq.write(body);
    upstreamReq.end();
  });
}

// Check if an error response from the router indicates an invalid/expired session
function isSessionError(status, bodyStr) {
  if (status >= 400 && status < 500) {
    const lower = bodyStr.toLowerCase();
    return lower.includes("session") && (lower.includes("not found") || lower.includes("expired") || lower.includes("invalid") || lower.includes("closed"));
  }
  return false;
}

async function handleChatCompletions(req, res, body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    return oaiError(res, 400, "Invalid JSON body", "invalid_request_error");
  }

  const requestedModel = parsed.model || "glm-5";
  const modelId = resolveModelId(requestedModel);

  // --- Gateway-only path: model not on P2P, forward to Morpheus API Gateway ---
  if (!modelId && GATEWAY_ONLY_MODELS.has(requestedModel)) {
    if (!GATEWAY_API_KEY) {
      return oaiError(res, 502,
        `Model "${requestedModel}" is gateway-only but no MOR_GATEWAY_API_KEY is configured`,
        "server_error", "gateway_not_configured");
    }
    console.log(`[morpheus-proxy] Gateway-only model "${requestedModel}" — forwarding to ${GATEWAY_URL}`);
    const isStreaming = parsed.stream === true;
    try {
      const result = await forwardToGateway(body, isStreaming, res);
      if (result.streamed) return; // streaming already piped to res
      res.writeHead(result.status, { "Content-Type": result.headers["content-type"] || "application/json" });
      res.end(result.body);
      return;
    } catch (e) {
      if (!res.headersSent) {
        return oaiError(res, 502,
          `Morpheus Gateway error for ${requestedModel}: ${e.message}`,
          "server_error", "morpheus_gateway_error");
      }
    }
  }

  if (!modelId) {
    return oaiError(res, 400,
      `Unknown model: ${requestedModel}. Available: ${[...Object.keys(MODEL_MAP), ...GATEWAY_ONLY_MODELS].join(", ")}`,
      "invalid_request_error", "model_not_found");
  }

  const isStreaming = parsed.stream === true;

  // P0: Check if we should use Gateway fallback
  if (shouldUseFallback() && GATEWAY_API_KEY) {
    console.log(`[morpheus-proxy] 🔄 Using Gateway fallback for ${requestedModel}`);
    try {
      const result = await forwardToGateway(body, isStreaming, res);
      if (result.streamed) return; // Already handled streaming

      if (result.status >= 200 && result.status < 300) {
        res.writeHead(result.status, { "Content-Type": result.headers["content-type"] || "application/json" });
        res.end(result.body);
        return;
      }

      return oaiError(res, result.status >= 500 ? 502 : result.status,
        `Gateway error: ${result.body.toString().substring(0, 500)}`,
        "server_error", "gateway_error");
    } catch (e) {
      console.error(`[morpheus-proxy] Gateway fallback failed: ${e.message}`);
      return oaiError(res, 502, `Gateway fallback error: ${e.message}`, "server_error", "gateway_error");
    }
  }

  // --- Attempt 1: use existing/new session ---
  let sessionId;
  try {
    sessionId = await getOrCreateSession(modelId);
    if (!sessionId) {
      // Fallback mode - should not reach here, but handle gracefully
      if (GATEWAY_API_KEY) {
        console.log(`[morpheus-proxy] No P2P session, using Gateway fallback`);
        const result = await forwardToGateway(body, isStreaming, res);
        if (result.streamed) return;
        if (result.status >= 200 && result.status < 300) {
          res.writeHead(result.status, { "Content-Type": result.headers["content-type"] || "application/json" });
          res.end(result.body);
          return;
        }
        return oaiError(res, result.status >= 500 ? 502 : result.status,
          `Gateway error: ${result.body.toString().substring(0, 500)}`,
          "server_error", "gateway_error");
      }
      return oaiError(res, 503, "P2P unavailable and no Gateway configured", "server_error", "no_provider");
    }
  } catch (e) {
    console.error(`[morpheus-proxy] Session open error: ${e.message}`);
    p2pFailure();

    // Try Gateway fallback
    if (GATEWAY_API_KEY) {
      console.log(`[morpheus-proxy] 🔄 Falling back to Gateway after P2P failure`);
      try {
        const result = await forwardToGateway(body, isStreaming, res);
        if (result.streamed) return;
        if (result.status >= 200 && result.status < 300) {
          res.writeHead(result.status, { "Content-Type": result.headers["content-type"] || "application/json" });
          res.end(result.body);
          return;
        }
        return oaiError(res, result.status >= 500 ? 502 : result.status,
          `Gateway error: ${result.body.toString().substring(0, 500)}`,
          "server_error", "gateway_error");
      } catch (ge) {
        console.error(`[morpheus-proxy] Gateway fallback also failed: ${ge.message}`);
      }
    }

    // This is a Morpheus infrastructure error, NOT a billing error
    return oaiError(res, 502, `Morpheus session unavailable: ${e.message}`, "server_error", "morpheus_session_error");
  }

  let attempt1Error = null;

  try {
    const result = await forwardToRouter(body, sessionId, modelId, isStreaming);

    // --- Streaming response ---
    if (result.stream) {
      const outHeaders = {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      };
      res.writeHead(result.status, outHeaders);
      result.stream.on("data", (chunk) => res.write(chunk));
      result.stream.on("end", () => res.end());
      result.stream.on("error", (e) => {
        console.error(`[morpheus-proxy] Stream error: ${e.message}`);
        res.end();
      });
      p2pSuccess(); // Mark P2P as working
      return;
    }

    // --- Non-streaming response ---
    const bodyStr = result.body.toString();

    // If router returned success, pass through
    if (result.status >= 200 && result.status < 300) {
      res.writeHead(result.status, { "Content-Type": result.headers["content-type"] || "application/json" });
      res.end(result.body);
      p2pSuccess(); // Mark P2P as working
      return;
    }

    // If it's a session error, we can retry with a fresh session
    if (isSessionError(result.status, bodyStr)) {
      console.log(`[morpheus-proxy] Session error detected (${result.status}), will retry with new session`);
      sessions.delete(modelId); // invalidate cached session
      saveSessions(); // ← runtime save
      attempt1Error = `session_invalid (${result.status})`;
      // Fall through to retry below
    } else {
      // Non-session upstream error — return as server_error (not billing!)
      console.error(`[morpheus-proxy] Router error (${result.status}): ${bodyStr.substring(0, 200)}`);
      p2pFailure();
      return oaiError(res, result.status >= 500 ? 502 : result.status,
        `Morpheus inference error: ${bodyStr.substring(0, 500)}`,
        "server_error", "morpheus_inference_error");
    }
  } catch (e) {
    if (e.message === "upstream_timeout") {
      console.error(`[morpheus-proxy] Upstream timed out on attempt 1`);
      p2pFailure();
      return oaiError(res, 504, "Morpheus inference timed out", "server_error", "timeout");
    }
    // Connection error — might be transient, try to invalidate session and retry
    console.error(`[morpheus-proxy] Attempt 1 failed: ${e.message}`);
    sessions.delete(modelId);
    saveSessions(); // ← runtime save
    p2pFailure();
    attempt1Error = e.message;
  }

  // --- Attempt 2: open a fresh session and retry once ---
  if (attempt1Error) {
    console.log(`[morpheus-proxy] Retrying with fresh session (attempt 1 failed: ${attempt1Error})`);
    let newSessionId;
    try {
      newSessionId = await openSession(modelId);
    } catch (e) {
      console.error(`[morpheus-proxy] Session re-open failed: ${e.message}`);
      return oaiError(res, 502, `Morpheus session unavailable after retry: ${e.message}`, "server_error", "morpheus_session_error");
    }

    try {
      const result = await forwardToRouter(body, newSessionId, modelId, isStreaming);

      if (result.stream) {
        const outHeaders = {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        };
        res.writeHead(result.status, outHeaders);
        result.stream.on("data", (chunk) => res.write(chunk));
        result.stream.on("end", () => res.end());
        result.stream.on("error", (e) => {
          console.error(`[morpheus-proxy] Stream error (retry): ${e.message}`);
          res.end();
        });
        return;
      }

      const bodyStr = result.body.toString();
      if (result.status >= 200 && result.status < 300) {
        res.writeHead(result.status, { "Content-Type": result.headers["content-type"] || "application/json" });
        res.end(result.body);
        return;
      }

      console.error(`[morpheus-proxy] Retry also failed (${result.status}): ${bodyStr.substring(0, 200)}`);
      return oaiError(res, 502,
        `Morpheus inference failed after retry: ${bodyStr.substring(0, 500)}`,
        "server_error", "morpheus_inference_error");
    } catch (e) {
      if (e.message === "upstream_timeout") {
        return oaiError(res, 504, "Morpheus inference timed out (retry)", "server_error", "timeout");
      }
      console.error(`[morpheus-proxy] Retry failed: ${e.message}`);
      return oaiError(res, 502, `Morpheus upstream error after retry: ${e.message}`, "server_error", "morpheus_upstream_error");
    }
  }
}

function handleModels(req, res) {
  const now = Math.floor(Date.now() / 1000);
  const p2pModels = Object.entries(MODEL_MAP).map(([name]) => ({
    id: name,
    object: "model",
    created: now,
    owned_by: "morpheus",
  }));
  // Include gateway-only models that aren't already in MODEL_MAP
  const gwModels = [...GATEWAY_ONLY_MODELS]
    .filter((name) => !MODEL_MAP[name])
    .map((name) => ({
      id: name,
      object: "model",
      created: now,
      owned_by: "morpheus-gateway",
    }));
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ object: "list", data: [...p2pModels, ...gwModels] }));
}

function handleHealth(req, res) {
  const activeSessions = [];
  for (const [modelId, sess] of sessions) {
    const modelName = Object.entries(MODEL_MAP).find(([_, v]) => v === modelId)?.[0] || modelId;
    activeSessions.push({
      model: modelName,
      sessionId: sess.sessionId,
      expiresAt: new Date(sess.expiresAt).toISOString(),
      active: Date.now() < sess.expiresAt,
    });
  }

  // P0: Include balance and fallback status in health
  const health = {
    status: "ok",
    routerUrl: ROUTER_URL,
    gatewayUrl: GATEWAY_URL,
    gatewayConfigured: !!GATEWAY_API_KEY,
    activeSessions,
    availableModels: Object.keys(MODEL_MAP),
    gatewayOnlyModels: [...GATEWAY_ONLY_MODELS].filter((m) => !MODEL_MAP[m]),
    morBalance: morBalance,
    morBalanceLastCheck: morBalanceLastCheck ? new Date(morBalanceLastCheck).toISOString() : null,
    morThreshold: MOR_BALANCE_THRESHOLD,
    fallbackMode,
    fallbackRemaining: fallbackMode ? Math.max(0, Math.floor((fallbackUntil - Date.now()) / 1000)) : 0,
    consecutiveFailures,
  };

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(health, null, 2));
}

// --- Auth check ---
function checkAuth(req) {
  if (PROXY_API_KEY === "morpheus-local") return true; // no auth required if default
  const authHeader = req.headers.authorization;
  if (!authHeader) return false;
  const token = authHeader.replace(/^Bearer\s+/i, "");
  return token === PROXY_API_KEY;
}

// --- Server ---

const server = http.createServer((req, res) => {
  // === STAGE 5: SECURITY MIDDLEWARE FIRST (before auth) ===
  if (!securityMiddleware(req, res)) return;

  // Auth check
  if (!checkAuth(req)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Unauthorized" } }));
    return;
  }

  const url = new URL(req.url, `http://localhost:${PROXY_PORT}`);

  if (req.method === "GET" && url.pathname === "/health") {
    return handleHealth(req, res);
  }

  if (req.method === "GET" && url.pathname === "/v1/models") {
    return handleModels(req, res);
  }

  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString();
      handleChatCompletions(req, res, body).catch((e) => {
        console.error(`[morpheus-proxy] Unhandled error: ${e.message}`);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: e.message } }));
        }
      });
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: "Not found" } }));
});

// v5.12.0: Align server timeouts with upstream consumer→provider total (270s)
server.requestTimeout = 300000;   // 5 min
server.headersTimeout = 305000;   // slightly above requestTimeout
server.keepAliveTimeout = 300000;

server.listen(PROXY_PORT, PROXY_HOST, async () => {
  console.log(`[morpheus-proxy] Listening on http://${PROXY_HOST}:${PROXY_PORT}`);
  console.log(`[morpheus-proxy] Router: ${ROUTER_URL}`);
  console.log(`[morpheus-proxy] Session duration: ${SESSION_DURATION}s, renew before: ${RENEW_BEFORE_SEC}s`);
  console.log(`[morpheus-proxy] MOR threshold: ${MOR_BALANCE_THRESHOLD}, fallback threshold: ${FALLBACK_THRESHOLD} failures`);
  if (GATEWAY_API_KEY) {
    console.log(`[morpheus-proxy] Gateway fallback: configured (${GATEWAY_URL})`);
  } else {
    console.log(`[morpheus-proxy] Gateway fallback: not configured (set MORPHEUS_GATEWAY_API_KEY)`);
  }

  // Refresh model map from router on startup
  await refreshModelMap();
  console.log(`[morpheus-proxy] Available models: ${Object.keys(MODEL_MAP).join(", ")}`);

  // P0: Check MOR balance on startup
  const balance = await checkMorBalance();
  if (balance !== null) {
    console.log(`[morpheus-proxy] MOR balance: ${balance.toFixed(2)}`);
    if (balance < MOR_BALANCE_THRESHOLD) {
      console.warn(`[morpheus-proxy] ⚠️  MOR balance below threshold (${balance.toFixed(2)} < ${MOR_BALANCE_THRESHOLD})`);
    }
  }

  // Periodically refresh to pick up new on-chain models
  if (MODEL_REFRESH_INTERVAL > 0) {
    setInterval(refreshModelMap, MODEL_REFRESH_INTERVAL * 1000);
    console.log(`[morpheus-proxy] Model refresh interval: ${MODEL_REFRESH_INTERVAL}s`);
  }

  // P0: Periodically check MOR balance (every 5 minutes)
  setInterval(checkMorBalance, 300000);
});

server.on("error", (e) => {
  console.error(`[morpheus-proxy] Server error: ${e.message}`);
  process.exit(1);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  saveSessions(); // ← graceful save
  console.log("[morpheus-proxy] Shutting down...");
  server.close(() => process.exit(0));
});
process.on("SIGINT", () => {
  saveSessions(); // ← graceful save
  console.log("[morpheus-proxy] Shutting down...");
  server.close(() => process.exit(0));
});
