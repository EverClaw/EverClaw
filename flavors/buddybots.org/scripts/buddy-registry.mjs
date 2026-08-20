#!/usr/bin/env node
/**
 * buddy-registry.mjs — Local buddy bot registry
 *
 * Maps phone/userID → XMTP address → agentId → workspace.
 * Local only — never published, never synced. Contains PII.
 *
 * CLI:
 *   node buddy-registry.mjs add --phone "+15125551234" --name "Alice" --xmtp "0xABC..." --agent-id alice --trust personal
 *   node buddy-registry.mjs remove --phone "+15125551234"
 *   node buddy-registry.mjs lookup --phone "+15125551234"
 *   node buddy-registry.mjs lookup --xmtp "0xABC..."
 *   node buddy-registry.mjs lookup --agent-id alice
 *   node buddy-registry.mjs list
 *   node buddy-registry.mjs export
 *   node buddy-registry.mjs import --file backup.json
 *
 * Library:
 *   import { loadRegistry, addBuddy, removeBuddy, lookupByPhone, lookupByXmtp, lookupByAgentId, listBuddies } from './buddy-registry.mjs';
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync, rmdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

// ── Paths ────────────────────────────────────────────────────────

const EVERCLAW_DIR = join(process.env.HOME || '', '.everclaw');
const REGISTRY_PATH = process.env.BUDDY_REGISTRY_PATH || join(EVERCLAW_DIR, 'buddy-registry.json');
const CURRENT_VERSION = 1;

// ── File Lock (simple mkdir-based, parameterized by registry path) ───

const LOCK_TIMEOUT_MS = 10_000;
const LOCK_STALE_MS = 60_000;

function getLockPath(registryPath) {
  return registryPath + '.lock';
}

function acquireLock(registryPath = REGISTRY_PATH) {
  const lockPath = getLockPath(registryPath);
  const parentDir = dirname(lockPath);
  mkdirSync(parentDir, { recursive: true, mode: 0o700 });

  const start = Date.now();
  while (true) {
    try {
      mkdirSync(lockPath);
      writeFileSync(join(lockPath, 'timestamp'), Date.now().toString());
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // Check for stale lock
      try {
        const tsStr = readFileSync(join(lockPath, 'timestamp'), 'utf8').trim();
        const lockAge = Date.now() - Number(tsStr);
        if (!isNaN(lockAge) && lockAge > LOCK_STALE_MS) {
          releaseLock(registryPath);
          continue;
        }
      } catch {
        /* no timestamp file — check age via directory */
        try {
          const lockStat = statSync(lockPath);
          const lockAge = Date.now() - lockStat.mtimeMs;
          if (lockAge > LOCK_STALE_MS) {
            releaseLock(registryPath);
            continue;
          }
        } catch { /* ignore */ }
      }
      if (Date.now() - start > LOCK_TIMEOUT_MS) {
        throw new Error(`buddy-registry: lock timeout after ${LOCK_TIMEOUT_MS}ms. Stale lock at ${lockPath}?`);
      }
      // Busy-wait 50ms
      const deadline = Date.now() + 50;
      while (Date.now() < deadline) { /* spin */ }
    }
  }
}

function releaseLock(registryPath = REGISTRY_PATH) {
  const lockPath = getLockPath(registryPath);
  try { unlinkSync(join(lockPath, 'timestamp')); } catch { /* ignore */ }
  try { rmdirSync(lockPath); } catch { /* ignore */ }
}

// ── Registry I/O ─────────────────────────────────────────────────

function emptyRegistry() {
  return { version: CURRENT_VERSION, buddies: {} };
}

export function loadRegistry(path = REGISTRY_PATH) {
  if (!existsSync(path)) return emptyRegistry();
  try {
    const raw = readFileSync(path, 'utf8');
    const data = JSON.parse(raw);
    if (!data.version || !data.buddies) return emptyRegistry();
    return data;
  } catch {
    return emptyRegistry();
  }
}

export function saveRegistry(registry, path = REGISTRY_PATH) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = path + '.tmp.' + randomUUID().slice(0, 8);
  writeFileSync(tmp, JSON.stringify(registry, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
}

// ── CRUD Operations ──────────────────────────────────────────────

/**
 * Add a buddy to the registry.
 * @param {object} opts
 * @param {string} opts.phone - Phone number (primary key)
 * @param {string} opts.name - Display name
 * @param {string} opts.xmtpAddress - XMTP wallet address
 * @param {string} opts.agentId - OpenClaw agent ID
 * @param {string} [opts.trustProfile='personal'] - Trust profile
 * @param {string} [opts.hostAgentId='buddy-host'] - Host agent ID
 * @param {object} [opts.channelIds] - Channel-specific IDs
 * @param {string} [opts.registryPath] - Override registry path
 * @returns {object} The added buddy entry
 */
export function addBuddy(opts) {
  const { phone, name, xmtpAddress, agentId, trustProfile = 'personal',
          hostAgentId = 'buddy-host', channelIds, registryPath } = opts;
  const path = registryPath || REGISTRY_PATH;

  if (!phone || typeof phone !== 'string') throw new Error('phone is required and must be a string');
  if (!name || typeof name !== 'string') throw new Error('name is required and must be a string');
  if (!xmtpAddress || typeof xmtpAddress !== 'string') throw new Error('xmtpAddress is required and must be a string');
  if (!agentId || typeof agentId !== 'string') throw new Error('agentId is required and must be a string');

  acquireLock(path);
  try {

  const validProfiles = ['public', 'business', 'personal', 'financial', 'full'];
  if (!validProfiles.includes(trustProfile)) {
    throw new Error(`trustProfile must be one of: ${validProfiles.join(', ')}`);
  }

  const registry = loadRegistry(path);

  if (registry.buddies[phone]) {
    throw new Error(`buddy already registered for phone ${phone}`);
  }

  // Check for duplicate xmtpAddress or agentId
  for (const [existingPhone, buddy] of Object.entries(registry.buddies)) {
    if (buddy.xmtpAddress === xmtpAddress) {
      throw new Error(`xmtpAddress ${xmtpAddress} already registered to ${existingPhone}`);
    }
    if (buddy.agentId === agentId) {
      throw new Error(`agentId ${agentId} already registered to ${existingPhone}`);
    }
  }

  const entry = {
    name,
    xmtpAddress,
    agentId,
    channelIds: channelIds || { signal: phone, whatsapp: phone },
    trustProfile,
    provisionedAt: new Date().toISOString(),
    hostAgentId,
    status: 'active'
  };

  registry.buddies[phone] = entry;
  saveRegistry(registry, path);
  return entry;
  } finally {
    releaseLock(path);
  }
}

/**
 * Remove a buddy from the registry.
 * @param {string} phone - Phone number
 * @param {string} [registryPath] - Override registry path
 * @returns {object|null} The removed entry, or null if not found
 */
export function removeBuddy(phone, registryPath) {
  const path = registryPath || REGISTRY_PATH;
  acquireLock(path);
  try {
    const registry = loadRegistry(path);
    const entry = registry.buddies[phone];
    if (!entry) return null;
    delete registry.buddies[phone];
    saveRegistry(registry, path);
    return entry;
  } finally {
    releaseLock(path);
  }
}

/**
 * Lookup by phone number.
 * @param {string} phone
 * @param {string} [registryPath]
 * @returns {object|null} { phone, ...entry } or null
 */
export function lookupByPhone(phone, registryPath) {
  const registry = loadRegistry(registryPath || REGISTRY_PATH);
  const entry = registry.buddies[phone];
  return entry ? { phone, ...entry } : null;
}

/**
 * Lookup by XMTP address.
 * @param {string} xmtpAddress
 * @param {string} [registryPath]
 * @returns {object|null} { phone, ...entry } or null
 */
export function lookupByXmtp(xmtpAddress, registryPath) {
  const registry = loadRegistry(registryPath || REGISTRY_PATH);
  for (const [phone, entry] of Object.entries(registry.buddies)) {
    if (entry.xmtpAddress === xmtpAddress) return { phone, ...entry };
  }
  return null;
}

/**
 * Lookup by agent ID.
 * @param {string} agentId
 * @param {string} [registryPath]
 * @returns {object|null} { phone, ...entry } or null
 */
export function lookupByAgentId(agentId, registryPath) {
  const registry = loadRegistry(registryPath || REGISTRY_PATH);
  for (const [phone, entry] of Object.entries(registry.buddies)) {
    if (entry.agentId === agentId) return { phone, ...entry };
  }
  return null;
}

/**
 * List all buddies.
 * @param {string} [registryPath]
 * @returns {Array<{phone, ...entry}>}
 */
export function listBuddies(registryPath) {
  const registry = loadRegistry(registryPath || REGISTRY_PATH);
  return Object.entries(registry.buddies).map(([phone, entry]) => ({ phone, ...entry }));
}

/**
 * Export the full registry as JSON string.
 * @param {string} [registryPath]
 * @returns {string}
 */
export function exportRegistry(registryPath) {
  const registry = loadRegistry(registryPath || REGISTRY_PATH);
  return JSON.stringify(registry, null, 2);
}

/**
 * Import a registry from JSON string, merging with existing.
 * Existing entries are NOT overwritten — only new phones are added.
 * @param {string} json
 * @param {string} [registryPath]
 * @returns {{ added: number, skipped: number }}
 */
export function importRegistry(json, registryPath) {
  const path = registryPath || REGISTRY_PATH;
  const incoming = JSON.parse(json);
  if (!incoming.buddies || typeof incoming.buddies !== 'object') {
    throw new Error('Invalid registry format: missing buddies object');
  }

  acquireLock(path);
  try {
    const registry = loadRegistry(path);
    let added = 0;
    let skipped = 0;

    for (const [phone, entry] of Object.entries(incoming.buddies)) {
      if (registry.buddies[phone]) {
        skipped++;
      } else {
        registry.buddies[phone] = entry;
        added++;
      }
    }

    saveRegistry(registry, path);
    return { added, skipped };
  } finally {
    releaseLock(path);
  }
}

// ── CLI ──────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

function printUsage() {
  console.log(`buddy-registry — Local buddy bot registry

Commands:
  add      Register a new buddy
  remove   Deregister a buddy
  lookup   Find a buddy by phone, xmtp, or agent-id
  list     List all registered buddies
  export   Dump registry as JSON
  import   Load registry from file (merge, no overwrite)

Examples:
  node buddy-registry.mjs add --phone "+15125551234" --name "Alice" --xmtp "0xABC..." --agent-id alice
  node buddy-registry.mjs remove --phone "+15125551234"
  node buddy-registry.mjs lookup --phone "+15125551234"
  node buddy-registry.mjs lookup --xmtp "0xABC..."
  node buddy-registry.mjs lookup --agent-id alice
  node buddy-registry.mjs list
  node buddy-registry.mjs export
  node buddy-registry.mjs import --file backup.json`);
}

async function main() {
  const command = process.argv[2];
  const args = parseArgs(process.argv.slice(3));

  if (!command || command === '--help' || command === '-h') {
    printUsage();
    process.exit(0);
  }

  try {
    switch (command) {
      case 'add': {
        const entry = addBuddy({
          phone: args.phone,
          name: args.name,
          xmtpAddress: args.xmtp,
          agentId: args['agent-id'],
          trustProfile: args.trust || 'personal',
          hostAgentId: args['host-agent'] || 'buddy-host'
        });
        console.log(`✅ Added buddy: ${args.name} (${args.phone})`);
        console.log(JSON.stringify(entry, null, 2));
        break;
      }
      case 'remove': {
        if (!args.phone) { console.error('❌ --phone required'); process.exit(1); }
        const removed = removeBuddy(args.phone);
        if (removed) {
          console.log(`✅ Removed buddy: ${removed.name} (${args.phone})`);
        } else {
          console.log(`⚠️ No buddy found for ${args.phone}`);
          process.exit(1);
        }
        break;
      }
      case 'lookup': {
        let result = null;
        if (args.phone) result = lookupByPhone(args.phone);
        else if (args.xmtp) result = lookupByXmtp(args.xmtp);
        else if (args['agent-id']) result = lookupByAgentId(args['agent-id']);
        else { console.error('❌ Specify --phone, --xmtp, or --agent-id'); process.exit(1); }

        if (result) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log('⚠️ Not found');
          process.exit(1);
        }
        break;
      }
      case 'list': {
        const buddies = listBuddies();
        if (buddies.length === 0) {
          console.log('No buddies registered.');
        } else {
          console.log(`${buddies.length} buddy/buddies registered:\n`);
          for (const b of buddies) {
            console.log(`  ${b.name} (${b.phone}) → agent:${b.agentId} xmtp:${b.xmtpAddress.slice(0, 10)}... [${b.status}]`);
          }
        }
        break;
      }
      case 'export': {
        console.log(exportRegistry());
        break;
      }
      case 'import': {
        if (!args.file) { console.error('❌ --file required'); process.exit(1); }
        const json = readFileSync(args.file, 'utf8');
        const result = importRegistry(json);
        console.log(`✅ Imported: ${result.added} added, ${result.skipped} skipped (already exist)`);
        break;
      }
      default:
        console.error(`❌ Unknown command: ${command}`);
        printUsage();
        process.exit(1);
    }
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }
}

// Run CLI if executed directly
const isMain = process.argv[1] && fileURLToPath(import.meta.url).endsWith(process.argv[1].replace(/.*[\\/]/, ''));
if (isMain) {
  main().catch(err => { console.error(err); process.exit(1); });
}
