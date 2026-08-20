#!/usr/bin/env node
/**
 * buddy-coordinate.test.mjs — Tests for Bot-to-Bot Coordination Skill (Gap 6)
 */

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import {
  COORDINATION_TYPES,
  isAllowedByTrust,
  validateEnvelope,
  validatePayload,
  createCoordinationMessage,
  wrapAsV6Data,
  parseCoordinationMessage,
  trackRequest,
  resolveRequest,
  listPending,
  expirePending,
  matchResponse,
  handleCoordinationMessage,
} from './buddy-coordinate.mjs';

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

function makeTmpDir() {
  const dir = join(tmpdir(), `buddy-coord-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ── Tests: COORDINATION_TYPES ────────────────────────────────────

console.log('\n📋 COORDINATION_TYPES');

assertEq(COORDINATION_TYPES.length, 10, 'exactly 10 coordination types');
assertTrue(COORDINATION_TYPES.includes('schedule-request'), 'includes schedule-request');
assertTrue(COORDINATION_TYPES.includes('schedule-response'), 'includes schedule-response');
assertTrue(COORDINATION_TYPES.includes('recommendation-request'), 'includes recommendation-request');
assertTrue(COORDINATION_TYPES.includes('recommendation-response'), 'includes recommendation-response');
assertTrue(COORDINATION_TYPES.includes('group-plan-propose'), 'includes group-plan-propose');
assertTrue(COORDINATION_TYPES.includes('group-plan-vote'), 'includes group-plan-vote');
assertTrue(COORDINATION_TYPES.includes('group-plan-finalize'), 'includes group-plan-finalize');
assertTrue(COORDINATION_TYPES.includes('reminder-relay'), 'includes reminder-relay');
assertTrue(COORDINATION_TYPES.includes('reminder-ack'), 'includes reminder-ack');
assertTrue(COORDINATION_TYPES.includes('preference-share'), 'includes preference-share');

// ── Tests: isAllowedByTrust ──────────────────────────────────────

console.log('\n🔒 isAllowedByTrust');

// Public — limited to group plans
assertTrue(isAllowedByTrust('group-plan-propose', 'public'), 'public: group-plan-propose allowed');
assertTrue(isAllowedByTrust('group-plan-vote', 'public'), 'public: group-plan-vote allowed');
assertTrue(!isAllowedByTrust('schedule-request', 'public'), 'public: schedule-request blocked');
assertTrue(!isAllowedByTrust('recommendation-request', 'public'), 'public: recommendation-request blocked');
assertTrue(!isAllowedByTrust('preference-share', 'public'), 'public: preference-share blocked');

// Business — adds scheduling and reminders
assertTrue(isAllowedByTrust('schedule-request', 'business'), 'business: schedule-request allowed');
assertTrue(isAllowedByTrust('reminder-relay', 'business'), 'business: reminder-relay allowed');
assertTrue(!isAllowedByTrust('recommendation-request', 'business'), 'business: recommendation-request blocked');
assertTrue(!isAllowedByTrust('preference-share', 'business'), 'business: preference-share blocked');

// Personal — adds recommendations and preferences
assertTrue(isAllowedByTrust('recommendation-request', 'personal'), 'personal: recommendation-request allowed');
assertTrue(isAllowedByTrust('preference-share', 'personal'), 'personal: preference-share allowed');
assertTrue(isAllowedByTrust('schedule-request', 'personal'), 'personal: schedule-request allowed');

// Full — everything
for (const type of COORDINATION_TYPES) {
  assertTrue(isAllowedByTrust(type, 'full'), `full: ${type} allowed`);
}

// Unknown profile
assertTrue(!isAllowedByTrust('group-plan-propose', 'unknown'), 'unknown: everything blocked');
assertTrue(!isAllowedByTrust('schedule-request', null), 'null: everything blocked');

// ── Tests: validateEnvelope ──────────────────────────────────────

console.log('\n📦 validateEnvelope');

{
  const valid = validateEnvelope({
    type: 'schedule-request',
    version: '1.0',
    requestId: 'abc-123',
    payload: { date: '2026-04-20' },
  });
  assertTrue(valid.valid, 'valid envelope passes');
  assertEq(valid.errors.length, 0, 'no errors on valid envelope');
}

{
  const r = validateEnvelope(null);
  assertTrue(!r.valid, 'null rejected');
}

{
  const r = validateEnvelope({});
  assertTrue(!r.valid, 'empty object rejected');
  assertTrue(r.errors.length >= 2, 'at least 2 errors (type + requestId)');
}

{
  const r = validateEnvelope({ type: 'invalid-type', version: '1.0', requestId: 'x' });
  assertTrue(!r.valid, 'invalid type rejected');
  assertTrue(r.errors[0].includes('not a valid type'), 'error mentions invalid type');
}

{
  const r = validateEnvelope({
    type: 'schedule-request',
    version: '1.0',
    requestId: 'x',
    expiresAt: 'not-a-date',
  });
  assertTrue(!r.valid, 'invalid date rejected');
}

{
  const r = validateEnvelope({
    type: 'schedule-request',
    version: '1.0',
    requestId: 'x',
    groupId: 123,
  });
  assertTrue(!r.valid, 'non-string groupId rejected');
}

// Whitespace-only groupId/replyTo
{
  const r = validateEnvelope({
    type: 'schedule-request',
    version: '1.0',
    requestId: 'x',
    groupId: '   ',
  });
  assertTrue(!r.valid, 'whitespace-only groupId rejected');
}
{
  const r = validateEnvelope({
    type: 'schedule-request',
    version: '1.0',
    requestId: 'x',
    replyTo: '  ',
  });
  assertTrue(!r.valid, 'whitespace-only replyTo rejected');
}
// Empty-string requestId
{
  const r = validateEnvelope({
    type: 'schedule-request',
    version: '1.0',
    requestId: '   ',
  });
  assertTrue(!r.valid, 'whitespace-only requestId rejected');
}

// ── Tests: validatePayload ───────────────────────────────────────

console.log('\n🎯 validatePayload');

// schedule-request
{
  const r = validatePayload('schedule-request', { date: '2026-04-20' });
  assertTrue(r.valid, 'schedule-request with date: valid');
}
{
  const r = validatePayload('schedule-request', { dateRange: { start: '2026-04-20', end: '2026-04-21' } });
  assertTrue(r.valid, 'schedule-request with dateRange: valid');
}
{
  const r = validatePayload('schedule-request', {});
  assertTrue(!r.valid, 'schedule-request without date/dateRange: invalid');
}
{
  const r = validatePayload('schedule-request', { dateRange: { start: '2026-04-20' } });
  assertTrue(!r.valid, 'schedule-request with incomplete dateRange: invalid');
}

// schedule-response
{
  const r = validatePayload('schedule-response', { slots: [{ start: '12:00', end: '14:00' }] });
  assertTrue(r.valid, 'schedule-response with slots: valid');
}
{
  const r = validatePayload('schedule-response', { slots: 'not-array' });
  assertTrue(!r.valid, 'schedule-response with non-array slots: invalid');
}
{
  const r = validatePayload('schedule-response', { slots: [{ end: '14:00' }] });
  assertTrue(!r.valid, 'schedule-response slot missing start: invalid');
}

// recommendation-request
{
  const r = validatePayload('recommendation-request', { category: 'restaurant' });
  assertTrue(r.valid, 'recommendation-request with category: valid');
}
{
  const r = validatePayload('recommendation-request', {});
  assertTrue(!r.valid, 'recommendation-request without category: invalid');
}

// recommendation-response
{
  const r = validatePayload('recommendation-response', { recommendations: ['Sushi place'] });
  assertTrue(r.valid, 'recommendation-response with array: valid');
}
{
  const r = validatePayload('recommendation-response', {});
  assertTrue(!r.valid, 'recommendation-response without array: invalid');
}

// group-plan-propose
{
  const r = validatePayload('group-plan-propose', { activity: 'Dinner at 7pm' });
  assertTrue(r.valid, 'group-plan-propose with activity: valid');
}
{
  const r = validatePayload('group-plan-propose', {});
  assertTrue(!r.valid, 'group-plan-propose without activity: invalid');
}

// group-plan-vote
{
  const r = validatePayload('group-plan-vote', { vote: 'accept' });
  assertTrue(r.valid, 'group-plan-vote accept: valid');
}
{
  const r = validatePayload('group-plan-vote', { vote: 'decline' });
  assertTrue(r.valid, 'group-plan-vote decline: valid');
}
{
  const r = validatePayload('group-plan-vote', { vote: 'counter' });
  assertTrue(r.valid, 'group-plan-vote counter: valid');
}
{
  const r = validatePayload('group-plan-vote', { vote: 'maybe' });
  assertTrue(!r.valid, 'group-plan-vote invalid vote: rejected');
}

// group-plan-finalize
{
  const r = validatePayload('group-plan-finalize', { activity: 'Dinner', finalTime: '2026-04-20T19:00:00Z' });
  assertTrue(r.valid, 'group-plan-finalize: valid');
}
{
  const r = validatePayload('group-plan-finalize', { activity: 'Dinner' });
  assertTrue(!r.valid, 'group-plan-finalize without finalTime: invalid');
}

// reminder-relay
{
  const r = validatePayload('reminder-relay', { message: 'Bring snacks' });
  assertTrue(r.valid, 'reminder-relay: valid');
}
{
  const r = validatePayload('reminder-relay', {});
  assertTrue(!r.valid, 'reminder-relay without message: invalid');
}

// reminder-ack
{
  const r = validatePayload('reminder-ack', {});
  assertTrue(r.valid, 'reminder-ack empty: valid');
}

// preference-share
{
  const r = validatePayload('preference-share', { category: 'food', value: 'Italian' });
  assertTrue(r.valid, 'preference-share: valid');
}
{
  const r = validatePayload('preference-share', { category: 'food', value: false });
  assertTrue(r.valid, 'preference-share with false value: valid');
}
{
  const r = validatePayload('preference-share', { category: 'food', value: 0 });
  assertTrue(r.valid, 'preference-share with zero value: valid');
}
{
  const r = validatePayload('preference-share', {});
  assertTrue(!r.valid, 'preference-share without category: invalid');
}

// ── Tests: createCoordinationMessage ─────────────────────────────

console.log('\n🔨 createCoordinationMessage');

{
  const msg = createCoordinationMessage('schedule-request', { date: '2026-04-20', note: 'Lunch?' });
  assertEq(msg.type, 'schedule-request', 'type is schedule-request');
  assertEq(msg.version, '1.0', 'version is 1.0');
  assertTrue(typeof msg.requestId === 'string' && msg.requestId.length > 0, 'requestId generated');
  assertTrue(msg.expiresAt !== null, 'expiresAt set');
  assertTrue(msg.createdAt !== null, 'createdAt set');
  assertEq(msg.payload.date, '2026-04-20', 'payload.date preserved');
  assertEq(msg.payload.note, 'Lunch?', 'payload.note preserved');
}

{
  const msg = createCoordinationMessage('group-plan-propose', { activity: 'Movie night' }, {
    groupId: 'grp-123',
    requestId: 'custom-id',
    expiryMs: 60000,
  });
  assertEq(msg.groupId, 'grp-123', 'groupId set');
  assertEq(msg.requestId, 'custom-id', 'custom requestId used');
  const expiryDelta = new Date(msg.expiresAt) - new Date(msg.createdAt);
  assertTrue(expiryDelta > 55000 && expiryDelta < 65000, 'custom expiry applied (~60s)');
}

assertThrows(
  () => createCoordinationMessage('invalid-type', {}),
  'throws on invalid type'
);

assertThrows(
  () => createCoordinationMessage('schedule-request', {}),
  'throws on invalid payload (missing date)'
);

assertThrows(
  () => createCoordinationMessage(null, {}),
  'throws on null type'
);

// ── Tests: wrapAsV6Data ──────────────────────────────────────────

console.log('\n📨 wrapAsV6Data');

{
  const envelope = createCoordinationMessage('reminder-relay', { message: 'Bring snacks' });
  const v6 = wrapAsV6Data(envelope);
  assertEq(v6.messageType, 'DATA', 'V6 messageType is DATA');
  assertEq(v6.version, '6.0', 'V6 version is 6.0');
  assertEq(v6.correlationId, envelope.requestId, 'correlationId matches requestId');
  assertTrue(v6.payload.coordination !== undefined, 'payload.coordination exists');
  assertEq(v6.payload.coordination.type, 'reminder-relay', 'coordination type preserved');
  assertTrue(Array.isArray(v6.topics) && v6.topics.includes('coordination'), 'topics includes coordination');
  assertEq(v6.sensitivity, 'public', 'reminder-relay: sensitivity is public');
}

// Sensitivity marking for sensitive types
{
  const prefEnv = createCoordinationMessage('preference-share', { category: 'food', value: 'Italian' });
  const prefV6 = wrapAsV6Data(prefEnv);
  assertEq(prefV6.sensitivity, 'private', 'preference-share: sensitivity is private');
}
{
  const recEnv = createCoordinationMessage('recommendation-response', { recommendations: ['Sushi'] });
  const recV6 = wrapAsV6Data(recEnv);
  assertEq(recV6.sensitivity, 'private', 'recommendation-response: sensitivity is private');
}
{
  const schedEnv = createCoordinationMessage('schedule-request', { date: '2026-04-20' });
  const schedV6 = wrapAsV6Data(schedEnv);
  assertEq(schedV6.sensitivity, 'public', 'schedule-request: sensitivity is public');
}
{
  const planEnv = createCoordinationMessage('group-plan-propose', { activity: 'Dinner' });
  const planV6 = wrapAsV6Data(planEnv);
  assertEq(planV6.sensitivity, 'public', 'group-plan-propose: sensitivity is public');
}

// ── Tests: parseCoordinationMessage ──────────────────────────────

console.log('\n🔍 parseCoordinationMessage');

{
  const envelope = createCoordinationMessage('schedule-request', { date: '2026-04-20' });
  const v6 = wrapAsV6Data(envelope);
  const result = parseCoordinationMessage(v6);
  assertTrue(result.valid, 'round-trip parse: valid (no trust check)');
  assertEq(result.coordination.type, 'schedule-request', 'round-trip parse: type preserved');
}

{
  const result = parseCoordinationMessage(null);
  assertTrue(!result.valid, 'null input: invalid');
}

{
  const result = parseCoordinationMessage({ payload: {} });
  assertTrue(!result.valid, 'no coordination field: invalid');
}

{
  // Expired message
  const envelope = createCoordinationMessage('schedule-request', { date: '2026-04-20' }, { expiryMs: -1000 });
  const v6 = wrapAsV6Data(envelope);
  const result = parseCoordinationMessage(v6);
  assertTrue(!result.valid, 'expired message: invalid');
  assertTrue(result.errors.some(e => e.includes('expired')), 'error mentions expired');
}

// Trust enforcement in parser
{
  const envelope = createCoordinationMessage('recommendation-request', { category: 'restaurant' });
  const v6 = wrapAsV6Data(envelope);
  // Allowed for personal trust
  const allowed = parseCoordinationMessage(v6, 'personal');
  assertTrue(allowed.valid, 'parse with personal trust: recommendation-request allowed');
  // Blocked for public trust
  const blocked = parseCoordinationMessage(v6, 'public');
  assertTrue(!blocked.valid, 'parse with public trust: recommendation-request blocked');
  assertTrue(blocked.errors.some(e => e.includes('not allowed')), 'parse trust error mentions not allowed');
  // No trust param — passes (backwards compat)
  const noTrust = parseCoordinationMessage(v6);
  assertTrue(noTrust.valid, 'parse without trustProfile: passes (no enforcement)');
}

{
  const envelope = createCoordinationMessage('preference-share', { category: 'food', value: 'Italian' });
  const v6 = wrapAsV6Data(envelope);
  const blocked = parseCoordinationMessage(v6, 'business');
  assertTrue(!blocked.valid, 'parse with business trust: preference-share blocked');
  const allowed = parseCoordinationMessage(v6, 'full');
  assertTrue(allowed.valid, 'parse with full trust: preference-share allowed');
}

// Oversized payload rejection on parse
{
  const hugePayload = { coordination: {
    type: 'preference-share',
    version: '1.0',
    requestId: 'over-id',
    payload: { category: 'test', value: 'x'.repeat(60000) },
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    createdAt: new Date().toISOString(),
  }};
  const result = parseCoordinationMessage(hugePayload);
  assertTrue(!result.valid, 'oversized coordination rejected on parse');
  assertTrue(result.errors.some(e => e.includes('size limit')), 'parse error mentions size limit');
}

// ── Tests: Request Tracking ──────────────────────────────────────

console.log('\n📝 Request Tracking');

{
  const pendingDir = makeTmpDir();
  const archiveDir = makeTmpDir();

  // Track a request
  const envelope = createCoordinationMessage('schedule-request', { date: '2026-04-20' });
  trackRequest(envelope, '0xPeer123', pendingDir);

  const pending = listPending(pendingDir);
  assertEq(pending.length, 1, 'one pending request');
  assertEq(pending[0].requestId, envelope.requestId, 'pending requestId matches');
  assertEq(pending[0].type, 'schedule-request', 'pending type matches');
  assertEq(pending[0].targetPeer, '0xPeer123', 'pending targetPeer matches');
  assertEq(pending[0].status, 'pending', 'status is pending');
  assertEq(pending[0].expectedResponse, 'schedule-response', 'expectedResponse is schedule-response');

  // Resolve the request
  const resolved = resolveRequest(envelope.requestId, 'resolved', pendingDir, archiveDir);
  assertTrue(resolved !== null, 'resolveRequest returns record');
  assertEq(resolved.status, 'resolved', 'resolved status');
  assertTrue(resolved.resolvedAt !== undefined, 'resolvedAt set');

  const pendingAfter = listPending(pendingDir);
  assertEq(pendingAfter.length, 0, 'no pending after resolve');

  const archived = readdirSync(archiveDir).filter(f => f.endsWith('.json'));
  assertEq(archived.length, 1, 'one archived request');

  cleanDir(pendingDir);
  cleanDir(archiveDir);
}

{
  // Non-request types should not be tracked
  const pendingDir = makeTmpDir();
  const envelope = createCoordinationMessage('reminder-ack', {});
  trackRequest(envelope, '0xPeer', pendingDir);
  assertEq(listPending(pendingDir).length, 0, 'reminder-ack not tracked (not a request type)');
  cleanDir(pendingDir);
}

{
  // Resolve non-existent request
  const pendingDir = makeTmpDir();
  const result = resolveRequest('non-existent-id', 'resolved', pendingDir);
  assertEq(result, null, 'resolveRequest returns null for non-existent');
  cleanDir(pendingDir);
}

// ── Tests: expirePending ─────────────────────────────────────────

console.log('\n⏰ expirePending');

{
  const pendingDir = makeTmpDir();
  const archiveDir = makeTmpDir();

  // Create an expired request
  const envelope = createCoordinationMessage('schedule-request', { date: '2026-04-20' }, { expiryMs: -1000 });
  trackRequest(envelope, '0xPeer', pendingDir);

  // Create a non-expired request
  const fresh = createCoordinationMessage('reminder-relay', { message: 'Hey' }, { expiryMs: 86400000 });
  trackRequest(fresh, '0xPeer', pendingDir);

  const result = expirePending(pendingDir, archiveDir);
  assertEq(result.expired, 1, 'one expired');
  assertEq(result.remaining, 1, 'one remaining');

  cleanDir(pendingDir);
  cleanDir(archiveDir);
}

// ── Tests: matchResponse ─────────────────────────────────────────

console.log('\n🔗 matchResponse');

{
  const pendingDir = makeTmpDir();
  const archiveDir = makeTmpDir();

  // Create and track a request
  const request = createCoordinationMessage('schedule-request', { date: '2026-04-20' });
  trackRequest(request, '0xBob', pendingDir);

  // Create a matching response
  const response = createCoordinationMessage('schedule-response', {
    slots: [{ start: '12:00', end: '14:00' }],
  }, { replyTo: request.requestId });

  const result = matchResponse(response, '0xBob', pendingDir, archiveDir);
  assertTrue(result.matched, 'response matched');
  assertEq(result.error, null, 'no error');
  assertEq(result.request.status, 'resolved', 'request resolved');

  cleanDir(pendingDir);
  cleanDir(archiveDir);
}

{
  const pendingDir = makeTmpDir();
  const archiveDir = makeTmpDir();

  // No replyTo
  const response = createCoordinationMessage('schedule-response', {
    slots: [{ start: '12:00' }],
  });
  const result = matchResponse(response, '0xBob', pendingDir, archiveDir);
  assertTrue(!result.matched, 'no replyTo: not matched');
  assertTrue(result.error.includes('No replyTo'), 'error mentions no replyTo');

  cleanDir(pendingDir);
  cleanDir(archiveDir);
}

{
  const pendingDir = makeTmpDir();
  const archiveDir = makeTmpDir();

  // Wrong response type
  const request = createCoordinationMessage('schedule-request', { date: '2026-04-20' });
  trackRequest(request, '0xBob', pendingDir);

  const wrongType = createCoordinationMessage('recommendation-response', {
    recommendations: ['Pizza'],
  }, { replyTo: request.requestId });

  const result = matchResponse(wrongType, '0xBob', pendingDir, archiveDir);
  assertTrue(!result.matched, 'wrong type: not matched');
  assertTrue(result.error.includes('Expected response type'), 'error mentions expected type');

  cleanDir(pendingDir);
  cleanDir(archiveDir);
}

{
  const pendingDir = makeTmpDir();
  const archiveDir = makeTmpDir();

  // Wrong sender
  const request = createCoordinationMessage('schedule-request', { date: '2026-04-20' });
  trackRequest(request, '0xBob', pendingDir);

  const response = createCoordinationMessage('schedule-response', {
    slots: [{ start: '12:00' }],
  }, { replyTo: request.requestId });

  const result = matchResponse(response, '0xEve', pendingDir, archiveDir);
  assertTrue(!result.matched, 'wrong sender: not matched');
  assertTrue(result.error.includes('unexpected peer'), 'error mentions unexpected peer');

  cleanDir(pendingDir);
  cleanDir(archiveDir);
}

// ── Tests: handleCoordinationMessage ─────────────────────────────

console.log('\n🎮 handleCoordinationMessage');

{
  const envelope = createCoordinationMessage('schedule-request', { date: '2026-04-20' });
  const v6 = wrapAsV6Data(envelope);
  const result = handleCoordinationMessage(v6, {
    senderPeer: '0xAlice',
    trustProfile: 'business',
  });
  assertEq(result.action, 'request', 'schedule-request → action: request');
  assertTrue(result.expectsResponse, 'expects response');
  assertEq(result.expectedResponseType, 'schedule-response', 'expected response type');
}

{
  // Trust boundary block
  const envelope = createCoordinationMessage('recommendation-request', { category: 'restaurant' });
  const v6 = wrapAsV6Data(envelope);
  const result = handleCoordinationMessage(v6, {
    senderPeer: '0xAlice',
    trustProfile: 'public',
  });
  assertEq(result.action, 'blocked', 'recommendation-request from public → blocked');
  assertEq(result.reason, 'trust-boundary', 'blocked reason is trust-boundary');
}

{
  // Notification (no response expected)
  const envelope = createCoordinationMessage('group-plan-finalize', {
    activity: 'Dinner',
    finalTime: '2026-04-20T19:00:00Z',
  });
  const v6 = wrapAsV6Data(envelope);
  const result = handleCoordinationMessage(v6, {
    senderPeer: '0xAlice',
    trustProfile: 'full',
  });
  assertEq(result.action, 'notification', 'finalize → action: notification');
  assertTrue(!result.expectsResponse, 'does not expect response');
}

{
  // Missing context
  const result = handleCoordinationMessage({}, { senderPeer: '', trustProfile: 'full' });
  assertEq(result.action, 'error', 'empty senderPeer → error');
}

{
  const result = handleCoordinationMessage({}, { senderPeer: '0xAlice', trustProfile: '' });
  assertEq(result.action, 'error', 'empty trustProfile → error');
}

{
  // Invalid coordination message
  const result = handleCoordinationMessage({ payload: { coordination: { type: 'fake' } } }, {
    senderPeer: '0xAlice',
    trustProfile: 'full',
  });
  assertEq(result.action, 'invalid', 'invalid message → action: invalid');
}

{
  // Response matching via handler
  const pendingDir = makeTmpDir();
  const archiveDir = makeTmpDir();

  const request = createCoordinationMessage('schedule-request', { date: '2026-04-20' });
  trackRequest(request, '0xBob', pendingDir);

  const response = createCoordinationMessage('schedule-response', {
    slots: [{ start: '12:00' }],
  }, { replyTo: request.requestId });
  const v6 = wrapAsV6Data(response);

  const result = handleCoordinationMessage(v6, {
    senderPeer: '0xBob',
    trustProfile: 'business',
    pendingDir,
    archiveDir,
  });
  assertEq(result.action, 'response-matched', 'matched response via handler');
  assertTrue(result.match.matched, 'match.matched is true');

  cleanDir(pendingDir);
  cleanDir(archiveDir);
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
