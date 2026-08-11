/**
 * MemoryHub — four-asset memory routing layer (OSSAI-010)
 *
 * Wraps any MemoryBackend and adds the TencentDB Agent Memory four-asset
 * taxonomy (Chat Memory / Skill / LLM-Wiki / Code-Graph) for retrieval and
 * discovery. Backends are untouched — MemoryHub is additive and opt-in.
 *
 * Local-first: uses the deterministic AssetClassifier, no LLM, no network.
 * Safe for trusted/local use only (empty-string search is bounded here).
 *
 * @module memory-hub
 */

import {
  ASSETS,
  ASSET_NAMES,
  classifyText,
  classifyRecord,
  rankAssets,
} from './asset-classifier.mjs';

const ALL_ASSETS = Object.values(ASSETS);
const MAX_SUMMARY_LIMIT = 1000;

export class MemoryHub {
  /**
   * @param {Object} backend - Any backend exposing search()/status() (MemoryBackend-compatible).
   * @param {Object} [options]
   * @param {number} [options.searchTimeoutMs=15000] - Per-search timeout (0 disables).
   */
  constructor(backend, options = {}) {
    if (!backend || typeof backend.search !== 'function') {
      throw new Error('MemoryHub requires a backend with a search() method');
    }
    this.backend = backend;
    this.timeout = options.searchTimeoutMs ?? 15_000;
  }

  /**
   * Full-text search across all assets, with optional query-intent ranking.
   * @param {string} query
   * @param {Object} [options] - { limit, asset, minScore }.
   * @returns {Promise<Array>} Ranked results with asset labels.
   */
  async search(query, options = {}) {
    const { asset, ...rest } = options;
    // Coerce non-strings early so intent ranking / class capping never throw
    // on object/number queries (classifyText assumes a string body).
    const q = String(query ?? '');
    const results = await this._safeSearch(q, rest);

    const labeled = results.map((r) => this._withAsset(r));
    const filtered = asset ? labeled.filter((r) => r.asset === asset) : labeled;
    if (asset || !q) return filtered;

    // Soft-route: prefer assets matching query intent (all results stay, order shifts).
    // Equal intent weight falls back to backend relevance score so a strong hit is
    // never buried beneath a weak hit just because of its asset class.
    const qRank = rankAssets(classifyText(q));
    const weight = Object.fromEntries(qRank.map((a, i) => [a, qRank.length - i]));
    return filtered.sort(
      (a, b) => (weight[b.asset] || 0) - (weight[a.asset] || 0) || (b.score ?? 0) - (a.score ?? 0)
    );
  }

  /**
   * Search scoped to a single asset class (Chat|Skill|Wiki|Code).
   * @param {string} assetId - One of ASSETS.* values.
   * @param {string} query
   * @param {Object} [options] - Passed through (limit, minScore, ...).
   * @returns {Promise<Array>}
   */
  async searchByAsset(assetId, query, options = {}) {
    if (!ALL_ASSETS.includes(assetId)) {
      throw new Error(`Unknown asset '${assetId}'. Valid: ${ALL_ASSETS.join(', ')}`);
    }
    return this.search(query, { ...options, asset: assetId });
  }

  /**
   * Classify backend memory into the four assets. Returns real per-asset counts
   * (bounded by the summary limit) plus a per-class sample for discovery/UI.
   * @param {Object} [options] - { sampleSize, limit }.
   * @returns {Promise<{assets:Object, entries:Object, total:number}>}
   */
  async assetSummary(options = {}) {
    const sampleSize = options.sampleSize || 5;
    // Clamp limit to a finite, non-negative integer <= MAX_SUMMARY_LIMIT so a
    // caller-passed -1 / NaN / Infinity never reaches the backend unguarded.
    const rawLimit = Number.isFinite(options.limit) ? options.limit : MAX_SUMMARY_LIMIT;
    const limit = Math.min(Math.max(0, rawLimit), MAX_SUMMARY_LIMIT);
    const raw = await this._safeSearch('', { limit });

    const counts = Object.fromEntries(ALL_ASSETS.map((a) => [a, 0]));
    const byAsset = Object.fromEntries(ALL_ASSETS.map((a) => [a, []]));

    for (const r of raw) {
      const classified = this._withAsset(r);
      counts[classified.asset] += 1;
      if (byAsset[classified.asset].length < sampleSize) {
        byAsset[classified.asset].push(classified);
      }
    }

    return {
      assets: Object.fromEntries(
        ALL_ASSETS.map((a) => [a, { label: ASSET_NAMES[a], count: counts[a] }])
      ),
      entries: byAsset,
      total: raw.length,
      // Empty-string search is a best-effort “list all” — some backends cap or
      // reject it, so counts may under-report. Flag truncation when the cap binds.
      truncated: raw.length >= limit,
    };
  }

  /**
   * Backend health + fact count (per-asset counts are best-effort and may be
   * unavailable from some backends).
   * @returns {Promise<Object>}
   */
  async status() {
    const status = await this._safeStatus();
    return {
      backend: this.backend.name || 'MemoryBackend',
      healthy: status?.healthy ?? false,
      factCount: status?.factCount ?? 0,
      error: status?.error ?? null,
    };
  }

  // --- Private ---

  async _safeSearch(query, options) {
    try {
      const result = await this._withTimeout(this.backend.search(query, options));
      return Array.isArray(result) ? result : [];
    } catch {
      return [];
    }
  }

  /** Race a promise against the configured timeout. 0/negative disables. */
  _withTimeout(promise) {
    if (!this.timeout || this.timeout <= 0) return promise;
    let timer;
    const p = Promise.resolve(promise);
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('search timeout')), this.timeout);
    });
    return Promise.race([p, timeout]).finally(() => {
      clearTimeout(timer);
      // The losing side (typically a slow backend) may reject after the timeout
      // wins — attach a no-op catch so Node never sees an unhandled rejection.
      p.catch(() => {});
    });
  }

  async _safeStatus() {
    try {
      return await this.backend.status();
    } catch (err) {
      return { healthy: false, factCount: 0, error: err?.message || 'status failed' };
    }
  }

  _withAsset(result) {
    // Only use real filepath metadata as a path hint. `metadata.source` is a
    // class-tag in classifyRecord (e.g. 'daily' -> +1 Chat), so using it as a
    // path fallback would collide ('daily' as a path boosts Chat twice).
    const record = {
      path: result.metadata?.source_file || result.path || null,
      content: result.content || '',
      metadata: result.metadata || {},
    };
    const scored = classifyRecord(record);
    return { ...result, asset: rankAssets(scored)[0] };
  }
}

export default MemoryHub;