#!/usr/bin/env node
/**
 * Safe Transfer Script - Transfer MOR from Safe to Router wallet
 * 
 * Usage: node safe-transfer.mjs <amount> [--execute]
 * 
 * The Safe is 1-of-2, and the router wallet is an owner,
 * so it can execute transactions alone.
 * 
 * Required env vars: MORPHEUS_SAFE_ADDRESS, MORPHEUS_WALLET_ADDRESS
 */

import { createPublicClient, createWalletClient, http, parseEther, formatEther, encodeFunctionData, parseAbi } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { execSync } from "node:child_process";

// Config
const RPC_URL = process.env.EVERCLAW_RPC || "https://base-mainnet.public.blastapi.io";
const MOR_TOKEN = "0x7431aDa8a591C955a994a21710752EF9b882b8e3";
const SAFE_ADDRESS = process.env.MORPHEUS_SAFE_ADDRESS;
const ROUTER_WALLET = process.env.MORPHEUS_WALLET_ADDRESS;
if (!SAFE_ADDRESS) { console.error("❌ MORPHEUS_SAFE_ADDRESS env var required"); process.exit(1); }
if (!ROUTER_WALLET) { console.error("❌ MORPHEUS_WALLET_ADDRESS env var required"); process.exit(1); }

const ERC20_ABI = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

const SAFE_ABI = parseAbi([
  "function nonce() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) returns (bool)",
]);

const OP_KEYCHAIN_ACCOUNT = process.env.OP_KEYCHAIN_ACCOUNT;
const OP_KEYCHAIN_SERVICE = process.env.OP_KEYCHAIN_SERVICE || "op-service-account-token";
const OP_VAULT = process.env.OP_VAULT;
const OP_ITEM = process.env.OP_ITEM;
if (!OP_KEYCHAIN_ACCOUNT) { console.error("❌ OP_KEYCHAIN_ACCOUNT env var required"); process.exit(1); }
if (!OP_VAULT) { console.error("❌ OP_VAULT env var required"); process.exit(1); }
if (!OP_ITEM) { console.error("❌ OP_ITEM env var required"); process.exit(1); }

async function getPrivateKey() {
  const token = execSync(`security find-generic-password -a "${OP_KEYCHAIN_ACCOUNT}" -s "${OP_KEYCHAIN_SERVICE}" -w 2>/dev/null`, { encoding: 'utf-8' }).trim();
  process.env.OP_SERVICE_ACCOUNT_TOKEN = token;
  const key = execSync(`op item get "${OP_ITEM}" --vault "${OP_VAULT}" --fields "Private Key" --reveal 2>/dev/null`, { encoding: 'utf-8' }).trim();
  return key;
}

async function main() {
  const amountMor = process.argv[2];
  const shouldExecute = process.argv.includes("--execute");
  
  if (!amountMor || isNaN(parseFloat(amountMor))) {
    console.error("Usage: node safe-transfer.mjs <amount> [--execute]");
    console.error("Example: node safe-transfer.mjs 300 --execute");
    process.exit(1);
  }
  
  const amountWei = parseEther(amountMor);
  
  console.log(`\n🏦 Safe Transfer Script\n`);
  console.log(`Safe:        ${SAFE_ADDRESS}`);
  console.log(`Recipient:   ${ROUTER_WALLET}`);
  console.log(`Amount:      ${amountMor} MOR`);
  console.log(`Execute:     ${shouldExecute ? "YES" : "NO (dry run)"}\n`);
  
  // Get private key from 1Password
  console.log("🔑 Fetching private key from 1Password...");
  const privateKey = await getPrivateKey();
  const account = privateKeyToAccount(privateKey);
  console.log(`   Signer: ${account.address}\n`);
  
  // Setup clients
  const publicClient = createPublicClient({ chain: base, transport: http(RPC_URL) });
  const walletClient = createWalletClient({ account, chain: base, transport: http(RPC_URL) });
  
  // Check MOR balance on Safe
  console.log("💰 Checking Safe MOR balance...");
  const safeBalance = await publicClient.readContract({
    address: MOR_TOKEN,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [SAFE_ADDRESS],
  });
  console.log(`   Safe balance: ${formatEther(safeBalance)} MOR\n`);
  
  if (safeBalance < amountWei) {
    console.error(`❌ Insufficient balance. Safe has ${formatEther(safeBalance)} MOR, need ${amountMor} MOR.`);
    process.exit(1);
  }
  
  // Check Safe owners and threshold
  console.log("🔍 Checking Safe configuration...");
  const [owners, threshold, nonce] = await Promise.all([
    publicClient.readContract({ address: SAFE_ADDRESS, abi: SAFE_ABI, functionName: "getOwners" }),
    publicClient.readContract({ address: SAFE_ADDRESS, abi: SAFE_ABI, functionName: "getThreshold" }),
    publicClient.readContract({ address: SAFE_ADDRESS, abi: SAFE_ABI, functionName: "nonce" }),
  ]);
  
  console.log(`   Owners: ${owners.map(o => o.slice(0, 10) + '...').join(', ')}`);
  console.log(`   Threshold: ${threshold}`);
  console.log(`   Nonce: ${nonce}`);
  
  const isOwner = owners.some(o => o.toLowerCase() === account.address.toLowerCase());
  if (!isOwner) {
    console.error(`\n❌ Signer ${account.address} is not an owner of this Safe!`);
    process.exit(1);
  }
  console.log(`   ✅ Signer is an owner`);

  // Validate threshold === 1 (Issue #12, 4D)
  // This script produces a single signature. A multi-sig Safe (threshold > 1)
  // would accept the tx submission but it would revert on-chain, wasting gas.
  if (threshold !== 1n) {
    console.error(`\n❌ Safe threshold is ${threshold}, but this script requires exactly 1.`);
    console.error(`   This is a ${threshold}-of-${owners.length} Safe — needs ${threshold} signatures to execute.`);
    console.error(`   This script produces only 1 signature — the transaction would revert on-chain.`);
    console.error(`   Use the Safe web interface at https://app.safe.global for multi-sig transactions.`);
    process.exit(1);
  }
  console.log(`   ✅ Threshold is 1 (single-signer execution)\n`);

  if (!shouldExecute) {
    console.log("📋 Dry run complete. Run with --execute to submit transaction.\n");
    return;
  }
  
  // Build Safe transaction
  console.log("📝 Building Safe transaction...");
  
  // Encode the MOR transfer call
  const transferData = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [ROUTER_WALLET, amountWei],
  });
  
  // Safe transaction parameters
  const safeTx = {
    to: MOR_TOKEN,
    value: 0n,
    data: transferData,
    operation: 0, // CALL
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: "0x0000000000000000000000000000000000000000",
    refundReceiver: "0x0000000000000000000000000000000000000000",
    nonce: nonce,
  };
  
  // Build the Safe transaction hash
  // EIP-712 typed data for Safe transaction
  const domain = {
    verifyingContract: SAFE_ADDRESS,
    chainId: 8453,
  };
  
  const types = {
    SafeTx: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "operation", type: "uint8" },
      { name: "safeTxGas", type: "uint256" },
      { name: "baseGas", type: "uint256" },
      { name: "gasPrice", type: "uint256" },
      { name: "gasToken", type: "address" },
      { name: "refundReceiver", type: "address" },
      { name: "nonce", type: "uint256" },
    ],
  };
  
  // Sign the transaction
  console.log("✍️  Signing transaction...");
  const signature = await walletClient.signTypedData({
    domain,
    types,
    primaryType: "SafeTx",
    message: safeTx,
  });
  
  // Signature from viem is already in correct r+s+v format for Safe — no packing needed

  // === STAGE 1: SIMULATE + CONFIRM BEFORE execution ===
  console.log("🔍 Simulating Safe transaction on Base...");
  await publicClient.simulateContract({
    address: SAFE_ADDRESS,
    abi: SAFE_ABI,
    functionName: "execTransaction",
    args: [safeTx.to, safeTx.value, safeTx.data, safeTx.operation, safeTx.safeTxGas, safeTx.baseGas, safeTx.gasPrice, safeTx.gasToken, safeTx.refundReceiver, signature],
    account: walletClient.account,
  });
  console.log("   ✅ Simulation passed");

  const answer = await new Promise(resolve => {
    process.stdout.write("⚠️  CONFIRM TRANSACTION? (type yes to proceed) ");
    process.stdin.once("data", d => resolve(d.toString().trim().toLowerCase()));
  });
  if (answer !== "yes") {
    console.log("Cancelled by user.");
    process.exit(0);
  }

  console.log("📤 Executing Safe transaction...");
  
  try {
    const hash = await walletClient.writeContract({
      address: SAFE_ADDRESS,
      abi: SAFE_ABI,
      functionName: "execTransaction",
      args: [
        safeTx.to,
        safeTx.value,
        safeTx.data,
        safeTx.operation,
        safeTx.safeTxGas,
        safeTx.baseGas,
        safeTx.gasPrice,
        safeTx.gasToken,
        safeTx.refundReceiver,
        signature,
      ],
      gas: undefined, // let viem estimate dynamically
    });
    
    console.log(`\n✅ Transaction submitted: ${hash}`);
    console.log(`   View on BaseScan: https://basescan.org/tx/${hash}\n`);
    
    // Wait for confirmation
    console.log("⏳ Waiting for confirmation...");
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    
    if (receipt.status === "success") {
      console.log(`\n🎉 Success! Transferred ${amountMor} MOR from Safe to Router wallet.`);
      
      // Check new balances
      const newRouterBalance = await publicClient.readContract({
        address: MOR_TOKEN,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [ROUTER_WALLET],
      });
      console.log(`   Router wallet balance: ${formatEther(newRouterBalance)} MOR\n`);
    } else {
      console.error(`\n❌ Transaction reverted!\n`);
      process.exit(1);
    }
  } catch (e) {
    console.error(`\n❌ Transaction failed: ${e.message}\n`);
    process.exit(1);
  }
}

main().catch(console.error);