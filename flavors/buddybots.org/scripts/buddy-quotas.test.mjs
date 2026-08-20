#!/usr/bin/env node
/**
 * buddy-quotas.test.mjs — Tests for buddy-quotas.mjs
 *
 * Run: node scripts/buddy-quotas.test.mjs
 * Uses temp directories for isolation — no side effects.
 */

import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const SCRIPT = join(dirname(__filename), 'buddy-quotas.mjs');

let passed = 0;
let failed = 0;
let tmpDir;

function setup() {
  tmpDir = join(tmpdir(), `buddy-quotas-test-${randomUUID().slice(0, 8)}`);
  mkdirSync(join(tmpDir, 'quotas', 'usage'), { recursive: true });
  process.env.EVERCLAW_DIR = tmpDir;
  process.env.BUDDY_QUOTAS_DIR = join(tmpDir, 'quotas');
}

function teardown() {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch { /* ignore */ }
  delete process.env.EVERCLAW_DIR;
  delete process.env.BUDDY_QUOTAS_DIR;
}

function assert(condition, msg) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

function assertThrows(fn, msgPart) {
  try {
    fn();
    throw new Error(`Expected to throw containing "${msgPart}" but did not throw`);
  } catch (err) {
    if (err.message.includes('Expected to throw')) throw err;
    if (msgPart && !err.message.includes(msgPart)) {
      throw new Error(`Expected error containing "${msgPart}", got: "${err.message}"`);
    }
  }
}

async function test(name, fn) {
  setup();
  try {
    await fn();
    console.log(`✔ ${name}`);
    passed++;
  } catch (err) {
    console.log(`✖ ${name}`);
    console.log(`  ${err.message}`);
    failed++;
  } finally {
    teardown();
  }
}

function runCli(...args) {
  return execFileSync(process.execPath, [SCRIPT, ...args], {
    env: { ...process.env },
    encoding: 'utf8',
    timeout: 10_000,
  });
}

function runCliFail(...args) {
  try {
    execFileSync(process.execPath, [SCRIPT, ...args], {
      env: { ...process.env },
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    throw new Error('Expected CLI to fail but it succeeded');
  } catch (err) {
    if (err.message === 'Expected CLI to fail but it succeeded') throw err;
    return (err.stdout || '') + (err.stderr || '');
  }
}

// ── Import module for library tests ──────────────────────────────

async function importModule() {
  // Dynamic import with cache-busting to get fresh module per test
  const mod = await import(`./buddy-quotas.mjs?t=${Date.now()}-${randomUUID().slice(0, 4)}`);
  return mod;
}

// ── Tests ────────────────────────────────────────────────────────

await test('loadConfig returns defaults when no config exists', async () => {
  const mod = await importModule();
  const config = mod.loadConfig();
  assert(config.version === 1, 'version should be 1');
  assert(config.defaults.daily === 100_000, 'daily default 100K');
  assert(config.defaults.monthly === 2_000_000, 'monthly default 2M');
  assert(config.defaults.alertThreshold === 0.8, 'alert at 80%');
  assert(config.defaults.degradeThreshold === 0.9, 'degrade at 90%');
  assert(config.defaults.cutoffAction === 'degrade', 'cutoff action degrade');
  assert(Object.keys(config.agents).length === 0, 'no agent overrides');
});

await test('setDefaults updates global defaults', async () => {
  const mod = await importModule();
  mod.setDefaults({ daily: 200_000, monthly: 5_000_000 });
  const config = mod.loadConfig();
  assert(config.defaults.daily === 200_000, 'daily updated');
  assert(config.defaults.monthly === 5_000_000, 'monthly updated');
  assert(config.defaults.alertThreshold === 0.8, 'alert unchanged');
});

await test('setLimits creates per-agent overrides', async () => {
  const mod = await importModule();
  mod.setLimits('alice', { daily: 150_000, monthly: 3_000_000 });
  const limits = mod.loadQuotaConfig('alice');
  assert(limits.daily === 150_000, 'alice daily');
  assert(limits.monthly === 3_000_000, 'alice monthly');

  // Default agent should still have defaults
  const bob = mod.loadQuotaConfig('bob');
  assert(bob.daily === 100_000, 'bob has default daily');
});

await test('loadQuotaConfig merges agent overrides with defaults', async () => {
  const mod = await importModule();
  mod.setLimits('alice', { daily: 150_000 }); // Only override daily
  const limits = mod.loadQuotaConfig('alice');
  assert(limits.daily === 150_000, 'alice daily overridden');
  assert(limits.monthly === 2_000_000, 'alice monthly from defaults');
  assert(limits.alertThreshold === 0.8, 'threshold from defaults');
});

await test('recordUsage tracks tokens correctly', async () => {
  const mod = await importModule();
  mod.recordUsage('alice', 1000, 'glm-5', 'morpheus');
  mod.recordUsage('alice', 500, 'glm-5', 'morpheus');
  mod.recordUsage('alice', 200, 'ollama/gemma4', 'ollama');

  const usage = mod.getUsage('alice');
  assert(usage.daily.tokens === 1700, `daily tokens ${usage.daily.tokens} should be 1700`);
  assert(usage.daily.requests === 3, 'daily requests 3');
  assert(usage.monthly.tokens === 1700, 'monthly matches daily (same day)');
  assert(usage.daily.byModel['glm-5'].tokens === 1500, 'glm-5 tokens');
  assert(usage.daily.byModel['glm-5'].requests === 2, 'glm-5 requests');
  assert(usage.daily.byModel['ollama/gemma4'].tokens === 200, 'ollama tokens');
  assert(usage.daily.byProvider.morpheus.tokens === 1500, 'morpheus provider');
  assert(usage.daily.byProvider.ollama.tokens === 200, 'ollama provider');
});

await test('checkQuota returns allowed when under limits', async () => {
  const mod = await importModule();
  mod.recordUsage('alice', 50_000, 'glm-5', 'morpheus');
  const result = mod.checkQuota('alice');
  assert(result.allowed === true, 'should be allowed');
  assert(result.degraded === false, 'not degraded');
  assert(result.alert === false, 'no alert');
  assert(result.blocked === false, 'not blocked');
  assert(result.remaining.daily === 50_000, `remaining daily ${result.remaining.daily}`);
});

await test('checkQuota alerts at 80% threshold', async () => {
  const mod = await importModule();
  mod.recordUsage('alice', 80_000, 'glm-5', 'morpheus');
  const result = mod.checkQuota('alice');
  assert(result.alert === true, 'should alert at 80%');
  assert(result.alertMessage.includes('80%'), `alert msg: ${result.alertMessage}`);
  assert(result.degraded === false, 'not yet degraded');
  assert(result.allowed === true, 'still allowed');
});

await test('checkQuota degrades at 90% threshold', async () => {
  const mod = await importModule();
  mod.recordUsage('alice', 95_000, 'glm-5', 'morpheus');
  const result = mod.checkQuota('alice');
  assert(result.degraded === true, 'should degrade at 95%');
  assert(result.model === 'ollama/gemma4-26b-q3', `model: ${result.model}`);
  assert(result.alert === true, 'also alerting');
  assert(result.allowed === true, 'still allowed');
});

await test('checkQuota handles cutoffAction=degrade at 100%', async () => {
  const mod = await importModule();
  mod.recordUsage('alice', 100_000, 'glm-5', 'morpheus');
  const result = mod.checkQuota('alice');
  assert(result.degraded === true, 'degraded at 100%');
  assert(result.allowed === true, 'degrade mode still allows');
  assert(result.model === 'ollama/gemma4-26b-q3', 'degraded model');
});

await test('checkQuota handles cutoffAction=block at 100%', async () => {
  const mod = await importModule();
  mod.setLimits('alice', { daily: 100_000 });
  mod.setDefaults({ cutoffAction: 'block' });
  mod.recordUsage('alice', 100_000, 'glm-5', 'morpheus');
  const result = mod.checkQuota('alice');
  assert(result.blocked === true, 'should be blocked');
  assert(result.allowed === false, 'not allowed');
  assert(result.model === null, 'no model when blocked');
});

await test('checkQuota handles cutoffAction=warn at 100%', async () => {
  const mod = await importModule();
  mod.setLimits('alice', { cutoffAction: 'warn' });
  mod.recordUsage('alice', 100_000, 'glm-5', 'morpheus');
  const result = mod.checkQuota('alice');
  assert(result.allowed === true, 'warn mode allows');
  assert(result.alert === true, 'alerting');
  assert(result.alertMessage.includes('EXCEEDED'), `msg: ${result.alertMessage}`);
});

await test('checkQuota triggers on monthly limit', async () => {
  const mod = await importModule();
  mod.setLimits('alice', { daily: 10_000_000, monthly: 1_000 }); // High daily, low monthly
  mod.recordUsage('alice', 900, 'glm-5', 'morpheus');
  const result = mod.checkQuota('alice');
  assert(result.alert === true, 'monthly alert at 90%');
  assert(result.degraded === true, 'monthly degrade at 90%');
});

await test('resetDaily resets counters and archives history', async () => {
  const mod = await importModule();
  mod.recordUsage('alice', 5000, 'glm-5', 'morpheus');
  const beforeReset = mod.getUsage('alice');
  assert(beforeReset.daily.tokens === 5000, 'pre-reset tokens');

  mod.resetDaily('alice');
  const after = mod.getUsage('alice');
  assert(after.daily.tokens === 0, 'daily tokens reset');
  assert(after.daily.requests === 0, 'daily requests reset');
  assert(after.history.length === 1, 'history has 1 entry');
  assert(after.history[0].tokens === 5000, 'archived tokens');
});

await test('resetMonthly resets monthly counters', async () => {
  const mod = await importModule();
  mod.recordUsage('alice', 5000, 'glm-5', 'morpheus');
  mod.resetMonthly('alice');
  const after = mod.getUsage('alice');
  assert(after.monthly.tokens === 0, 'monthly tokens reset');
  assert(after.monthly.requests === 0, 'monthly requests reset');
});

await test('resetDaily(null) resets all agents', async () => {
  const mod = await importModule();
  mod.recordUsage('alice', 1000, 'glm-5', 'morpheus');
  mod.recordUsage('bob', 2000, 'glm-5', 'morpheus');
  const result = mod.resetDaily(null);
  assert(result.length === 2, `reset ${result.length} agents`);
  assert(mod.getUsage('alice').daily.tokens === 0, 'alice reset');
  assert(mod.getUsage('bob').daily.tokens === 0, 'bob reset');
});

await test('daily rollover auto-archives and resets', async () => {
  const mod = await importModule();
  mod.recordUsage('alice', 5000, 'glm-5', 'morpheus');

  // Manually set a stale date to simulate rollover
  const usagePath = join(process.env.BUDDY_QUOTAS_DIR, 'usage', 'alice.json');
  const data = JSON.parse(readFileSync(usagePath, 'utf8'));
  data.daily.date = '2026-04-01'; // Stale date
  writeFileSync(usagePath, JSON.stringify(data));

  // Next record should trigger rollover
  mod.recordUsage('alice', 100, 'glm-5', 'morpheus');
  const usage = mod.getUsage('alice');
  assert(usage.daily.tokens === 100, `daily after rollover: ${usage.daily.tokens}`);
  assert(usage.history.length >= 1, 'history populated');
  assert(usage.history.find(h => h.date === '2026-04-01'), 'old date archived');
});

await test('monthly rollover resets monthly counters', async () => {
  const mod = await importModule();
  mod.recordUsage('alice', 5000, 'glm-5', 'morpheus');

  const usagePath = join(process.env.BUDDY_QUOTAS_DIR, 'usage', 'alice.json');
  const data = JSON.parse(readFileSync(usagePath, 'utf8'));
  data.monthly.month = '2026-03'; // Stale month
  writeFileSync(usagePath, JSON.stringify(data));

  mod.recordUsage('alice', 100, 'glm-5', 'morpheus');
  const usage = mod.getUsage('alice');
  assert(usage.monthly.tokens === 100, `monthly after rollover: ${usage.monthly.tokens}`);
});

await test('history capped at 30 entries', async () => {
  const mod = await importModule();
  
  // Build up 35 history entries via manual resets
  for (let i = 0; i < 35; i++) {
    mod.recordUsage('alice', 100, 'glm-5', 'morpheus');
    // Manually force a different date on each entry before reset
    const usagePath = join(process.env.BUDDY_QUOTAS_DIR, 'usage', 'alice.json');
    const data = JSON.parse(readFileSync(usagePath, 'utf8'));
    data.daily.date = `2026-03-${String(i + 1).padStart(2, '0')}`;
    writeFileSync(usagePath, JSON.stringify(data));
    mod.resetDaily('alice');
  }

  const usage = mod.getUsage('alice');
  assert(usage.history.length <= 30, `history length ${usage.history.length} should be <= 30`);
});

await test('getAllStatus returns all agents', async () => {
  const mod = await importModule();
  mod.recordUsage('alice', 1000, 'glm-5', 'morpheus');
  mod.recordUsage('bob', 2000, 'glm-5', 'morpheus');
  mod.setLimits('charlie', { daily: 50_000 }); // Config but no usage

  const all = mod.getAllStatus();
  assert(all.length === 3, `expected 3, got ${all.length}`);
  assert(all.find(s => s.agentId === 'alice'), 'alice present');
  assert(all.find(s => s.agentId === 'bob'), 'bob present');
  assert(all.find(s => s.agentId === 'charlie'), 'charlie present');
});

await test('getAlerts filters agents at/above threshold', async () => {
  const mod = await importModule();
  mod.recordUsage('alice', 85_000, 'glm-5', 'morpheus'); // 85% of 100K
  mod.recordUsage('bob', 50_000, 'glm-5', 'morpheus');   // 50% of 100K

  const alerts = mod.getAlerts();
  assert(alerts.length === 1, `expected 1 alert, got ${alerts.length}`);
  assert(alerts[0].agentId === 'alice', 'alice alerting');
});

await test('exportAll and importAll roundtrip', async () => {
  const mod = await importModule();
  mod.setLimits('alice', { daily: 200_000 });
  mod.recordUsage('alice', 5000, 'glm-5', 'morpheus');
  mod.recordUsage('bob', 3000, 'glm-5', 'morpheus');

  const exported = mod.exportAll();
  assert(exported.exportVersion === 1, 'export version');
  assert(exported.config.agents.alice.daily === 200_000, 'alice config exported');
  assert(exported.usage.alice.daily.tokens === 5000, 'alice usage exported');

  // Write to file, import into fresh env
  const exportPath = join(tmpDir, 'export.json');
  writeFileSync(exportPath, JSON.stringify(exported));

  // Clear existing data
  rmSync(join(tmpDir, 'quotas'), { recursive: true, force: true });
  mkdirSync(join(tmpDir, 'quotas', 'usage'), { recursive: true });

  const importData = JSON.parse(readFileSync(exportPath, 'utf8'));
  const result = mod.importAll(importData);
  assert(result.configImported === true, 'config imported');
  assert(result.agentsImported === 2, `agents imported: ${result.agentsImported}`);

  // Verify data survived
  const aliceUsage = mod.getUsage('alice');
  assert(aliceUsage.daily.tokens === 5000, 'alice usage preserved');
  const aliceLimits = mod.loadQuotaConfig('alice');
  assert(aliceLimits.daily === 200_000, 'alice limits preserved');
});

await test('removeAgentData cleans up usage and config', async () => {
  const mod = await importModule();
  mod.setLimits('alice', { daily: 200_000 });
  mod.recordUsage('alice', 5000, 'glm-5', 'morpheus');

  mod.removeAgentData('alice');

  const usagePath = join(process.env.BUDDY_QUOTAS_DIR, 'usage', 'alice.json');
  assert(!existsSync(usagePath), 'usage file removed');

  const config = mod.loadConfig();
  assert(!config.agents.alice, 'config override removed');
});

await test('initializeAgent creates empty usage with defaults', async () => {
  const mod = await importModule();
  const result = mod.initializeAgent('alice');
  assert(result.agentId === 'alice', 'agent id');
  assert(result.usage.daily.tokens === 0, 'zero daily');
  assert(result.limits.daily === 100_000, 'default limit');

  const usagePath = join(process.env.BUDDY_QUOTAS_DIR, 'usage', 'alice.json');
  assert(existsSync(usagePath), 'usage file created');
});

await test('initializeAgent with overrides sets per-agent limits', async () => {
  const mod = await importModule();
  const result = mod.initializeAgent('alice', { daily: 200_000 });
  assert(result.limits.daily === 200_000, 'custom daily limit');
  assert(result.limits.monthly === 2_000_000, 'default monthly');
});

await test('validation rejects invalid agent IDs', async () => {
  const mod = await importModule();
  assertThrows(() => mod.recordUsage('', 100, 'glm-5', 'morpheus'), 'Invalid agent ID');
  assertThrows(() => mod.recordUsage('Alice', 100, 'glm-5', 'morpheus'), 'Invalid agent ID'); // uppercase
  assertThrows(() => mod.recordUsage('1alice', 100, 'glm-5', 'morpheus'), 'Invalid agent ID'); // starts with number
  assertThrows(() => mod.recordUsage('al ice', 100, 'glm-5', 'morpheus'), 'Invalid agent ID'); // space
  assertThrows(() => mod.recordUsage('../etc', 100, 'glm-5', 'morpheus'), 'Invalid agent ID'); // path traversal
});

await test('validation rejects invalid token counts', async () => {
  const mod = await importModule();
  assertThrows(() => mod.recordUsage('alice', -1, 'glm-5', 'morpheus'), 'non-negative');
  assertThrows(() => mod.recordUsage('alice', 1.5, 'glm-5', 'morpheus'), 'integer');
  assertThrows(() => mod.recordUsage('alice', NaN, 'glm-5', 'morpheus'), 'non-negative');
  assertThrows(() => mod.recordUsage('alice', Infinity, 'glm-5', 'morpheus'), 'non-negative');
});

await test('validation rejects empty model and provider', async () => {
  const mod = await importModule();
  assertThrows(() => mod.recordUsage('alice', 100, '', 'morpheus'), 'non-empty string');
  assertThrows(() => mod.recordUsage('alice', 100, 'glm-5', ''), 'non-empty string');
});

await test('validation rejects invalid limits', async () => {
  const mod = await importModule();
  assertThrows(() => mod.setLimits('alice', { daily: -1 }), 'non-negative');
  assertThrows(() => mod.setLimits('alice', { daily: 1.5 }), 'integer');
  assertThrows(() => mod.setDefaults({ alertThreshold: 2.0 }), 'between 0 and 1');
  assertThrows(() => mod.setDefaults({ cutoffAction: 'explode' }), 'Must be one of');
});

await test('importAll rejects invalid data', async () => {
  const mod = await importModule();
  assertThrows(() => mod.importAll(null), 'non-null object');
  assertThrows(() => mod.importAll({ exportVersion: 99 }), 'Unsupported export');
  assertThrows(() => mod.importAll({ exportVersion: 1, config: null }), 'missing config');
  assertThrows(() => mod.importAll({ exportVersion: 1, config: {}, usage: {} }), 'Unsupported config version');
});

await test('zero-token record increments requests but not tokens', async () => {
  const mod = await importModule();
  mod.recordUsage('alice', 0, 'glm-5', 'morpheus');
  const usage = mod.getUsage('alice');
  assert(usage.daily.tokens === 0, 'zero tokens');
  assert(usage.daily.requests === 1, 'one request');
});

await test('getUsage for nonexistent agent returns empty', async () => {
  const mod = await importModule();
  const usage = mod.getUsage('nobody');
  assert(usage.daily.tokens === 0, 'zero tokens');
  assert(usage.daily.requests === 0, 'zero requests');
  assert(usage.monthly.tokens === 0, 'zero monthly');
});

await test('concurrent recordUsage calls do not corrupt', async () => {
  const mod = await importModule();
  // Simulate rapid sequential calls (not truly concurrent in single-threaded Node, but tests atomicWrite)
  for (let i = 0; i < 50; i++) {
    mod.recordUsage('alice', 100, 'glm-5', 'morpheus');
  }
  const usage = mod.getUsage('alice');
  assert(usage.daily.tokens === 5000, `expected 5000, got ${usage.daily.tokens}`);
  assert(usage.daily.requests === 50, `expected 50, got ${usage.daily.requests}`);
});

await test('setLimits with all options', async () => {
  const mod = await importModule();
  mod.setLimits('alice', {
    daily: 500_000,
    monthly: 10_000_000,
    alertThreshold: 0.7,
    degradeThreshold: 0.85,
    degradeModel: 'ollama/qwen3',
    cutoffAction: 'block',
  });
  const limits = mod.loadQuotaConfig('alice');
  assert(limits.daily === 500_000, 'daily');
  assert(limits.monthly === 10_000_000, 'monthly');
  assert(limits.alertThreshold === 0.7, 'alert');
  assert(limits.degradeThreshold === 0.85, 'degrade');
  assert(limits.degradeModel === 'ollama/qwen3', 'model');
  assert(limits.cutoffAction === 'block', 'cutoff');
});

await test('getAgentStatus includes all fields', async () => {
  const mod = await importModule();
  mod.recordUsage('alice', 85_000, 'glm-5', 'morpheus');
  const status = mod.getAgentStatus('alice');
  assert(status.agentId === 'alice', 'id');
  assert(status.daily.used === 85_000, 'daily used');
  assert(status.daily.limit === 100_000, 'daily limit');
  assert(status.daily.remaining === 15_000, 'daily remaining');
  assert(status.daily.ratio === 0.85, `ratio: ${status.daily.ratio}`);
  assert(status.alert === true, 'alerting');
  assert(status.degraded === false, 'not degraded (below 90%)');
  assert(typeof status.history === 'object', 'history present');
});

// ── CLI Tests ────────────────────────────────────────────────────

await test('CLI --help exits cleanly', async () => {
  const output = runCli('--help');
  assert(output.includes('Usage:'), 'help text');
  assert(output.includes('status'), 'mentions status');
});

await test('CLI status with no data', async () => {
  const output = runCli('status');
  assert(output.includes('No agents'), 'no data message');
});

await test('CLI record + status flow', async () => {
  runCli('record', '--agent-id', 'alice', '--tokens', '5000', '--model', 'glm-5', '--provider', 'morpheus');
  const output = runCli('status', '--agent-id', 'alice');
  assert(output.includes('alice'), 'shows alice');
  assert(output.includes('5.0K'), 'shows formatted tokens');
});

await test('CLI set limits', async () => {
  const output = runCli('set', '--agent-id', 'alice', '--daily', '200000');
  assert(output.includes('200000'), 'shows new limit');
});

await test('CLI set defaults', async () => {
  const output = runCli('set', '--default', '--daily', '300000');
  assert(output.includes('300000'), 'shows new default');
});

await test('CLI reset', async () => {
  runCli('record', '--agent-id', 'alice', '--tokens', '5000', '--model', 'glm-5', '--provider', 'morpheus');
  const output = runCli('reset', '--agent-id', 'alice');
  assert(output.includes('reset'), 'confirms reset');
});

await test('CLI reset all', async () => {
  runCli('record', '--agent-id', 'alice', '--tokens', '5000', '--model', 'glm-5', '--provider', 'morpheus');
  runCli('record', '--agent-id', 'bob', '--tokens', '3000', '--model', 'glm-5', '--provider', 'morpheus');
  const output = runCli('reset', '--all', '--period', 'daily');
  assert(output.includes('reset'), 'confirms reset');
});

await test('CLI alerts with no alerts', async () => {
  const output = runCli('alerts');
  assert(output.includes('No quota alerts'), 'no alerts');
});

await test('CLI alerts with alert', async () => {
  runCli('record', '--agent-id', 'alice', '--tokens', '85000', '--model', 'glm-5', '--provider', 'morpheus');
  const output = runCli('alerts');
  assert(output.includes('alice'), 'shows alerting agent');
});

await test('CLI export produces valid JSON', async () => {
  runCli('record', '--agent-id', 'alice', '--tokens', '5000', '--model', 'glm-5', '--provider', 'morpheus');
  const output = runCli('export');
  const data = JSON.parse(output);
  assert(data.exportVersion === 1, 'export version');
  assert(data.usage.alice, 'alice in export');
});

await test('CLI import restores data', async () => {
  runCli('record', '--agent-id', 'alice', '--tokens', '5000', '--model', 'glm-5', '--provider', 'morpheus');
  const exported = runCli('export');
  const exportPath = join(tmpDir, 'cli-export.json');
  writeFileSync(exportPath, exported);

  // Clear data
  rmSync(join(tmpDir, 'quotas'), { recursive: true, force: true });
  mkdirSync(join(tmpDir, 'quotas', 'usage'), { recursive: true });

  const output = runCli('import', '--file', exportPath);
  assert(output.includes('Import complete'), 'import success');
});

await test('CLI unknown command exits with error', async () => {
  const output = runCliFail('bogus');
  assert(output.includes('Unknown command'), 'error message');
});

await test('CLI record missing required args', async () => {
  const output = runCliFail('record', '--agent-id', 'alice');
  assert(output.includes('required'), 'error about required args');
});

await test('CLI set without target', async () => {
  const output = runCliFail('set', '--daily', '100000');
  assert(output.includes('--agent-id') || output.includes('--default'), 'error about target');
});

await test('multiple providers tracked separately', async () => {
  const mod = await importModule();
  mod.recordUsage('alice', 1000, 'glm-5', 'morpheus');
  mod.recordUsage('alice', 500, 'glm-5', 'venice');
  mod.recordUsage('alice', 200, 'gemma4', 'ollama');

  const usage = mod.getUsage('alice');
  assert(usage.daily.byProvider.morpheus.tokens === 1000, 'morpheus');
  assert(usage.daily.byProvider.venice.tokens === 500, 'venice');
  assert(usage.daily.byProvider.ollama.tokens === 200, 'ollama');
  assert(usage.daily.tokens === 1700, 'total');
});

await test('daily and monthly thresholds checked independently', async () => {
  const mod = await importModule();
  // Set daily high, monthly low
  mod.setLimits('alice', { daily: 10_000_000, monthly: 100 });
  mod.recordUsage('alice', 90, 'glm-5', 'morpheus');

  const result = mod.checkQuota('alice');
  assert(result.alert === true, 'monthly at 90% alerts');
  assert(result.degraded === true, 'monthly triggers degrade');
  assert(result.ratios.daily < 0.01, 'daily ratio still low');
  assert(result.ratios.monthly === 0.9, `monthly ratio: ${result.ratios.monthly}`);
});

// ── Summary ──────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log('All tests passed! ✅');
}
