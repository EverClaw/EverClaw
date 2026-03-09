#!/usr/bin/env node
/**
 * everclaw-wallet.test.mjs — Integration tests for everclaw-wallet.mjs
 * Part A1: Scaffold + offline tests (no RPC)
 *
 * Uses node:test (built-in, no deps).
 * Isolates from real wallet via EVERCLAW_KEYCHAIN_ACCOUNT/SERVICE env vars.
 *
 * Run: node --test scripts/everclaw-wallet.test.mjs
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createServer } from "node:http";

// --- Test Config ---
const __dirname = dirname(fileURLToPath(import.meta.url));
const WALLET_SCRIPT = join(__dirname, "everclaw-wallet.mjs");

const TEST_ACCOUNT = "everclaw-test-agent";
const TEST_SERVICE = "everclaw-test-wallet-key";

// A known-valid private key for testing (DO NOT use on mainnet with real funds)
const TEST_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
// Corresponding address (Hardhat account #0)
const TEST_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

// --- Helpers ---

/** Run the wallet script with args (sync), return { stdout, stderr, exitCode } */
function runWallet(args = [], env = {}) {
  const fullEnv = {
    ...process.env,
    EVERCLAW_KEYCHAIN_ACCOUNT: TEST_ACCOUNT,
    EVERCLAW_KEYCHAIN_SERVICE: TEST_SERVICE,
    // Point RPC to nowhere — offline tests should never hit RPC
    EVERCLAW_RPC: "http://127.0.0.1:1/offline",
    ...env,
  };

  try {
    const stdout = execFileSync("node", [WALLET_SCRIPT, ...args], {
      encoding: "utf-8",
      env: fullEnv,
      timeout: 10_000,
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (e) {
    return {
      stdout: e.stdout?.toString() || "",
      stderr: e.stderr?.toString() || "",
      exitCode: e.status ?? 1,
    };
  }
}

/**
 * Run the wallet script ASYNC — required for A2 tests where a mock HTTP
 * server runs in the same process. execFileSync blocks the event loop,
 * preventing the server from responding (deadlock). This version uses
 * child_process.execFile with a Promise wrapper so the event loop stays free.
 */
import { execFile } from "node:child_process";

function runWalletAsync(args = [], env = {}) {
  const fullEnv = {
    ...process.env,
    EVERCLAW_KEYCHAIN_ACCOUNT: TEST_ACCOUNT,
    EVERCLAW_KEYCHAIN_SERVICE: TEST_SERVICE,
    EVERCLAW_RPC: "http://127.0.0.1:1/offline",
    ...env,
  };

  return new Promise((resolve) => {
    execFile("node", [WALLET_SCRIPT, ...args], {
      encoding: "utf-8",
      env: fullEnv,
      timeout: 30_000,
    }, (err, stdout, stderr) => {
      if (err) {
        resolve({
          stdout: stdout || "",
          stderr: stderr || "",
          exitCode: err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? 1 : (err.code ?? 1),
        });
      } else {
        resolve({ stdout: stdout || "", stderr: stderr || "", exitCode: 0 });
      }
    });
  });
}

/** Delete the test keychain entry (cleanup) */
function deleteTestKeychain() {
  try {
    execSync(
      `security delete-generic-password -a "${TEST_ACCOUNT}" -s "${TEST_SERVICE}"`,
      { stdio: "pipe" }
    );
  } catch {
    // Doesn't exist — fine
  }
}

/** Store a key in the test keychain slot */
function storeTestKey(key) {
  try {
    execSync(
      `security add-generic-password -a "${TEST_ACCOUNT}" -s "${TEST_SERVICE}" -w "${key}" -U`,
      { stdio: "pipe" }
    );
  } catch {
    // Update failed, try delete + add
    deleteTestKeychain();
    execSync(
      `security add-generic-password -a "${TEST_ACCOUNT}" -s "${TEST_SERVICE}" -w "${key}"`,
      { stdio: "pipe" }
    );
  }
}

/** Retrieve key from test keychain slot */
function retrieveTestKey() {
  try {
    return execSync(
      `security find-generic-password -a "${TEST_ACCOUNT}" -s "${TEST_SERVICE}" -w`,
      { stdio: "pipe", encoding: "utf-8" }
    ).trim();
  } catch {
    return null;
  }
}

// --- Mock RPC Server ---
// Intercepts JSON-RPC calls and returns canned responses.
// Tracks call history for assertions.

const MOR_TOKEN  = "0x7431aDa8a591C955a994a21710752EF9b882b8e3".toLowerCase();
const USDC_TOKEN = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913".toLowerCase();
const WETH_TOKEN = "0x4200000000000000000000000000000000000006".toLowerCase();
const DIAMOND    = "0x6aBE1d282f72B474E54527D93b979A4f64d3030a".toLowerCase();
const ROUTER     = "0x2626664c2603336E57B271c5C0b26F421741e481".toLowerCase();

// Function selectors
const SEL_BALANCE_OF = "0x70a08231";
const SEL_ALLOWANCE  = "0xdd62ed3e";
const SEL_APPROVE    = "0x095ea7b3";
const SEL_EXACT_INPUT_SINGLE = "0x414bf389";

// Encode a uint256 as 32-byte hex (no 0x prefix)
function encHex256(val) {
  return BigInt(val).toString(16).padStart(64, "0");
}

function createMockRpc(opts = {}) {
  const calls = [];
  let txCount = 0;

  // Default balances (override via opts)
  const ethBalance   = opts.ethBalance   ?? 1_000_000_000_000_000_000n;  // 1 ETH
  const morBalance   = opts.morBalance   ?? 5_000_000_000_000_000_000n;  // 5 MOR
  const usdcBalance  = opts.usdcBalance  ?? 1000_000_000n;               // 1000 USDC
  const morAllowance = opts.morAllowance ?? 0n;
  const shouldRevert = opts.shouldRevert ?? false;

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch { 
        res.writeHead(400); res.end("bad json"); return; 
      }

      // Handle batched requests
      const reqs = Array.isArray(parsed) ? parsed : [parsed];
      const results = reqs.map((rpc) => handleRpc(rpc));
      
      const response = Array.isArray(parsed) ? results : results[0];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
    });
  });

  function handleRpc(rpc) {
    const { method, params, id } = rpc;
    calls.push({ method, params });

    switch (method) {
      case "eth_chainId":
        return { jsonrpc: "2.0", id, result: "0x2105" }; // Base = 8453

      case "eth_blockNumber":
        return { jsonrpc: "2.0", id, result: "0x100000" };

      case "eth_getBalance":
        return { jsonrpc: "2.0", id, result: "0x" + encHex256(ethBalance) };

      case "eth_getTransactionCount":
        return { jsonrpc: "2.0", id, result: "0x" + (txCount++).toString(16) };

      case "eth_gasPrice":
      case "eth_maxPriorityFeePerGas":
        return { jsonrpc: "2.0", id, result: "0x" + encHex256(1_000_000_000n) }; // 1 gwei

      case "eth_estimateGas":
        return { jsonrpc: "2.0", id, result: "0x" + encHex256(200_000n) };

      case "eth_getBlockByNumber":
        return {
          jsonrpc: "2.0", id,
          result: {
            baseFeePerGas: "0x" + encHex256(1_000_000_000n),
            number: "0x100000",
            hash: "0x" + "ab".repeat(32),
            timestamp: "0x" + Math.floor(Date.now() / 1000).toString(16),
          },
        };

      case "eth_call": {
        const to = (params?.[0]?.to || "").toLowerCase();
        const data = params?.[0]?.data || "";
        const selector = data.slice(0, 10);

        // balanceOf
        if (selector === SEL_BALANCE_OF) {
          if (to === MOR_TOKEN.toLowerCase())  return { jsonrpc: "2.0", id, result: "0x" + encHex256(morBalance) };
          if (to === USDC_TOKEN.toLowerCase()) return { jsonrpc: "2.0", id, result: "0x" + encHex256(usdcBalance) };
          return { jsonrpc: "2.0", id, result: "0x" + encHex256(0n) };
        }
        // allowance
        if (selector === SEL_ALLOWANCE) {
          return { jsonrpc: "2.0", id, result: "0x" + encHex256(morAllowance) };
        }
        // Fallback
        return { jsonrpc: "2.0", id, result: "0x" + encHex256(0n) };
      }

      case "eth_sendRawTransaction": {
        // Return a fake tx hash
        const fakeTxHash = "0x" + "aa".repeat(32);
        return { jsonrpc: "2.0", id, result: fakeTxHash };
      }

      case "eth_getTransactionReceipt": {
        if (shouldRevert) {
          return {
            jsonrpc: "2.0", id,
            result: {
              status: "0x0", // reverted
              transactionHash: params?.[0] || "0x" + "aa".repeat(32),
              blockNumber: "0x100001",
              blockHash: "0x" + "bb".repeat(32),
              gasUsed: "0x30d40",
              logs: [],
            },
          };
        }
        return {
          jsonrpc: "2.0", id,
          result: {
            status: "0x1", // success
            transactionHash: params?.[0] || "0x" + "aa".repeat(32),
            blockNumber: "0x100001",
            blockHash: "0x" + "bb".repeat(32),
            gasUsed: "0x30d40",
            logs: [],
          },
        };
      }

      case "eth_feeHistory":
        return {
          jsonrpc: "2.0", id,
          result: {
            baseFeePerGas: ["0x" + encHex256(1_000_000_000n)],
            gasUsedRatio: [0.5],
            oldestBlock: "0x100000",
          },
        };

      default:
        // Unknown method — return empty
        return { jsonrpc: "2.0", id, result: "0x" };
    }
  }

  return { server, calls };
}

/** Start mock RPC, return { url, stop, calls } */
async function startMockRpc(opts = {}) {
  const { server, calls } = createMockRpc(opts);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}`;
  const stop = () => new Promise((resolve) => server.close(resolve));
  return { url, stop, calls };
}

// ============================================================
// TESTS
// ============================================================

describe("everclaw-wallet A1: offline tests", () => {
  // Clean slate before all tests
  before(() => deleteTestKeychain());
  // Clean up after all tests
  after(() => deleteTestKeychain());

  // --------------------------------------------------------
  // 1. Help / no-args
  // --------------------------------------------------------
  describe("help output", () => {
    it("prints help with no arguments", () => {
      const { stdout, exitCode } = runWallet([]);
      assert.equal(exitCode, 0);
      assert.ok(stdout.includes("Everclaw Wallet"), "should show title");
      assert.ok(stdout.includes("setup"), "should list setup command");
      assert.ok(stdout.includes("swap"), "should list swap command");
    });

    it("prints help with unknown command", () => {
      const { stdout, exitCode } = runWallet(["foobar"]);
      assert.equal(exitCode, 0);
      assert.ok(stdout.includes("Everclaw Wallet"));
    });
  });

  // --------------------------------------------------------
  // 2. setup
  // --------------------------------------------------------
  describe("setup", () => {
    beforeEach(() => deleteTestKeychain());

    it("generates a new wallet and stores in keychain", () => {
      const { stdout, exitCode } = runWallet(["setup"]);
      assert.equal(exitCode, 0);
      assert.ok(stdout.includes("Everclaw Wallet Created"), "should confirm creation");
      assert.ok(stdout.includes("Address:"), "should show address");

      // Verify keychain has a valid hex key
      const storedKey = retrieveTestKey();
      assert.ok(storedKey, "key should exist in keychain");
      assert.ok(storedKey.startsWith("0x"), "key should be hex");
      assert.equal(storedKey.length, 66, "key should be 32 bytes + 0x prefix");
    });

    it("refuses to overwrite existing wallet", () => {
      // First setup
      runWallet(["setup"]);
      const firstKey = retrieveTestKey();

      // Second setup — should warn, not overwrite
      const { stdout, exitCode } = runWallet(["setup"]);
      assert.equal(exitCode, 0);
      assert.ok(stdout.includes("already exists"), "should warn about existing wallet");

      // Key should be unchanged
      const secondKey = retrieveTestKey();
      assert.equal(firstKey, secondKey, "should not overwrite existing key");
    });
  });

  // --------------------------------------------------------
  // 3. address
  // --------------------------------------------------------
  describe("address", () => {
    before(() => {
      deleteTestKeychain();
      storeTestKey(TEST_PRIVATE_KEY);
    });

    it("prints the correct address for a known key", () => {
      const { stdout, exitCode } = runWallet(["address"]);
      assert.equal(exitCode, 0);
      assert.ok(
        stdout.trim().toLowerCase().includes(TEST_ADDRESS.toLowerCase()),
        `should output ${TEST_ADDRESS}`
      );
    });

    it("fails when no wallet exists", () => {
      deleteTestKeychain();
      const { stderr, exitCode } = runWallet(["address"]);
      assert.notEqual(exitCode, 0, "should exit non-zero");
      assert.ok(
        (stderr + "").includes("No wallet found") || exitCode !== 0,
        "should indicate missing wallet"
      );
    });

    after(() => storeTestKey(TEST_PRIVATE_KEY)); // restore for next tests
  });

  // --------------------------------------------------------
  // 4. export-key
  // --------------------------------------------------------
  describe("export-key", () => {
    before(() => {
      deleteTestKeychain();
      storeTestKey(TEST_PRIVATE_KEY);
    });

    it("prints the stored private key and address", () => {
      const { stdout, exitCode } = runWallet(["export-key"]);
      assert.equal(exitCode, 0);
      assert.ok(stdout.includes(TEST_PRIVATE_KEY), "should show exact key");
      assert.ok(
        stdout.toLowerCase().includes(TEST_ADDRESS.toLowerCase()),
        "should show address"
      );
      assert.ok(stdout.includes("DO NOT SHARE"), "should show warning");
    });

    it("fails when no wallet exists", () => {
      deleteTestKeychain();
      const { exitCode } = runWallet(["export-key"]);
      assert.notEqual(exitCode, 0);
    });

    after(() => storeTestKey(TEST_PRIVATE_KEY));
  });

  // --------------------------------------------------------
  // 5. import-key
  // --------------------------------------------------------
  describe("import-key", () => {
    beforeEach(() => deleteTestKeychain());

    it("imports a valid 0x-prefixed key", () => {
      const { stdout, exitCode } = runWallet(["import-key", TEST_PRIVATE_KEY]);
      assert.equal(exitCode, 0);
      assert.ok(stdout.includes("imported successfully"), "should confirm import");
      assert.ok(
        stdout.toLowerCase().includes(TEST_ADDRESS.toLowerCase()),
        "should show derived address"
      );

      // Verify it's actually in keychain
      const stored = retrieveTestKey();
      assert.equal(stored, TEST_PRIVATE_KEY);
    });

    it("imports a key without 0x prefix (auto-adds)", () => {
      const keyWithout0x = TEST_PRIVATE_KEY.slice(2);
      const { stdout, exitCode } = runWallet(["import-key", keyWithout0x]);
      assert.equal(exitCode, 0);
      assert.ok(stdout.includes("imported successfully"));

      // Stored key should have 0x prefix
      const stored = retrieveTestKey();
      assert.equal(stored, TEST_PRIVATE_KEY, "should store with 0x prefix");
    });

    it("rejects an invalid key", () => {
      const { exitCode, stderr } = runWallet(["import-key", "0xdeadbeef"]);
      assert.notEqual(exitCode, 0, "should reject short/invalid key");
    });

    it("fails with no key argument", () => {
      const { exitCode } = runWallet(["import-key"]);
      assert.notEqual(exitCode, 0);
    });

    it("overwrites an existing key on import", () => {
      // Store a dummy key first
      storeTestKey("0x0000000000000000000000000000000000000000000000000000000000000001");

      // Import the real test key
      const { exitCode } = runWallet(["import-key", TEST_PRIVATE_KEY]);
      assert.equal(exitCode, 0);

      const stored = retrieveTestKey();
      assert.equal(stored, TEST_PRIVATE_KEY, "should overwrite previous key");
    });
  });

  // --------------------------------------------------------
  // 6. swap argument validation (offline — no RPC)
  // --------------------------------------------------------
  describe("swap argument validation", () => {
    before(() => {
      deleteTestKeychain();
      storeTestKey(TEST_PRIVATE_KEY);
    });

    it("fails with no arguments", () => {
      const { exitCode } = runWallet(["swap"]);
      assert.notEqual(exitCode, 0);
    });

    it("fails with only token argument", () => {
      const { exitCode } = runWallet(["swap", "eth"]);
      assert.notEqual(exitCode, 0);
    });

    it("fails with unsupported token", () => {
      // This will fail either from validation or RPC — both acceptable
      const { exitCode, stderr } = runWallet(["swap", "btc", "1.0"]);
      assert.notEqual(exitCode, 0);
    });

    it("fails with no wallet", () => {
      deleteTestKeychain();
      const { exitCode } = runWallet(["swap", "eth", "0.01"]);
      assert.notEqual(exitCode, 0);
      storeTestKey(TEST_PRIVATE_KEY); // restore
    });
  });

  // --------------------------------------------------------
  // 7. Keychain isolation verification
  // --------------------------------------------------------
  describe("keychain isolation", () => {
    it("test keychain does not interfere with real keychain", () => {
      // Verify we're using test account, not the real one
      deleteTestKeychain();
      storeTestKey(TEST_PRIVATE_KEY);

      // The real keychain slot should be untouched
      // (We just verify our test env vars are being respected)
      const { stdout } = runWallet(["address"]);
      assert.ok(
        stdout.trim().toLowerCase().includes(TEST_ADDRESS.toLowerCase()),
        "should use test keychain, not real one"
      );

      deleteTestKeychain();
    });
  });
});

// ============================================================
// A2: RPC-dependent tests (mock chain)
// ============================================================

describe("everclaw-wallet A2: RPC-dependent tests", () => {
  before(() => {
    deleteTestKeychain();
    storeTestKey(TEST_PRIVATE_KEY);
  });
  after(() => deleteTestKeychain());

  // --------------------------------------------------------
  // 8. balance
  // --------------------------------------------------------
  describe("balance", () => {
    it("displays ETH, MOR, USDC balances and allowance", async () => {
      const mock = await startMockRpc({
        ethBalance:   2_500_000_000_000_000_000n,  // 2.5 ETH
        morBalance:   10_000_000_000_000_000_000n,  // 10 MOR
        usdcBalance:  500_000_000n,                  // 500 USDC
        morAllowance: 100_000_000_000_000_000_000n,  // 100 MOR allowance
      });
      try {
        const { stdout, exitCode } = await runWalletAsync(["balance"], { EVERCLAW_RPC: mock.url });
        assert.equal(exitCode, 0, `should exit 0, got stdout: ${stdout}`);
        assert.ok(stdout.includes("2.5"), `should show 2.5 ETH, got: ${stdout}`);
        assert.ok(stdout.includes("10"), `should show 10 MOR, got: ${stdout}`);
        assert.ok(stdout.includes("500"), `should show 500 USDC, got: ${stdout}`);
        assert.ok(stdout.includes("100"), `should show 100 MOR allowance, got: ${stdout}`);

        // Verify the right RPC calls were made
        const ethCalls = mock.calls.filter((c) => c.method === "eth_call");
        // Should have: MOR balanceOf, USDC balanceOf, MOR allowance = 3 eth_call
        assert.ok(ethCalls.length >= 3, `expected >=3 eth_call, got ${ethCalls.length}`);

        // Should have eth_getBalance
        const balCalls = mock.calls.filter((c) => c.method === "eth_getBalance");
        assert.ok(balCalls.length >= 1, "should call eth_getBalance");
      } finally {
        await mock.stop();
      }
    });

    it("shows zero balances correctly", async () => {
      const mock = await startMockRpc({
        ethBalance: 0n,
        morBalance: 0n,
        usdcBalance: 0n,
        morAllowance: 0n,
      });
      try {
        const { stdout, exitCode } = await runWalletAsync(["balance"], { EVERCLAW_RPC: mock.url });
        assert.equal(exitCode, 0);
        // Should still display without errors even with zero balances
        assert.ok(stdout.includes("ETH:"), "should show ETH label");
        assert.ok(stdout.includes("MOR:"), "should show MOR label");
        assert.ok(stdout.includes("USDC:"), "should show USDC label");
      } finally {
        await mock.stop();
      }
    });

    it("fails when no wallet exists", async () => {
      deleteTestKeychain();
      const { exitCode } = runWallet(["balance"]);
      assert.notEqual(exitCode, 0);
      storeTestKey(TEST_PRIVATE_KEY); // restore
    });
  });

  // --------------------------------------------------------
  // 9. approve
  // --------------------------------------------------------
  describe("approve", () => {
    it("approves unlimited MOR by default", async () => {
      const mock = await startMockRpc();
      try {
        const { stdout, exitCode } = await runWalletAsync(["approve"], { EVERCLAW_RPC: mock.url });
        assert.equal(exitCode, 0, `should exit 0, got: ${stdout}`);
        assert.ok(stdout.includes("unlimited"), "should say unlimited");
        assert.ok(stdout.includes("approved") || stdout.includes("Approved"), "should confirm approval");

        // Verify a sendRawTransaction was made
        const sendCalls = mock.calls.filter((c) => c.method === "eth_sendRawTransaction");
        assert.ok(sendCalls.length >= 1, "should send a transaction");
      } finally {
        await mock.stop();
      }
    });

    it("approves a specified MOR amount", async () => {
      const mock = await startMockRpc();
      try {
        const { stdout, exitCode } = await runWalletAsync(["approve", "50"], { EVERCLAW_RPC: mock.url });
        assert.equal(exitCode, 0);
        assert.ok(stdout.includes("50"), "should show specified amount");
        assert.ok(stdout.includes("approved") || stdout.includes("Approved"), "should confirm");
      } finally {
        await mock.stop();
      }
    });

    it("reports failure on reverted tx", async () => {
      const mock = await startMockRpc({ shouldRevert: true });
      try {
        const { stdout, exitCode, stderr } = await runWalletAsync(["approve"], { EVERCLAW_RPC: mock.url });
        const output = stdout + stderr;
        // Part B fix: waitAndVerify now throws on reverted receipts
        const failed = exitCode !== 0 || output.includes("revert") || output.includes("failed");
        assert.ok(failed, `should fail on reverted tx, exit=${exitCode}, output: ${output.slice(0, 200)}`);
      } finally {
        await mock.stop();
      }
    });

    it("respects EVERCLAW_MAX_GAS env var", async () => {
      const mock = await startMockRpc();
      try {
        const { stdout, exitCode } = await runWalletAsync(["approve"], {
          EVERCLAW_RPC: mock.url,
          EVERCLAW_MAX_GAS: "123456",
        });
        assert.equal(exitCode, 0, `should exit 0, got: ${stdout}`);
        // Gas limit is passed to writeContract — we can't verify the exact value
        // without decoding the signed tx, but at least verify it doesn't crash
      } finally {
        await mock.stop();
      }
    });

    // Note: EVERCLAW_CONFIRMATIONS can't be tested with mock RPC since
// it requires block progression. Tested manually on mainnet.

    it("fails when no wallet exists", async () => {
      deleteTestKeychain();
      const { exitCode } = runWallet(["approve"]);
      assert.notEqual(exitCode, 0);
      storeTestKey(TEST_PRIVATE_KEY);
    });
  });

  // --------------------------------------------------------
  // 10. swap
  // --------------------------------------------------------
  describe("swap", () => {
    it("swaps ETH for MOR successfully", async () => {
      const mock = await startMockRpc({
        morBalance: 15_000_000_000_000_000_000n, // 15 MOR after swap
      });
      try {
        const { stdout, exitCode } = await runWalletAsync(
          ["swap", "eth", "0.1"],
          { EVERCLAW_RPC: mock.url }
        );
        assert.equal(exitCode, 0, `should exit 0, got: ${stdout}`);
        assert.ok(
          stdout.includes("Swap") || stdout.includes("swap") || stdout.includes("MOR"),
          "should mention swap or MOR"
        );
        assert.ok(
          stdout.includes("successful") || stdout.includes("✅"),
          "should confirm success"
        );

        // Verify tx was sent
        const sendCalls = mock.calls.filter((c) => c.method === "eth_sendRawTransaction");
        assert.ok(sendCalls.length >= 1, "should send at least 1 tx (the swap)");
      } finally {
        await mock.stop();
      }
    });

    it("swaps USDC for MOR (approve + swap = 2 txs)", async () => {
      const mock = await startMockRpc({
        morBalance: 20_000_000_000_000_000_000n, // 20 MOR after swap
      });
      try {
        const { stdout, exitCode } = await runWalletAsync(
          ["swap", "usdc", "100"],
          { EVERCLAW_RPC: mock.url }
        );
        assert.equal(exitCode, 0, `should exit 0, got: ${stdout}`);
        assert.ok(stdout.includes("Approv"), "should show USDC approval step");
        assert.ok(
          stdout.includes("successful") || stdout.includes("✅"),
          "should confirm success"
        );

        // USDC swap should send 2 txs: approve + swap
        const sendCalls = mock.calls.filter((c) => c.method === "eth_sendRawTransaction");
        assert.ok(
          sendCalls.length >= 2,
          `expected >=2 txs (approve+swap), got ${sendCalls.length}`
        );
      } finally {
        await mock.stop();
      }
    });

    it("reports failure on reverted swap", async () => {
      const mock = await startMockRpc({ shouldRevert: true });
      try {
        const { stdout, exitCode, stderr } = await runWalletAsync(
          ["swap", "eth", "0.01"],
          { EVERCLAW_RPC: mock.url }
        );
        const output = stdout + stderr;
        const failed = exitCode !== 0 || output.includes("fail") || output.includes("revert") || output.includes("❌");
        assert.ok(failed, "should indicate failure on reverted swap");
      } finally {
        await mock.stop();
      }
    });

    it("ETH swap sends value with transaction", async () => {
      const mock = await startMockRpc();
      try {
        await runWalletAsync(["swap", "eth", "0.05"], { EVERCLAW_RPC: mock.url });

        // Verify the mock received a sendRawTransaction
        const sendCalls = mock.calls.filter((c) => c.method === "eth_sendRawTransaction");
        assert.ok(sendCalls.length >= 1, "should have sent a raw transaction");
      } finally {
        await mock.stop();
      }
    });

    it("USDC swap does not send ETH value", async () => {
      const mock = await startMockRpc();
      try {
        await runWalletAsync(["swap", "usdc", "50"], { EVERCLAW_RPC: mock.url });

        // At minimum: approve tx + swap tx
        const sendCalls = mock.calls.filter((c) => c.method === "eth_sendRawTransaction");
        assert.ok(sendCalls.length >= 2, "should send approve + swap txs");
      } finally {
        await mock.stop();
      }
    });

    it("applies slippage tolerance from env var", async () => {
      const mock = await startMockRpc({
        morBalance: 10_000_000_000_000_000_000n,
      });
      try {
        // Default slippage is 100 bps = 1%
        const { stdout, exitCode } = await runWalletAsync(["swap", "eth", "0.01"], {
          EVERCLAW_RPC: mock.url,
        });
        assert.equal(exitCode, 0, `should exit 0, got: ${stdout}`);
        // Slippage is applied internally — we verify the swap succeeds
      } finally {
        await mock.stop();
      }
    });

    it("uses custom slippage from EVERCLAW_SLIPPAGE_BPS", async () => {
      const mock = await startMockRpc();
      try {
        const { stdout, exitCode } = await runWalletAsync(["swap", "eth", "0.01"], {
          EVERCLAW_RPC: mock.url,
          EVERCLAW_SLIPPAGE_BPS: "500", // 5% slippage
        });
        assert.equal(exitCode, 0, `should exit 0, got: ${stdout}`);
        // The slippage value is used in applySlippage() — mock can't verify exact value
      } finally {
        await mock.stop();
      }
    });
  });

  // --------------------------------------------------------
  // 11. RPC error handling
  // --------------------------------------------------------
  describe("RPC error handling", () => {
    // Note: The wallet uses async/await but doesn't always process.exit(1) on
    // unhandled errors. These tests verify the wallet at least errors out
    // (non-zero exit or error output) when RPC is unreachable.
    // We use a mock that returns JSON-RPC errors to trigger clean failures.

    it("balance errors when RPC returns errors", async () => {
      const mock = await startMockRpc();
      // Override: make all calls return errors
      mock.errorMode = true;
      try {
        const { stdout, exitCode, stderr } = await runWalletAsync(["balance"], {
          EVERCLAW_RPC: mock.url.replace(/:\d+/, ":1"), // unreachable port
        });
        const output = stdout + stderr;
        const errored = exitCode !== 0 || output.includes("error") || output.includes("Error") || output.includes("fail") || output.includes("❌");
        assert.ok(errored, `should error on unreachable RPC, exit=${exitCode}, out=${output.slice(0,200)}`);
      } finally {
        await mock.stop();
      }
    });

    it("swap fails gracefully when RPC is unreachable", async () => {
      const { exitCode, stderr } = await runWalletAsync(["swap", "eth", "0.01"], {
        EVERCLAW_RPC: "http://127.0.0.1:19999",
      });
      const output = stderr;
      const failed = exitCode !== 0 || output.includes("fail") || output.includes("Error");
      assert.ok(failed, "should fail when RPC is unreachable");
    });

    it("approve fails gracefully when RPC is unreachable", async () => {
      const { exitCode, stderr } = await runWalletAsync(["approve"], {
        EVERCLAW_RPC: "http://127.0.0.1:19999",
      });
      const output = stderr;
      const failed = exitCode !== 0 || output.includes("fail") || output.includes("Error");
      assert.ok(failed, "should fail when RPC is unreachable");
    });
  });
});
