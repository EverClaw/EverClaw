#!/usr/bin/env node
/**
 * buddy-host.test.mjs — Tests for buddy-host.mjs
 *
 * Tests the group tracking, member extraction, contact resolution,
 * trust inference, and provisioning orchestration logic.
 *
 * Uses temp directories to avoid touching real state files.
 *
 * Run: node scripts/buddy-host.test.mjs
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import {
  loadGroups,
  saveGroups,
  resolveContact,
  inferTrustProfile,
  extractMembers,
  filterMembers,
  generateWelcomeDM,
  handleGroupMessage,
  getGroupStatus,
  listTrackedGroups,
  isValidE164
} from './buddy-host.mjs';

// ── Test Harness ─────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    failures.push(message);
    console.log(`  ❌ ${message}`);
  }
}

function assertEq(actual, expected, message) {
  if (actual === expected) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    failures.push(`${message} — expected: ${JSON.stringify(expected)}, got: ${JSON.stringify(actual)}`);
    console.log(`  ❌ ${message} — expected: ${JSON.stringify(expected)}, got: ${JSON.stringify(actual)}`);
  }
}

function assertDeepEq(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    failures.push(`${message} — expected: ${b}, got: ${a}`);
    console.log(`  ❌ ${message} — expected: ${b}, got: ${a}`);
  }
}

function createTempDir() {
  const dir = join(tmpdir(), 'buddy-host-test-' + randomUUID().slice(0, 8));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupTempDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ── Tests: Group State Persistence ───────────────────────────────

console.log('\n📁 Group State Persistence');

{
  const dir = createTempDir();
  const path = join(dir, 'groups.json');

  // Load from non-existent file
  const empty = loadGroups(path);
  assertEq(empty.version, 1, 'loadGroups: default version is 1');
  assertDeepEq(empty.groups, {}, 'loadGroups: default groups is empty');

  // Save and reload
  const state = {
    version: 1,
    groups: {
      'group-abc': {
        id: 'group-abc',
        channel: 'signal',
        name: 'Test Group',
        createdAt: '2026-04-18T00:00:00Z',
        owner: '+15125551234',
        members: {
          '+15125555678': { agentId: 'alice', status: 'active', provisionedAt: '2026-04-18T00:00:00Z' }
        },
        autoProvision: true
      }
    }
  };
  saveGroups(state, path);
  assert(existsSync(path), 'saveGroups: file created');

  const loaded = loadGroups(path);
  assertEq(loaded.version, 1, 'loadGroups: version preserved after save');
  assertEq(Object.keys(loaded.groups).length, 1, 'loadGroups: one group after save');
  assertEq(loaded.groups['group-abc'].name, 'Test Group', 'loadGroups: group name preserved');
  assertEq(loaded.groups['group-abc'].members['+15125555678'].agentId, 'alice', 'loadGroups: member data preserved');

  cleanupTempDir(dir);
}

{
  const dir = createTempDir();
  const path = join(dir, 'corrupt.json');
  writeFileSync(path, 'NOT JSON!!!');
  const recovered = loadGroups(path);
  assertDeepEq(recovered.groups, {}, 'loadGroups: handles corrupt JSON gracefully');
  cleanupTempDir(dir);
}

{
  const dir = createTempDir();
  const path = join(dir, 'null.json');
  writeFileSync(path, 'null');
  const recovered = loadGroups(path);
  assertDeepEq(recovered.groups, {}, 'loadGroups: handles null JSON gracefully');
  cleanupTempDir(dir);
}

// ── Tests: isValidE164 ────────────────────────────────────────────

console.log('\n☎️ isValidE164');

assert(isValidE164('+15125551234'), 'isValidE164: valid US number');
assert(isValidE164('+447911123456'), 'isValidE164: valid UK number');
assert(isValidE164('+8613812345678'), 'isValidE164: valid CN number');
assert(!isValidE164('15125551234'), 'isValidE164: rejects no plus');
assert(!isValidE164('+0125551234'), 'isValidE164: rejects leading zero after plus');
assert(!isValidE164(''), 'isValidE164: rejects empty string');
assert(!isValidE164(null), 'isValidE164: rejects null');
assert(!isValidE164('+1'), 'isValidE164: rejects too short');
assert(!isValidE164('+99887766554433221'), 'isValidE164: rejects too long (>15 digits)');
assert(!isValidE164('+1-512-555-1234'), 'isValidE164: rejects dashes');
assert(!isValidE164('+1 512 555 1234'), 'isValidE164: rejects spaces');
assert(!isValidE164('hello'), 'isValidE164: rejects non-numeric');

// ── Tests: extractMembers (with E.164 validation) ────────────────

console.log('\n👥 extractMembers');

{
  // String array
  const result = extractMembers({ members: ['+15125551234', '+15125555678'] });
  assertEq(result.length, 2, 'extractMembers: string array → 2 members');
  assertEq(result[0].phone, '+15125551234', 'extractMembers: first phone correct');
  assertEq(result[0].name, null, 'extractMembers: name is null for string input');
}

{
  // Object array
  const result = extractMembers({ members: [{ phone: '+15125551234', name: 'Alice' }] });
  assertEq(result.length, 1, 'extractMembers: object array → 1 member');
  assertEq(result[0].name, 'Alice', 'extractMembers: name extracted from object');
}

{
  // participants key (alternative)
  const result = extractMembers({ participants: ['+15125551234'] });
  assertEq(result.length, 1, 'extractMembers: participants key works');
}

{
  // Empty / missing
  const result1 = extractMembers({});
  assertEq(result1.length, 0, 'extractMembers: empty event → 0 members');

  const result2 = extractMembers({ members: [] });
  assertEq(result2.length, 0, 'extractMembers: empty array → 0 members');
}

{
  // Mixed types (string + object + garbage)
  const result = extractMembers({
    members: [
      '+15125551234',
      { phone: '+15125555678', name: 'Bob' },
      42,
      null,
      { noPhone: true }
    ]
  });
  assertEq(result.length, 2, 'extractMembers: filters out non-member items');
}

{
  // Whitespace trimming
  const result = extractMembers({ members: ['  +15125551234  '] });
  assertEq(result[0].phone, '+15125551234', 'extractMembers: trims whitespace');
}

// ── Tests: filterMembers ─────────────────────────────────────────

console.log('\n🔍 filterMembers');

{
  const dir = createTempDir();
  const regPath = join(dir, 'registry.json');

  // No host phones, no registry → all pass through
  const members = [{ phone: '+15125551234', name: 'Alice' }, { phone: '+15125555678', name: 'Bob' }];
  const result = filterMembers(members, [], regPath);
  assertEq(result.length, 2, 'filterMembers: all pass when no host phones');
  assertEq(result[0].existing, false, 'filterMembers: marked as not existing');

  cleanupTempDir(dir);
}

{
  const dir = createTempDir();
  const regPath = join(dir, 'registry.json');

  // Host phone filtered out
  const members = [{ phone: '+15125551234', name: null }, { phone: '+15125559999', name: null }];
  const result = filterMembers(members, ['+15125551234'], regPath);
  assertEq(result.length, 1, 'filterMembers: host phone excluded');
  assertEq(result[0].phone, '+15125559999', 'filterMembers: non-host phone passes');

  cleanupTempDir(dir);
}

// ── Tests: inferTrustProfile ─────────────────────────────────────

console.log('\n🛡️ inferTrustProfile');

assertEq(inferTrustProfile(null), 'public', 'inferTrustProfile: null → public');
assertEq(inferTrustProfile({}), 'public', 'inferTrustProfile: empty → public');
assertEq(inferTrustProfile({ relationship: null }), 'public', 'inferTrustProfile: null relationship → public');
assertEq(inferTrustProfile({ relationship: 'friend' }), 'personal', 'inferTrustProfile: friend → personal');
assertEq(inferTrustProfile({ relationship: 'family member' }), 'personal', 'inferTrustProfile: family → personal');
assertEq(inferTrustProfile({ relationship: 'spouse' }), 'personal', 'inferTrustProfile: spouse → personal');
assertEq(inferTrustProfile({ relationship: 'mother' }), 'personal', 'inferTrustProfile: mother → personal');
assertEq(inferTrustProfile({ relationship: 'colleague at work' }), 'business', 'inferTrustProfile: colleague → business');
assertEq(inferTrustProfile({ relationship: 'business partner' }), 'business', 'inferTrustProfile: business → business');
assertEq(inferTrustProfile({ relationship: 'neighbor' }), 'public', 'inferTrustProfile: unknown → public');

// Name-based inference (falls back when relationship is null)
assertEq(inferTrustProfile({ name: 'Mom' }), 'personal', 'inferTrustProfile: name Mom → personal');
assertEq(inferTrustProfile({ name: 'Dad Smith' }), 'personal', 'inferTrustProfile: name Dad → personal');
assertEq(inferTrustProfile({ name: 'My Brother' }), 'personal', 'inferTrustProfile: name brother → personal');
assertEq(inferTrustProfile({ name: 'My Buddy' }), 'personal', 'inferTrustProfile: name buddy → personal');
assertEq(inferTrustProfile({ name: 'Work Buddy' }), 'business', 'inferTrustProfile: work takes priority over buddy');
assertEq(inferTrustProfile({ name: 'Business Client Co' }), 'business', 'inferTrustProfile: name business → business');
assertEq(inferTrustProfile({ name: 'John Smith' }), 'public', 'inferTrustProfile: generic name → public');
// Relationship takes priority over name
assertEq(inferTrustProfile({ name: 'John', relationship: 'friend' }), 'personal', 'inferTrustProfile: relationship priority over name');

// ── Tests: generateWelcomeDM ─────────────────────────────────────

console.log('\n💬 generateWelcomeDM');

{
  const dm = generateWelcomeDM({ humanName: 'Alice', ownerName: 'Owner', groupName: 'Weekend Crew' });
  assert(dm.includes('Alice'), 'welcomeDM: includes human name');
  assert(dm.includes('Owner'), 'welcomeDM: includes owner name');
  assert(dm.includes('Weekend Crew'), 'welcomeDM: includes group name');
  assert(dm.includes('👋'), 'welcomeDM: includes wave emoji');
}

{
  const dm = generateWelcomeDM({ humanName: null, ownerName: null });
  assert(dm.includes('there'), 'welcomeDM: fallback greeting when no name');
  assert(dm.includes('Your friend'), 'welcomeDM: fallback owner name');
}

// ── Tests: resolveContact ────────────────────────────────────────

console.log('\n📇 resolveContact');

{
  // On macOS, this will attempt contacts lookup (may or may not find anything).
  // On other platforms, returns unavailable. Either way, it should not crash.
  const result = resolveContact('+10000000000');
  assert(typeof result === 'object', 'resolveContact: returns object');
  assert('name' in result, 'resolveContact: has name field');
  assert('source' in result, 'resolveContact: has source field');
  assert(
    ['contacts-cli', 'applescript', 'not-found', 'unavailable'].includes(result.source),
    `resolveContact: valid source (${result.source})`
  );
}

// ── Tests: handleGroupMessage ────────────────────────────────────

console.log('\n🎯 handleGroupMessage');

{
  // Missing event
  let threw = false;
  try { handleGroupMessage(null); } catch (e) { threw = true; }
  assert(threw, 'handleGroupMessage: throws on null event');
}

{
  // Missing groupId
  let threw = false;
  try { handleGroupMessage({ channel: 'signal', members: [] }); } catch (e) { threw = true; }
  assert(threw, 'handleGroupMessage: throws on missing groupId');
}

{
  // Missing channel
  let threw = false;
  try { handleGroupMessage({ groupId: 'g1', members: [] }); } catch (e) { threw = true; }
  assert(threw, 'handleGroupMessage: throws on missing channel');
}

{
  // No members → no-members action
  const result = handleGroupMessage(
    { groupId: 'g1', channel: 'signal', members: [] },
    { groupsPath: join(createTempDir(), 'g.json') }
  );
  assertEq(result.action, 'no-members', 'handleGroupMessage: no members → no-members action');
}

// ── Tests: getGroupStatus / listTrackedGroups ────────────────────

console.log('\n📊 getGroupStatus / listTrackedGroups');

{
  const dir = createTempDir();
  const path = join(dir, 'groups.json');

  // Empty state
  assertEq(getGroupStatus('nonexistent', path), null, 'getGroupStatus: null for unknown group');
  assertDeepEq(listTrackedGroups(path), [], 'listTrackedGroups: empty when no groups');

  // Add a group
  saveGroups({
    version: 1,
    groups: {
      'g1': { id: 'g1', channel: 'signal', name: 'Test', createdAt: '2026-01-01', owner: null, members: {}, autoProvision: true }
    }
  }, path);

  const status = getGroupStatus('g1', path);
  assertEq(status.name, 'Test', 'getGroupStatus: returns correct group');
  assertEq(listTrackedGroups(path).length, 1, 'listTrackedGroups: returns 1 group');

  cleanupTempDir(dir);
}

// ── Tests: Atomic save (concurrent-safe) ─────────────────────────

console.log('\n🔒 Atomic Save');

{
  const dir = createTempDir();
  const path = join(dir, 'groups.json');

  // Save twice rapidly — second should not corrupt first
  saveGroups({ version: 1, groups: { g1: { id: 'g1' } } }, path);
  saveGroups({ version: 1, groups: { g1: { id: 'g1' }, g2: { id: 'g2' } } }, path);

  const loaded = loadGroups(path);
  assertEq(Object.keys(loaded.groups).length, 2, 'atomic save: both groups present after rapid saves');

  cleanupTempDir(dir);
}

// ── Tests: File permissions ──────────────────────────────────────

console.log('\n🔐 File Permissions');

{
  const dir = createTempDir();
  const path = join(dir, 'groups.json');
  saveGroups({ version: 1, groups: {} }, path);

  const { statSync } = await import('node:fs');
  const stats = statSync(path);
  const mode = (stats.mode & 0o777).toString(8);
  assertEq(mode, '600', 'saveGroups: file permissions are 0o600');

  cleanupTempDir(dir);
}

// ── Summary ──────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(50)}`);
console.log(`Tests: ${passed + failed} | ✅ Passed: ${passed} | ❌ Failed: ${failed}`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  ❌ ${f}`);
  }
}
console.log(`${'═'.repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
