#!/usr/bin/env node
/**
 * buddy-host.mjs — Buddy Host Agent: Auto-Provisioning on Group Creation
 *
 * Gap 5 of the Buddy Bots architecture (v4).
 *
 * When a user creates a group chat and adds the Buddy Host Agent + friends,
 * automatically provisions a buddy bot for each friend and wires them over XMTP.
 *
 * Trigger modes:
 *   - Auto:    First message in an untracked group → auto-provision all members
 *   - Command: `/buddy provision` in any group → (re-)provision missing members
 *   - Add:     `/buddy add` when new members join later
 *
 * CLI:
 *   node buddy-host.mjs --event '{"groupId":"...","members":[...]}'
 *   node buddy-host.mjs --provision <groupId> --members '+15125551234,+15125555678' --channel signal
 *   node buddy-host.mjs --status
 *   node buddy-host.mjs --list-groups
 *   node buddy-host.mjs --group-status <groupId>
 *   node buddy-host.mjs --dry-run --provision <groupId> --members '...'
 *
 * Library:
 *   import { handleGroupMessage, provisionGroup, addMember, getGroupStatus, listTrackedGroups } from './buddy-host.mjs';
 *
 * Dependencies: Node built-ins + buddy-provision.mjs + buddy-registry.mjs
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, rmdirSync, statSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { platform } from 'node:os';

import { provision, deprovision, deriveAgentId } from './buddy-provision.mjs';
import { lookupByPhone, listBuddies as registryListBuddies } from './buddy-registry.mjs';

// ── Paths ────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const HOME = process.env.HOME || '';
const EVERCLAW_DIR = join(HOME, '.everclaw');
const GROUPS_FILE = process.env.BUDDY_GROUPS_PATH || join(EVERCLAW_DIR, 'buddy-groups.json');

const CURRENT_VERSION = 1;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_STALE_MS = 60_000;

// ── Validation ───────────────────────────────────────────────────

/**
 * Validate E.164 phone number format.
 * @param {string} phone
 * @returns {boolean}
 */
export function isValidE164(phone) {
  return typeof phone === 'string' && /^\+[1-9]\d{1,14}$/.test(phone);
}

// ── Host agent's own phone/identifier (excluded from provisioning) ──

const HOST_PHONES = new Set(
  (process.env.BUDDY_HOST_PHONES || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
);

// ── File Lock (mkdir-based, matches buddy-registry.mjs pattern) ───

/**
 * Acquire an advisory lock on a file path.
 * Uses mkdir (atomic on POSIX) with stale-lock detection.
 * @param {string} filePath — The file to lock.
 * @returns {Function} Release function.
 */
function acquireLock(filePath) {
  const lockPath = filePath + '.lock';
  const parentDir = dirname(lockPath);
  mkdirSync(parentDir, { recursive: true, mode: 0o700 });

  const start = Date.now();
  while (true) {
    try {
      mkdirSync(lockPath);
      writeFileSync(join(lockPath, 'timestamp'), Date.now().toString());
      return () => {
        try {
          const tsFile = join(lockPath, 'timestamp');
          if (existsSync(tsFile)) unlinkSync(tsFile);
          rmdirSync(lockPath);
        } catch { /* best-effort cleanup */ }
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // Check for stale lock
      try {
        const tsStr = readFileSync(join(lockPath, 'timestamp'), 'utf8').trim();
        const lockAge = Date.now() - Number(tsStr);
        if (!isNaN(lockAge) && lockAge > LOCK_STALE_MS) {
          try { rmdirSync(lockPath, { recursive: true }); } catch { /* ignore */ }
          continue;
        }
      } catch {
        try {
          const lockStat = statSync(lockPath);
          if (Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
            try { rmdirSync(lockPath, { recursive: true }); } catch { /* ignore */ }
            continue;
          }
        } catch { /* ignore */ }
      }
      if (Date.now() - start > LOCK_TIMEOUT_MS) {
        throw new Error(`[buddy-host] Lock timeout after ${LOCK_TIMEOUT_MS}ms on ${lockPath}`);
      }
      // Back off without tight CPU spin (exponential 10–100ms with jitter)
      const backoff = Math.min(100, 10 * Math.pow(2, Math.floor(Math.random() * 4)));
      const deadline = Date.now() + backoff;
      while (Date.now() < deadline) { /* intentional sync backoff; event loop blocked by lock */ }
    }
  }
}

// ── Group State Persistence ──────────────────────────────────────

/**
 * Load tracked groups from disk.
 * @param {string} [groupsPath] — Override path for testing.
 * @returns {{ version: number, groups: Object }}
 */
export function loadGroups(groupsPath = GROUPS_FILE) {
  if (!existsSync(groupsPath)) {
    return { version: CURRENT_VERSION, groups: {} };
  }
  try {
    const data = JSON.parse(readFileSync(groupsPath, 'utf8'));
    if (typeof data !== 'object' || data === null) {
      console.error('[buddy-host] Invalid groups file: not an object');
      return { version: CURRENT_VERSION, groups: {} };
    }
    return {
      version: data.version || CURRENT_VERSION,
      groups: data.groups || {}
    };
  } catch (err) {
    console.error('[buddy-host] Failed to load groups:', err.message);
    return { version: CURRENT_VERSION, groups: {} };
  }
}

/**
 * Save tracked groups atomically.
 * @param {object} state — Full state object { version, groups }.
 * @param {string} [groupsPath] — Override path for testing.
 */
export function saveGroups(state, groupsPath = GROUPS_FILE) {
  const dir = dirname(groupsPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = groupsPath + '.tmp.' + randomUUID().slice(0, 8);
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, groupsPath);
}

// ── Contact Lookup ───────────────────────────────────────────────

/**
 * Resolve a phone number to a contact name via macOS Contacts.
 * Falls back to null if not on macOS or Contacts unavailable.
 *
 * @param {string} phone — E.164 phone number (e.g. "+15125551234").
 * @returns {{ name: string|null, relationship: string|null, source: string }}
 */
export function resolveContact(phone) {
  if (platform() !== 'darwin') {
    return { name: null, relationship: null, source: 'unavailable' };
  }

  // Strategy 1: `contacts` CLI (HomeBrew contacts-cli)
  try {
    const output = execFileSync('contacts', ['-Sf', '%p\t%n'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5_000,
      encoding: 'utf8'
    });
    // Each line: phone\tname — find matching phone
    const normalPhone = phone.replace(/[\s\-\(\)]/g, '');
    for (const line of output.split('\n')) {
      const [contactPhone, contactName] = line.split('\t');
      if (!contactPhone || !contactName) continue;
      const normalContactPhone = contactPhone.replace(/[\s\-\(\)]/g, '');
      if (normalContactPhone === normalPhone || normalContactPhone.endsWith(normalPhone.slice(-10))) {
        return { name: contactName.trim(), relationship: null, source: 'contacts-cli' };
      }
    }
  } catch {
    // contacts CLI not installed or failed — try AppleScript
  }

  // Strategy 2: AppleScript (always available on macOS)
  // Only run AppleScript with validated E.164 phones (digits + plus only = no injection risk)
  if (!isValidE164(phone)) {
    console.warn('[buddy-host] Refusing AppleScript lookup on non-E.164 phone');
    return { name: null, relationship: null, source: 'invalid-phone' };
  }

  try {
    const script = `tell application "Contacts"
      set theNames to name of every person whose value of phones contains "${phone}"
      if theNames is not {} then return item 1 of theNames
      return "missing value"
    end tell`;
    const output = execFileSync('osascript', ['-e', script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10_000,
      encoding: 'utf8'
    });
    const name = output.trim();
    if (name && name !== '' && name !== 'missing value') {
      return { name: name.trim(), relationship: null, source: 'applescript' };
    }
  } catch (err) {
    console.warn('[buddy-host] AppleScript contact lookup failed:', err.message);
  }

  return { name: null, relationship: null, source: 'not-found' };
}

/**
 * Infer trust profile from contact data.
 * Checks both relationship field (when available from enriched contacts)
 * and contact name as fallback (works with current resolveContact output).
 * Conservative default: 'public'.
 *
 * @param {{ name: string|null, relationship: string|null, source: string }} contact
 * @returns {string} Trust profile: public | business | personal
 */
export function inferTrustProfile(contact) {
  if (!contact) return 'public';

  // Use relationship if available (future enrichment), fall back to name
  const text = (contact.relationship || contact.name || '').toLowerCase();
  if (!text) return 'public';

  // Work/business → business (check BEFORE family to avoid "business partner" matching family)
  if (/\b(colleague|coworker|co-worker|work|boss|manager|employee|client|business)\b/.test(text)) {
    return 'business';
  }

  // Family → personal
  if (/\b(parent|mother|father|mom|dad|sibling|brother|sister|child|son|daughter|spouse|wife|husband|partner|family)\b/.test(text)) {
    return 'personal';
  }

  // Friend → personal
  if (/\b(friend|buddy|pal)\b/.test(text)) {
    return 'personal';
  }

  return 'public';
}

// ── Member Extraction ────────────────────────────────────────────

/**
 * Extract member identifiers from an event payload.
 * Handles multiple formats:
 *   - { members: ["+1...", "+2..."] } (array of phone strings)
 *   - { members: [{ phone: "+1...", name: "Alice" }] } (array of objects)
 *   - { participants: [...] } (alternative key)
 *
 * @param {object} event — Inbound event payload.
 * @returns {Array<{ phone: string, name: string|null }>}
 */
export function extractMembers(event) {
  const rawMembers = event.members || event.participants || [];

  if (!Array.isArray(rawMembers) || rawMembers.length === 0) {
    return [];
  }

  const members = [];
  for (const m of rawMembers) {
    let phone = null;
    let name = null;
    if (typeof m === 'string') {
      phone = m.trim();
    } else if (m && typeof m === 'object' && typeof m.phone === 'string') {
      phone = m.phone.trim();
      name = m.name || null;
    }
    // Only include valid E.164 phone numbers
    if (phone && isValidE164(phone)) {
      members.push({ phone, name });
    } else if (phone) {
      console.warn(`[buddy-host] Skipping invalid phone: ${phone}`);
    }
    // Skip non-phone items silently
  }

  return members;
}

/**
 * Filter out the host agent's own phone(s) and already-provisioned members.
 *
 * @param {Array<{ phone: string, name: string|null }>} members
 * @param {string[]} hostPhones — Host agent phone numbers to exclude.
 * @param {string} [registryPath] — Override for testing.
 * @returns {Array<{ phone: string, name: string|null, existing: boolean }>}
 */
export function filterMembers(members, hostPhones = HOST_PHONES, registryPath) {
  // Support both Set and Array for hostPhones
  const hostSet = hostPhones instanceof Set ? hostPhones : new Set(hostPhones);
  const result = [];
  for (const m of members) {
    // Skip host agent
    if (hostSet.has(m.phone)) continue;

    // Check if already provisioned
    const existing = lookupByPhone(m.phone, registryPath);
    if (existing) {
      result.push({ ...m, existing: true, agentId: existing.agentId });
    } else {
      result.push({ ...m, existing: false });
    }
  }
  return result;
}

// ── Group Provisioning ───────────────────────────────────────────

/**
 * Provision buddy bots for all new members in a group.
 *
 * @param {object} opts
 * @param {string} opts.groupId — Group identifier.
 * @param {string} opts.channel — Channel name (signal, whatsapp, telegram, etc.).
 * @param {Array<{ phone: string, name: string|null }>} opts.members — Group members.
 * @param {string} [opts.groupName] — Human-readable group name.
 * @param {string} [opts.owner] — Phone/ID of the group creator.
 * @param {boolean} [opts.autoProvision=true] — Enable auto-provisioning for future members.
 * @param {boolean} [opts.dryRun=false] — Print plan without executing.
 * @param {string} [opts.configPath] — Override openclaw.json path.
 * @param {string} [opts.registryPath] — Override buddy registry path.
 * @param {string} [opts.groupsPath] — Override buddy-groups.json path.
 * @returns {{ groupId: string, provisioned: object[], skipped: object[], errors: object[], dryRun: boolean }}
 */
export function provisionGroup(opts) {
  const {
    groupId,
    channel,
    members,
    groupName,
    owner,
    autoProvision = true,
    dryRun = false,
    configPath,
    registryPath,
    groupsPath
  } = opts;

  if (!groupId || typeof groupId !== 'string') {
    throw new Error('groupId is required');
  }
  if (!channel || typeof channel !== 'string') {
    throw new Error('channel is required');
  }
  if (!Array.isArray(members) || members.length === 0) {
    throw new Error('members array is required and must not be empty');
  }

  // ── Short lock 1: decide what still needs provisioning ──────────────
  const groupsFile = groupsPath || GROUPS_FILE;
  let newMembers = [];
  let existingMembers = [];
  let skippedHostCount = 0;

  const releaseCheck = acquireLock(groupsFile);
  try {
    const state = loadGroups(groupsPath);
    const alreadyTracked = new Set(
      Object.keys(state.groups[groupId]?.members || {})
    );
    const filtered = filterMembers(members, HOST_PHONES, registryPath);
    skippedHostCount = members.length - filtered.length;
    newMembers = filtered.filter(m => !m.existing && !alreadyTracked.has(m.phone));
    existingMembers = filtered.filter(m => m.existing || alreadyTracked.has(m.phone));
  } finally {
    releaseCheck();
  }

  if (dryRun) {
    return {
      groupId,
      channel,
      dryRun: true,
      total: members.length,
      toProvision: newMembers.map(m => ({
        phone: m.phone,
        name: m.name || '(will resolve from contacts)',
        agentId: deriveAgentId(m.name || m.phone.slice(-4))
      })),
      alreadyProvisioned: existingMembers.map(m => ({
        phone: m.phone,
        agentId: m.agentId
      })),
      skippedHost: skippedHostCount
    };
  }

  // ── Expensive work outside lock ────────────────────────────────────
  const provisioned = [];
  const skipped = [];
  const errors = [];

  // Provision each new member sequentially (avoids race conditions on config files)
  for (const member of newMembers) {
    let name = member.name;
    let trustProfile = 'public';

    // Resolve contact info if name not provided
    if (!name) {
      const contact = resolveContact(member.phone);
      name = contact.name || member.phone.slice(-4); // Last 4 digits as fallback
      trustProfile = inferTrustProfile(contact);
    }

    try {
      const result = provision({
        name,
        phone: member.phone,
        trustProfile,
        dryRun: false,
        configPath,
        registryPath
      });

      provisioned.push({
        phone: member.phone,
        name,
        agentId: result.agentId,
        xmtpAddress: result.xmtpAddress,
        trustProfile
      });
    } catch (err) {
      errors.push({
        phone: member.phone,
        name,
        error: err.message
      });
    }
  }

  // Track existing members as skipped
  for (const member of existingMembers) {
    skipped.push({
      phone: member.phone,
      agentId: member.agentId,
      reason: 'already-provisioned'
    });
  }

  // ── Short lock 2: re-check then atomic update ────────────────────
  const releaseUpdate = acquireLock(groupsFile);
  try {
    const state = loadGroups(groupsPath);
    const groupEntry = state.groups[groupId] || {
      id: groupId,
      channel,
      name: groupName || groupId,
      createdAt: new Date().toISOString(),
      owner: owner || null,
      members: {},
      autoProvision
    };

    // Add newly provisioned members (skip if already added by concurrent process)
    for (const p of provisioned) {
      if (!groupEntry.members[p.phone]) {
        groupEntry.members[p.phone] = {
          agentId: p.agentId,
          status: 'active',
          provisionedAt: new Date().toISOString()
        };
      }
    }

    // Track existing members that were already there
    for (const s of skipped) {
      if (!groupEntry.members[s.phone]) {
        groupEntry.members[s.phone] = {
          agentId: s.agentId,
          status: 'active',
          provisionedAt: 'pre-existing'
        };
      }
    }

    state.groups[groupId] = groupEntry;
    saveGroups(state, groupsPath);
  } finally {
    releaseUpdate();
  }

  return {
    groupId,
    channel,
    dryRun: false,
    provisioned,
    skipped,
    errors
  };
}

/**
 * Add a single new member to an existing tracked group.
 *
 * @param {object} opts
 * @param {string} opts.groupId — Group identifier.
 * @param {{ phone: string, name?: string }} opts.member — New member.
 * @param {boolean} [opts.dryRun=false]
 * @param {string} [opts.configPath]
 * @param {string} [opts.registryPath]
 * @param {string} [opts.groupsPath]
 * @returns {object} Provision result for the single member.
 */
export function addMember(opts) {
  const { groupId, member, dryRun = false, configPath, registryPath, groupsPath } = opts;

  if (!groupId) throw new Error('groupId is required');
  if (!member || !member.phone) throw new Error('member.phone is required');

  // E.164 validation (before any AppleScript or provisioning)
  if (!isValidE164(member.phone)) {
    throw new Error(`Invalid E.164 phone number: ${member.phone}`);
  }

  const groupsFile = groupsPath || GROUPS_FILE;

  // ── Short lock 1: verify group exists & member not already tracked ──
  const releaseCheck = acquireLock(groupsFile);
  try {
    const state = loadGroups(groupsPath);
    const group = state.groups[groupId];
    if (!group) {
      throw new Error(`Group '${groupId}' not tracked. Use provisionGroup first.`);
    }
    if (group.members[member.phone]) {
      return {
        groupId,
        skipped: true,
        reason: 'already-in-group',
        agentId: group.members[member.phone].agentId
      };
    }
  } finally {
    releaseCheck();
  }

  // ── Expensive work outside the lock ─────────────────────────────────
  let name = member.name;
  let trustProfile = 'public';
  if (!name) {
    const contact = resolveContact(member.phone);
    name = contact.name || member.phone.slice(-4);
    trustProfile = inferTrustProfile(contact);
  }

  if (dryRun) {
    return {
      groupId,
      dryRun: true,
      phone: member.phone,
      name,
      agentId: deriveAgentId(name),
      trustProfile
    };
  }

  // Provision the bot (slow: XMTP identity + config injection + reload)
  const result = provision({
    name,
    phone: member.phone,
    trustProfile,
    dryRun: false,
    configPath,
    registryPath
  });

  // ── Short lock 2: re-check then atomic update ──────────────────────
  const releaseUpdate = acquireLock(groupsFile);
  try {
    const state = loadGroups(groupsPath);
    const group = state.groups[groupId];
    if (!group) {
      throw new Error(`Group '${groupId}' no longer tracked`);
    }

    // Another process may have added the member while we were provisioning
    if (group.members[member.phone]) {
      return {
        groupId,
        skipped: true,
        reason: 'added-by-concurrent-process',
        agentId: group.members[member.phone].agentId
      };
    }

    group.members[member.phone] = {
      agentId: result.agentId,
      status: 'active',
      provisionedAt: new Date().toISOString()
    };
    saveGroups(state, groupsPath);
  } finally {
    releaseUpdate();
  }

  return {
    groupId,
    dryRun: false,
    phone: member.phone,
    name,
    agentId: result.agentId,
    xmtpAddress: result.xmtpAddress,
    trustProfile
  };
}

// ── Event Handler ────────────────────────────────────────────────

/**
 * Handle an inbound group message event. Main entry point for auto-provisioning.
 *
 * If the group is untracked and autoProvision is enabled, provisions bots for all members.
 * If the group is tracked, checks for new members and provisions them.
 *
 * @param {object} event
 * @param {string} event.groupId — Group identifier.
 * @param {string} event.channel — Channel name.
 * @param {string} [event.groupName] — Human-readable group name.
 * @param {string} [event.sender] — Message sender identifier.
 * @param {Array} event.members — Group member list.
 * @param {object} [options]
 * @param {boolean} [options.dryRun=false]
 * @param {string} [options.configPath]
 * @param {string} [options.registryPath]
 * @param {string} [options.groupsPath]
 * @returns {object} Provisioning result.
 */
export function handleGroupMessage(event, options = {}) {
  if (!event || typeof event !== 'object') {
    throw new Error('Event object is required');
  }
  if (!event.groupId || typeof event.groupId !== 'string') {
    throw new Error('event.groupId is required');
  }
  if (!event.channel || typeof event.channel !== 'string') {
    throw new Error('event.channel is required');
  }

  const members = extractMembers(event);
  if (members.length === 0) {
    return { groupId: event.groupId, action: 'no-members', provisioned: [], errors: [] };
  }

  const state = loadGroups(options.groupsPath);
  const isNewGroup = !state.groups[event.groupId];

  if (isNewGroup) {
    // New group — provision all members
    return {
      action: 'new-group',
      ...provisionGroup({
        groupId: event.groupId,
        channel: event.channel,
        members,
        groupName: event.groupName,
        owner: event.sender,
        autoProvision: true,
        dryRun: options.dryRun,
        configPath: options.configPath,
        registryPath: options.registryPath,
        groupsPath: options.groupsPath
      })
    };
  }

  // Existing group — check for new members
  const trackedGroup = state.groups[event.groupId];
  const newMembers = members.filter(m =>
    !trackedGroup.members[m.phone] && !HOST_PHONES.includes(m.phone)
  );

  if (newMembers.length === 0) {
    return {
      groupId: event.groupId,
      action: 'no-new-members',
      provisioned: [],
      skipped: members.length,
      errors: []
    };
  }

  // Auto-provision only if enabled for this group
  if (!trackedGroup.autoProvision) {
    return {
      groupId: event.groupId,
      action: 'auto-provision-disabled',
      newMembers: newMembers.map(m => m.phone),
      provisioned: [],
      errors: []
    };
  }

  return {
    action: 'new-members',
    ...provisionGroup({
      groupId: event.groupId,
      channel: trackedGroup.channel,
      members: newMembers,
      groupName: trackedGroup.name,
      owner: trackedGroup.owner,
      autoProvision: true,
      dryRun: options.dryRun,
      configPath: options.configPath,
      registryPath: options.registryPath,
      groupsPath: options.groupsPath
    })
  };
}

// ── Status / Query ───────────────────────────────────────────────

/**
 * Get status for a specific tracked group.
 * @param {string} groupId
 * @param {string} [groupsPath]
 * @returns {object|null}
 */
export function getGroupStatus(groupId, groupsPath) {
  const state = loadGroups(groupsPath);
  return state.groups[groupId] || null;
}

/**
 * List all tracked groups.
 * @param {string} [groupsPath]
 * @returns {object[]}
 */
export function listTrackedGroups(groupsPath) {
  const state = loadGroups(groupsPath);
  return Object.values(state.groups);
}

// Note: OpenClaw reload is handled by buddy-provision.mjs internally
// (each provision() call sends SIGUSR1). No separate reload needed here.

// ── Welcome DM Generation ────────────────────────────────────────

/**
 * Generate welcome DM text for a newly provisioned buddy bot.
 *
 * @param {object} opts
 * @param {string} opts.humanName — The human's name.
 * @param {string} opts.ownerName — Name of the person who set up the group.
 * @param {string} [opts.groupName] — Group name for context.
 * @returns {string} Welcome message text.
 */
export function generateWelcomeDM(opts) {
  const { humanName, ownerName, groupName } = opts;
  const greeting = humanName || 'there';
  const groupCtx = groupName ? ` for the "${groupName}" group` : '';
  return `Hey ${greeting}! 👋 I'm your Buddy Bot. ${ownerName || 'Your friend'} set me up${groupCtx} to help coordinate. Want to connect your calendar so I can help with scheduling?`;
}

// ── CLI ──────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    event: null,
    provision: null,
    members: null,
    channel: null,
    groupName: null,
    status: false,
    listGroups: false,
    groupStatus: null,
    dryRun: false,
    configPath: null,
    registryPath: null,
    groupsPath: null,
    help: false
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const takeValue = () => {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
        console.error(`❌ ${arg} requires a value`);
        process.exit(1);
      }
      return argv[++i];
    };

    switch (arg) {
      case '--event':       args.event = takeValue(); break;
      case '--provision':   args.provision = takeValue(); break;
      case '--members':     args.members = takeValue(); break;
      case '--channel':     args.channel = takeValue(); break;
      case '--group-name':  args.groupName = takeValue(); break;
      case '--status':      args.status = true; break;
      case '--list-groups': args.listGroups = true; break;
      case '--group-status': args.groupStatus = takeValue(); break;
      case '--dry-run':     args.dryRun = true; break;
      case '--config':      args.configPath = takeValue(); break;
      case '--registry':    args.registryPath = takeValue(); break;
      case '--groups':      args.groupsPath = takeValue(); break;
      case '--help':
      case '-h':            args.help = true; break;
    }
  }
  return args;
}

function showHelp() {
  console.log(`
buddy-host — Buddy Host Agent: Auto-Provisioning on Group Creation

Usage:
  buddy-host --event '{"groupId":"...","channel":"signal","members":[...]}'
  buddy-host --provision <groupId> --members '+1...,+2...' --channel signal
  buddy-host --group-status <groupId>
  buddy-host --status
  buddy-host --list-groups

Event mode:
  --event <json>      Process a group event (JSON with groupId, channel, members)

Manual provision:
  --provision <gid>   Group ID to provision
  --members <csv>     Comma-separated phone numbers
  --channel <name>    Channel name (signal, whatsapp, telegram, etc.)
  --group-name <n>    Human-readable group name (optional)
  --dry-run           Print plan without executing

Query:
  --status            Show overall buddy host status
  --list-groups       List all tracked groups
  --group-status <id> Show status for a specific group

Advanced:
  --config <path>     Override openclaw.json path
  --registry <path>   Override buddy registry path
  --groups <path>     Override buddy-groups.json path
  --help              Show this help
  `);
}

function cmdEvent(args) {
  let event;
  try {
    event = JSON.parse(args.event);
  } catch (e) {
    console.error(`❌ Invalid JSON in --event: ${e.message}`);
    process.exit(1);
  }

  const result = handleGroupMessage(event, {
    dryRun: args.dryRun,
    configPath: args.configPath,
    registryPath: args.registryPath,
    groupsPath: args.groupsPath
  });

  if (args.dryRun) {
    console.log('🧪 DRY RUN — no changes made\n');
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`\n🤝 Group event processed (${result.action}):`);
  if (result.provisioned && result.provisioned.length > 0) {
    console.log(`  ✅ Provisioned ${result.provisioned.length} bot(s):`);
    for (const p of result.provisioned) {
      console.log(`     ${p.agentId} — ${p.name} (${p.phone})`);
    }
  }
  // Normalize skipped to a count (handles number, array, or boolean from different code paths)
  let skippedCount = 0;
  if (typeof result.skipped === 'number') skippedCount = result.skipped;
  else if (Array.isArray(result.skipped)) skippedCount = result.skipped.length;
  else if (result.skipped === true) skippedCount = 1;
  if (skippedCount > 0) {
    console.log(`  ⏭️  Skipped: ${skippedCount}`);
  }
  if (result.errors && result.errors.length > 0) {
    console.log(`  ❌ Errors: ${result.errors.length}`);
    for (const e of result.errors) {
      console.log(`     ${e.phone}: ${e.error}`);
    }
  }
}

function cmdProvision(args) {
  if (!args.members) {
    console.error('❌ --members is required with --provision');
    process.exit(1);
  }
  if (!args.channel) {
    console.error('❌ --channel is required with --provision');
    process.exit(1);
  }

  const members = args.members.split(',').map(p => ({ phone: p.trim(), name: null }));
  const result = provisionGroup({
    groupId: args.provision,
    channel: args.channel,
    members,
    groupName: args.groupName,
    dryRun: args.dryRun,
    configPath: args.configPath,
    registryPath: args.registryPath,
    groupsPath: args.groupsPath
  });

  if (args.dryRun) {
    console.log('🧪 DRY RUN — no changes made\n');
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`\n🤝 Group '${args.provision}' provisioned:`);
  console.log(`  Channel: ${args.channel}`);
  if (result.provisioned.length > 0) {
    console.log(`  ✅ Provisioned ${result.provisioned.length} bot(s):`);
    for (const p of result.provisioned) {
      console.log(`     ${p.agentId} — ${p.name} (${p.phone})`);
    }
  }
  if (result.errors.length > 0) {
    console.log(`  ❌ Errors:`);
    for (const e of result.errors) {
      console.log(`     ${e.phone}: ${e.error}`);
    }
  }
  if (result.provisioned && result.provisioned.length > 0) {
    console.log('  OpenClaw reloaded after each provision.');
  }
}

function cmdStatus(args) {
  const groups = listTrackedGroups(args.groupsPath);
  const buddies = registryListBuddies(args.registryPath);
  console.log('🤝 Buddy Host Agent');
  console.log(`   Tracked groups: ${groups.length}`);
  console.log(`   Total buddy bots: ${buddies.length}`);
  console.log(`   Active: ${buddies.filter(b => b.status === 'active').length}`);
  console.log(`   Groups file: ${args.groupsPath || GROUPS_FILE}`);
}

function cmdListGroups(args) {
  const groups = listTrackedGroups(args.groupsPath);
  if (groups.length === 0) {
    console.log('No tracked groups yet.');
    return;
  }
  console.log(`🤝 ${groups.length} tracked group(s):\n`);
  for (const g of groups) {
    const memberCount = Object.keys(g.members || {}).length;
    console.log(`  ${g.id} — "${g.name}" (${g.channel})`);
    console.log(`    Members: ${memberCount} | Auto-provision: ${g.autoProvision ? 'on' : 'off'} | Created: ${g.createdAt}`);
  }
}

function cmdGroupStatus(args) {
  const group = getGroupStatus(args.groupStatus, args.groupsPath);
  if (!group) {
    console.log(`Group '${args.groupStatus}' not found.`);
    return;
  }
  console.log(`🤝 Group: ${group.name} (${group.id})`);
  console.log(`   Channel: ${group.channel}`);
  console.log(`   Owner: ${group.owner || '(unknown)'}`);
  console.log(`   Auto-provision: ${group.autoProvision ? 'on' : 'off'}`);
  console.log(`   Created: ${group.createdAt}`);
  const members = Object.entries(group.members || {});
  if (members.length > 0) {
    console.log(`   Members (${members.length}):`);
    for (const [phone, info] of members) {
      console.log(`     ${info.agentId} — ${phone} (${info.status})`);
    }
  }
}

// ── Entry Point ──────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) { showHelp(); return; }
  if (args.event) { cmdEvent(args); return; }
  if (args.provision) { cmdProvision(args); return; }
  if (args.status) { cmdStatus(args); return; }
  if (args.listGroups) { cmdListGroups(args); return; }
  if (args.groupStatus) { cmdGroupStatus(args); return; }

  console.error('❌ No action specified. Run with --help for usage.');
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
