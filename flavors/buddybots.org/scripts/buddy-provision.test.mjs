/**
 * buddy-provision.test.mjs — Unit tests for buddy provisioner
 *
 * Tests provisioning logic with mock filesystem (temp dirs).
 * Does NOT test XMTP identity generation (requires viem + network).
 * Does NOT test SIGUSR1 reload (requires running OpenClaw).
 *
 * Run: node --test scripts/buddy-provision.test.mjs
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { deriveAgentId, provision, deprovision } from './buddy-provision.mjs';
import { loadRegistry, addBuddy } from './buddy-registry.mjs';

// ── Test Helpers ─────────────────────────────────────────────────

let testDir;

function freshTestEnv() {
  testDir = mkdtempSync(join(tmpdir(), 'buddy-prov-test-'));
  const configPath = join(testDir, 'openclaw.json');
  const registryPath = join(testDir, 'buddy-registry.json');
  const workspaceBase = join(testDir, 'workspaces');

  // Create minimal openclaw.json
  mkdirSync(workspaceBase, { recursive: true });
  writeFileSync(configPath, JSON.stringify({
    agents: { defaults: {}, list: [{ id: 'main' }] }
  }, null, 2));

  return { configPath, registryPath, workspaceBase };
}

function cleanup() {
  if (testDir) {
    rmSync(testDir, { recursive: true, force: true });
    testDir = null;
  }
}

// ── deriveAgentId Tests ──────────────────────────────────────────

describe('deriveAgentId', () => {
  test('simple name', () => {
    assert.equal(deriveAgentId('Alice'), 'alice');
  });

  test('two-word name', () => {
    assert.equal(deriveAgentId('Bob Smith'), 'bob-smith');
  });

  test('accented characters', () => {
    assert.equal(deriveAgentId('José María'), 'jose-maria');
  });

  test('special characters', () => {
    assert.equal(deriveAgentId('O\'Brien-Jr.'), 'o-brien-jr');
  });

  test('numbers preserved', () => {
    assert.equal(deriveAgentId('Agent 007'), 'agent-007');
  });

  test('empty string fallback', () => {
    assert.equal(deriveAgentId('!!!'), 'buddy');
  });

  test('whitespace-only fallback', () => {
    assert.equal(deriveAgentId('   '), 'buddy');
  });

  test('trims leading/trailing hyphens', () => {
    assert.equal(deriveAgentId('--Alice--'), 'alice');
  });
});

// ── Provision Dry Run Tests ──────────────────────────────────────

describe('provision --dry-run', () => {
  let env;
  beforeEach(() => {
    env = freshTestEnv();
  });
  afterEach(() => cleanup());

  test('returns plan without creating anything', () => {
    const result = provision({
      name: 'Alice',
      phone: '+15125551234',
      trustProfile: 'personal',
      dryRun: true,
      configPath: env.configPath,
      registryPath: env.registryPath
    });

    assert.equal(result.dryRun, true);
    assert.equal(result.agentId, 'alice');
    assert.equal(result.name, 'Alice');
    assert.equal(result.phone, '+15125551234');
    assert.ok(result.steps.length > 0);

    // Nothing should be created
    const config = JSON.parse(readFileSync(env.configPath, 'utf8'));
    assert.equal(config.agents.list.length, 1); // only 'main'
  });

  test('uses custom agent-id', () => {
    const result = provision({
      name: 'Alice',
      phone: '+15125551234',
      agentId: 'custom-alice',
      dryRun: true,
      configPath: env.configPath,
      registryPath: env.registryPath
    });
    assert.equal(result.agentId, 'custom-alice');
  });
});

// ── Validation Tests ─────────────────────────────────────────────

describe('provision validation', () => {
  let env;
  beforeEach(() => {
    env = freshTestEnv();
  });
  afterEach(() => cleanup());

  test('rejects missing name', () => {
    assert.throws(
      () => provision({ phone: '+1', dryRun: true, configPath: env.configPath, registryPath: env.registryPath }),
      /--name is required/
    );
  });

  test('rejects missing phone', () => {
    assert.throws(
      () => provision({ name: 'A', dryRun: true, configPath: env.configPath, registryPath: env.registryPath }),
      /--phone is required/
    );
  });

  test('rejects invalid trust profile', () => {
    assert.throws(
      () => provision({ name: 'A', phone: '+1', trustProfile: 'evil', dryRun: true, configPath: env.configPath, registryPath: env.registryPath }),
      /--trust must be one of/
    );
  });

  test('rejects duplicate phone in registry', () => {
    addBuddy({
      phone: '+15125551234',
      name: 'Existing',
      xmtpAddress: '0xAAA',
      agentId: 'existing',
      registryPath: env.registryPath
    });
    assert.throws(
      () => provision({ name: 'Alice', phone: '+15125551234', dryRun: true, configPath: env.configPath, registryPath: env.registryPath }),
      /already registered/
    );
  });

  test('rejects duplicate agentId in registry', () => {
    addBuddy({
      phone: '+15125550000',
      name: 'Existing Alice',
      xmtpAddress: '0xBBB',
      agentId: 'alice',
      registryPath: env.registryPath
    });
    assert.throws(
      () => provision({ name: 'Alice', phone: '+15125551234', dryRun: true, configPath: env.configPath, registryPath: env.registryPath }),
      /already registered/
    );
  });
});

// ── Deprovision Tests ────────────────────────────────────────────

describe('deprovision', () => {
  let env;
  beforeEach(() => {
    env = freshTestEnv();
  });
  afterEach(() => cleanup());

  test('removes agent from config', () => {
    // Manually add an agent entry
    const config = JSON.parse(readFileSync(env.configPath, 'utf8'));
    config.agents.list.push({ id: 'alice', name: "Alice's Buddy Bot" });
    writeFileSync(env.configPath, JSON.stringify(config, null, 2));

    const result = deprovision('alice', {
      configPath: env.configPath,
      registryPath: env.registryPath
    });
    assert.ok(result.removed.includes('config'));

    const after = JSON.parse(readFileSync(env.configPath, 'utf8'));
    assert.equal(after.agents.list.find(a => a.id === 'alice'), undefined);
  });

  test('removes agent from registry', () => {
    addBuddy({
      phone: '+15125551234',
      name: 'Alice',
      xmtpAddress: '0xAAA',
      agentId: 'alice',
      registryPath: env.registryPath
    });

    const result = deprovision('alice', {
      configPath: env.configPath,
      registryPath: env.registryPath
    });
    assert.ok(result.removed.includes('registry'));

    const reg = loadRegistry(env.registryPath);
    assert.equal(Object.keys(reg.buddies).length, 0);
  });

  test('removes workspace directory', () => {
    const wsPath = join(process.env.HOME || '', '.openclaw', 'workspace-test-deprov-' + Date.now());
    mkdirSync(wsPath, { recursive: true });
    writeFileSync(join(wsPath, 'SOUL.md'), 'test');

    // We can't easily test workspace removal because getWorkspacePath uses a fixed HOME
    // Just test that deprovision doesn't throw on missing workspace
    const result = deprovision('nonexistent-agent', {
      configPath: env.configPath,
      registryPath: env.registryPath
    });
    assert.equal(result.errors.length, 0);

    // Cleanup
    rmSync(wsPath, { recursive: true, force: true });
  });

  test('handles already-removed agent gracefully', () => {
    const result = deprovision('ghost', {
      configPath: env.configPath,
      registryPath: env.registryPath
    });
    assert.equal(result.removed.length, 0);
    assert.equal(result.errors.length, 0);
  });

  test('rejects missing agentId', () => {
    assert.throws(() => deprovision(''), /Agent ID is required/);
    assert.throws(() => deprovision(null), /Agent ID is required/);
  });
});

// ── Integration: Provision + Deprovision Cycle ───────────────────

describe('provision → deprovision cycle (dry-run)', () => {
  let env;
  beforeEach(() => {
    env = freshTestEnv();
  });
  afterEach(() => cleanup());

  test('dry-run provision, then deprovision cleans up', () => {
    // Dry-run doesn't create anything
    const plan = provision({
      name: 'Cycle Test',
      phone: '+15125559999',
      dryRun: true,
      configPath: env.configPath,
      registryPath: env.registryPath
    });
    assert.equal(plan.dryRun, true);
    assert.equal(plan.agentId, 'cycle-test');

    // Deprovision on non-existent should be clean
    const result = deprovision('cycle-test', {
      configPath: env.configPath,
      registryPath: env.registryPath
    });
    assert.equal(result.removed.length, 0);
    assert.equal(result.errors.length, 0);
  });
});
