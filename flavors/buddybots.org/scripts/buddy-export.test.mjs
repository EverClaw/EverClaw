#!/usr/bin/env node
/**
 * buddy-export.test.mjs — Tests for Scoped Agent Export & Import (Gap 7)
 */

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';

import {
  getAgentPaths,
  validateAgentExists,
  extractRegistryEntry,
  extractPeerEntry,
  listExportableAgents,
  exportAgent,
  importAgent,
} from './buddy-export.mjs';

// ── Test Helpers ─────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function assertEq(actual, expected, label) {
  if (actual === expected) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label} — expected: ${JSON.stringify(expected)}, got: ${JSON.stringify(actual)}`);
    failed++;
    failures.push(label);
  }
}

function assertTrue(condition, label) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}`);
    failed++;
    failures.push(label);
  }
}

function assertThrows(fn, label) {
  try {
    fn();
    console.log(`  ❌ ${label} — expected throw`);
    failed++;
    failures.push(label);
  } catch {
    console.log(`  ✅ ${label}`);
    passed++;
  }
}

/**
 * Create a complete test environment with mock agent data.
 */
function createTestEnv() {
  const root = join(tmpdir(), `buddy-export-test-${randomUUID()}`);
  const openclawDir = join(root, '.openclaw');
  const everclawDir = join(root, '.everclaw');

  // Create workspace for agent "alice"
  const aliceWorkspace = join(openclawDir, 'workspace-alice');
  mkdirSync(join(aliceWorkspace, 'memory'), { recursive: true });
  writeFileSync(join(aliceWorkspace, 'SOUL.md'), '# Alice\nI am Alice\'s buddy bot.');
  writeFileSync(join(aliceWorkspace, 'USER.md'), '# Alice\'s Human\nName: Alice Smith');
  writeFileSync(join(aliceWorkspace, 'memory', '2026-04-19.md'), '## Today\nHad a great day.');

  // Create XMTP identity for alice
  const aliceXmtp = join(everclawDir, 'xmtp-alice');
  mkdirSync(aliceXmtp, { recursive: true });
  writeFileSync(join(aliceXmtp, 'identity.json'), JSON.stringify({
    address: '0xAliceXMTP123',
    publicKey: 'alice-pub-key',
    createdAt: '2026-04-01T00:00:00Z',
  }));

  // Create workspace for agent "bob" (no XMTP)
  const bobWorkspace = join(openclawDir, 'workspace-bob');
  mkdirSync(bobWorkspace, { recursive: true });
  writeFileSync(join(bobWorkspace, 'SOUL.md'), '# Bob\nI am Bob\'s buddy bot.');

  // Create buddy registry
  const registry = {
    version: '1.0',
    buddies: [
      { agentId: 'alice', name: 'Alice Bot', phone: '+15551234567', xmtpAddress: '0xAliceXMTP123', trustProfile: 'personal' },
      { agentId: 'bob', name: 'Bob Bot', phone: '+15559876543', xmtpAddress: '0xBobXMTP456', trustProfile: 'business' },
    ],
  };
  mkdirSync(everclawDir, { recursive: true });
  writeFileSync(join(everclawDir, 'buddy-registry.json'), JSON.stringify(registry, null, 2));

  // Create peers file
  const peers = {
    trusted: {
      '0xAliceXMTP123': { agentId: 'alice', name: 'Alice Bot', addedAt: '2026-04-01' },
      '0xBobXMTP456': { agentId: 'bob', name: 'Bob Bot', addedAt: '2026-04-02' },
    },
  };
  mkdirSync(join(everclawDir, 'xmtp'), { recursive: true });
  writeFileSync(join(everclawDir, 'xmtp', 'peers.json'), JSON.stringify(peers, null, 2));

  return { root, openclawDir, everclawDir };
}

function cleanEnv(root) {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ── Tests: getAgentPaths ─────────────────────────────────────────

console.log('\n📁 getAgentPaths');

{
  const paths = getAgentPaths('alice');
  assertTrue(paths.workspace.includes('workspace-alice'), 'workspace path includes agent id');
  assertTrue(paths.xmtpIdentity.includes('xmtp-alice'), 'xmtp path includes agent id');
  assertTrue(typeof paths.registry === 'string', 'registry path is string');
  assertTrue(typeof paths.peers === 'string', 'peers path is string');
}

assertThrows(() => getAgentPaths(''), 'rejects empty agentId');
assertThrows(() => getAgentPaths(null), 'rejects null agentId');
assertThrows(() => getAgentPaths('   '), 'rejects whitespace agentId');
assertThrows(() => getAgentPaths('alice/../../etc'), 'rejects path traversal');
assertThrows(() => getAgentPaths('alice bob'), 'rejects spaces in agentId');
assertThrows(() => getAgentPaths('alice.dot'), 'rejects dots in agentId');

{
  const paths = getAgentPaths('agent-123_test');
  assertTrue(paths.workspace.includes('workspace-agent-123_test'), 'allows dashes and underscores');
}

// ── Tests: extractRegistryEntry ──────────────────────────────────

console.log('\n📋 extractRegistryEntry');

{
  const env = createTestEnv();
  const regPath = join(env.everclawDir, 'buddy-registry.json');

  const alice = extractRegistryEntry('alice', regPath);
  assertTrue(alice !== null, 'finds alice');
  assertEq(alice.agentId, 'alice', 'alice agentId matches');
  assertEq(alice.name, 'Alice Bot', 'alice name matches');

  const bob = extractRegistryEntry('bob', regPath);
  assertTrue(bob !== null, 'finds bob');

  const charlie = extractRegistryEntry('charlie', regPath);
  assertEq(charlie, null, 'returns null for unknown agent');

  const noFile = extractRegistryEntry('alice', '/tmp/nonexistent-registry.json');
  assertEq(noFile, null, 'returns null for missing file');

  cleanEnv(env.root);
}

// ── Tests: extractPeerEntry ──────────────────────────────────────

console.log('\n👥 extractPeerEntry');

{
  const env = createTestEnv();
  const peersPath = join(env.everclawDir, 'xmtp', 'peers.json');

  const alice = extractPeerEntry('alice', peersPath);
  assertTrue(alice !== null, 'finds alice peer');
  assertEq(alice.address, '0xAliceXMTP123', 'alice address matches');
  assertEq(alice.entry.agentId, 'alice', 'alice peer agentId matches');

  const charlie = extractPeerEntry('charlie', peersPath);
  assertEq(charlie, null, 'returns null for unknown agent');

  const noFile = extractPeerEntry('alice', '/tmp/nonexistent-peers.json');
  assertEq(noFile, null, 'returns null for missing file');

  cleanEnv(env.root);
}

// ── Tests: exportAgent ───────────────────────────────────────────

console.log('\n📦 exportAgent');

{
  const env = createTestEnv();
  const outputPath = join(env.root, 'alice-export.tar.gz');

  const result = exportAgent('alice', outputPath, {
    openclawDir: env.openclawDir,
    everclawDir: env.everclawDir,
    registryPath: join(env.everclawDir, 'buddy-registry.json'),
    peersPath: join(env.everclawDir, 'xmtp', 'peers.json'),
  });

  assertTrue(result.success, 'export success');
  assertEq(result.dryRun, false, 'not a dry run');
  assertEq(result.agentId, 'alice', 'agentId matches');
  assertTrue(existsSync(result.output), 'archive file created');
  assertTrue(result.archiveSize > 0, 'archive has content');
  assertTrue(typeof result.checksum === 'string' && result.checksum.length === 64, 'SHA-256 checksum');
  assertTrue(result.components.includes('workspace'), 'components includes workspace');
  assertTrue(result.components.includes('xmtp-identity'), 'components includes xmtp-identity');
  assertTrue(result.components.includes('registry-entry'), 'components includes registry-entry');
  assertTrue(result.components.includes('peer-entry'), 'components includes peer-entry');

  // Verify archive contents
  const extractDir = join(env.root, 'verify');
  mkdirSync(extractDir, { recursive: true });
  execSync(`tar -xzf "${result.output}" -C "${extractDir}"`);
  assertTrue(existsSync(join(extractDir, 'manifest.json')), 'archive contains manifest.json');
  assertTrue(existsSync(join(extractDir, 'workspace', 'SOUL.md')), 'archive contains workspace/SOUL.md');
  assertTrue(existsSync(join(extractDir, 'xmtp-identity', 'identity.json')), 'archive contains xmtp-identity');
  assertTrue(existsSync(join(extractDir, 'registry-entry.json')), 'archive contains registry-entry.json');
  assertTrue(existsSync(join(extractDir, 'peer-entry.json')), 'archive contains peer-entry.json');

  // Verify manifest
  const manifest = JSON.parse(readFileSync(join(extractDir, 'manifest.json'), 'utf8'));
  assertEq(manifest.agentId, 'alice', 'manifest agentId');
  assertEq(manifest.version, '1.0', 'manifest version');
  assertTrue(manifest.exportedAt !== undefined, 'manifest has exportedAt');

  cleanEnv(env.root);
}

// Dry run
{
  const env = createTestEnv();

  const result = exportAgent('alice', null, {
    dryRun: true,
    openclawDir: env.openclawDir,
    everclawDir: env.everclawDir,
    registryPath: join(env.everclawDir, 'buddy-registry.json'),
    peersPath: join(env.everclawDir, 'xmtp', 'peers.json'),
  });

  assertTrue(result.success, 'dry run success');
  assertTrue(result.dryRun, 'is dry run');
  assertTrue(result.components.length >= 2, 'components listed');
  assertTrue(result.totalSize > 0, 'total size calculated');

  cleanEnv(env.root);
}

// No XMTP flag
{
  const env = createTestEnv();
  const outputPath = join(env.root, 'alice-no-xmtp.tar.gz');

  const result = exportAgent('alice', outputPath, {
    noXmtp: true,
    openclawDir: env.openclawDir,
    everclawDir: env.everclawDir,
    registryPath: join(env.everclawDir, 'buddy-registry.json'),
    peersPath: join(env.everclawDir, 'xmtp', 'peers.json'),
  });

  assertTrue(result.success, 'export without XMTP success');
  assertTrue(!result.components.includes('xmtp-identity'), 'no xmtp-identity in components');

  cleanEnv(env.root);
}

// Missing workspace
{
  const env = createTestEnv();

  assertThrows(
    () => exportAgent('charlie', null, {
      openclawDir: env.openclawDir,
      everclawDir: env.everclawDir,
    }),
    'throws for missing workspace'
  );

  cleanEnv(env.root);
}

// Invalid agentId
assertThrows(() => exportAgent(''), 'throws for empty agentId');
assertThrows(() => exportAgent('../etc/passwd'), 'throws for path traversal');

// ── Tests: importAgent ───────────────────────────────────────────

console.log('\n📥 importAgent');

// Full round-trip: export alice → import on fresh host
{
  const env = createTestEnv();
  const archivePath = join(env.root, 'alice-roundtrip.tar.gz');

  // Export
  const exp = exportAgent('alice', archivePath, {
    openclawDir: env.openclawDir,
    everclawDir: env.everclawDir,
    registryPath: join(env.everclawDir, 'buddy-registry.json'),
    peersPath: join(env.everclawDir, 'xmtp', 'peers.json'),
  });
  assertTrue(exp.success, 'export for roundtrip');

  // Create fresh target env
  const target = join(env.root, 'target');
  const tOpenclawDir = join(target, '.openclaw');
  const tEverclawDir = join(target, '.everclaw');
  mkdirSync(tOpenclawDir, { recursive: true });
  mkdirSync(join(tEverclawDir, 'xmtp'), { recursive: true });

  // Import
  const imp = importAgent(archivePath, {
    openclawDir: tOpenclawDir,
    everclawDir: tEverclawDir,
    registryPath: join(tEverclawDir, 'buddy-registry.json'),
    peersPath: join(tEverclawDir, 'xmtp', 'peers.json'),
  });

  assertTrue(imp.success, 'import success');
  assertEq(imp.agentId, 'alice', 'imported agentId');
  assertTrue(imp.restored.includes('workspace'), 'restored workspace');
  assertTrue(imp.restored.includes('xmtp-identity'), 'restored xmtp-identity');
  assertTrue(imp.restored.includes('registry-entry'), 'restored registry-entry');
  assertTrue(imp.restored.includes('peer-entry'), 'restored peer-entry');

  // Verify files on disk
  assertTrue(existsSync(join(tOpenclawDir, 'workspace-alice', 'SOUL.md')), 'SOUL.md restored');
  assertTrue(existsSync(join(tOpenclawDir, 'workspace-alice', 'memory', '2026-04-19.md')), 'memory file restored');
  assertTrue(existsSync(join(tEverclawDir, 'xmtp-alice', 'identity.json')), 'XMTP identity restored');

  // Verify registry
  const reg = JSON.parse(readFileSync(join(tEverclawDir, 'buddy-registry.json'), 'utf8'));
  assertTrue(reg.buddies.some(b => b.agentId === 'alice'), 'alice in target registry');

  // Verify peers
  const peers = JSON.parse(readFileSync(join(tEverclawDir, 'xmtp', 'peers.json'), 'utf8'));
  assertTrue(peers.trusted['0xAliceXMTP123'] !== undefined, 'alice in target peers');

  cleanEnv(env.root);
}

// Conflict detection
{
  const env = createTestEnv();
  const archivePath = join(env.root, 'alice-conflict.tar.gz');

  exportAgent('alice', archivePath, {
    openclawDir: env.openclawDir,
    everclawDir: env.everclawDir,
    registryPath: join(env.everclawDir, 'buddy-registry.json'),
    peersPath: join(env.everclawDir, 'xmtp', 'peers.json'),
  });

  // Import into SAME env (conflict)
  const result = importAgent(archivePath, {
    openclawDir: env.openclawDir,
    everclawDir: env.everclawDir,
  });

  assertEq(result.success, false, 'import blocked by conflict');
  assertTrue(result.conflicts.length > 0, 'conflicts listed');
  assertTrue(result.error.includes('--force'), 'error mentions --force');

  cleanEnv(env.root);
}

// Force overwrite
{
  const env = createTestEnv();
  const archivePath = join(env.root, 'alice-force.tar.gz');

  exportAgent('alice', archivePath, {
    openclawDir: env.openclawDir,
    everclawDir: env.everclawDir,
    registryPath: join(env.everclawDir, 'buddy-registry.json'),
    peersPath: join(env.everclawDir, 'xmtp', 'peers.json'),
  });

  // Modify workspace to verify overwrite
  writeFileSync(join(env.openclawDir, 'workspace-alice', 'SOUL.md'), '# Modified');

  const result = importAgent(archivePath, {
    force: true,
    openclawDir: env.openclawDir,
    everclawDir: env.everclawDir,
    registryPath: join(env.everclawDir, 'buddy-registry.json'),
    peersPath: join(env.everclawDir, 'xmtp', 'peers.json'),
  });

  assertTrue(result.success, 'force import success');
  assertTrue(result.forced, 'forced flag set');

  // Verify original content restored
  const soul = readFileSync(join(env.openclawDir, 'workspace-alice', 'SOUL.md'), 'utf8');
  assertTrue(soul.includes('Alice'), 'original SOUL.md restored');

  cleanEnv(env.root);
}

// Import dry run
{
  const env = createTestEnv();
  const archivePath = join(env.root, 'alice-dryimport.tar.gz');

  exportAgent('alice', archivePath, {
    openclawDir: env.openclawDir,
    everclawDir: env.everclawDir,
    registryPath: join(env.everclawDir, 'buddy-registry.json'),
    peersPath: join(env.everclawDir, 'xmtp', 'peers.json'),
  });

  const target = join(env.root, 'drytarget');
  const tOc = join(target, '.openclaw');
  mkdirSync(tOc, { recursive: true });

  const result = importAgent(archivePath, {
    dryRun: true,
    openclawDir: tOc,
    everclawDir: join(target, '.everclaw'),
  });

  assertTrue(result.success, 'dry run import success');
  assertTrue(result.dryRun, 'is dry run');
  assertEq(result.agentId, 'alice', 'agentId from manifest');
  assertTrue(!existsSync(join(tOc, 'workspace-alice')), 'no files created during dry run');

  cleanEnv(env.root);
}

// Missing archive
assertThrows(
  () => importAgent('/tmp/nonexistent-archive-12345.tar.gz'),
  'throws for missing archive'
);

// Invalid archive (no manifest)
{
  const env = createTestEnv();
  const badArchive = join(env.root, 'bad.tar.gz');
  mkdirSync(join(env.root, 'badstaging'), { recursive: true });
  writeFileSync(join(env.root, 'badstaging', 'junk.txt'), 'not a real export');
  execSync(`tar -czf "${badArchive}" -C "${join(env.root, 'badstaging')}" .`);

  assertThrows(
    () => importAgent(badArchive),
    'throws for archive without manifest'
  );

  cleanEnv(env.root);
}

// ── Tests: Checksum Verification ───────────────────────────────

console.log('\n🔐 Checksum Verification');

// Valid checksum passes
{
  const env = createTestEnv();
  const archivePath = join(env.root, 'alice-cksum.tar.gz');

  const exp = exportAgent('alice', archivePath, {
    openclawDir: env.openclawDir,
    everclawDir: env.everclawDir,
    registryPath: join(env.everclawDir, 'buddy-registry.json'),
    peersPath: join(env.everclawDir, 'xmtp', 'peers.json'),
  });

  const target = join(env.root, 'cksum-target');
  mkdirSync(join(target, '.openclaw'), { recursive: true });
  mkdirSync(join(target, '.everclaw', 'xmtp'), { recursive: true });

  const imp = importAgent(archivePath, {
    expectedChecksum: exp.checksum,
    openclawDir: join(target, '.openclaw'),
    everclawDir: join(target, '.everclaw'),
    registryPath: join(target, '.everclaw', 'buddy-registry.json'),
    peersPath: join(target, '.everclaw', 'xmtp', 'peers.json'),
  });

  assertTrue(imp.success, 'import with valid checksum succeeds');
  cleanEnv(env.root);
}

// Wrong checksum fails
{
  const env = createTestEnv();
  const archivePath = join(env.root, 'alice-badcksum.tar.gz');

  exportAgent('alice', archivePath, {
    openclawDir: env.openclawDir,
    everclawDir: env.everclawDir,
    registryPath: join(env.everclawDir, 'buddy-registry.json'),
    peersPath: join(env.everclawDir, 'xmtp', 'peers.json'),
  });

  assertThrows(
    () => importAgent(archivePath, { expectedChecksum: 'deadbeef'.repeat(8) }),
    'import with wrong checksum throws'
  );

  cleanEnv(env.root);
}

// No checksum — passes (backwards compat)
{
  const env = createTestEnv();
  const archivePath = join(env.root, 'alice-nocksum.tar.gz');

  exportAgent('alice', archivePath, {
    openclawDir: env.openclawDir,
    everclawDir: env.everclawDir,
    registryPath: join(env.everclawDir, 'buddy-registry.json'),
    peersPath: join(env.everclawDir, 'xmtp', 'peers.json'),
  });

  const target = join(env.root, 'nocksum-target');
  mkdirSync(join(target, '.openclaw'), { recursive: true });
  mkdirSync(join(target, '.everclaw', 'xmtp'), { recursive: true });

  const imp = importAgent(archivePath, {
    openclawDir: join(target, '.openclaw'),
    everclawDir: join(target, '.everclaw'),
    registryPath: join(target, '.everclaw', 'buddy-registry.json'),
    peersPath: join(target, '.everclaw', 'xmtp', 'peers.json'),
  });

  assertTrue(imp.success, 'import without checksum succeeds (backwards compat)');
  cleanEnv(env.root);
}

// ── Tests: validateAgentExists ───────────────────────────────────

console.log('\n✅ validateAgentExists');

// Note: validateAgentExists uses default paths (real homedir), so we just test structure
{
  const result = validateAgentExists('nonexistent-agent-xyz');
  assertEq(result.valid, false, 'invalid for nonexistent agent');
  assertTrue(result.missing.length > 0, 'missing paths listed');
}

// ── Tests: Edge Cases ────────────────────────────────────────────

console.log('\n🔒 Edge Cases');

// Export bob (has workspace but no XMTP)
{
  const env = createTestEnv();
  const outputPath = join(env.root, 'bob-export.tar.gz');

  const result = exportAgent('bob', outputPath, {
    openclawDir: env.openclawDir,
    everclawDir: env.everclawDir,
    registryPath: join(env.everclawDir, 'buddy-registry.json'),
    peersPath: join(env.everclawDir, 'xmtp', 'peers.json'),
  });

  assertTrue(result.success, 'bob export success (no XMTP)');
  assertTrue(result.components.includes('workspace'), 'has workspace');
  assertTrue(!result.components.includes('xmtp-identity'), 'no xmtp-identity');
  assertTrue(result.warnings.some(w => w.includes('XMTP')), 'warning about missing XMTP');

  cleanEnv(env.root);
}

// Export with nested directory structure
{
  const env = createTestEnv();
  const nestedOutput = join(env.root, 'nested', 'dir', 'export.tar.gz');

  const result = exportAgent('alice', nestedOutput, {
    openclawDir: env.openclawDir,
    everclawDir: env.everclawDir,
    registryPath: join(env.everclawDir, 'buddy-registry.json'),
    peersPath: join(env.everclawDir, 'xmtp', 'peers.json'),
  });

  assertTrue(result.success, 'export to nested dir success');
  assertTrue(existsSync(nestedOutput), 'archive created in nested dir');

  cleanEnv(env.root);
}

// ── Summary ──────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(50)}`);
console.log(`Tests: ${passed + failed} | ✅ Passed: ${passed} | ❌ Failed: ${failed}`);
console.log(`${'═'.repeat(50)}`);

if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  ❌ ${f}`);
  }
}

process.exit(failed > 0 ? 1 : 0);
