#!/usr/bin/env node
/**
 * EverClaw Bootstrap Client
 *
 * Handles micro-funding for x402, ERC-8004, and XMTP Agent Chat.
 * Provides 0.0008 ETH + 2.00 USDC on Base mainnet (or Base Sepolia for testing).
 *
 * Features:
 * - Device fingerprint (SHA-256 hashed)
 * - CPU PoW (6 leading zeros, ~7s average)
 * - PoW + fingerprint validation (EIP-712 signing deferred to v2)
 * - Optional X post for +1 USDC bonus
 *
 * Usage:
 *   node bootstrap-client.mjs bootstrap
 *   node bootstrap-client.mjs bootstrap --test-fingerprint=deadbeef01
 *
 * Environment:
 *   EVERCLAW_BOOTSTRAP_URL - API endpoint (default: https://api.everclaw.xyz)
 *   TEST_FINGERPRINT - Override fingerprint for testing
 *   NODE_ENV=test - Use Base Sepolia instead of Base mainnet
 */

import crypto from 'crypto';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { ENC_FORMAT_V2, deriveEncryptionKey, getPassphraseFromEnv, askLine, decryptLegacyV1 } from './lib/wallet-crypto.mjs';
import { privateKeyToAccount } from 'viem/accounts';
import { execSync } from 'child_process';

// node-machine-id is optional — fallback to OS-based fingerprint
let machineIdSync;
try {
  const { createRequire } = await import('module');
  const require = createRequire(import.meta.url);
  machineIdSync = require('node-machine-id').machineIdSync;
} catch {
  machineIdSync = null;
}

const BOOTSTRAP_DIR = path.join(os.homedir(), '.everclaw');
const STATE_FILE = path.join(BOOTSTRAP_DIR, 'bootstrap.json');

// ─── Issue #13 5A: Safe error logging ───────────────────────────────
function logSafeError(context, error) {
  const msg = error?.message || error?.toString() || '(no details)';
  console.error(`❌ ${context}`);
  if (process.env.DEBUG === '1' || process.env.DEBUG === 'true') {
    console.error(`   ${msg}`);
  }
}

// ─── TLS Enforcement (Issue #8: MITM protection) ──────────────────────────

/**
 * Validate and return the API base URL.
 * Enforces HTTPS for all remote endpoints. Only localhost/127.0.0.1 may use HTTP (dev only).
 */
function resolveApiBase() {
  const raw = process.env.EVERCLAW_BOOTSTRAP_URL || 'https://api.everclaw.xyz';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid EVERCLAW_BOOTSTRAP_URL: ${raw}`);
  }

  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);

  if (parsed.protocol !== 'https:' && !isLocal) {
    throw new Error(
      `EVERCLAW_BOOTSTRAP_URL must use HTTPS for remote hosts (got ${parsed.protocol}//${parsed.hostname}). ` +
      'Plain HTTP exposes wallet addresses and PoW challenges to network observers. ' +
      'Only localhost/127.0.0.1 may use HTTP for development.'
    );
  }

  // Warn if TLS verification is disabled (common footgun)
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0' && !isLocal) {
    console.warn(
      '⚠️  WARNING: NODE_TLS_REJECT_UNAUTHORIZED=0 disables TLS certificate verification.\n' +
      '   This makes HTTPS connections vulnerable to MITM attacks.\n' +
      '   Remove this env var for production use.'
    );
  }

  // Strip trailing slash for consistent URL building
  return parsed.origin + parsed.pathname.replace(/\/+$/, '');
}

const API_BASE = resolveApiBase();
const FETCH_TIMEOUT_MS = 30000; // 30s per request — fail fast on dead networks

// ─── Directory Setup ───────────────────────────────────────────────────────

async function ensureDir() {
  if (!fs.existsSync(BOOTSTRAP_DIR)) {
    fs.mkdirSync(BOOTSTRAP_DIR, { recursive: true, mode: 0o700 });
  }
}

// ─── Fingerprint (GAP-001 + GAP-003)───────────────────────────────────────

/**
 * Generate device fingerprint.
 * SHA-256 hash of machine ID + platform.
 * Can be overridden via TEST_FINGERPRINT for testing.
 */
function getFingerprint() {
  // GAP-003: Test override for Sybil/parallel testing
  if (process.env.TEST_FINGERPRINT) {
    return process.env.TEST_FINGERPRINT;
  }

  let machineId;
  // Try node-machine-id first
  if (machineIdSync) {
    try { machineId = machineIdSync(); } catch { /* fall through */ }
  }
  // Fallback: OS-specific machine ID
  if (!machineId) {
    try {
      if (process.platform === 'darwin') {
        machineId = execSync('ioreg -rd1 -c IOPlatformExpertDevice | grep IOPlatformUUID', {
          encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000
        }).trim();
      } else if (fs.existsSync('/etc/machine-id')) {
        machineId = fs.readFileSync('/etc/machine-id', 'utf-8').trim();
      } else if (fs.existsSync('/var/lib/dbus/machine-id')) {
        machineId = fs.readFileSync('/var/lib/dbus/machine-id', 'utf-8').trim();
      }
    } catch { /* fall through */ }
  }
  // Last resort: hostname + CPU info
  if (!machineId) {
    machineId = `${os.hostname()}:${os.cpus()[0]?.model || 'unknown'}:${os.cpus().length}`;
  }

  return crypto.createHash('sha256')
    .update(`${machineId}:${process.platform}`)
    .digest('hex');
}

// ─── PoW Solver─────────────────────────────────────────────────────────────

/**
 * Solve PoW challenge.
 * Finds nonce such that SHA-256(challenge + nonce) starts with 6 zeros.
 * Timeout: 60 seconds.
 */
async function solvePoW(challenge) {
  const start = Date.now();
  const timeout = 60000; // 60 seconds

  for (let i = 0; Date.now() - start < timeout; i++) {
    const hash = crypto.createHash('sha256')
      .update(challenge + i.toString())
      .digest('hex');
    if (hash.startsWith('000000')) {
      return i.toString(16);
    }
  }
  throw new Error('PoW timeout');
}

// EIP-712 signing deferred to v2 — server currently validates via PoW + fingerprint

// ─── Keychain Access─────────────────────────────────────────────────────────

/**
 * Get private key from keychain.
 * Reuses the same logic as everclaw-wallet.mjs.
 */
async function getKeyFromKeychain() {
  const platform = os.platform();
  const KEYCHAIN_ACCOUNT = process.env.EVERCLAW_KEYCHAIN_ACCOUNT || 'everclaw-agent';
  const KEYCHAIN_SERVICE = process.env.EVERCLAW_KEYCHAIN_SERVICE || 'everclaw-wallet-key';
  const KEY_STORE_PATH = process.env.EVERCLAW_KEY_STORE || path.join(os.homedir(), '.everclaw', 'wallet.enc');

  // macOS Keychain
  if (platform === 'darwin') {
    try {
      const result = execSync(
        `security find-generic-password -a "${KEYCHAIN_ACCOUNT}" -s "${KEYCHAIN_SERVICE}" -w`,
        { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8', timeout: 5000 }
      );
      return result.trim();
    } catch {
      // Fall through to encrypted file
    }
  }

  // Linux libsecret
  if (platform === 'linux') {
    try {
      execSync('which secret-tool', { stdio: 'pipe' });
      const result = execSync(
        `secret-tool lookup service "${KEYCHAIN_SERVICE}" account "${KEYCHAIN_ACCOUNT}"`,
        { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8', timeout: 5000 }
      );
      return result.trim();
    } catch {
      // Fall through to encrypted file
    }
  }

  // Encrypted file fallback
  if (fs.existsSync(KEY_STORE_PATH)) {
    const blob = fs.readFileSync(KEY_STORE_PATH);
    if (blob.length < 2) return null;

    if (blob[0] === ENC_FORMAT_V2) {
      // --- v2: Argon2id/scrypt passphrase-based ---
      if (blob.length < 66) return null;
      const salt = blob.subarray(1, 33);
      const iv = blob.subarray(33, 49);
      const authTag = blob.subarray(49, 65);
      const encrypted = blob.subarray(65);

      // Acquire passphrase: env var → file → interactive prompt
      let passphrase = getPassphraseFromEnv();
      if (!passphrase) {
        if (!process.stdin.isTTY) {
          console.error('❌ Wallet passphrase required. Set EVERCLAW_WALLET_PASSPHRASE env var.');
          return null;
        }
        passphrase = (await askLine('🔑 Enter wallet passphrase: ')).trim();
        if (!passphrase) return null;
      }

      // Single decryption path using shared deriveEncryptionKey helper
      const encKey = await deriveEncryptionKey(passphrase, salt);
      const decipher = crypto.createDecipheriv('aes-256-gcm', encKey, iv);
      decipher.setAuthTag(authTag);
      return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf-8');
    }

    // --- v1 legacy: machine-id based (shared helper) ---
    return decryptLegacyV1(blob, KEYCHAIN_ACCOUNT);
  }

  return null;
}

// ─── Main Bootstrap Function ────────────────────────────────────────────────

/**
 * Run the bootstrap flow:
 * 1. Check if already bootstrapped
 * 2. Get fingerprint
 * 3. Request challenge
 * 4. Solve PoW
 * 5. Sign and submit
 * 6. Store result
 */
async function bootstrap() {
  await ensureDir();

  // Check if already bootstrapped
  if (fs.existsSync(STATE_FILE)) {
    console.log('✅ Bootstrap already completed');
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  }

  try {
    // Get private key
    const privateKey = await getKeyFromKeychain();
    if (!privateKey) {
      throw new Error('No wallet found. Run `everclaw-wallet.mjs setup` first.');
    }

    // Get fingerprint
    const fingerprint = getFingerprint();
    console.log(`🔐 Fingerprint: ${fingerprint.slice(0, 16)}...`);

    // Request challenge (unsigned)
    const timestamp = Date.now();
    console.log('📡 Requesting challenge...');
    const challengeRes = await fetch(`${API_BASE}/bootstrap/challenge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fingerprint, timestamp }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });

    if (!challengeRes.ok) {
      let errMsg = `HTTP ${challengeRes.status}`;
      try { const errBody = await challengeRes.json(); errMsg = errBody.error || errMsg; } catch {}
      throw new Error(`Challenge request failed: ${errMsg}`);
    }
    const challengeData = await challengeRes.json();
    if (!challengeData || typeof challengeData.challenge !== 'string' || challengeData.challenge.length < 16) {
      throw new Error('Invalid challenge response from server — possible MITM or API change');
    }
    const { challenge } = challengeData;
    console.log(`⚡ Challenge received: ${challenge.slice(0, 16)}...`);

    // Solve PoW
    console.log('🔄 Solving PoW (this takes ~7 seconds)...');
    const solution = await solvePoW(challenge);
    console.log('✅ PoW solved');

    // Derive wallet address
    const account = privateKeyToAccount(privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`);
    const wallet = account.address;
    console.log(`✍️ Wallet: ${wallet}`);

    // Submit bootstrap request
    console.log('🚀 Submitting bootstrap request...');
    const claimRes = await fetch(`${API_BASE}/bootstrap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wallet,
        fingerprint,
        challengeNonce: challenge,
        solution
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });

    if (!claimRes.ok) {
      let errMsg = `HTTP ${claimRes.status}`;
      try { const errBody = await claimRes.json(); errMsg = errBody.error || errMsg; } catch {}
      throw new Error(`Bootstrap claim failed: ${errMsg}`);
    }
    const resultData = await claimRes.json();
    if (!resultData || typeof resultData.claimCode !== 'string') {
      throw new Error('Invalid bootstrap response from server — possible MITM or API change');
    }

    // Store result
    fs.writeFileSync(STATE_FILE, JSON.stringify(resultData, null, 2));

    console.log('');
    console.log('✅ Bootstrap complete!');
    console.log(`   ETH: 0.0008 → ${wallet}`);
    console.log(`   USDC: 2.00 → ${wallet}`);
    console.log(`   Claim code: ${resultData.claimCode}`);
    console.log('');
    console.log('To unlock buddy messaging, post this on X:');
    console.log('');
    console.log(`   Just activated my EverClaw Agent on Base!`);
    console.log(`   Agent wallet: ${wallet}`);
    console.log(`   Claim code: ${resultData.claimCode}`);
    console.log(`   #EverClawAI #AgentChat @everclaw_xyz`);
    console.log('');
    console.log(`   Want to chat directly with my new Agent? Install EverClaw and reply with your Agent's address!`);
    console.log('');

    return resultData;
  } catch (error) {
    logSafeError('Bootstrap failed', error);
    throw error;
  }
}

// ─── CLI ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  // Handle test fingerprint override
  const fingerprintOverride = args.find(a => a.startsWith('--test-fingerprint='));
  if (fingerprintOverride) {
    process.env.TEST_FINGERPRINT = fingerprintOverride.split('=')[1];
  }

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
EverClaw Bootstrap Client

Usage:
  node bootstrap-client.mjs bootstrap [--test-fingerprint=HASH]

Environment:
  EVERCLAW_BOOTSTRAP_URL - API endpoint (default: https://api.everclaw.xyz)
  TEST_FINGERPRINT - Override fingerprint for testing
  NODE_ENV=test - Use Base Sepolia instead of Base mainnet

Examples:
  node bootstrap-client.mjs bootstrap
  TEST_FINGERPRINT=deadbeef01 node bootstrap-client.mjs bootstrap
`);
    process.exit(0);
  }

  if (args[0] === 'bootstrap' || args.length === 0) {
    await bootstrap();
  } else {
    console.error(`Unknown command: ${args[0]}`);
    console.error('Run with --help for usage');
    process.exit(1);
  }
}

const isMain = process.argv[1]?.endsWith('bootstrap-client.mjs');
if (isMain) main().catch(e => { logSafeError('Bootstrap', e); process.exit(1); });

// Export for testing
export { bootstrap, getFingerprint, solvePoW };