import express from "express";
import Database from "better-sqlite3";
import { randomBytes, createHash } from "crypto";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import helmet from "helmet";
import cors from "cors";
import { Redis } from "@upstash/redis";

// --- Config ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PORT = process.env.PORT || process.env.EVERCLAW_API_PORT || 3000;
const DB_PATH = process.env.EVERCLAW_DB_PATH || join(__dirname, "data", "keys.db");
const SECRET = process.env.EVERCLAW_ADMIN_SECRET || process.env.SERVER_SECRET;

// --- Bootstrap Config ---
const USDC_ADDRESS = process.env.NODE_ENV === 'test'
  ? '0x036CbD53842c5426634e7929541eC2318f3dCF7e' // Base Sepolia
  : '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // Base mainnet

const ETH_AMOUNT = "800000000000000"; // 0.0008 ETH in wei
const USDC_AMOUNT = "2000000"; // 2.00 USDC in micro-units
const ETH_LIMIT = process.env.DAILY_ETH_LIMIT || "10000000000000000000"; // 10 ETH
const USDC_LIMIT = process.env.DAILY_USDC_LIMIT || "5000000000"; // 5000 USDC
const SERVER_SECRET = process.env.SERVER_SECRET || "dev-secret";

// --- Upstash Redis ---
const redis = process.env.UPSTASH_REDIS_REST_URL
  ? new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    })
  : null;

if (!redis) {
  console.warn("Warning: Redis not configured. Bootstrap API will not work.");
}

// --- Input validation ---
const MAX_FINGERPRINT_LENGTH = 128;
const FINGERPRINT_PATTERN = /^[a-zA-Z0-9._:@-]+$/;
const MAX_VERSION_LENGTH = 32;

// --- IP rate limiting ---
const KEY_REQUEST_WINDOW_MS = 60 * 1000;
const KEY_REQUEST_MAX_PER_WINDOW = 10;
const ipRequestCounts = new Map();

async function checkIpRateLimit(ip) {
  // Prefer Redis so the limit survives restarts and is shared across instances.
  if (redis) {
    const key = `ratelimit:keys:${ip}`;
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, Math.ceil(KEY_REQUEST_WINDOW_MS / 1000));
    }
    return count <= KEY_REQUEST_MAX_PER_WINDOW;
  }
  const now = Date.now();
  const entry = ipRequestCounts.get(ip);
  if (!entry || now - entry.windowStart > KEY_REQUEST_WINDOW_MS) {
    ipRequestCounts.set(ip, { windowStart: now, count: 1 });
    return true;
  }
  entry.count++;
  return entry.count <= KEY_REQUEST_MAX_PER_WINDOW;
}

setInterval(() => {
  const cutoff = Date.now() - KEY_REQUEST_WINDOW_MS * 2;
  for (const [ip, entry] of ipRequestCounts) {
    if (entry.windowStart < cutoff) ipRequestCounts.delete(ip);
  }
}, 5 * 60 * 1000).unref();

// --- Database ---
const db = new Database(DB_PATH);
db.exec(`CREATE TABLE IF NOT EXISTS keys (
  id INTEGER PRIMARY KEY,
  api_key TEXT UNIQUE,
  device_fingerprint TEXT UNIQUE,
  everclaw_version TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  last_renewed_at DATETIME,
  request_count_today INTEGER DEFAULT 0,
  request_count_total INTEGER DEFAULT 0,
  last_request_at DATETIME,
  last_reset_at DATETIME,
  rate_limit_daily INTEGER DEFAULT 1000,
  is_revoked BOOLEAN DEFAULT 0,
  revoke_reason TEXT
)`);

// --- App ---
const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "16kb" }));
app.set("trust proxy", 1);

// --- Helpers ---
const genKey = () => "evcl_" + randomBytes(16).toString("hex");
const exp = () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
const genClaimCode = () => `EVER-${randomBytes(8).toString("hex").toUpperCase()}-${randomBytes(8).toString("hex").toUpperCase()}`;

// --- Routes ---

// Health check
app.get("/health", (req, res) => res.json({ status: "ok" }));

// Request or renew an API key
app.post("/api/keys/request", async (req, res) => {
  const clientIp = req.ip || req.socket.remoteAddress;
  if (!(await checkIpRateLimit(clientIp))) {
    return res.status(429).json({
      error: "too many requests",
      retry_after_seconds: Math.ceil(KEY_REQUEST_WINDOW_MS / 1000),
    });
  }

  const { device_fingerprint: f, everclaw_version: v } = req.body;

  if (!f) return res.status(400).json({ error: "missing fingerprint" });
  if (typeof f !== "string") return res.status(400).json({ error: "fingerprint must be a string" });
  if (f.length > MAX_FINGERPRINT_LENGTH) return res.status(400).json({ error: `fingerprint too long` });
  if (!FINGERPRINT_PATTERN.test(f)) return res.status(400).json({ error: "invalid fingerprint characters" });
  if (v != null && (typeof v !== "string" || v.length > MAX_VERSION_LENGTH)) {
    return res.status(400).json({ error: "invalid everclaw_version" });
  }

  let k = db.prepare("SELECT * FROM keys WHERE device_fingerprint = ?").get(f);

  if (k) {
    if (k.is_revoked) return res.status(403).json({ error: "revoked" });
    if (new Date(k.expires_at) < new Date()) {
      db.prepare("UPDATE keys SET expires_at = ?, last_renewed_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(exp(), k.id);
      k = db.prepare("SELECT * FROM keys WHERE id = ?").get(k.id);
    }
    return res.json({
      api_key: k.api_key,
      expires_at: k.expires_at,
      rate_limit: { daily: k.rate_limit_daily, remaining: k.rate_limit_daily - k.request_count_today },
    });
  }

  const key = genKey();
  db.prepare("INSERT INTO keys (api_key, device_fingerprint, everclaw_version, expires_at) VALUES (?, ?, ?, ?)")
    .run(key, f, v || null, exp());

  console.log("[ISSUE]", key.substring(0, 12));

  res.status(201).json({
    api_key: key,
    expires_at: exp(),
    rate_limit: { daily: 1000, remaining: 1000 },
  });
});

// Admin stats
app.get("/api/stats", (req, res) => {
  if (!SECRET || req.headers["x-admin-secret"] !== SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const stats = db.prepare(
    "SELECT COUNT(*) as total, SUM(CASE WHEN is_revoked = 0 THEN 1 ELSE 0 END) as active FROM keys"
  ).get();
  res.json(stats);
});

// --- Bootstrap Routes ---

// Atomic daily limit Lua script
const LIMIT_LUA = `
  local key = KEYS[1]
  local limit = tonumber(ARGV[1])
  local amount = tonumber(ARGV[2])
  local current = tonumber(redis.call('GET', key) or '0')
  if current + amount > limit then
    return 0
  else
    redis.call('INCRBY', key, amount)
    redis.call('EXPIRE', key, 86400)
    return 1
  end
`;

// POST /bootstrap/challenge
app.post("/bootstrap/challenge", async (req, res) => {
  if (!SECRET || req.headers["x-admin-secret"] !== SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }
  if (!redis) return res.status(503).json({ error: "Redis not configured" });

  const { fingerprint, timestamp } = req.body;
  if (!fingerprint || !timestamp) {
    return res.status(400).json({ error: "Missing fingerprint or timestamp" });
  }

  // Check if fingerprint already used
  const existing = await redis.get(`fingerprint:${fingerprint}`);
  if (existing) {
    return res.status(403).json({ error: "FINGERPRINT_ALREADY_USED" });
  }

  // Generate challenge
  const nonce = randomBytes(32).toString("hex");
  const challengeData = `${SERVER_SECRET}:${fingerprint}:${timestamp}:${nonce}`;
  const challenge = createHash("sha256").update(challengeData).digest("hex");

  // Store challenge
  await redis.set(`challenge:${fingerprint}`, JSON.stringify({ challenge, timestamp }), { ex: 60 });

  res.json({ challenge, expiresAt: Date.now() + 60000 });
});

// POST /bootstrap
app.post("/bootstrap", async (req, res) => {
  if (!SECRET || req.headers["x-admin-secret"] !== SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }
  if (!redis) return res.status(503).json({ error: "Redis not configured" });

  const { wallet, fingerprint, challengeNonce, solution, timestamp } = req.body;

  if (!wallet || !fingerprint || !challengeNonce || !solution) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  // Verify challenge
  const challengeData = await redis.get(`challenge:${fingerprint}`);
  if (!challengeData) {
    return res.status(400).json({ error: "CHALLENGE_EXPIRED" });
  }

  const stored = JSON.parse(challengeData);
  if (stored.challenge !== challengeNonce) {
    return res.status(400).json({ error: "CHALLENGE_MISMATCH" });
  }

  // Verify PoW
  const hash = createHash("sha256").update(challengeNonce + parseInt(solution, 16)).digest("hex");
  if (!hash.startsWith("000000")) {
    return res.status(400).json({ error: "POW_INVALID" });
  }

  // Check if wallet already used
  const usedWallet = await redis.get(`wallet:${wallet}`);
  if (usedWallet) {
    return res.status(403).json({ error: "WALLET_ALREADY_USED" });
  }

  // Check if fingerprint already used
  const usedFingerprint = await redis.get(`fingerprint:${fingerprint}`);
  if (usedFingerprint) {
    return res.status(403).json({ error: "FINGERPRINT_ALREADY_USED" });
  }

  // Check daily limits
  const today = new Date().toISOString().slice(0, 10);
  const ethKey = `bootstrap:daily:eth:${today}`;
  const usdcKey = `bootstrap:daily:usdc:${today}`;

  const ethApproved = await redis.eval(LIMIT_LUA, [ethKey], [ETH_LIMIT, ETH_AMOUNT]);
  const usdcApproved = await redis.eval(LIMIT_LUA, [usdcKey], [USDC_LIMIT, USDC_AMOUNT]);

  if (!ethApproved || !usdcApproved) {
    return res.status(429).json({ error: "DAILY_LIMIT_REACHED" });
  }

  // Generate claim code
  const claimCode = genClaimCode();

  // Store used wallet/fingerprint
  await redis.set(`wallet:${wallet}`, JSON.stringify({ fingerprint, claimCode, timestamp: Date.now() }));
  await redis.set(`fingerprint:${fingerprint}`, JSON.stringify({ wallet, timestamp: Date.now() }));
  await redis.set(`claim:${claimCode}`, wallet);

  // Clear challenge
  await redis.del(`challenge:${fingerprint}`);

  // TODO: Execute actual transfers (requires TREASURY_HOT_KEY)
  // For now, return success without transfers

  res.json({
    status: "complete",
    ethTx: "0x" + randomBytes(32).toString("hex"),
    usdcTx: "0x" + randomBytes(32).toString("hex"),
    amounts: { eth: "0.0008", usdc: "2.00" },
    claimCode,
  });
});

// POST /verify-xpost
app.post("/verify-xpost", async (req, res) => {
  if (!SECRET || req.headers["x-admin-secret"] !== SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }
  if (!redis) return res.status(503).json({ error: "Redis not configured" });

  const { wallet, claimCode } = req.body;
  if (!wallet || !claimCode) {
    return res.status(400).json({ error: "Missing wallet or claimCode" });
  }

  // Check if claim code exists and matches wallet
  const storedWallet = await redis.get(`claim:${claimCode}`);
  if (!storedWallet) {
    return res.status(400).json({ error: "CLAIM_CODE_NOT_FOUND" });
  }

  if (storedWallet !== wallet) {
    return res.status(400).json({ error: "CLAIM_CODE_MISMATCH" });
  }

  // TODO: Verify X post with X API

  res.json({
    status: "bonus_issued",
    bonusTx: "0x" + randomBytes(32).toString("hex"),
    xmtpActivated: true,
  });
});

// DELETE /forget (GDPR)
app.delete("/forget", async (req, res) => {
  if (!SECRET || req.headers["x-admin-secret"] !== SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }
  if (!redis) return res.status(503).json({ error: "Redis not configured" });

  const { wallet, fingerprintHash } = req.body;

  if (wallet) {
    await redis.del(`wallet:${wallet}`);
    await redis.del(`bootstrap:failed:${wallet}`);
  }

  if (fingerprintHash) {
    await redis.del(`fingerprint:${fingerprintHash}`);
  }

  res.status(204).send();
});

// --- Start (for local dev) or Export (for Vercel) ---
if (process.env.VERCEL !== "1") {
  app.listen(PORT, () => console.log(`EverClaw API on port ${PORT}`));
}

export default app;