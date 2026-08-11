/**
 * memory-hub.test.mjs — Unit tests for the MemoryHub four-asset routing layer.
 *
 * Run: node --test tests/memory-hub.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import MemoryHub from '../scripts/lib/memory-hub.mjs';
import { ASSETS } from '../scripts/lib/asset-classifier.mjs';

/** Minimal fake backend implementing the MemoryBackend search()/status() surface. */
function makeFakeBackend(facts) {
  return {
    name: 'FakeBackend',
    async search(query = '', options = {}) {
      const limit = options.limit || 100;
      const q = query.toLowerCase();
      const results = facts
        .filter((f) => !q || (f.content || '').toLowerCase().includes(q) || (f.path || '').toLowerCase().includes(q))
        .slice(0, limit)
        .map((f, i) => ({
          id: `f-${i}`,
          content: f.content,
          score: 0.9,
          metadata: { source_file: f.path, source: f.source },
        }));
      return results;
    },
    async status() {
      return { healthy: true, factCount: facts.length, wings: { default: facts.length } };
    },
  };
}

const FACTS = [
  { path: 'memory/daily/2026-08-11.md', content: 'David said we agreed to ship auth yesterday.' },
  { path: 'skills/everclaw/SKILL.md', content: 'To deploy, run the install script step by step.' },
  { path: 'memory/references/architecture.md', content: 'What is the definition of a knowledge graph.' },
  { path: 'scripts/lib/memory-hub.mjs', content: 'The function processOrder has callers in module auth.' },
];

describe('MemoryHub', () => {
  it('requires a backend with search()', () => {
    assert.throws(() => new MemoryHub(null), /search/);
    assert.throws(() => new MemoryHub({}), /search/);
  });

  it('returns all results with asset labels', async () => {
    const hub = new MemoryHub(makeFakeBackend(FACTS));
    const results = await hub.search('');
    assert.ok(results.length >= 4, 'should return all facts');
    for (const r of results) {
      assert.ok([ASSETS.CHAT, ASSETS.SKILL, ASSETS.WIKI, ASSETS.CODE].includes(r.asset),
        'every result should carry an asset label');
    }
  });

  it('filters by asset class', async () => {
    const hub = new MemoryHub(makeFakeBackend(FACTS));
    const chat = await hub.search('', { asset: ASSETS.CHAT });
    assert.ok(chat.every((r) => r.asset === ASSETS.CHAT), 'all results should be Chat');
  });

  it('searchByAsset returns only that asset', async () => {
    const hub = new MemoryHub(makeFakeBackend(FACTS));
    const code = await hub.searchByAsset(ASSETS.CODE, '');
    assert.ok(code.every((r) => r.asset === ASSETS.CODE));
    assert.ok(code.length >= 1, 'should find the code fact');
  });

  it('searchByAsset throws on unknown asset', async () => {
    const hub = new MemoryHub(makeFakeBackend(FACTS));
    await assert.rejects(() => hub.searchByAsset('bogus', 'x'), /Unknown asset/);
  });

  it('assetSummary tallies real counts with sample cap separate from count', async () => {
    const hub = new MemoryHub(makeFakeBackend(FACTS));
    const summary = await hub.assetSummary({ sampleSize: 2 });
    const labels = Object.keys(summary.assets);
    assert.deepStrictEqual(labels.sort(), [ASSETS.CHAT, ASSETS.CODE, ASSETS.SKILL, ASSETS.WIKI].sort());
    // Count is true per-class total (1 each here), not the sample cap (2).
    assert.strictEqual(summary.assets[ASSETS.CHAT].count, 1);
    assert.strictEqual(summary.assets[ASSETS.CODE].count, 1);
    assert.strictEqual(summary.assets[ASSETS.WIKI].count, 1);
    assert.strictEqual(summary.assets[ASSETS.SKILL].count, 1);
    assert.strictEqual(summary.total, 4);
  });

  it('coerces non-string queries without throwing', async () => {
    const hub = new MemoryHub(makeFakeBackend(FACTS));
    const num = await hub.search(42);
    assert.ok(Array.isArray(num), 'numeric query should return an array');
    const obj = await hub.search({ q: 'x' });
    assert.ok(Array.isArray(obj), 'object query should return an array');
  });

  it('soft-route preserves backend score within an equal-weight asset', async () => {
    const scoredBackend = {
      name: 'Scored',
      async search() {
        return [
          { id: 'weak-chat', content: 'a', score: 0.1, metadata: { source_file: 'memory/daily/a.md' } },
          { id: 'strong-wiki', content: 'a', score: 0.99, metadata: { source_file: 'memory/references/strong.md' } },
        ];
      },
      async status() { return { healthy: true, factCount: 2 }; },
    };
    const hub = new MemoryHub(scoredBackend);
    const results = await hub.search('what is the definition'); // Wiki intent
    assert.strictEqual(results[0].id, 'strong-wiki', 'stronger backend score should win the tie');
  });

  it('assetSummary flags truncation when the cap binds', async () => {
    const many = Array.from({ length: 1000 }, (_, i) => ({
      path: 'memory/references/f.md',
      content: `fact ${i}`,
    }));
    const hub = new MemoryHub(makeFakeBackend(many));
    const summary = await hub.assetSummary({ limit: 1000 });
    assert.strictEqual(summary.truncated, true, 'cap-binding search should flag truncated');
  });

  it('honors searchTimeoutMs (times out a slow backend)', async () => {
    const slow = {
      name: 'Slow',
      async search() { return new Promise(() => {}); }, // never resolves
      async status() { return { healthy: true }; },
    };
    const hub = new MemoryHub(slow, { searchTimeoutMs: 50 });
    const start = Date.now();
    const results = await hub.search('x');
    assert.deepStrictEqual(results, [], 'timed-out search should return empty');
    assert.ok(Date.now() - start < 5000, 'should not hang');
  });

  it('soft-routes results by query intent (Chat query ranks Chat first)', async () => {
    // Unfiltered backend so soft-routing (which preserves ALL results and shifts
    // order by query intent) is actually exercised — a substring-filtering fake
    // would drop reordered multi-word queries to zero results.
    const unfiltered = {
      name: 'Unfiltered',
      async search() {
        return FACTS.map((f, i) => ({
          id: `f-${i}`,
          content: f.content,
          score: 0.9,
          metadata: { source_file: f.path, source: f.source },
        }));
      },
      async status() { return { healthy: true, factCount: FACTS.length }; },
    };
    const hub = new MemoryHub(unfiltered);
    const results = await hub.search('yesterday David said we agreed');
    assert.ok(results.length >= 1, 'should find results');
    assert.strictEqual(results[0].asset, ASSETS.CHAT, 'Chat-intent query should rank Chat first');
    assert.strictEqual(results[0].content, FACTS[0].content, 'the chat-session fact should sort first');
  });

  it('status surfaces a backend error instead of failing silently', async () => {
    const broken = {
      name: 'Broken',
      async search() { return []; },
      async status() { throw new Error('status blew up'); },
    };
    const hub = new MemoryHub(broken);
    const status = await hub.status();
    assert.strictEqual(status.healthy, false);
    assert.ok(status.error && status.error.includes('status blew up'), 'error should be surfaced');
  });

  it('gracefully degrades when backend search throws', async () => {
    const bad = { name: 'Bad', async search() { throw new Error('boom'); }, async status() { throw new Error('x'); } };
    const hub = new MemoryHub(bad);
    const results = await hub.search('anything');
    assert.deepStrictEqual(results, []);
    const status = await hub.status();
    assert.strictEqual(status.healthy, false);
  });

  it('handles a backend that returns results without metadata', async () => {
    const bare = {
      name: 'Bare',
      async search() { return [{ id: '1', content: 'a fact with no metadata' }]; },
      async status() { return { healthy: true, factCount: 1 }; },
    };
    const hub = new MemoryHub(bare);
    const results = await hub.search('fact');
    assert.ok(results.length === 1);
    assert.ok([ASSETS.CHAT, ASSETS.SKILL, ASSETS.WIKI, ASSETS.CODE].includes(results[0].asset));
  });
});