/**
 * rewards.mjs — Unit tests for the KAT-Coder RL reward patterns library.
 *
 * Run: node --test tests/rewards.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  DEFAULT_WEIGHTS,
  parallelToolCallPenalty,
  failedToolCallPenalty,
  emptyToolBlockPenalty,
  repetitionPenalty,
  hierarchicalCredit,
  scoreTrajectory,
} from '../scripts/lib/rewards.mjs';

describe('parallelToolCallPenalty', () => {
  it('returns 0 at or below the threshold', () => {
    assert.strictEqual(parallelToolCallPenalty({ toolCalls: [] }), 0);
    assert.strictEqual(
      parallelToolCallPenalty({ toolCalls: new Array(8).fill({}) }),
      0,
    );
  });

  it('rises non-linearly above the threshold, never exceeding 1', () => {
    const one = parallelToolCallPenalty({ toolCalls: new Array(9).fill({}) });
    const burst = parallelToolCallPenalty({ toolCalls: new Array(40).fill({}) });
    assert.ok(Math.abs(one - 0.2) < 1e-9, '1 over threshold pins at 0.2');
    assert.ok(burst >= 0.85, 'runaway burst should saturate high');
  });

  it('sanitizes NaN / negative threshold and handles malformed input', () => {
    assert.strictEqual(parallelToolCallPenalty({ toolCalls: 'nope' }), 0);
    assert.strictEqual(parallelToolCallPenalty({}), 0);
    // NaN threshold falls back to default (so a 9-call turn still penalizes).
    const nanThr = parallelToolCallPenalty({ toolCalls: new Array(9).fill({}), threshold: NaN });
    assert.ok(Math.abs(nanThr - 0.2) < 1e-9, 'NaN threshold uses default');
    // Negative / zero threshold: any call beyond 0 penalizes but never beyond [0,1].
    const zeroThr = parallelToolCallPenalty({ toolCalls: new Array(5).fill({}), threshold: 0 });
    assert.ok(zeroThr > 0 && zeroThr <= 1);
  });
});

describe('failedToolCallPenalty', () => {
  it('returns 0 when there are no calls', () => {
    assert.strictEqual(failedToolCallPenalty({ toolCalls: [] }), 0);
  });

  it('scores the failure fraction', () => {
    const calls = [{ ok: true }, { failed: true }, { status: 'error' }];
    const p = failedToolCallPenalty({ toolCalls: calls });
    assert.ok(Math.abs(p - 2 / 3) < 1e-9, '2 of 3 failed => ~0.667');
  });

  it('is 0 when nothing is marked failed', () => {
    const calls = [{ ok: true }, { status: 'ok' }];
    assert.strictEqual(failedToolCallPenalty({ toolCalls: calls }), 0);
  });

  it('respects failureScale', () => {
    const calls = [{ failed: true }, { failed: true }];
    assert.strictEqual(failedToolCallPenalty({ toolCalls: calls, failureScale: 0.5 }), 0.5);
  });

  it('recognizes error-, ok:false-, and status-FAILURE paths', () => {
    const calls = [
      { error: 'boom' },
      { ok: false },
      { status: 'FAILURE' },
      { status: 'ok' },   // NOT a failure
    ];
    const p = failedToolCallPenalty({ toolCalls: calls });
    assert.ok(Math.abs(p - 0.75) < 1e-9, '3 of 4 failed => 0.75');
  });

  it('does NOT treat empty error string as failure', () => {
    const p = failedToolCallPenalty({ toolCalls: [{ error: '' }, { error: 0 }, { failed: true }] });
    assert.ok(Math.abs(p - 1 / 3) < 1e-9, 'only the explicit failed:true counts');
  });
});

describe('emptyToolBlockPenalty', () => {
  it('is 0 with no blocks', () => {
    assert.strictEqual(emptyToolBlockPenalty({ toolBlocks: [] }), 0);
  });

  it('flags a block with an empty toolCalls array', () => {
    const p = emptyToolBlockPenalty({ toolBlocks: [{ toolCalls: [] }] });
    assert.ok(p > 0, 'empty toolCalls block should register');
  });

  it('flags an all-empty-calls block but not a populated one', () => {
    const p = emptyToolBlockPenalty({
      toolBlocks: [
        { toolCalls: [{ id: 'a', name: 'f', args: {} }] },   // args empty but has id/name -> NOT empty
        { toolCalls: [{}] },                                  // fully empty -> empty
      ],
    });
    assert.strictEqual(p, 0.5, '1 of 2 blocks empty => 0.5');
  });

  it('treats a malformed block as empty', () => {
    assert.strictEqual(emptyToolBlockPenalty({ toolBlocks: [null] }), 1);
  });
});

describe('repetitionPenalty', () => {
  it('is 0 for short or normal text', () => {
    assert.strictEqual(repetitionPenalty({ text: 'hello world' }), 0);
    assert.strictEqual(repetitionPenalty({ text: '' }), 0);
    assert.strictEqual(repetitionPenalty({}), 0);
  });

  it('penalizes a long continuous repetition run', () => {
    const p = repetitionPenalty({ text: 'error '.repeat(40) });
    assert.ok(p > 0.9, 'pathological repetition should saturate high');
  });

  it('caps very long input without crashing', () => {
    const p = repetitionPenalty({ text: 'x '.repeat(200_000) });
    assert.ok(p > 0 && p <= 1, 'large input saturates safely');
  });

  it('respects minRun', () => {
    const p = repetitionPenalty({
      text: 'a a a a a a a a a a',
      minRun: 20,
    });
    assert.strictEqual(p, 0, 'run under minRun => 0');
  });
});

describe('hierarchicalCredit', () => {
  it('is 0 on a success turn', () => {
    assert.strictEqual(hierarchicalCredit({ failed: false, partialProgress: 1 }), 0);
  });

  it('rewards meaningful progress on failed turns, bounded below failure penalty', () => {
    const c = hierarchicalCredit({ failed: true, partialProgress: 1 });
    assert.ok(c > 0 && c < 1, 'perfect progress recovers some but not all');
    assert.ok(c <= 0.5, 'bounded by (1 - failurePenalty) = 0.5');
  });

  it('is 0 on a failed turn with no progress', () => {
    assert.strictEqual(hierarchicalCredit({ failed: true, partialProgress: 0 }), 0);
  });
});

describe('scoreTrajectory — composer', () => {
  it('clean success gets the base reward', () => {
    const r = scoreTrajectory({ toolCalls: [{ ok: true }], toolBlocks: [], text: 'done', failed: false });
    assert.strictEqual(r.reward, DEFAULT_WEIGHTS.base);
  });

  it('parallel tool-call burst collapses the reward', () => {
    const calls = new Array(40).fill({ ok: true });
    const r = scoreTrajectory({ toolCalls: calls, toolBlocks: [], text: 'ok', failed: false });
    const expectedPenalty = parallelToolCallPenalty({ toolCalls: calls });
    assert.ok(r.components.parallelToolCall === expectedPenalty, 'component matches penalty fn');
    assert.ok(r.reward < 0.40, 'runaway parallel burst should heavily penalize (got ' + r.reward + ')');
  });

  it('failed turn with progress is higher than failed turn without progress', () => {
    const noProgress = scoreTrajectory({ toolCalls: [{ failed: true }], toolBlocks: [], text: '', failed: true, partialProgress: 0 });
    const progress = scoreTrajectory({ toolCalls: [{ failed: true }], toolBlocks: [], text: '', failed: true, partialProgress: 1 });
    assert.ok(progress.reward > noProgress.reward, 'hierarchical credit should lift the reward');
  });

  it('clamps reward to [-1,1]', () => {
    const bad = scoreTrajectory({
      toolCalls: [
        { failed: true }, { failed: true }, { failed: true }, { failed: true },
        { failed: true }, { failed: true }, { failed: true }, { failed: true },
        { failed: true }, { failed: true }, { failed: true }, { failed: true },
      ],
      toolBlocks: [{ toolCalls: [] }, null],
      text: 'x x x x x x x x x x x x x x x x x x x x x x x x x',
      failed: true,
      partialProgress: 0,
    });
    assert.ok(bad.reward >= -1 && bad.reward <= 1, 'reward stays in [-1,1]');
  });

  it('clamps reward to [-1,1] even with pathological weights > 1', () => {
    const boosted = scoreTrajectory(
      {
        toolCalls: new Array(40).fill({ failed: true }),
        toolBlocks: [null, null, null, null, null],
        text: 'x '.repeat(40),
        failed: true,
        partialProgress: 0,
      },
      { failedToolCall: 10, emptyToolBlock: 10, repetition: 10, parallelToolCall: 10 },
    );
    assert.ok(boosted.reward >= -1 && boosted.reward <= 1, 'boosted weights clamp to floor');
    assert.strictEqual(boosted.reward, -1, 'pathological weights hit the floor exactly');
  });

  it('respects weight overrides', () => {
    const turn = { toolCalls: new Array(40).fill({}), toolBlocks: [], text: 'ok', failed: false };
    const full = scoreTrajectory(turn);
    const none = scoreTrajectory(turn, { ...DEFAULT_WEIGHTS, parallelToolCall: 0 });
    assert.ok(none.reward > full.reward, 'zeroed parallel weight raises the reward');
    assert.strictEqual(none.reward, DEFAULT_WEIGHTS.base, 'no penalties => base reward');
  });

  it('sanitizes NaN and negative weights (no reward inversion)', () => {
    // A negative penalty weight is floored to 0 — it must NEVER flip a failed
    // turn into a reward. Result: the failed-tool penalty contributes nothing,
    // so the reward equals the base (safe floor), not max-plus.
    const neg = scoreTrajectory(
      { toolCalls: [{ failed: true }], toolBlocks: [], text: '', failed: true, partialProgress: 0 },
      { failedToolCall: -5 },
    );
    assert.strictEqual(neg.reward, DEFAULT_WEIGHTS.base, 'negative weight floors to 0, no inversion');
    assert.ok(neg.reward >= -1 && neg.reward <= 1);
    // NaN base must fall back to the default (1.0), not pin to the floor.
    const nanBase = scoreTrajectory({ toolCalls: [], toolBlocks: [], text: 'ok', failed: false }, { base: NaN });
    assert.strictEqual(nanBase.reward, DEFAULT_WEIGHTS.base, 'NaN base uses default');
  });

  it('hierarchicalCredit stays bounded even with weight > 1', () => {
    // With failurePenalty 0.5, credit must not exceed 0.5 even at perfect progress + weight 2.
    const c = hierarchicalCredit({ failed: true, partialProgress: 1, progressWeight: 2, failurePenalty: 0.5 });
    assert.ok(c <= 0.5, 'credit bounded by (1 - failurePenalty) even with weight > 1');
  });

  it('breaks down components and applied credit', () => {
    const r = scoreTrajectory({ toolCalls: [], toolBlocks: [], text: 'ok', failed: true, partialProgress: 0.5 });
    assert.ok('penaltyTotal' in r.breakdown);
    assert.ok('creditApplied' in r.breakdown);
    assert.ok(r.breakdown.creditApplied > 0, 'credit applied on failed+progress turn');
  });
});
