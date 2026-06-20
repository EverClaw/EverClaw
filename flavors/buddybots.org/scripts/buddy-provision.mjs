#!/usr/bin/env node
/**
 * buddy-provision.mjs — Dynamic Buddy Bot Provisioner
 *
 * Provisions a new buddy bot for a group member:
 *   1. Creates workspace (chmod 700) with templated SOUL/USER/AGENTS
 *   2. Generates XMTP identity via setup-identity.mjs
 *   3. Injects agent entry into openclaw.json
 *   4. Updates buddy registry (via buddy-registry.mjs)
 *   5. Registers peer in comms-guard peers.json
 *   6. Reloads OpenClaw (SIGUSR1)
 *
 * Usage:
 *   node scripts/buddy-provision.mjs --name "Alice" --phone "+15125551234" --trust personal
 *   node scripts/buddy-provision.mjs --remove alice
 *   node scripts/buddy-provision.mjs --status
 *   node scripts/buddy-provision.mjs --list
 *   node scripts/buddy-provision.mjs --dry-run --name "Bob" --phone "+15125555678"
 *
 * Dependencies: Node built-ins + buddy-registry.mjs + setup-identity.mjs
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, chmodSync, readdirSync, renameSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import {
  addBuddy,
  removeBuddy as registryRemoveBuddy,
  lookupByAgentId,
  lookupByPhone,
  listBuddies
} from './buddy-registry.mjs';

// ── Paths ────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const HOME = process.env.HOME || '';
const OPENCLAW_DIR = join(HOME, '.openclaw');
const EVERCLAW_DIR = join(HOME, '.everclaw');
const OPENCLAW_CONFIG = process.env.OPENCLAW_CONFIG || join(OPENCLAW_DIR, 'openclaw.json');
const TEMPLATES_DIR = join(REPO_ROOT, 'claw-repos', 'buddybots.org', 'templates');
const SETUP_IDENTITY = join(REPO_ROOT, 'skills', 'agent-chat', 'setup-identity.mjs');

const VALID_TRUST_PROFILES = ['public', 'business', 'personal', 'financial', 'full'];

// Default model config for buddy bots — lighter than host agent
const BUDDY_MODEL_CONFIG = {
  primary: 'ollama/gemma4-26b-q3',
  fallbacks: [
    'morpheus/glm-5',
    'ollama/qwen3.5:9b'
  ]
};

// ── Utilities ────────────────────────────────────────────────────

/**
 * Derive a safe agent ID from a human name.
 * "Alice" → "alice", "Bob Smith" → "bob-smith", "José María" → "jose-maria"
 */
export function deriveAgentId(name) {
  return name
    .normalize('NFD')                     // decompose accents
    .replace(/[\u0300-\u036f]/g, '')      // strip diacritical marks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')         // non-alphanum → hyphen
    .replace(/^-+|-+$/g, '')             // trim leading/trailing hyphens
    || 'buddy';                           // fallback if empty
}

/**
 * Get workspace path for an agent.
 */
function getWorkspacePath(agentId) {
  return join(OPENCLAW_DIR, `workspace-${agentId}`);
}

/**
 * Interpolate template variables in a string.
 */
function interpolate(template, vars) {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

/**
 * Read and parse openclaw.json. Returns the parsed config object.
 */
function readOpenClawConfig(configPath = OPENCLAW_CONFIG) {
  if (!existsSync(configPath)) {
    throw new Error(`OpenClaw config not found: ${configPath}`);
  }
  return JSON.parse(readFileSync(configPath, 'utf8'));
}

/**
 * Write openclaw.json atomically.
 */
function writeOpenClawConfig(config, configPath = OPENCLAW_CONFIG) {
  const tmp = configPath + '.tmp.' + randomUUID().slice(0, 8);
  writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, configPath);
}

/**
 * Atomically write peers.json (mirrors writeOpenClawConfig pattern).
 */
function writePeers(peers, peersPath = join(EVERCLAW_DIR, 'xmtp', 'peers.json')) {
  const dir = dirname(peersPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = peersPath + '.tmp.' + randomUUID().slice(0, 8);
  writeFileSync(tmp, JSON.stringify(peers, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, peersPath);
}

/**
 * Remove peer entry by agentId (DRY helper used by rollback + deprovision).
 */
function removePeerByAgentId(agentId, peersPath = join(EVERCLAW_DIR, 'xmtp', 'peers.json')) {
  if (!existsSync(peersPath)) return false;
  let peers;
  try {
    peers = JSON.parse(readFileSync(peersPath, 'utf8'));
  } catch (e) {
    throw new Error(`Corrupt peers.json: ${e.message}`);
  }
  let removed = false;
  if (peers.trusted) {
    for (const [addr, info] of Object.entries(peers.trusted)) {
      if (info && info.agentId === agentId) {
        delete peers.trusted[addr];
        removed = true;
      }
    }
  }
  if (removed) {
    writePeers(peers, peersPath);
    return true;
  }
  return false;
}

/**
 * Send SIGUSR1 to the OpenClaw gateway process to reload config.
 */
function reloadOpenClaw() {
  const pidFile = join(OPENCLAW_DIR, '.gateway.pid');
  if (existsSync(pidFile)) {
    try {
      const pid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
      if (!isNaN(pid) && pid > 0) {
        process.kill(pid, 'SIGUSR1');
        return true;
      }
    } catch {}
  }
  // Fallback: try pkill (non-fatal)
  try {
    execFileSync('pkill', ['-USR1', '-f', 'openclaw.*gateway'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// ── Provisioning Steps ───────────────────────────────────────────

/**
 * Step 1: Create workspace with templated files.
 */
function createWorkspace(agentId, vars) {
  const wsPath = getWorkspacePath(agentId);

  if (existsSync(wsPath)) {
    throw new Error(`Workspace already exists: ${wsPath}. Use --remove ${agentId} first.`);
  }

  mkdirSync(wsPath, { recursive: true, mode: 0o700 });
  mkdirSync(join(wsPath, 'memory'), { mode: 0o700 });

  // Template files
  const templateFiles = ['SOUL.md', 'USER.md', 'AGENTS.md'];
  for (const file of templateFiles) {
    const templatePath = join(TEMPLATES_DIR, file);
    if (existsSync(templatePath)) {
      const content = interpolate(readFileSync(templatePath, 'utf8'), vars);
      writeFileSync(join(wsPath, file), content, { encoding: 'utf8', mode: 0o600 });
    }
  }

  // Create empty MEMORY.md
  writeFileSync(join(wsPath, 'MEMORY.md'), `# MEMORY.md — ${vars.NAME}'s Buddy Bot\n\nLast updated: ${vars.DATE}\n\n---\n\nNew buddy bot. No memories yet.\n`, { encoding: 'utf8', mode: 0o600 });

  return wsPath;
}

/**
 * Step 2: Generate XMTP identity by calling setup-identity.mjs.
 * Returns the XMTP address from the identity file.
 */
function generateXmtpIdentity(agentId) {
  try {
    execFileSync('node', [SETUP_IDENTITY, '--agent-id', agentId], {
      stdio: 'pipe',
      cwd: dirname(SETUP_IDENTITY),
      timeout: 30_000
    });
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : '';
    const stdout = err.stdout ? err.stdout.toString() : '';
    throw new Error(`XMTP identity generation failed: ${stderr || stdout || err.message}`);
  }

  // Read the generated identity
  const identityPath = join(EVERCLAW_DIR, `xmtp-${agentId}`, 'identity.json');
  if (!existsSync(identityPath)) {
    throw new Error(`XMTP identity file not found after generation: ${identityPath}`);
  }
  const identity = JSON.parse(readFileSync(identityPath, 'utf8'));
  return identity.address;
}

/**
 * Step 3: Inject agent entry into openclaw.json.
 */
function injectAgent(agentId, name, wsPath, configPath = OPENCLAW_CONFIG) {
  const config = readOpenClawConfig(configPath);

  if (!config.agents) config.agents = {};
  if (!config.agents.list) config.agents.list = [];

  // Check for duplicate
  const existing = config.agents.list.find(a => a.id === agentId);
  if (existing) {
    throw new Error(`Agent '${agentId}' already exists in openclaw.json`);
  }

  const agentEntry = {
    id: agentId,
    name: `${name}'s Buddy Bot`,
    workspace: wsPath,
    model: { ...BUDDY_MODEL_CONFIG }
  };

  config.agents.list.push(agentEntry);
  writeOpenClawConfig(config, configPath);
  return agentEntry;
}

/**
 * Step 4: Update buddy registry.
 */
function updateRegistry(phone, name, xmtpAddress, agentId, trustProfile, registryPath) {
  return addBuddy({
    phone,
    name,
    xmtpAddress,
    agentId,
    trustProfile,
    hostAgentId: 'buddy-host',
    registryPath
  });
}

/**
 * Step 5: Register peer in comms-guard peers.json.
 */
function registerPeer(agentId, xmtpAddress) {
  const peersPath = join(EVERCLAW_DIR, 'xmtp', 'peers.json');
  let peers = {};

  if (existsSync(peersPath)) {
    try {
      peers = JSON.parse(readFileSync(peersPath, 'utf8'));
    } catch { /* start fresh if corrupt */ }
  }

  if (!peers.trusted) peers.trusted = {};

  peers.trusted[xmtpAddress] = {
    agentId,
    addedAt: new Date().toISOString(),
    addedBy: 'buddy-provision',
    autoTrusted: true
  };

  writePeers(peers, peersPath);
}

// ── Rollback ─────────────────────────────────────────────────────

/**
 * Undo partial provisioning on failure.
 */
function rollback(agentId, steps, { configPath, registryPath } = {}) {
  const errors = [];

  if (steps.includes('workspace')) {
    try {
      const wsPath = getWorkspacePath(agentId);
      if (existsSync(wsPath)) rmSync(wsPath, { recursive: true, force: true });
    } catch (e) { errors.push(`workspace cleanup: ${e.message}`); }
  }

  if (steps.includes('xmtp')) {
    try {
      const xmtpDir = join(EVERCLAW_DIR, `xmtp-${agentId}`);
      if (existsSync(xmtpDir)) rmSync(xmtpDir, { recursive: true, force: true });
    } catch (e) { errors.push(`xmtp cleanup: ${e.message}`); }
  }

  if (steps.includes('config')) {
    try {
      const path = configPath || OPENCLAW_CONFIG;
      const config = readOpenClawConfig(path);
      config.agents.list = config.agents.list.filter(a => a.id !== agentId);
      writeOpenClawConfig(config, path);
    } catch (e) { errors.push(`config cleanup: ${e.message}`); }
  }

  if (steps.includes('registry')) {
    try {
      const entry = lookupByAgentId(agentId, registryPath);
      if (entry && entry.phone) {
        registryRemoveBuddy(entry.phone, registryPath);
      }
    } catch (e) { errors.push(`registry cleanup: ${e.message}`); }
  }

  if (steps.includes('peers')) {
    try {
      removePeerByAgentId(agentId);
    } catch (e) { errors.push(`peers cleanup: ${e.message}`); }
  }

  // Reload OpenClaw to pick up the removals
  try {
    reloadOpenClaw();
  } catch { /* non-fatal */ }

  return errors;
}

// ── Main Provision ───────────────────────────────────────────────

/**
 * Provision a new buddy bot. Performs all 6 steps with rollback on failure.
 *
 * @param {object} opts
 * @param {string} opts.name - Human's name
 * @param {string} opts.phone - Phone number
 * @param {string} [opts.trustProfile='personal'] - Trust profile
 * @param {string} [opts.agentId] - Override derived agent ID
 * @param {boolean} [opts.dryRun=false] - Print plan without executing
 * @param {string} [opts.configPath] - Override openclaw.json path
 * @param {string} [opts.registryPath] - Override buddy registry path
 * @returns {object} Provision result with all details
 */
export function provision(opts) {
  const { name, phone, trustProfile = 'personal', dryRun = false, configPath, registryPath } = opts;

  // Validation
  if (!name || typeof name !== 'string') throw new Error('--name is required');
  if (!phone || typeof phone !== 'string') throw new Error('--phone is required');
  if (!VALID_TRUST_PROFILES.includes(trustProfile)) {
    throw new Error(`--trust must be one of: ${VALID_TRUST_PROFILES.join(', ')}`);
  }

  const agentId = opts.agentId || deriveAgentId(name);
  const wsPath = getWorkspacePath(agentId);

  // Check for conflicts before doing anything
  if (existsSync(wsPath)) {
    throw new Error(`Workspace already exists: ${wsPath}. Use --remove ${agentId} first.`);
  }

  const existingByPhone = lookupByPhone(phone, registryPath);
  if (existingByPhone) {
    throw new Error(`Phone ${phone} already registered to agent '${existingByPhone.agentId}'`);
  }

  const existingByAgent = lookupByAgentId(agentId, registryPath);
  if (existingByAgent) {
    throw new Error(`Agent ID '${agentId}' already registered to phone ${existingByAgent.phone}`);
  }

  const plan = {
    agentId,
    name,
    phone,
    trustProfile,
    workspace: wsPath,
    xmtpDir: join(EVERCLAW_DIR, `xmtp-${agentId}`),
    steps: [
      '1. Create workspace with templated SOUL/USER/AGENTS',
      '2. Generate XMTP identity',
      '3. Inject agent into openclaw.json',
      '4. Update buddy registry',
      '5. Register peer in comms-guard',
      '6. Reload OpenClaw (SIGUSR1)'
    ]
  };

  if (dryRun) {
    return { dryRun: true, ...plan };
  }

  // Execute steps with rollback tracking
  const completedSteps = [];
  const templateVars = {
    NAME: name,
    PHONE: phone,
    TRUST_PROFILE: trustProfile,
    AGENT_ID: agentId,
    DATE: new Date().toISOString().split('T')[0]
  };

  try {
    // Step 1: Create workspace
    createWorkspace(agentId, templateVars);
    completedSteps.push('workspace');

    // Step 2: Generate XMTP identity
    const xmtpAddress = generateXmtpIdentity(agentId);
    completedSteps.push('xmtp');

    // Step 3: Inject into openclaw.json
    const agentEntry = injectAgent(agentId, name, wsPath, configPath);
    completedSteps.push('config');

    // Step 4: Update buddy registry
    const registryEntry = updateRegistry(phone, name, xmtpAddress, agentId, trustProfile, registryPath);
    completedSteps.push('registry');

    // Step 5: Register comms-guard peer
    registerPeer(agentId, xmtpAddress);
    completedSteps.push('peers');

    // Step 6: Reload OpenClaw
    const reloaded = reloadOpenClaw();

    return {
      success: true,
      agentId,
      name,
      phone,
      trustProfile,
      workspace: wsPath,
      xmtpAddress,
      reloaded,
      registryEntry,
      agentEntry
    };
  } catch (err) {
    // Rollback completed steps
    const rollbackErrors = rollback(agentId, completedSteps, { configPath, registryPath });
    const msg = `Provisioning failed at step ${completedSteps.length + 1}: ${err.message}`;
    if (rollbackErrors.length > 0) {
      throw new Error(`${msg}\nRollback errors: ${rollbackErrors.join('; ')}`);
    }
    throw new Error(`${msg} (rolled back ${completedSteps.length} steps)`);
  }
}

// ── Remove ───────────────────────────────────────────────────────

/**
 * Remove a provisioned buddy bot. Undoes all provisioning steps.
 *
 * @param {string} agentId - Agent ID to remove
 * @param {object} [opts] - Options
 * @param {string} [opts.configPath] - Override openclaw.json path
 * @param {string} [opts.registryPath] - Override buddy registry path
 * @returns {object} Removal result
 */
export function deprovision(agentId, opts = {}) {
  const { configPath, registryPath } = opts;

  if (!agentId || typeof agentId !== 'string') {
    throw new Error('Agent ID is required for removal');
  }

  const results = {
    agentId,
    removed: [],
    errors: []
  };

  // 1. Remove from buddy registry (by agentId lookup → get phone → remove)
  try {
    const entry = lookupByAgentId(agentId, registryPath);
    if (entry) {
      registryRemoveBuddy(entry.phone, registryPath);
      results.removed.push('registry');
    }
  } catch (e) { results.errors.push(`registry: ${e.message}`); }

  // 2. Remove from openclaw.json
  try {
    const path = configPath || OPENCLAW_CONFIG;
    if (existsSync(path)) {
      const config = readOpenClawConfig(path);
      const before = config.agents?.list?.length || 0;
      if (config.agents?.list) {
        config.agents.list = config.agents.list.filter(a => a.id !== agentId);
      }
      if ((config.agents?.list?.length || 0) < before) {
        writeOpenClawConfig(config, path);
        results.removed.push('config');
      }
    }
  } catch (e) { results.errors.push(`config: ${e.message}`); }

  // 3. Remove from comms-guard peers
  try {
    if (removePeerByAgentId(agentId)) {
      results.removed.push('peers');
    }
  } catch (e) { results.errors.push(`peers: ${e.message}`); }

  // 4. Remove XMTP identity directory
  try {
    const xmtpDir = join(EVERCLAW_DIR, `xmtp-${agentId}`);
    if (existsSync(xmtpDir)) {
      rmSync(xmtpDir, { recursive: true, force: true });
      results.removed.push('xmtp');
    }
  } catch (e) { results.errors.push(`xmtp: ${e.message}`); }

  // 5. Remove workspace
  try {
    const wsPath = getWorkspacePath(agentId);
    if (existsSync(wsPath)) {
      rmSync(wsPath, { recursive: true, force: true });
      results.removed.push('workspace');
    }
  } catch (e) { results.errors.push(`workspace: ${e.message}`); }

  // 6. Reload OpenClaw
  results.reloaded = reloadOpenClaw();

  return results;
}

// ── CLI ──────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--name' && argv[i + 1]) args.name = argv[++i];
    else if (arg === '--phone' && argv[i + 1]) args.phone = argv[++i];
    else if (arg === '--trust' && argv[i + 1]) args.trustProfile = argv[++i];
    else if (arg === '--agent-id' && argv[i + 1]) args.agentId = argv[++i];
    else if (arg === '--remove' && argv[i + 1]) args.remove = argv[++i];
    else if (arg === '--config' && argv[i + 1]) args.configPath = argv[++i];
    else if (arg === '--registry' && argv[i + 1]) args.registryPath = argv[++i];
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--status') args.status = true;
    else if (arg === '--list') args.list = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
  }
  return args;
}

function showHelp() {
  console.log(`
🤝 Buddy Bot Provisioner

Usage:
  buddy-provision --name <n> --phone <p> [--trust <t>] [--agent-id <id>] [--dry-run]
  buddy-provision --remove <agent-id>
  buddy-provision --status
  buddy-provision --list

Provision options:
  --name <name>       Human's name (local only, never on-chain)
  --phone <phone>     Phone number or user ID
  --trust <profile>   Trust profile: public, business, personal, financial, full (default: personal)
  --agent-id <id>     Override auto-derived agent ID
  --dry-run           Print plan without executing

Management:
  --remove <id>       Remove a provisioned buddy bot (cleans up everything)
  --status            Show provisioner status and buddy count
  --list              List all provisioned buddy bots

Advanced:
  --config <path>     Override openclaw.json path
  --registry <path>   Override buddy registry path
  --help              Show this help
  `);
}

function cmdStatus(args) {
  const buddies = listBuddies(args.registryPath);
  console.log('🤝 Buddy Bots Provisioner');
  console.log(`   Provisioned bots: ${buddies.length}`);
  console.log(`   Registry: ${args.registryPath || '~/.everclaw/buddy-registry.json'}`);
  console.log(`   Config: ${args.configPath || '~/.openclaw/openclaw.json'}`);
  if (buddies.length > 0) {
    console.log(`   Active: ${buddies.filter(b => b.status === 'active').length}`);
  }
}

function cmdList(args) {
  const buddies = listBuddies(args.registryPath);
  if (buddies.length === 0) {
    console.log('No buddy bots provisioned yet.');
    return;
  }
  console.log(`🤝 ${buddies.length} buddy bot(s):\n`);
  for (const b of buddies) {
    console.log(`  ${b.agentId} — ${b.name} (${b.phone})`);
    console.log(`    Trust: ${b.trustProfile} | Status: ${b.status} | XMTP: ${b.xmtpAddress?.slice(0, 10)}...`);
  }
}

function cmdProvision(args) {
  const result = provision(args);

  if (result.dryRun) {
    console.log('🧪 DRY RUN — no changes made\n');
    console.log(`  Agent ID:     ${result.agentId}`);
    console.log(`  Name:         ${result.name}`);
    console.log(`  Phone:        ${result.phone}`);
    console.log(`  Trust:        ${result.trustProfile}`);
    console.log(`  Workspace:    ${result.workspace}`);
    console.log(`  XMTP dir:     ${result.xmtpDir}`);
    console.log(`\n  Steps:`);
    for (const step of result.steps) {
      console.log(`    ${step}`);
    }
    return;
  }

  console.log(`✅ Buddy bot provisioned!\n`);
  console.log(`  Agent ID:     ${result.agentId}`);
  console.log(`  Name:         ${result.name}`);
  console.log(`  Phone:        ${result.phone}`);
  console.log(`  Trust:        ${result.trustProfile}`);
  console.log(`  XMTP Address: ${result.xmtpAddress}`);
  console.log(`  Workspace:    ${result.workspace}`);
  console.log(`  Reloaded:     ${result.reloaded ? 'yes' : 'no (manual SIGUSR1 needed)'}`);
}

function cmdRemove(args) {
  const result = deprovision(args.remove, {
    configPath: args.configPath,
    registryPath: args.registryPath
  });

  if (result.removed.length === 0 && result.errors.length === 0) {
    console.log(`⚠️  Agent '${args.remove}' not found in any registry.`);
    return;
  }

  console.log(`🗑️  Removed buddy bot '${args.remove}':\n`);
  for (const step of result.removed) {
    console.log(`  ✅ ${step}`);
  }
  for (const err of result.errors) {
    console.log(`  ❌ ${err}`);
  }
  console.log(`\n  Reloaded: ${result.reloaded ? 'yes' : 'no'}`);
}

// ── Entry Point ──────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) { showHelp(); return; }
  if (args.status) { cmdStatus(args); return; }
  if (args.list) { cmdList(args); return; }
  if (args.remove) { cmdRemove(args); return; }
  if (args.name && args.phone) { cmdProvision(args); return; }

  console.error('❌ Missing required arguments. Run with --help for usage.');
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }
}
