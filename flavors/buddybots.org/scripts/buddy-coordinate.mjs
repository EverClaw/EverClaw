#!/usr/bin/env node
/**
 * buddy-coordinate.mjs — Bot-to-Bot Coordination Skill (Gap 6)
 *
 * Standard payload schemas and coordination logic for buddy bots
 * to communicate over XMTP V6 DATA messages.
 *
 * Coordination types:
 *   - schedule-request / schedule-response
 *   - recommendation-request / recommendation-response
 *   - group-plan-propose / group-plan-vote / group-plan-finalize
 *   - reminder-relay / reminder-ack
 *   - preference-share
 *
 * Usage (CLI):
 *   node buddy-coordinate.mjs --create schedule-request --payload '{"date":"2026-04-20","note":"Saturday lunch?"}'
 *   node buddy-coordinate.mjs --parse < message.json
 *   node buddy-coordinate.mjs --pending
 *   node buddy-coordinate.mjs --expire
 *   node buddy-coordinate.mjs --status
 *
 * Usage (Library):
 *   import { createCoordinationMessage, parseCoordinationMessage } from './buddy-coordinate.mjs';
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, statSync, unlinkSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir, platform } from 'node:os';

// ── Constants ────────────────────────────────────────────────────

const EVERCLAW_DIR = join(homedir(), '.everclaw');
const PENDING_DIR = join(EVERCLAW_DIR, 'coordination', 'pending');
const ARCHIVE_DIR = join(EVERCLAW_DIR, 'coordination', 'archive');

const PROTOCOL_VERSION = '1.0';
const DEFAULT_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_PAYLOAD_BYTES = 32 * 1024; // 32KB max per coordination payload

// ── Coordination Types ───────────────────────────────────────────

export const COORDINATION_TYPES = [
  'schedule-request',
  'schedule-response',
  'recommendation-request',
  'recommendation-response',
  'group-plan-propose',
  'group-plan-vote',
  'group-plan-finalize',
  'reminder-relay',
  'reminder-ack',
  'preference-share',
];

// Types that expect a response
const REQUEST_TYPES = new Set([
  'schedule-request',
  'recommendation-request',
  'group-plan-propose',
  'reminder-relay',
]);

// Expected response type for each request
const RESPONSE_MAP = {
  'schedule-request': 'schedule-response',
  'recommendation-request': 'recommendation-response',
  'group-plan-propose': 'group-plan-vote',
  'reminder-relay': 'reminder-ack',
};

// ── Trust Boundaries ─────────────────────────────────────────────

/**
 * Maps trust profile → allowed coordination types.
 * More trusted profiles get broader access.
 */
const TRUST_BOUNDARIES = {
  public: new Set([
    'group-plan-propose',
    'group-plan-vote',
    'group-plan-finalize',
  ]),
  business: new Set([
    'group-plan-propose',
    'group-plan-vote',
    'group-plan-finalize',
    'schedule-request',
    'schedule-response',
    'reminder-relay',
    'reminder-ack',
  ]),
  personal: new Set([
    'group-plan-propose',
    'group-plan-vote',
    'group-plan-finalize',
    'schedule-request',
    'schedule-response',
    'reminder-relay',
    'reminder-ack',
    'recommendation-request',
    'recommendation-response',
    'preference-share',
  ]),
  full: new Set(COORDINATION_TYPES),
};

/**
 * Check if a coordination type is allowed for a given trust profile.
 * @param {string} type — Coordination message type.
 * @param {string} trustProfile — Peer's trust profile (public|business|personal|full).
 * @returns {boolean}
 */
export function isAllowedByTrust(type, trustProfile) {
  const allowed = TRUST_BOUNDARIES[trustProfile];
  if (!allowed) return false;
  return allowed.has(type);
}

// ── Schema Validation ────────────────────────────────────────────

/**
 * Validate coordination envelope structure.
 * Uses manual validation (no Zod dep) for zero-dependency constraint.
 *
 * @param {object} envelope — The coordination object from a V6 DATA payload.
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateEnvelope(envelope) {
  const errors = [];

  if (!envelope || typeof envelope !== 'object') {
    return { valid: false, errors: ['coordination must be an object'] };
  }

  // Required fields
  if (!envelope.type || typeof envelope.type !== 'string') {
    errors.push('coordination.type is required (string)');
  } else if (!COORDINATION_TYPES.includes(envelope.type)) {
    errors.push(`coordination.type "${envelope.type}" is not a valid type`);
  }

  if (!envelope.requestId || typeof envelope.requestId !== 'string' || envelope.requestId.trim() === '') {
    errors.push('coordination.requestId is required (non-empty string)');
  }

  if (!envelope.version || typeof envelope.version !== 'string') {
    errors.push('coordination.version is required (string)');
  }

  if (envelope.createdAt !== undefined && envelope.createdAt !== null) {
    if (typeof envelope.createdAt !== 'string' || isNaN(Date.parse(envelope.createdAt))) {
      errors.push('coordination.createdAt must be a valid ISO-8601 string if present');
    }
  }

  // Optional fields with type enforcement
  if (envelope.groupId !== undefined && envelope.groupId !== null) {
    if (typeof envelope.groupId !== 'string' || envelope.groupId.trim() === '') {
      errors.push('coordination.groupId must be a non-empty string if present');
    }
  }

  if (envelope.replyTo !== undefined && envelope.replyTo !== null) {
    if (typeof envelope.replyTo !== 'string' || envelope.replyTo.trim() === '') {
      errors.push('coordination.replyTo must be a non-empty string if present');
    }
  }

  if (envelope.expiresAt !== undefined && envelope.expiresAt !== null) {
    if (typeof envelope.expiresAt !== 'string') {
      errors.push('coordination.expiresAt must be an ISO-8601 string if present');
    } else if (isNaN(Date.parse(envelope.expiresAt))) {
      errors.push('coordination.expiresAt is not a valid ISO-8601 date');
    }
  }

  if (envelope.payload !== undefined && envelope.payload !== null && typeof envelope.payload !== 'object') {
    errors.push('coordination.payload must be an object if present');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate type-specific payload constraints.
 * @param {string} type
 * @param {object} payload
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validatePayload(type, payload) {
  const errors = [];
  const p = payload || {};

  switch (type) {
    case 'schedule-request':
      if (!p.date && !p.dateRange) {
        errors.push('schedule-request requires date or dateRange');
      }
      if (p.date && typeof p.date !== 'string') {
        errors.push('schedule-request.date must be a string');
      }
      if (p.dateRange) {
        if (typeof p.dateRange !== 'object') {
          errors.push('schedule-request.dateRange must be an object');
        } else {
          if (!p.dateRange.start || typeof p.dateRange.start !== 'string') {
            errors.push('schedule-request.dateRange.start is required (string)');
          }
          if (!p.dateRange.end || typeof p.dateRange.end !== 'string') {
            errors.push('schedule-request.dateRange.end is required (string)');
          }
        }
      }
      break;

    case 'schedule-response':
      if (!Array.isArray(p.slots)) {
        errors.push('schedule-response requires slots array');
      } else {
        for (let i = 0; i < p.slots.length; i++) {
          const slot = p.slots[i];
          if (!slot || typeof slot !== 'object') {
            errors.push(`schedule-response.slots[${i}] must be an object`);
          } else if (!slot.start || typeof slot.start !== 'string') {
            errors.push(`schedule-response.slots[${i}].start is required (string)`);
          }
        }
      }
      break;

    case 'recommendation-request':
      if (!p.category || typeof p.category !== 'string') {
        errors.push('recommendation-request requires category (string)');
      }
      break;

    case 'recommendation-response':
      if (!Array.isArray(p.recommendations)) {
        errors.push('recommendation-response requires recommendations array');
      }
      break;

    case 'group-plan-propose':
      if (!p.activity || typeof p.activity !== 'string') {
        errors.push('group-plan-propose requires activity (string)');
      }
      break;

    case 'group-plan-vote':
      if (!p.vote || !['accept', 'decline', 'counter'].includes(p.vote)) {
        errors.push('group-plan-vote requires vote (accept|decline|counter)');
      }
      break;

    case 'group-plan-finalize':
      if (!p.activity || typeof p.activity !== 'string') {
        errors.push('group-plan-finalize requires activity (string)');
      }
      if (!p.finalTime || typeof p.finalTime !== 'string') {
        errors.push('group-plan-finalize requires finalTime (string)');
      }
      break;

    case 'reminder-relay':
      if (!p.message || typeof p.message !== 'string') {
        errors.push('reminder-relay requires message (string)');
      }
      break;

    case 'reminder-ack':
      // No required fields — acknowledgment is implicit
      break;

    case 'preference-share':
      if (!p.category || typeof p.category !== 'string') {
        errors.push('preference-share requires category (string)');
      }
      if (!p.value && p.value !== false && p.value !== 0) {
        errors.push('preference-share requires value');
      }
      break;

    default:
      if (!COORDINATION_TYPES.includes(type)) {
        errors.push(`Unknown coordination type: ${type}`);
      }
      break;
  }

  return { valid: errors.length === 0, errors };
}

// ── Message Creation ─────────────────────────────────────────────

/**
 * Create a coordination message envelope.
 *
 * @param {string} type — Coordination type.
 * @param {object} payload — Type-specific payload.
 * @param {object} [options]
 * @param {string} [options.groupId] — Optional group context.
 * @param {string} [options.replyTo] — Request ID this responds to.
 * @param {number} [options.expiryMs] — Custom expiry (default 24h).
 * @param {string} [options.requestId] — Custom request ID (default: auto-generated UUID).
 * @returns {object} Coordination envelope ready for V6 DATA payload.
 */
export function createCoordinationMessage(type, payload, options = {}) {
  if (!type || typeof type !== 'string') {
    throw new Error('type is required (string)');
  }
  if (!COORDINATION_TYPES.includes(type)) {
    throw new Error(`Unknown coordination type: "${type}". Valid: ${COORDINATION_TYPES.join(', ')}`);
  }

  // Validate payload
  const payloadValidation = validatePayload(type, payload);
  if (!payloadValidation.valid) {
    throw new Error(`Invalid payload for ${type}: ${payloadValidation.errors.join('; ')}`);
  }

  // Size check
  const payloadJson = JSON.stringify(payload || {});
  if (Buffer.byteLength(payloadJson, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw new Error(`Payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
  }

  const requestId = options.requestId || randomUUID();
  const expiryMs = options.expiryMs ?? DEFAULT_EXPIRY_MS;
  const expiresAt = new Date(Date.now() + expiryMs).toISOString();

  const envelope = {
    type,
    version: PROTOCOL_VERSION,
    requestId,
    groupId: options.groupId || null,
    replyTo: options.replyTo || null,
    payload: payload || {},
    expiresAt,
    createdAt: new Date().toISOString(),
  };

  // Validate the full envelope
  const envelopeValidation = validateEnvelope(envelope);
  if (!envelopeValidation.valid) {
    throw new Error(`Envelope validation failed: ${envelopeValidation.errors.join('; ')}`);
  }

  return envelope;
}

/**
 * Wrap a coordination envelope in a V6 DATA message structure.
 *
 * @param {object} envelope — From createCoordinationMessage.
 * @param {string} correlationId — V6 correlation ID (usually same as requestId).
 * @returns {object} V6-compatible DATA message.
 */
export function wrapAsV6Data(envelope, correlationId) {
  const SENSITIVE_TYPES = new Set(['recommendation-response', 'preference-share']);
  const isSensitive = SENSITIVE_TYPES.has(envelope.type);
  return {
    messageType: 'DATA',
    version: '6.0',
    correlationId: correlationId || envelope.requestId,
    timestamp: new Date().toISOString(),
    nonce: randomUUID(),
    topics: ['coordination'],
    sensitivity: isSensitive ? 'private' : 'public',
    intent: 'coordinate',
    payload: {
      coordination: envelope,
    },
  };
}

// ── Message Parsing ──────────────────────────────────────────────

/**
 * Parse and validate a coordination message from a V6 DATA payload.
 *
 * @param {object} v6Data — V6 DATA message (from inbox JSON).
 * @param {string} [trustProfile] — Sender's trust profile. If provided, enforces TRUST_BOUNDARIES.
 * @returns {{ valid: boolean, coordination: object|null, errors: string[] }}
 */
export function parseCoordinationMessage(v6Data, trustProfile) {
  if (!v6Data || typeof v6Data !== 'object') {
    return { valid: false, coordination: null, errors: ['Input must be an object'] };
  }

  // Extract coordination from payload
  const coordination = v6Data.payload?.coordination || v6Data.coordination;
  if (!coordination) {
    return { valid: false, coordination: null, errors: ['No coordination field in payload'] };
  }

  // Size limit check on ingestion (hardening against oversized payloads)
  try {
    const coordSize = Buffer.byteLength(JSON.stringify(coordination), 'utf8');
    if (coordSize > MAX_PAYLOAD_BYTES * 1.5) {
      return { valid: false, coordination: null, errors: ['Coordination payload exceeds size limit'] };
    }
  } catch {
    return { valid: false, coordination: null, errors: ['Failed to measure coordination payload size'] };
  }

  // Validate envelope
  const envelopeResult = validateEnvelope(coordination);
  if (!envelopeResult.valid) {
    return { valid: false, coordination: null, errors: envelopeResult.errors };
  }

  // Trust boundary check (when trustProfile is provided)
  if (trustProfile && !isAllowedByTrust(coordination.type, trustProfile)) {
    return {
      valid: false,
      coordination,
      errors: [`Type "${coordination.type}" not allowed for trust profile "${trustProfile}"`],
    };
  }

  // Validate type-specific payload
  const payloadResult = validatePayload(coordination.type, coordination.payload);
  if (!payloadResult.valid) {
    return { valid: false, coordination, errors: payloadResult.errors };
  }

  // Check expiry
  if (coordination.expiresAt && new Date(coordination.expiresAt) < new Date()) {
    return { valid: false, coordination, errors: ['Message has expired'] };
  }

  return { valid: true, coordination, errors: [] };
}

// ── Request Tracking ─────────────────────────────────────────────

/**
 * Save a pending request for tracking.
 * Only request-type messages are tracked (those expecting a response).
 *
 * @param {object} envelope — Coordination envelope.
 * @param {string} targetPeer — XMTP address of the recipient.
 * @param {string} [pendingDir] — Override for testing.
 */
export function trackRequest(envelope, targetPeer, pendingDir = PENDING_DIR) {
  if (!REQUEST_TYPES.has(envelope.type)) return; // Not a request type

  mkdirSync(pendingDir, { recursive: true, mode: 0o700 });

  const record = {
    requestId: envelope.requestId,
    type: envelope.type,
    expectedResponse: RESPONSE_MAP[envelope.type],
    targetPeer,
    groupId: envelope.groupId || null,
    createdAt: envelope.createdAt,
    expiresAt: envelope.expiresAt,
    status: 'pending',
  };

  const filePath = join(pendingDir, `${envelope.requestId}.json`);
  const tmpPath = filePath + '.tmp.' + process.pid;
  writeFileSync(tmpPath, JSON.stringify(record, null, 2));
  renameSync(tmpPath, filePath);
}

/**
 * Mark a pending request as resolved.
 *
 * @param {string} requestId — The request ID to resolve.
 * @param {string} [status='resolved'] — New status.
 * @param {string} [pendingDir]
 * @param {string} [archiveDir]
 */
export function resolveRequest(requestId, status = 'resolved', pendingDir = PENDING_DIR, archiveDir = ARCHIVE_DIR) {
  const filePath = join(pendingDir, `${requestId}.json`);
  if (!existsSync(filePath)) return null;

  const record = JSON.parse(readFileSync(filePath, 'utf8'));
  record.status = status;
  record.resolvedAt = new Date().toISOString();

  // Move to archive
  mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
  const archivePath = join(archiveDir, `${requestId}.json`);
  const tmpPath = archivePath + '.tmp.' + process.pid;
  writeFileSync(tmpPath, JSON.stringify(record, null, 2));
  renameSync(tmpPath, archivePath);

  // Remove from pending
  try { unlinkSync(filePath); } catch { /* best effort */ }

  return record;
}

/**
 * List all pending requests.
 * @param {string} [pendingDir]
 * @returns {object[]}
 */
export function listPending(pendingDir = PENDING_DIR) {
  if (!existsSync(pendingDir)) return [];

  const files = readdirSync(pendingDir).filter(f => f.endsWith('.json'));
  const results = [];

  for (const file of files) {
    try {
      const record = JSON.parse(readFileSync(join(pendingDir, file), 'utf8'));
      results.push(record);
    } catch {
      // Skip corrupt files
    }
  }

  return results;
}

/**
 * Expire pending requests that have passed their expiresAt timestamp.
 * @param {string} [pendingDir]
 * @param {string} [archiveDir]
 * @returns {{ expired: number, remaining: number }}
 */
export function expirePending(pendingDir = PENDING_DIR, archiveDir = ARCHIVE_DIR) {
  const pending = listPending(pendingDir);
  let expired = 0;

  for (const record of pending) {
    if (record.expiresAt && new Date(record.expiresAt) < new Date()) {
      resolveRequest(record.requestId, 'expired', pendingDir, archiveDir);
      expired++;
    }
  }

  return { expired, remaining: pending.length - expired };
}

/**
 * Handle an incoming coordination response — match to pending request.
 *
 * @param {object} coordination — Parsed coordination envelope.
 * @param {string} senderPeer — XMTP address of the sender.
 * @param {string} [pendingDir]
 * @param {string} [archiveDir]
 * @returns {{ matched: boolean, request: object|null, error: string|null }}
 */
export function matchResponse(coordination, senderPeer, pendingDir = PENDING_DIR, archiveDir = ARCHIVE_DIR) {
  if (!coordination.replyTo) {
    return { matched: false, request: null, error: 'No replyTo field — cannot match to request' };
  }

  const filePath = join(pendingDir, `${coordination.replyTo}.json`);
  if (!existsSync(filePath)) {
    return { matched: false, request: null, error: `No pending request with ID: ${coordination.replyTo}` };
  }

  let record;
  try {
    record = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return { matched: false, request: null, error: 'Corrupt pending request file' };
  }

  // Verify the response type matches what we expected
  if (record.expectedResponse && record.expectedResponse !== coordination.type) {
    return {
      matched: false,
      request: record,
      error: `Expected response type "${record.expectedResponse}" but got "${coordination.type}"`,
    };
  }

  // Verify the sender matches the target peer
  if (record.targetPeer && senderPeer &&
      record.targetPeer.toLowerCase() !== senderPeer.toLowerCase()) {
    return {
      matched: false,
      request: record,
      error: `Response from unexpected peer: expected ${record.targetPeer}, got ${senderPeer}`,
    };
  }

  // Match successful — resolve the request
  const resolved = resolveRequest(coordination.replyTo, 'resolved', pendingDir, archiveDir);
  return { matched: true, request: resolved, error: null };
}

// ── Coordination Handler ─────────────────────────────────────────

/**
 * Handle an incoming coordination message. Main entry point.
 *
 * Validates the message, checks trust boundaries, matches responses,
 * and returns a structured result for the caller to act on.
 *
 * @param {object} v6Data — V6 DATA message from inbox.
 * @param {object} context
 * @param {string} context.senderPeer — Sender's XMTP address.
 * @param {string} context.trustProfile — Sender's trust profile (from peers.mjs).
 * @param {string} [context.pendingDir]
 * @param {string} [context.archiveDir]
 * @returns {object} Result with action, coordination data, and any errors.
 */
export function handleCoordinationMessage(v6Data, context) {
  const { senderPeer, trustProfile } = context;

  if (!senderPeer || typeof senderPeer !== 'string') {
    return { action: 'error', error: 'senderPeer is required' };
  }
  if (!trustProfile || typeof trustProfile !== 'string') {
    return { action: 'error', error: 'trustProfile is required' };
  }

  // Parse and validate (trust boundary enforced inside parseCoordinationMessage)
  const parsed = parseCoordinationMessage(v6Data, trustProfile);
  if (!parsed.valid) {
    const isTrustError = parsed.errors.some(e =>
      e.includes('not allowed for trust profile')
    );
    if (isTrustError && parsed.coordination) {
      return {
        action: 'blocked',
        reason: 'trust-boundary',
        type: parsed.coordination.type,
        trustProfile,
        allowedTypes: Array.from(TRUST_BOUNDARIES[trustProfile] || []),
        errors: parsed.errors,
      };
    }
    return { action: 'invalid', errors: parsed.errors, coordination: parsed.coordination };
  }

  const coord = parsed.coordination;

  // If this is a response, try to match it to a pending request
  if (coord.replyTo) {
    const match = matchResponse(
      coord,
      senderPeer,
      context.pendingDir || PENDING_DIR,
      context.archiveDir || ARCHIVE_DIR
    );
    return {
      action: match.matched ? 'response-matched' : 'response-unmatched',
      coordination: coord,
      match,
    };
  }

  // This is a new request or notification
  return {
    action: REQUEST_TYPES.has(coord.type) ? 'request' : 'notification',
    coordination: coord,
    expectsResponse: REQUEST_TYPES.has(coord.type),
    expectedResponseType: RESPONSE_MAP[coord.type] || null,
  };
}

// ── CLI ──────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    create: null,
    payload: null,
    groupId: null,
    replyTo: null,
    parse: false,
    pending: false,
    expire: false,
    status: false,
    help: false,
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
      case '--create':    args.create = takeValue(); break;
      case '--payload':   args.payload = takeValue(); break;
      case '--group-id':  args.groupId = takeValue(); break;
      case '--reply-to':  args.replyTo = takeValue(); break;
      case '--parse':     args.parse = true; break;
      case '--pending':   args.pending = true; break;
      case '--expire':    args.expire = true; break;
      case '--status':    args.status = true; break;
      case '--help':
      case '-h':          args.help = true; break;
    }
  }
  return args;
}

function showHelp() {
  console.log(`
buddy-coordinate — Bot-to-Bot Coordination over XMTP V6

Usage:
  node buddy-coordinate.mjs --create <type> --payload '<json>' [--group-id <id>] [--reply-to <id>]
  node buddy-coordinate.mjs --parse < message.json
  node buddy-coordinate.mjs --pending
  node buddy-coordinate.mjs --expire
  node buddy-coordinate.mjs --status
  node buddy-coordinate.mjs --help

Coordination types:
  schedule-request, schedule-response, recommendation-request,
  recommendation-response, group-plan-propose, group-plan-vote,
  group-plan-finalize, reminder-relay, reminder-ack, preference-share

Examples:
  # Create a schedule request
  node buddy-coordinate.mjs --create schedule-request --payload '{"date":"2026-04-20","note":"Saturday lunch?"}'

  # Create a response to a request
  node buddy-coordinate.mjs --create schedule-response --reply-to abc-123 --payload '{"slots":[{"start":"12:00","end":"14:00"}]}'

  # List pending requests
  node buddy-coordinate.mjs --pending

  # Expire timed-out requests
  node buddy-coordinate.mjs --expire
`);
}

function cmdCreate(args) {
  let payload;
  try {
    payload = args.payload ? JSON.parse(args.payload) : {};
  } catch (err) {
    console.error(`❌ Invalid JSON payload: ${err.message}`);
    process.exit(1);
  }

  try {
    const envelope = createCoordinationMessage(args.create, payload, {
      groupId: args.groupId,
      replyTo: args.replyTo,
    });

    const v6 = wrapAsV6Data(envelope);
    console.log(JSON.stringify(v6, null, 2));
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }
}

function cmdParse() {
  let input = '';
  try {
    input = readFileSync('/dev/stdin', 'utf8');
  } catch {
    console.error('❌ Failed to read stdin');
    process.exit(1);
  }

  let data;
  try {
    data = JSON.parse(input);
  } catch {
    console.error('❌ Invalid JSON input');
    process.exit(1);
  }

  const result = parseCoordinationMessage(data);
  if (result.valid) {
    console.log('✅ Valid coordination message:');
    console.log(JSON.stringify(result.coordination, null, 2));
  } else {
    console.error('❌ Invalid coordination message:');
    for (const err of result.errors) {
      console.error(`   ${err}`);
    }
    process.exit(1);
  }
}

function cmdPending() {
  const pending = listPending();
  if (pending.length === 0) {
    console.log('No pending coordination requests.');
    return;
  }

  console.log(`📋 Pending requests (${pending.length}):\n`);
  for (const r of pending) {
    const age = Date.now() - new Date(r.createdAt).getTime();
    const ageMin = Math.floor(age / 60000);
    const expired = r.expiresAt && new Date(r.expiresAt) < new Date();
    console.log(`  ${r.requestId}`);
    console.log(`    Type: ${r.type} → expects ${r.expectedResponse}`);
    console.log(`    Target: ${r.targetPeer}`);
    console.log(`    Age: ${ageMin} min${expired ? ' (EXPIRED)' : ''}`);
    console.log('');
  }
}

function cmdExpire() {
  const result = expirePending();
  console.log(`🧹 Expired: ${result.expired} | Remaining: ${result.remaining}`);
}

function cmdStatus() {
  const pending = listPending();
  const archived = existsSync(ARCHIVE_DIR) ? readdirSync(ARCHIVE_DIR).filter(f => f.endsWith('.json')).length : 0;

  const byType = {};
  for (const r of pending) {
    byType[r.type] = (byType[r.type] || 0) + 1;
  }

  const expiredCount = pending.filter(r => r.expiresAt && new Date(r.expiresAt) < new Date()).length;

  console.log('📊 Coordination Status');
  console.log(`   Pending: ${pending.length}${expiredCount > 0 ? ` (${expiredCount} expired)` : ''}`);
  console.log(`   Archived: ${archived}`);
  if (Object.keys(byType).length > 0) {
    console.log('   By type:');
    for (const [type, count] of Object.entries(byType)) {
      console.log(`     ${type}: ${count}`);
    }
  }
}

// ── Entry Point ──────────────────────────────────────────────────

const IS_CLI = process.argv[1] && (
  process.argv[1].endsWith('buddy-coordinate.mjs') ||
  process.argv[1].endsWith('buddy-coordinate')
);

if (IS_CLI) {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    showHelp();
  } else if (args.create) {
    cmdCreate(args);
  } else if (args.parse) {
    cmdParse();
  } else if (args.pending) {
    cmdPending();
  } else if (args.expire) {
    cmdExpire();
  } else if (args.status) {
    cmdStatus();
  } else {
    showHelp();
  }
}
