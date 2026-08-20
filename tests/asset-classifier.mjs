/**
 * asset-classifier.test.mjs — Unit tests for the four-asset deterministic classifier.
 *
 * Run: node --test tests/asset-classifier.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  ASSETS,
  classifyPath,
  classifyText,
  classifyRecord,
  rankAssets,
  bestAsset,
} from '../scripts/lib/asset-classifier.mjs';
describe('Asset Classifier', () => {
  describe('classifyPath', () => {
    it('routes daily logs to Chat Memory', () => {
      const s = classifyPath('memory/daily/2026-08-11.md');
      assert.ok(s[ASSETS.CHAT] > 0, 'daily path should score Chat');
      assert.ok(s[ASSETS.CHAT] > s[ASSETS.WIKI], 'Chat should beat Wiki on daily path');
    });

    it('routes skills to Skill', () => {
      const s = classifyPath('skills/everclaw/SKILL.md');
      assert.ok(s[ASSETS.SKILL] > 0, 'skills path should score Skill');
      assert.ok(s[ASSETS.SKILL] > s[ASSETS.CHAT], 'Skill should lead on skills path');
    });

    it('routes references/research to LLM-Wiki', () => {
      const s = classifyPath('memory/references/architecture.md');
      assert.ok(s[ASSETS.WIKI] > 0, 'references path should score Wiki');
    });

    it('routes code paths to Code-Graph', () => {
      const s = classifyPath('scripts/lib/memory-hub.mjs');
      assert.ok(s[ASSETS.CODE] > 0, 'code path should score Code');
      assert.ok(s[ASSETS.CODE] > s[ASSETS.WIKI], 'Code should lead on .mjs path');
    });

    it('does NOT misroute a knowledge doc mentioning js in its name', () => {
      // Extension is anchored to basename end; 'js-guide.md' is not code.
      const s = classifyPath('docs/js-guide.md');
      assert.strictEqual(s[ASSETS.CODE], 0, 'md file should not score Code for .js substring');
    });

    it('routes .py/.sh code files to Code', () => {
      const s = classifyPath('scripts/bridge.py');
      assert.ok(s[ASSETS.CODE] > 0, 'python bridge should score Code');
    });

    it('matches word-join path variants (standard-operating)', () => {
      // Neutral parent (docs/) so the Skill score comes ONLY from word-join
      // normalization, not a coincidental 'playbook' pattern hit.
      const s = classifyPath('docs/standard-operating.md');
      assert.strictEqual(s[ASSETS.SKILL], 3, 'standard-operating.md should normalize to pattern standardoperating');
      const s2 = classifyPath('docs/standard_operating.md');
      assert.strictEqual(s2[ASSETS.SKILL], 3, 'standard_operating.md should normalize to Skill');
    });

    it('does not give a strong Code-Graph boost to a substring-only code dir', () => {
      // 'src-notes' is not a real code segment; it may get the weak +1 substring
      // signal but must NOT get the strong +3 segmented-dir boost.
      const s = classifyPath('memory/src-notes/overview.md');
      assert.ok(s[ASSETS.CODE] < 3, 'src-notes must not get the strong segment boost');
    });

    it('does not give a strong boost to short code tokens inside longer words', () => {
      // 'sop' inside 'sophisticated' and 'lib' inside 'library-guide' must NOT
      // get the strong +3 prefix boost; only the weak +1 substring signal is OK.
      // (src-notes.md IS a genuine source file, so Code +3 is defensible —
      //  tested separately in the segment test above.)
      const s = classifyPath('docs/sophisticated.md');
      assert.ok(s[ASSETS.SKILL] < 3, 'sophisticated must not get the strong Skill prefix boost');
      const l = classifyPath('docs/library-guide.md');
      assert.ok(l[ASSETS.CODE] < 3, 'library-guide must not get the strong Code prefix boost');
    });

    it('handles empty path without throwing', () => {
      const s = classifyPath('');
      assert.ok(typeof s[ASSETS.CHAT] === 'number');
    });
  });

  describe('classifyText', () => {
    it('detects conversational intent as Chat', () => {
      const s = classifyText('David said he decided to ship the auth module yesterday');
      assert.ok(s[ASSETS.CHAT] > 0, 'conversational text should score Chat');
      assert.ok(s[ASSETS.CHAT] > s[ASSETS.CODE], 'Chat should lead on conversational text');
    });

    it('detects procedural intent as Skill', () => {
      const s = classifyText('To deploy, run npm install then execute the bootstrap script step by step');
      assert.ok(s[ASSETS.SKILL] > 0, 'procedural text should score Skill');
      assert.ok(s[ASSETS.SKILL] > s[ASSETS.WIKI], 'Skill should lead on procedural text');
    });

    it('detects knowledge intent as Wiki', () => {
      const s = classifyText('What is the definition of a knowledge graph according to the reference');
      assert.ok(s[ASSETS.WIKI] > 0, 'knowledge text should score Wiki');
    });

    it('detects code intent as Code', () => {
      const s = classifyText('The function processOrder has callers in module auth and throws an exception');
      assert.ok(s[ASSETS.CODE] > 0, 'code text should score Code');
    });

    it('handles empty text', () => {
      const s = classifyText('');
      assert.strictEqual(s[ASSETS.CHAT], 0);
    });
  });

  describe('classifyRecord', () => {
    it('combines path and content signals', () => {
      const s = classifyRecord({
        path: 'memory/daily/2026-08-11.md',
        content: 'David said we agreed on the auth decision',
      });
      assert.ok(s[ASSETS.CHAT] > 0, 'record with daily path + convo content should score Chat');
    });

    it('respects metadata asset hint', () => {
      const s = classifyRecord({ content: 'x', metadata: { asset: ASSETS.CODE } });
      assert.ok(s[ASSETS.CODE] >= 3, 'metadata hint should boost Code');
    });

    it('adds +1 for daily source metadata exactly once', () => {
      const s = classifyRecord({ content: 'x', metadata: { source: 'daily' } });
      assert.strictEqual(s[ASSETS.CHAT], 1, 'daily source should add exactly +1 to Chat');
    });

    it('respects metadata asset hint (exactly +3 for each real asset)', () => {
      for (const a of [ASSETS.CHAT, ASSETS.SKILL, ASSETS.WIKI, ASSETS.CODE]) {
        const s = classifyRecord({ content: 'plain', metadata: { asset: a } });
        assert.strictEqual(s[a], 3, `hint ${a} must boost exactly +3`);
      }
    });

    it('ignores an invalid metadata asset hint (allowlist)', () => {
      const s = classifyRecord({ content: 'plain', metadata: { asset: 'not-a-real-asset' } });
      assert.strictEqual(s[ASSETS.WIKI], 0, 'bogus asset hint should not boost Wiki');
      assert.strictEqual(s[ASSETS.CODE], 0, 'bogus asset hint should not boost Code');
    });

    it('handles null/undefined record', () => {
      const s = classifyRecord(null);
      assert.strictEqual(Object.values(s).reduce((a, b) => a + b, 0), 0);
    });
  });

  describe('rankAssets / bestAsset', () => {
    it('returns best-first order with stable tiebreak', () => {
      const s = { [ASSETS.CHAT]: 2, [ASSETS.SKILL]: 2 };
      const ranked = rankAssets(s);
      assert.strictEqual(ranked[0], ASSETS.SKILL, 'Tie should prefer Skill over Chat');
      assert.strictEqual(bestAsset(s), ASSETS.SKILL);
    });

    it('returns wiki default on all-zero scores', () => {
      const s = { [ASSETS.CHAT]: 0, [ASSETS.SKILL]: 0, [ASSETS.WIKI]: 0, [ASSETS.CODE]: 0 };
      assert.strictEqual(bestAsset(s), ASSETS.WIKI);
    });
  });
});