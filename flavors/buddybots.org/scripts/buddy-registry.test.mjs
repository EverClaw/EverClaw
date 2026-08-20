/**
 * buddy-registry.test.mjs — Unit tests for buddy registry
 *
 * Run: node --test scripts/buddy-registry.test.mjs
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  loadRegistry,
  saveRegistry,
  addBuddy,
  removeBuddy,
  lookupByPhone,
  lookupByXmtp,
  lookupByAgentId,
  listBuddies,
  exportRegistry,
  importRegistry
} from './buddy-registry.mjs';

// ── Test Helpers ─────────────────────────────────────────────────

let testDir;
let testPath;

function freshPath() {
  testDir = mkdtempSync(join(tmpdir(), 'buddy-reg-test-'));
  testPath = join(testDir, 'buddy-registry.json');
  return testPath;
}

function cleanup() {
  if (testDir) {
    rmSync(testDir, { recursive: true, force: true });
    testDir = null;
  }
}

const ALICE = {
  phone: '+15125551234',
  name: 'Alice',
  xmtpAddress: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  agentId: 'alice',
  trustProfile: 'personal'
};

const BOB = {
  phone: '+15125555678',
  name: 'Bob',
  xmtpAddress: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
  agentId: 'bob',
  trustProfile: 'business'
};

// ── Tests ────────────────────────────────────────────────────────

describe('loadRegistry', () => {
  beforeEach(() => freshPath());
  afterEach(() => cleanup());

  test('returns empty registry for missing file', () => {
    const reg = loadRegistry(testPath);
    assert.equal(reg.version, 1);
    assert.deepEqual(reg.buddies, {});
  });

  test('loads valid registry', () => {
    saveRegistry({ version: 1, buddies: { '+1': { name: 'Test' } } }, testPath);
    const reg = loadRegistry(testPath);
    assert.equal(reg.buddies['+1'].name, 'Test');
  });

  test('returns empty registry for corrupt JSON', () => {
    writeFileSync(testPath, '{{bad json', 'utf8');
    const reg = loadRegistry(testPath);
    assert.deepEqual(reg.buddies, {});
  });
});

describe('addBuddy', () => {
  beforeEach(() => freshPath());
  afterEach(() => cleanup());

  test('adds a buddy successfully', () => {
    const entry = addBuddy({ ...ALICE, registryPath: testPath });
    assert.equal(entry.name, 'Alice');
    assert.equal(entry.xmtpAddress, ALICE.xmtpAddress);
    assert.equal(entry.agentId, 'alice');
    assert.equal(entry.trustProfile, 'personal');
    assert.equal(entry.status, 'active');
    assert.ok(entry.provisionedAt);
  });

  test('persists to disk', () => {
    addBuddy({ ...ALICE, registryPath: testPath });
    const reg = loadRegistry(testPath);
    assert.ok(reg.buddies[ALICE.phone]);
    assert.equal(reg.buddies[ALICE.phone].name, 'Alice');
  });

  test('sets default channelIds from phone', () => {
    const entry = addBuddy({ ...ALICE, registryPath: testPath });
    assert.equal(entry.channelIds.signal, ALICE.phone);
    assert.equal(entry.channelIds.whatsapp, ALICE.phone);
  });

  test('allows custom channelIds', () => {
    const entry = addBuddy({
      ...ALICE,
      channelIds: { telegram: '12345' },
      registryPath: testPath
    });
    assert.equal(entry.channelIds.telegram, '12345');
    assert.equal(entry.channelIds.signal, undefined);
  });

  test('rejects duplicate phone', () => {
    addBuddy({ ...ALICE, registryPath: testPath });
    assert.throws(
      () => addBuddy({ ...ALICE, registryPath: testPath }),
      /already registered for phone/
    );
  });

  test('rejects duplicate xmtpAddress', () => {
    addBuddy({ ...ALICE, registryPath: testPath });
    assert.throws(
      () => addBuddy({ ...BOB, xmtpAddress: ALICE.xmtpAddress, registryPath: testPath }),
      /xmtpAddress.*already registered/
    );
  });

  test('rejects duplicate agentId', () => {
    addBuddy({ ...ALICE, registryPath: testPath });
    assert.throws(
      () => addBuddy({ ...BOB, agentId: 'alice', registryPath: testPath }),
      /agentId.*already registered/
    );
  });

  test('rejects invalid trust profile', () => {
    assert.throws(
      () => addBuddy({ ...ALICE, trustProfile: 'evil', registryPath: testPath }),
      /trustProfile must be one of/
    );
  });

  test('rejects missing required fields', () => {
    assert.throws(() => addBuddy({ registryPath: testPath }), /phone is required/);
    assert.throws(() => addBuddy({ phone: '+1', registryPath: testPath }), /name is required/);
    assert.throws(() => addBuddy({ phone: '+1', name: 'A', registryPath: testPath }), /xmtpAddress is required/);
    assert.throws(() => addBuddy({ phone: '+1', name: 'A', xmtpAddress: '0x1', registryPath: testPath }), /agentId is required/);
  });

  test('adds multiple buddies', () => {
    addBuddy({ ...ALICE, registryPath: testPath });
    addBuddy({ ...BOB, registryPath: testPath });
    const all = listBuddies(testPath);
    assert.equal(all.length, 2);
  });
});

describe('removeBuddy', () => {
  beforeEach(() => freshPath());
  afterEach(() => cleanup());

  test('removes existing buddy', () => {
    addBuddy({ ...ALICE, registryPath: testPath });
    const removed = removeBuddy(ALICE.phone, testPath);
    assert.equal(removed.name, 'Alice');
    assert.equal(listBuddies(testPath).length, 0);
  });

  test('returns null for missing buddy', () => {
    const result = removeBuddy('+1999', testPath);
    assert.equal(result, null);
  });

  test('persists removal to disk', () => {
    addBuddy({ ...ALICE, registryPath: testPath });
    removeBuddy(ALICE.phone, testPath);
    const reg = loadRegistry(testPath);
    assert.equal(reg.buddies[ALICE.phone], undefined);
  });
});

describe('lookupByPhone', () => {
  beforeEach(() => freshPath());
  afterEach(() => cleanup());

  test('finds existing buddy', () => {
    addBuddy({ ...ALICE, registryPath: testPath });
    const result = lookupByPhone(ALICE.phone, testPath);
    assert.equal(result.name, 'Alice');
    assert.equal(result.phone, ALICE.phone);
  });

  test('returns null for missing', () => {
    const result = lookupByPhone('+1999', testPath);
    assert.equal(result, null);
  });
});

describe('lookupByXmtp', () => {
  beforeEach(() => freshPath());
  afterEach(() => cleanup());

  test('finds existing buddy by XMTP address', () => {
    addBuddy({ ...ALICE, registryPath: testPath });
    const result = lookupByXmtp(ALICE.xmtpAddress, testPath);
    assert.equal(result.name, 'Alice');
    assert.equal(result.phone, ALICE.phone);
  });

  test('returns null for missing', () => {
    const result = lookupByXmtp('0xNONE', testPath);
    assert.equal(result, null);
  });
});

describe('lookupByAgentId', () => {
  beforeEach(() => freshPath());
  afterEach(() => cleanup());

  test('finds existing buddy by agent ID', () => {
    addBuddy({ ...ALICE, registryPath: testPath });
    const result = lookupByAgentId('alice', testPath);
    assert.equal(result.name, 'Alice');
    assert.equal(result.phone, ALICE.phone);
  });

  test('returns null for missing', () => {
    const result = lookupByAgentId('nobody', testPath);
    assert.equal(result, null);
  });
});

describe('listBuddies', () => {
  beforeEach(() => freshPath());
  afterEach(() => cleanup());

  test('lists all buddies', () => {
    addBuddy({ ...ALICE, registryPath: testPath });
    addBuddy({ ...BOB, registryPath: testPath });
    const all = listBuddies(testPath);
    assert.equal(all.length, 2);
    const names = all.map(b => b.name).sort();
    assert.deepEqual(names, ['Alice', 'Bob']);
  });

  test('returns empty array for empty registry', () => {
    const all = listBuddies(testPath);
    assert.equal(all.length, 0);
  });
});

describe('exportRegistry', () => {
  beforeEach(() => freshPath());
  afterEach(() => cleanup());

  test('exports valid JSON', () => {
    addBuddy({ ...ALICE, registryPath: testPath });
    const json = exportRegistry(testPath);
    const parsed = JSON.parse(json);
    assert.equal(parsed.version, 1);
    assert.ok(parsed.buddies[ALICE.phone]);
  });
});

describe('importRegistry', () => {
  beforeEach(() => freshPath());
  afterEach(() => cleanup());

  test('imports new entries', () => {
    const data = { version: 1, buddies: { [ALICE.phone]: { name: 'Alice', xmtpAddress: ALICE.xmtpAddress, agentId: 'alice', status: 'active' } } };
    const result = importRegistry(JSON.stringify(data), testPath);
    assert.equal(result.added, 1);
    assert.equal(result.skipped, 0);
    assert.equal(lookupByPhone(ALICE.phone, testPath).name, 'Alice');
  });

  test('skips existing entries', () => {
    addBuddy({ ...ALICE, registryPath: testPath });
    const data = { version: 1, buddies: { [ALICE.phone]: { name: 'New Alice', xmtpAddress: '0xNEW', agentId: 'new-alice', status: 'active' } } };
    const result = importRegistry(JSON.stringify(data), testPath);
    assert.equal(result.added, 0);
    assert.equal(result.skipped, 1);
    // Original entry preserved
    assert.equal(lookupByPhone(ALICE.phone, testPath).name, 'Alice');
  });

  test('rejects invalid format', () => {
    assert.throws(
      () => importRegistry('{"version": 1}', testPath),
      /missing buddies object/
    );
  });

  test('merges new and existing', () => {
    addBuddy({ ...ALICE, registryPath: testPath });
    const data = {
      version: 1,
      buddies: {
        [ALICE.phone]: { name: 'Alice', xmtpAddress: ALICE.xmtpAddress, agentId: 'alice', status: 'active' },
        [BOB.phone]: { name: 'Bob', xmtpAddress: BOB.xmtpAddress, agentId: 'bob', status: 'active' }
      }
    };
    const result = importRegistry(JSON.stringify(data), testPath);
    assert.equal(result.added, 1);
    assert.equal(result.skipped, 1);
    assert.equal(listBuddies(testPath).length, 2);
  });
});
