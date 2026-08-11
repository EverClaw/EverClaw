/**
 * Asset Classifier — deterministic four-asset memory classifier
 *
 * Implements the TencentDB Agent Memory four-asset taxonomy (OSSAI-010):
 *   Chat Memory  — episodic conversations (daily logs, session history)
 *   Skill        — procedural know-how (SKILL.md, playbooks, SOPs)
 *   LLM-Wiki     — semantic knowledge (MEMORY.md, references, research)
 *   Code-Graph   — code structure, symbols, callers, impact paths
 *
 * Deterministic only — NO LLM calls, no network, no external deps.
 * Local-first and PII-safe by construction ("own your inference").
 *
 * @module asset-classifier
 */

export const ASSETS = Object.freeze({
  CHAT: 'chat',
  SKILL: 'skill',
  WIKI: 'wiki',
  CODE: 'code',
});

export const ASSET_NAMES = Object.freeze({
  [ASSETS.CHAT]: 'Chat Memory',
  [ASSETS.SKILL]: 'Skill',
  [ASSETS.WIKI]: 'LLM-Wiki',
  [ASSETS.CODE]: 'Code-Graph',
});

const ALL_ASSETS = Object.values(ASSETS);

/** Code file extensions, matched against the basename only. */
const CODE_EXT_RE = /\.(mjs|cjs|js|ts|tsx|jsx|py|go|rs|java|sh)$/;

/**
 * Signal tables. Each entry boosts a class when the path segment matches.
 * Segment matches (exact segment or basename prefix) win over substring.
 */
const PATH_SIGNALS = [
  { asset: ASSETS.CHAT, patterns: ['daily', 'session', 'transcript', 'logs'] },
  { asset: ASSETS.SKILL, patterns: ['skills', 'playbook', 'sop', 'standardoperating'] },
  { asset: ASSETS.WIKI, patterns: ['references', 'research', 'wiki', 'knowledge', 'braindump', 'glossary'] },
  { asset: ASSETS.CODE, patterns: ['scripts', 'packages', 'tests', 'src', 'lib'] },
];

const TEXT_SIGNALS = [
  {
    asset: ASSETS.CHAT,
    // Episodic: conversations, decisions, who-said-when
    patterns: [
      'said', 'told me', 'asked', 'replied', 'conversation', 'session log',
      'decided', 'we agreed', 'on our call', 'chat history', 'this morning',
      'timestamp', 'daily', 'today', 'yesterday',
    ],
  },
  {
    asset: ASSETS.SKILL,
    // Procedural: how-to, steps, instructions
    patterns: [
      'how to', 'step by step', 'run this', 'execute', 'run the following',
      'procedure', 'workflow', 'install', 'deploy', 'playbook', 'sop',
      'then run', 'first,', 'next,', 'checklist', 'commands',
    ],
  },
  {
    asset: ASSETS.WIKI,
    // Semantic: definitions, facts, concepts, references
    patterns: [
      'what is', 'definition', 'concept', 'fact', 'reference', 'according to',
      'wiki', 'overview', 'background', 'notes on', 'explains', 'knowledge',
      'architecture', 'summary of', 'key point',
    ],
  },
  {
    asset: ASSETS.CODE,
    // Code: symbols, functions, callers, errors
    patterns: [
      'function', 'class ', 'method', 'variable', 'api ', 'endpoint',
      'callers', 'import ', 'module', 'error', 'exception', 'stack trace',
      'symbol', 'signature', 'refactor', 'bug', 'compile', 'regression',
    ],
  },
];

/**
 * Classify a file path into asset classes.
 * @param {string} path - File or directory path.
 * @returns {{[asset:string]:number}} Score map per asset (0 = no signal).
 */
export function classifyPath(path = '') {
  const scored = _emptyScores();
  if (!path) return scored;

  const lower = path.toLowerCase();
  // Word-joins (standard-operating / daily_log) must match the pattern tokens.
  // Normalize per-segment by stripping separators, THEN compare to the token
  // set — never a global substring, or 'src-notes' would false-positive 'src'.
  const segments = lower.split(/[\\/]/).filter(Boolean);
  // Strip the file extension before normalized comparison so 'standard-operating.md'
  // normalizes to 'standardoperating' (== the pattern token), not 'standardoperating.md'.
  const stripExt = (s) => s.replace(/\.[^.]+$/, '');
  const normSegments = segments.map((s) => stripExt(s).replace(/[_-]+/g, ''));
  const basename = segments[segments.length - 1] || '';

  for (const group of PATH_SIGNALS) {
    const cleaned = group.patterns;
    const segHit =
      segments.some((s) => cleaned.includes(s) || cleaned.includes(stripExt(s))) ||
      normSegments.some((s) => cleaned.includes(s)) ||
      cleaned.some((p) => p && basename.startsWith(p));
    if (segHit) {
      scored[group.asset] += 3;
    } else if (group.patterns.some((p) => lower.includes(p))) {
      scored[group.asset] += 1;
    }
  }

  // Code extension anchored to basename end — never substring anywhere.
  if (CODE_EXT_RE.test(basename)) scored[ASSETS.CODE] += 3;

  // Weak default: a bare "memory" path with no code/asset dir is knowledge-heavy.
  if (!Object.values(scored).some((v) => v > 0) && lower.includes('memory')) {
    scored[ASSETS.WIKI] += 1;
  }

  return scored;
}

/**
 * Classify free text (query/body/content) into asset classes.
 * @param {string} text - Text to classify.
 * @returns {{[asset:string]:number}} Score map per asset.
 */
export function classifyText(text = '') {
  const scored = _emptyScores();
  if (!text) return scored;

  const lower = text.toLowerCase();
  for (const group of TEXT_SIGNALS) {
    const hits = group.patterns.filter((p) => lower.includes(p)).length;
    if (hits > 0) scored[group.asset] += Math.min(hits, 4); // cap per class
  }

  // Query-intent morphology ties toward the right class.
  if (/\bsaid\b|\btold\b|\basked\b|\breplied\b/.test(lower) || /\bwhen\b|\byesterday\b|\btoday\b/.test(lower)) {
    scored[ASSETS.CHAT] += 1;
  }
  if (/\bhow do i\b|\bhow to\b|\bsteps?\b|\bprocedur|\bcommands?\b/.test(lower)) {
    scored[ASSETS.SKILL] += 1;
  }
  if (/\bwhat is\b|\bdefinition\b|\bfact\b|\baccording to\b|\breference\b/.test(lower)) {
    scored[ASSETS.WIKI] += 1;
  }
  if (/\bfunction\b|\bcallers?\b|\bsymbol\b|\berror\b|\bbug\b|\bimport\b/.test(lower)) {
    scored[ASSETS.CODE] += 1;
  }

  return scored;
}

/**
 * Classify a memory record combining path + text signals.
 * @param {Object} record - { path?, content?, metadata? }.
 * @returns {{[asset:string]:number}} Combined score map.
 */
export function classifyRecord(record = {}) {
  if (!record || typeof record !== 'object') return _emptyScores();

  const pathScore = classifyPath(record.path || record.file || '');
  const { content, text } = record;
  const body = content || text || record.metadata?.content || '';
  const textScore = classifyText(typeof body === 'string' ? body : '');
  const metadata = record.metadata || {};

  const combined = _emptyScores();
  for (const asset of ALL_ASSETS) {
    combined[asset] = (pathScore[asset] || 0) * 3 + (textScore[asset] || 0);
  }
  // Apply the metadata hint AFTER the per-asset loop so the +3 is exactly +3
  // (never multiplied by loop-remaining iterations or wiped by reassignment),
  // and only when it names a real asset (allowlist).
  if (ALL_ASSETS.includes(metadata.asset)) {
    combined[metadata.asset] += 3;
  }
  if (metadata.source === 'daily') combined[ASSETS.CHAT] += 1;

  return combined;
}

/**
 * Rank assets for a scored map, descending with stable tiebreak.
 * Tie order: wiki > skill > chat > code (knowledge-heavy default).
 * @param {{[asset:string]:number}} scored
 * @returns {string[]} Asset ids ordered best-first.
 */
export function rankAssets(scored = {}) {
  const order = [ASSETS.WIKI, ASSETS.SKILL, ASSETS.CHAT, ASSETS.CODE];
  return [...ALL_ASSETS].sort((a, b) => {
    const da = scored[a] || 0;
    const db = scored[b] || 0;
    if (da !== db) return db - da;
    return order.indexOf(a) - order.indexOf(b);
  });
}

/**
 * Best single asset for a scored map (ties → rankAssets[0] = wiki).
 */
export function bestAsset(scored = {}) {
  return rankAssets(scored)[0];
}

function _emptyScores() {
  return { [ASSETS.CHAT]: 0, [ASSETS.SKILL]: 0, [ASSETS.WIKI]: 0, [ASSETS.CODE]: 0 };
}

export default {
  ASSETS,
  ASSET_NAMES,
  classifyPath,
  classifyText,
  classifyRecord,
  rankAssets,
  bestAsset,
};