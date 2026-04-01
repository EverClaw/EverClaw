#!/usr/bin/env node
/**
 * everclaw-wallet.mjs — Self-contained wallet management for Everclaw
 *
 * Replaces: 1Password, Foundry/cast, Safe Wallet, jq
 * Uses: viem (bundled with OpenClaw), platform-native key storage
 *
 * Commands:
 *   setup                    Generate wallet, store in Keychain, print address
 *   address                  Show wallet address
 *   balance                  Show ETH, MOR, USDC balances
 *   swap eth <amount>        Swap ETH for MOR via Uniswap V3
 *   swap usdc <amount>       Swap USDC for MOR via Uniswap V3
 *   approve [amount]         Approve MOR spending for Morpheus Diamond contract
 *   export-key               Print private key (use with caution)
 *   import-key <key>         Import existing private key
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { platform } from "node:os";
import { ENC_FORMAT_V2, deriveEncryptionKey, getPassphraseFromEnv, askLine, promptPassphrase, decryptLegacyV1 } from "./lib/wallet-crypto.mjs";
import { createPublicClient, createWalletClient, http, formatEther, parseEther, formatUnits, parseUnits, encodeFunctionData, parseAbi, maxUint256 } from "viem";
import { base } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

// --- Configuration ---
const KEYCHAIN_ACCOUNT = process.env.EVERCLAW_KEYCHAIN_ACCOUNT || "everclaw-agent";
const KEYCHAIN_SERVICE = process.env.EVERCLAW_KEYCHAIN_SERVICE || "everclaw-wallet-key";

// --- Shell Injection Prevention (Issue #10/#11) ---
// KEYCHAIN_ACCOUNT and KEYCHAIN_SERVICE come from env vars.
// A malicious actor who can set env vars (supply chain, compromised subprocess)
// could inject shell commands via these values. We:
//   1. Validate: only allow safe characters (alphanumeric, hyphens, dots, underscores)
//   2. Eliminate shell: use execFileSync (array args) instead of execSync (shell string)

/**
 * Validate a keychain parameter contains only safe characters.
 * Rejects values that could enable shell injection.
 * @param {string} value - The parameter value to validate
 * @param {string} paramName - Human-readable name for error messages
 * @returns {string} The validated value
 * @throws {Error} If the value contains unsafe characters or is empty
 */
function sanitizeKeychainParam(value, paramName) {
  const str = String(value || '');
  if (!str) {
    console.error(`❌ ${paramName} cannot be empty.`);
    process.exit(1);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(str)) {
    console.error(
      `❌ ${paramName} contains invalid characters: "${str.slice(0, 80)}"\n` +
      `   Only alphanumeric characters, dots, hyphens, and underscores are allowed (no spaces or other punctuation).\n` +
      `   This restriction prevents shell injection attacks.`
    );
    process.exit(1);
  }
  return str;
}

// Validate at load time — fail fast before any keychain operation
sanitizeKeychainParam(KEYCHAIN_ACCOUNT, "EVERCLAW_KEYCHAIN_ACCOUNT");
sanitizeKeychainParam(KEYCHAIN_SERVICE, "EVERCLAW_KEYCHAIN_SERVICE");
const RPC_URL = process.env.EVERCLAW_RPC || "https://base-mainnet.public.blastapi.io";
const KEY_STORE_PATH = process.env.EVERCLAW_KEY_STORE || join(process.env.HOME || "", ".everclaw", "wallet.enc");

// --- Cross-platform key storage backend ---
const OS = platform();

// --- Safety Configuration ---
const SLIPPAGE_BPS = parseInt(process.env.EVERCLAW_SLIPPAGE_BPS || "100", 10); // 100 = 1%
const TX_CONFIRMATIONS = parseInt(process.env.EVERCLAW_CONFIRMATIONS || "1", 10);
const CI_NON_INTERACTIVE = process.env.EVERCLAW_YES === "1" || process.env.CI === "true";
const CI_ALLOW_UNLIMITED = process.argv.includes("--unlimited");
const CI_ALLOW_EXPORT = process.env.EVERCLAW_ALLOW_EXPORT === "1";
const MAX_GAS_LIMIT = BigInt(process.env.EVERCLAW_MAX_GAS || "500000");

// --- Contract Addresses (Base Mainnet) ---
const MOR_TOKEN = "0x7431aDa8a591C955a994a21710752EF9b882b8e3";
const USDC_TOKEN = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH_TOKEN = "0x4200000000000000000000000000000000000006";
const DIAMOND_CONTRACT = "0x6aBE1d282f72B474E54527D93b979A4f64d3030a";
const UNISWAP_ROUTER = "0x2626664c2603336E57B271c5C0b26F421741e481"; // SwapRouter02 on Base
const UNISWAP_QUOTER = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a"; // QuoterV2 on Base

// --- ABIs ---
const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

const SWAP_ROUTER_ABI = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
]);

const QUOTER_ABI = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

// --- Cross-Platform Key Storage ---
// Backend priority:
//   macOS  → macOS Keychain (security CLI)
//   Linux  → libsecret (secret-tool CLI) if available
//   All    → encrypted file fallback (~/.everclaw/wallet.enc)

// -- macOS Keychain backend --
function macKeychainStore(key) {
  try {
    try {
      execFileSync("security", [
        "add-generic-password",
        "-a", KEYCHAIN_ACCOUNT,
        "-s", KEYCHAIN_SERVICE,
        "-w", key,
        "-U"
      ], { stdio: "pipe" });
    } catch {
      try {
        execFileSync("security", [
          "delete-generic-password",
          "-a", KEYCHAIN_ACCOUNT,
          "-s", KEYCHAIN_SERVICE
        ], { stdio: "pipe" });
      } catch {}
      execFileSync("security", [
        "add-generic-password",
        "-a", KEYCHAIN_ACCOUNT,
        "-s", KEYCHAIN_SERVICE,
        "-w", key
      ], { stdio: "pipe" });
    }
    return true;
  } catch (e) {
    console.error("❌ macOS Keychain store failed:", e.message);
    return false;
  }
}

function macKeychainRetrieve() {
  try {
    return execFileSync("security", [
      "find-generic-password",
      "-a", KEYCHAIN_ACCOUNT,
      "-s", KEYCHAIN_SERVICE,
      "-w"
    ], { stdio: "pipe", encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
}

// -- Linux libsecret backend (secret-tool) --
function hasSecretTool() {
  try {
    execFileSync("which", ["secret-tool"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function libsecretStore(key) {
  try {
    execFileSync("secret-tool", [
      "store",
      "--label=Everclaw Wallet",
      "service", KEYCHAIN_SERVICE,
      "account", KEYCHAIN_ACCOUNT
    ], { stdio: ["pipe", "pipe", "pipe"], input: key });
    return true;
  } catch (e) {
    console.error("❌ secret-tool store failed:", e.message);
    return false;
  }
}

function libsecretRetrieve() {
  try {
    return execFileSync("secret-tool", [
      "lookup",
      "service", KEYCHAIN_SERVICE,
      "account", KEYCHAIN_ACCOUNT
    ], { stdio: "pipe", encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
}

// -- Encrypted file backend (universal fallback) --
// v2: Uses AES-256-GCM with a key derived from user passphrase via Argon2id.
// v1 (legacy): Used machine-id + username (insecure — see Issue #7).
// Passphrase sources (priority order):
//   1. EVERCLAW_WALLET_PASSPHRASE env var
//   2. EVERCLAW_WALLET_PASSPHRASE_FILE env var (reads file contents)
//   3. Interactive prompt (TTY required)

// Shared crypto primitives imported from lib/wallet-crypto.mjs
// (ENC_FORMAT_V2, deriveEncryptionKey, getPassphraseFromEnv, askLine, promptPassphrase, decryptLegacyV1)

// --- v2 encrypted file store/retrieve ---

async function encryptedFileStore(key, passphrase) {
  try {
    const dir = join(process.env.HOME || "", ".everclaw");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    const salt = randomBytes(32);
    const encKey = await deriveEncryptionKey(passphrase, salt);
    const iv = randomBytes(16);
    const cipher = createCipheriv("aes-256-gcm", encKey, iv);
    const encrypted = Buffer.concat([cipher.update(key, "utf-8"), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // v2 format: version(1) + salt(32) + iv(16) + authTag(16) + ciphertext
    const blob = Buffer.concat([Buffer.from([ENC_FORMAT_V2]), salt, iv, authTag, encrypted]);
    writeFileSync(KEY_STORE_PATH, blob);
    chmodSync(KEY_STORE_PATH, 0o600);
    return true;
  } catch (e) {
    console.error("❌ Encrypted file store failed:", e.message);
    return false;
  }
}

async function encryptedFileRetrieve() {
  try {
    if (!existsSync(KEY_STORE_PATH)) return null;
    const blob = readFileSync(KEY_STORE_PATH);
    if (blob.length < 2) return null;

    // Detect format version
    if (blob[0] === ENC_FORMAT_V2) {
      // --- v2: Argon2id/scrypt passphrase-based ---
      if (blob.length < 66) return null; // version(1) + salt(32) + iv(16) + authTag(16) + 1
      const salt = blob.subarray(1, 33);
      const iv = blob.subarray(33, 49);
      const authTag = blob.subarray(49, 65);
      const encrypted = blob.subarray(65);

      const passphrase = await promptPassphrase(false);
      if (!passphrase) return null;

      const encKey = await deriveEncryptionKey(passphrase, salt);
      const decipher = createDecipheriv("aes-256-gcm", encKey, iv);
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
      return decrypted.toString("utf-8");
    }

    // --- v1 legacy: machine-id based — migrate to v2 ---
    console.log("\n🔒 Upgrading wallet encryption to secure Argon2id format...");
    const plaintext = decryptLegacyV1(blob, KEYCHAIN_ACCOUNT);
    if (!plaintext) {
      console.error("❌ Failed to decrypt legacy wallet file. Cannot migrate.");
      return null;
    }

    // Create backup before migration
    const backupPath = KEY_STORE_PATH + ".bak";
    copyFileSync(KEY_STORE_PATH, backupPath);
    chmodSync(backupPath, 0o600);
    console.log(`📋 Legacy wallet backed up to ${backupPath}`);

    // Prompt for new passphrase (with confirmation)
    console.log("   You need to set a passphrase to protect your wallet.");
    const passphrase = await promptPassphrase(true);
    if (!passphrase) {
      console.error("❌ Migration aborted — passphrase required. Your wallet is still accessible with the old format.");
      return plaintext; // Still return the key so the user isn't locked out
    }

    // Re-encrypt with v2 format
    const stored = await encryptedFileStore(plaintext, passphrase);
    if (stored) {
      console.log("✅ Wallet encryption upgraded to Argon2id. Backup: " + backupPath);
    } else {
      console.log("⚠️  Migration encryption failed. Wallet still accessible via backup.");
    }
    return plaintext;
  } catch {
    return null;
  }
}

// -- Unified interface --
async function keychainStore(key) {
  if (OS === "darwin") return macKeychainStore(key);
  if (OS === "linux" && hasSecretTool()) {
    if (libsecretStore(key)) return true;
  }
  // Encrypted file fallback — requires passphrase
  console.log("\n🔐 No OS keyring available. Using passphrase-encrypted file storage.");
  const passphrase = await promptPassphrase(true); // confirm on first store
  if (!passphrase) {
    console.error("❌ Cannot store wallet without a passphrase.");
    return false;
  }
  return encryptedFileStore(key, passphrase);
}

async function keychainRetrieve() {
  if (OS === "darwin") return macKeychainRetrieve();
  if (OS === "linux" && hasSecretTool()) {
    const val = libsecretRetrieve();
    if (val) return val;
  }
  return encryptedFileRetrieve();
}

async function keychainExists() {
  return (await keychainRetrieve()) !== null;
}

function getBackendName() {
  if (OS === "darwin") return "macOS Keychain";
  if (OS === "linux" && hasSecretTool()) return "libsecret (secret-tool)";
  return `encrypted file (${KEY_STORE_PATH})`;
}

// --- Viem Clients ---
function getPublicClient() {
  return createPublicClient({
    chain: base,
    transport: http(RPC_URL),
  });
}

function getWalletClient(privateKey) {
  const account = privateKeyToAccount(privateKey);
  return createWalletClient({
    account,
    chain: base,
    transport: http(RPC_URL),
  });
}

function getAccount(privateKey) {
  return privateKeyToAccount(privateKey);
}

// --- Transaction Helpers ---

/** Wait for tx receipt and verify it succeeded. Throws on revert. */
async function waitAndVerify(publicClient, hash, label = "Transaction") {
  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    confirmations: TX_CONFIRMATIONS,
  });
  if (receipt.status === "reverted" || receipt.status === "0x0") {
    throw new Error(`${label} reverted (tx: ${hash})`);
  }
  return receipt;
}

/** Get a quote from Uniswap V3 QuoterV2 for slippage calculation */
async function getQuote(publicClient, tokenIn, tokenOut, amountIn, fee) {
  try {
    const result = await publicClient.simulateContract({
      address: UNISWAP_QUOTER,
      abi: QUOTER_ABI,
      functionName: "quoteExactInputSingle",
      args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }],
    });
    return result.result[0]; // amountOut
  } catch (e) {
    console.warn(`   ⚠️  Quote failed (${e.shortMessage || e.message}), using zero minimum`);
    return 0n;
  }
}

/** Apply slippage tolerance: reduce expected output by SLIPPAGE_BPS */
function applySlippage(amountOut) {
  if (amountOut === 0n) return 0n;
  return amountOut - (amountOut * BigInt(SLIPPAGE_BPS)) / 10000n;
}

// --- Commands ---

async function cmdSetup() {
  if (await keychainExists()) {
    const existing = await keychainRetrieve();
    const account = getAccount(existing);
    console.log("⚠️  Wallet already exists in Keychain.");
    console.log(`   Address: ${account.address}`);
    console.log("   Use 'import-key' to replace it, or 'address' to view it.");
    return;
  }

  console.log("🔐 Generating new Ethereum wallet...");
  const privateKey = generatePrivateKey();
  const account = getAccount(privateKey);

  const keychainOk = await keychainStore(privateKey);

  if (!keychainOk) {
    console.error("❌ All storage backends failed. Wallet NOT saved.");
    console.error("   Run 'setup' again after fixing storage issues.");
    process.exit(1);
  }

  const backend = keychainOk ? getBackendName() : `encrypted file (${KEY_STORE_PATH})`;
  console.log("");
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  ♾️  Everclaw Wallet Created                                ║");
  console.log("╠══════════════════════════════════════════════════════════════╣");
  console.log(`║  Address: ${account.address}  ║`);
  console.log("║                                                              ║");
  console.log(`║  Key stored via: ${backend.padEnd(42)}║`);
  console.log("║  Encrypted at rest.                                          ║");
  console.log("║                                                              ║");
  console.log("║  NEXT STEPS:                                                 ║");
  console.log("║  1. Send ETH to the address above (for gas + MOR swap)      ║");
  console.log("║  2. Run: node everclaw-wallet.mjs swap eth 0.05             ║");
  console.log("║  3. Run: node everclaw-wallet.mjs approve                   ║");
  console.log("║  4. Start inference: bash start.sh                           ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");

  // Auto-bootstrap: request micro-funding (0.0008 ETH + 2 USDC on Base)
  try {
    const { bootstrap: bs } = await import('./bootstrap-client.mjs');
    await bs();
  } catch (e) {
    console.log(`\n⚠️  Auto-bootstrap skipped: ${e.message}`);
  }
}

async function cmdAddress() {
  const key = await keychainRetrieve();
  if (!key) {
    console.error("❌ No wallet found. Run 'setup' first.");
    process.exit(1);
  }
  const account = getAccount(key);
  console.log(account.address);
}

async function cmdBalance() {
  const key = await keychainRetrieve();
  if (!key) {
    console.error("❌ No wallet found. Run 'setup' first.");
    process.exit(1);
  }
  const account = getAccount(key);
  const client = getPublicClient();

  console.log(`\n💰 Balances for ${account.address}\n`);

  // ETH balance
  const ethBalance = await client.getBalance({ address: account.address });
  console.log(`   ETH:  ${formatEther(ethBalance)}`);

  // MOR balance
  const morBalance = await client.readContract({
    address: MOR_TOKEN,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [account.address],
  });
  console.log(`   MOR:  ${formatEther(morBalance)}`);

  // USDC balance
  const usdcBalance = await client.readContract({
    address: USDC_TOKEN,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [account.address],
  });
  console.log(`   USDC: ${formatUnits(usdcBalance, 6)}`);

  // MOR allowance for Diamond
  const allowance = await client.readContract({
    address: MOR_TOKEN,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [account.address, DIAMOND_CONTRACT],
  });
  console.log(`\n   MOR allowance (Diamond): ${formatEther(allowance)}`);
  console.log("");
}

async function cmdSwap(tokenIn, amountStr) {
  if (!tokenIn || !amountStr) {
    console.error("Usage: everclaw-wallet.mjs swap <eth|usdc> <amount>");
    process.exit(1);
  }

  const key = await keychainRetrieve();
  if (!key) {
    console.error("❌ No wallet found. Run 'setup' first.");
    process.exit(1);
  }

  const account = getAccount(key);
  const publicClient = getPublicClient();
  const walletClient = getWalletClient(key);

  const isETH = tokenIn.toLowerCase() === "eth";
  const isUSDC = tokenIn.toLowerCase() === "usdc";

  if (!isETH && !isUSDC) {
    console.error("❌ Supported tokens: eth, usdc");
    process.exit(1);
  }

  const tokenInAddress = isETH ? WETH_TOKEN : USDC_TOKEN;
  const decimals = isETH ? 18 : 6;
  const amountIn = isETH ? parseEther(amountStr) : parseUnits(amountStr, 6);
  const fee = 10000; // 1% fee tier (most common for MOR pairs)

  console.log(`\n🔄 Swapping ${amountStr} ${tokenIn.toUpperCase()} → MOR on Uniswap V3...\n`);

  // For USDC, approve the router first
  if (isUSDC) {
    console.log("   Approving USDC for swap router...");
    const approveTx = await walletClient.writeContract({
      address: USDC_TOKEN,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [UNISWAP_ROUTER, amountIn],
      gas: MAX_GAS_LIMIT,
    });
    console.log(`   Approve tx: ${approveTx}`);
    await waitAndVerify(publicClient, approveTx, "USDC approve");
    console.log("   ✓ Approved\n");
  }

  // Get quote for slippage protection
  console.log(`   Getting quote (slippage tolerance: ${SLIPPAGE_BPS / 100}%)...`);
  const quotedOutput = await getQuote(publicClient, tokenInAddress, MOR_TOKEN, amountIn, fee);
  const amountOutMinimum = applySlippage(quotedOutput);
  if (quotedOutput > 0n) {
    console.log(`   Expected: ~${formatEther(quotedOutput)} MOR`);
    console.log(`   Minimum:  ~${formatEther(amountOutMinimum)} MOR\n`);
  }

  // Execute swap
  const swapParams = {
    tokenIn: tokenInAddress,
    tokenOut: MOR_TOKEN,
    fee,
    recipient: account.address,
    amountIn,
    amountOutMinimum,
    sqrtPriceLimitX96: 0n,
  };

  // === STAGE 3: Simulate + Rich Confirmation ===
  console.log("🔍 Simulating swap...");
  await publicClient.simulateContract({
    address: UNISWAP_ROUTER,
    abi: SWAP_ROUTER_ABI,
    functionName: "exactInputSingle",
    args: [swapParams],
    account: walletClient.account,
    value: isETH ? amountIn : 0n,
  });
  console.log("   ✅ Simulation passed");

  console.log(`\n   Swap details:`);
  console.log(`     In:  ${amountStr} ${tokenIn.toUpperCase()}`);
  console.log(`     Expected out: ${formatEther(quotedOutput)} MOR`);
  console.log(`     Min out (after ${SLIPPAGE_BPS / 100}% slippage): ${formatEther(amountOutMinimum)} MOR`);

  let swapAnswer;
  if (CI_NON_INTERACTIVE) {
    console.log(`\n⚠️  CI MODE: Auto-approved swap of ${amountStr} ${tokenIn.toUpperCase()} → MOR`);
    swapAnswer = "yes";
  } else {
    swapAnswer = await new Promise(r => {
      process.stdout.write("\n⚠️  CONFIRM SWAP? (type yes to proceed) ");
      process.stdin.once("data", d => r(d.toString().trim().toLowerCase()));
    });
  }
  if (swapAnswer !== "yes") {
    console.log("Cancelled by user.");
    process.exit(0);
  }

  if (global.DRY_RUN) {
    console.log("\n🔒 DRY-RUN: Simulation passed. Skipping actual swap transaction.");
    process.exit(0);
  }

  console.log("   Executing swap...");

  try {
    const tx = await walletClient.writeContract({
      address: UNISWAP_ROUTER,
      abi: SWAP_ROUTER_ABI,
      functionName: "exactInputSingle",
      args: [swapParams],
      value: isETH ? amountIn : 0n,
      gas: MAX_GAS_LIMIT,
    });

    console.log(`   Swap tx: ${tx}`);
    const receipt = await waitAndVerify(publicClient, tx, "Swap");

    // Check new MOR balance
    const morBalance = await publicClient.readContract({
      address: MOR_TOKEN,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [account.address],
    });
    console.log(`\n   ✅ Swap successful!`);
    console.log(`   MOR balance: ${formatEther(morBalance)}`);
    console.log(`   Gas used: ${receipt.gasUsed}`);
  } catch (e) {
    console.error(`\n   ❌ Swap failed: ${e.shortMessage || e.message}`);
    process.exit(1);
  }
  console.log("");
}

async function cmdApprove(amountStr) {
  // CI safety gate: check BEFORE wallet retrieval for fail-fast
  const isUnlimited = !amountStr;
  if (CI_NON_INTERACTIVE && isUnlimited && !CI_ALLOW_UNLIMITED) {
    console.error("\n❌ CI MODE: Unlimited MOR approval blocked.");
    console.error("   CI/automated environments cannot silently approve unlimited token spending.");
    console.error("   To explicitly allow this, pass the --unlimited flag:");
    console.error("     node everclaw-wallet.mjs approve --unlimited");
    console.error("   Or specify a bounded amount:");
    console.error("     node everclaw-wallet.mjs approve 1000");
    process.exit(1);
  }

  const key = await keychainRetrieve();
  if (!key) {
    console.error("❌ No wallet found. Run 'setup' first.");
    process.exit(1);
  }

  const publicClient = getPublicClient();
  const walletClient = getWalletClient(key);

  // Default: approve max (so user doesn't have to re-approve)
  const amount = amountStr ? parseEther(amountStr) : maxUint256;
  const displayAmount = amountStr || "unlimited";

  console.log(`\n🔓 Approving MOR for Morpheus Diamond contract...`);
  console.log(`   Amount: ${displayAmount}`);
  console.log(`   Spender: ${DIAMOND_CONTRACT}\n`);

  // === STAGE 4: Simulate + Strong Unlimited Warning ===
  console.log("🔍 Simulating approve...");
  await publicClient.simulateContract({
    address: MOR_TOKEN,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [DIAMOND_CONTRACT, amount],
    account: walletClient.account,
  });
  console.log("   ✅ Simulation passed");

  if (isUnlimited) {
    console.log("\n⚠️  CRITICAL SECURITY WARNING:");
    console.log("   You are approving UNLIMITED MOR spending by the Diamond contract.");
    console.log("   This is permanent until manually revoked. If the contract is ever compromised,");
    console.log("   all your MOR can be drained.");
  }

  let approveAnswer;
  if (CI_NON_INTERACTIVE) {
    const approvedType = isUnlimited ? "UNLIMITED (--unlimited flag)" : `${amountStr || "unknown"} MOR`;
    console.log(`\n⚠️  CI MODE: Auto-approved MOR approval: ${approvedType}`);
    approveAnswer = "yes";
  } else {
    approveAnswer = await new Promise(r => {
      const promptText = isUnlimited
        ? "⚠️  CONFIRM UNLIMITED APPROVAL? (type yes to proceed) "
        : `⚠️  CONFIRM APPROVE ${amountStr} MOR? (type yes to proceed) `;
      process.stdout.write(promptText);
      process.stdin.once("data", d => r(d.toString().trim().toLowerCase()));
    });
  }
  if (approveAnswer !== "yes") {
    console.log("Cancelled by user.");
    process.exit(0);
  }

  if (global.DRY_RUN) {
    console.log("\n🔒 DRY-RUN: Simulation passed. Skipping actual approve transaction.");
    process.exit(0);
  }

  try {
    const tx = await walletClient.writeContract({
      address: MOR_TOKEN,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [DIAMOND_CONTRACT, amount],
      gas: MAX_GAS_LIMIT,
    });

    console.log(`   Tx: ${tx}`);
    await waitAndVerify(publicClient, tx, "Approve");
    console.log("   ✅ MOR approved for staking.\n");
  } catch (e) {
    console.error(`   ❌ Approve failed: ${e.shortMessage || e.message}`);
    process.exit(1);
  }
}

async function cmdExportKey() {
  // CI safety gate: check BEFORE wallet retrieval for fail-fast
  if (CI_NON_INTERACTIVE && !CI_ALLOW_EXPORT) {
    console.error("\n❌ CI MODE: Private key export blocked.");
    console.error("   CI/automated environments cannot silently export private keys.");
    console.error("   To explicitly allow this, set the environment variable:");
    console.error("     EVERCLAW_ALLOW_EXPORT=1 node everclaw-wallet.mjs export-key");
    process.exit(1);
  }

  const key = await keychainRetrieve();
  if (!key) {
    console.error("❌ No wallet found. Run 'setup' first.");
    process.exit(1);
  }
  const account = getAccount(key);

  // === STAGE 5: Double confirmation + countdown ===
  console.log("\n⚠️  WARNING: You are about to export your PRIVATE KEY in cleartext.");
  console.log("   This is EXTREMELY DANGEROUS. Anyone with this key controls your wallet.");
  console.log("   Type 'YES I UNDERSTAND' to continue (exact match required).");

  let confirm;
  if (CI_NON_INTERACTIVE) {
    console.log("\n⚠️  CI MODE: Auto-confirmed key export (EVERCLAW_ALLOW_EXPORT=1)");
    confirm = "YES I UNDERSTAND";
  } else {
    confirm = await new Promise(r => {
      process.stdout.write("> ");
      process.stdin.once("data", d => r(d.toString().trim()));
    });
  }

  if (confirm !== "YES I UNDERSTAND") {
    console.log("Export cancelled.");
    process.exit(0);
  }

  if (!CI_NON_INTERACTIVE) {
    console.log("   Proceeding in 5 seconds... Press Ctrl+C to abort.");
    await new Promise(r => setTimeout(r, 5000));
  }

  console.log(`\n⚠️  PRIVATE KEY — DO NOT SHARE THIS WITH ANYONE\n`);
  console.log(`   Address: ${account.address}`);
  console.log(`   Key:     ${key}\n`);

  process.exit(0); // stdin left in flowing mode — force clean exit
}

async function cmdImportKey(privateKey) {
  if (!privateKey) {
    console.error("Usage: everclaw-wallet.mjs import-key <0x...private_key>");
    process.exit(1);
  }

  if (!privateKey.startsWith("0x")) {
    privateKey = "0x" + privateKey;
  }

  try {
    const account = getAccount(privateKey);
    if (!(await keychainStore(privateKey))) {
      console.error("❌ Failed to store key in Keychain.");
      process.exit(1);
    }
    console.log(`\n✅ Key imported successfully.`);
    console.log(`   Address: ${account.address}`);
    console.log(`   Backend: ${getBackendName()}\n`);
  } catch (e) {
    console.error(`❌ Invalid private key: ${e.message}`);
    process.exit(1);
  }
}

function showHelp() {
  console.log(`
♾️  Everclaw Wallet — Self-sovereign key management

Commands:
  setup                    Generate wallet, store securely
  address                  Show wallet address
  balance                  Show ETH, MOR, USDC balances
  swap eth <amount>        Swap ETH for MOR via Uniswap V3
  swap usdc <amount>       Swap USDC for MOR via Uniswap V3
  approve [amount]         Approve MOR for Morpheus staking
  export-key               Print private key (use with caution)
  import-key <0xkey>       Import existing private key

Key Storage Backends (auto-detected):
  macOS    → macOS Keychain (security CLI)
  Linux    → libsecret/secret-tool if available, encrypted file fallback
  Other    → encrypted file (~/.everclaw/wallet.enc)

Flags:
  --unlimited                Explicitly allow unlimited MOR approval in CI mode
  --dry-run                  Simulate transactions without sending

Environment:
  EVERCLAW_RPC               Base RPC URL (default: public blastapi)
  EVERCLAW_KEY_STORE         Override encrypted file path (default: ~/.everclaw/wallet.enc)
  EVERCLAW_KEYCHAIN_ACCOUNT  Keychain/libsecret account name (default: everclaw-agent)
  EVERCLAW_KEYCHAIN_SERVICE  Keychain/libsecret service name (default: everclaw-wallet-key)
  EVERCLAW_SLIPPAGE_BPS      Slippage tolerance in basis points (default: 100 = 1%)
  EVERCLAW_CONFIRMATIONS     Block confirmations to wait (default: 1)
  EVERCLAW_MAX_GAS           Gas limit for transactions (default: 500000)
  EVERCLAW_ALLOW_EXPORT      Set to "1" to allow key export in CI mode
  EVERCLAW_YES               Set to "1" for non-interactive CI mode
  CI                         Set to "true" for non-interactive CI mode

Examples:
  node everclaw-wallet.mjs setup
  node everclaw-wallet.mjs swap eth 0.05
  node everclaw-wallet.mjs approve 1000              # Bounded approval (CI-safe)
  node everclaw-wallet.mjs approve --unlimited        # Unlimited approval (explicit)
  node everclaw-wallet.mjs balance

CI Safety:
  In CI mode (EVERCLAW_YES=1 or CI=true):
  - Bounded approvals and swaps auto-confirm (simulated first)
  - Unlimited approvals BLOCKED unless --unlimited flag is passed
  - Key export BLOCKED unless EVERCLAW_ALLOW_EXPORT=1 is set
`);
}

// --- Main ---
const [,, command, ...rawArgs] = process.argv;

// Filter known flags from positional args
const KNOWN_FLAGS = new Set(["--unlimited", "--dry-run"]);
const args = rawArgs.filter(a => !KNOWN_FLAGS.has(a));

// === GLOBAL DRY-RUN SAFETY ===
if (rawArgs.includes("--dry-run")) {
  console.log("🔒 DRY-RUN MODE ENABLED — no real transactions will be sent");
  global.DRY_RUN = true;
}

switch (command) {
  case "setup":
    cmdSetup().catch(console.error);
    break;
  case "address":
    cmdAddress().catch(console.error);
    break;
  case "balance":
    cmdBalance().catch(console.error);
    break;
  case "swap":
    cmdSwap(args[0], args[1]).catch(console.error);
    break;
  case "approve":
    cmdApprove(args[0]).catch(console.error);
    break;
  case "export-key":
    cmdExportKey().catch(console.error);
    break;
  case "import-key":
    cmdImportKey(args[0]).catch(console.error);
    break;
  default:
    showHelp();
}
