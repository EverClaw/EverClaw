/**
 * KAT-Coder RL Reward Patterns — deterministic agent-behavior reward signals
 *
 * Reference implementation of the reward-design lessons from Kwaipilot's
 * KAT-Coder-V2.5-Dev RL post-mortem (OSSAI-016 / OSSAI-272; 69.4% SWE-bench
 * Verified). That work showed a BINARY 0-1 reward caused agentic collapse by
 * epoch 2 — 70+ parallel tool calls per turn, context explosion, invalid
 * trajectories — while hierarchical rewards + model-specific penalties kept RL
 * stable across 10 epochs (abnormal tool labels 9.34% → 0.28%, single-turn
 * repetition 0.34% → 0%).
 *
 * This module turns those FOUR penalty signals + hierarchical credit into pure,
 * deterministic, dependency-free scoring functions usable against any
 * normalized tool-call turn shape (real OpenClaw transcripts or fixtures).
 * It is a reference/behavior-scoring library — NOT a live RL loop. Additive and
 * opt-in: it touches no existing code path and adds no runtime dependency.
 *
 * @module rewards
 */

/** Reward-component keys (exported for composability/pinning). */
export const COMPONENTS = Object.freeze({
  PARALLEL_TOOL: 'parallelToolCall',
  FAILED_TOOL: 'failedToolCall',
  EMPTY_TOOL_BLOCK: 'emptyToolBlock',
  REPETITION: 'repetition',
  HIERARCHICAL_CREDIT: 'hierarchicalCredit',
});

/** Default coefficients. Parallel tool-call collapse was the leading indicator in
 * KAT-Coder, so it carries the highest penalty weight by default. Penalty weights
 * are independent and need not sum to 1 (penalties are not mutually exclusive). */
export const DEFAULT_WEIGHTS = Object.freeze({
  [COMPONENTS.PARALLEL_TOOL]: 0.70,
  [COMPONENTS.FAILED_TOOL]: 0.20,
  [COMPONENTS.EMPTY_TOOL_BLOCK]: 0.10,
  [COMPONENTS.REPETITION]: 0.15,
  credit: 0.5,        // max contribution of hierarchical credit to the reward
  base: 1.0,          // nominal reward before penalties when nothing is wrong
});

/** Default single-turn parallel tool-call threshold (the KAT-Coder collapse
 * signal was "excessive parallel calls in a turn"). */
export const DEFAULT_PARALLEL_THRESHOLD = 8;

/** Internal bounds. */
const MIN_SCORE = -1;
const MAX_SCORE = 1;

function clamp(n, lo = MIN_SCORE, hi = MAX_SCORE) {
  const x = Number(n);
  if (!Number.isFinite(x)) return lo;
  return Math.min(hi, Math.max(lo, x));
}

/** Coerce a numeric option to a finite number in [floor, +inf), else fallback. */
function numOpt(v, fallback, floor = -Infinity) {
  const x = Number(v);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(floor, x);
}
/** Largest-n token run length for repetition scoring (whitespace-aware). */
function longestRun(tokens) {
  if (!tokens.length) return 0;
  let best = 1;
  let cur = 1;
  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i] === tokens[i - 1]) {
      cur += 1;
      if (cur > best) best = cur;
    } else {
      cur = 1;
    }
  }
  return best;
}

/**
 * Penalty for excessive parallel tool calls in a single turn.
 * Uses a gentle saturating curve (fractional, no hard cliff): a couple calls
 * over threshold cost a little, but a runaway burst (the vendor's collapse
 * signal at 70+ calls) collapses toward 1.
 *
 * @param {object} opts
 * @param {Array}  opts.toolCalls       list of tool calls in the turn
 * @param {number} [opts.threshold=8]   parallel-call threshold to exceed
 * @param {number} [opts.penaltyScale=1] overall scale of the penalty
 * @returns {number} penalty in [0,1]
 */
export function parallelToolCallPenalty({
  toolCalls = [],
  threshold = DEFAULT_PARALLEL_THRESHOLD,
  penaltyScale = 1,
} = {}) {
  const n = Array.isArray(toolCalls) ? toolCalls.length : 0;
  const thr = numOpt(threshold, DEFAULT_PARALLEL_THRESHOLD, 0);
  const scale = numOpt(penaltyScale, 1, 0);
  if (n <= thr) return 0;
  // Fractional saturating curve: raw = 1 - 1/(1 + k*excess).
  // excess=1 => ~0.20, excess=5 => ~0.56, excess=40 => ~0.91.
  const excess = n - thr;
  const raw = 1 - 1 / (1 + 0.25 * excess);
  return clamp(raw * scale, 0, 1);
}

/**
 * Penalty proportional to the fraction of FAILED tool calls in a turn.
 * A call is failed when it carries an explicit `failed` truthy flag, or a
 * `status`/`error`/`ok` field signaling an execution error.
 *
 * @param {object} opts
 * @param {Array}  opts.toolCalls
 * @param {number} [opts.failureScale=1]
 * @returns {number} penalty in [0,1]
 */
export function failedToolCallPenalty({ toolCalls = [], failureScale = 1 } = {}) {
  const calls = Array.isArray(toolCalls) ? toolCalls : [];
  const scale = numOpt(failureScale, 1, 0);
  if (calls.length === 0) return 0;
  const failed = calls.filter((c) => {
    if (!c || typeof c !== 'object') return false;
    if (c.failed) return true;
    if (typeof c.status === 'string') {
      const s = c.status.toLowerCase();
      if (s === 'error' || s === 'failed' || s === 'failure') return true;
    }
    if (typeof c.error === 'string' && c.error.trim().length > 0) return true;
    if (typeof c.error === 'object' && c.error !== null) return true;
    if (typeof c.ok === 'boolean' && c.ok === false) return true;
    return false;
  }).length;
  const frac = failed / calls.length;
  return clamp(frac * scale, 0, 1);
}

/**
 * Penalty for EMPTY tool blocks: an assistant turn that emits a tool wrapper
 * with no actionable content. Matches the vendor's "empty tool-call blocks"
 * signal. A block is empty when its toolCalls array is empty, or every entry is
 * empty (no id, no name, and no args).
 *
 * @param {object} opts
 * @param {Array}  opts.toolBlocks
 * @param {number} [opts.penaltyScale=1]
 * @returns {number} penalty in [0,1]
 */
export function emptyToolBlockPenalty({ toolBlocks = [], penaltyScale = 1 } = {}) {
  const blocks = Array.isArray(toolBlocks) ? toolBlocks : [];
  const scale = numOpt(penaltyScale, 1, 0);
  if (blocks.length === 0) return 0;

  const isEmptyCallArgs = (args) => {
    if (args === undefined || args === null) return true;
    if (typeof args === 'object' && Object.keys(args).length === 0) return true;
    return false;
  };
  const isEmptyCall = (c) => {
    if (!c || typeof c !== 'object') return true;
    const hasId = typeof c.id === 'string' && c.id.trim().length > 0;
    const hasName = typeof c.name === 'string' && c.name.trim().length > 0;
    const hasArgs = typeof c.args !== 'undefined' && !isEmptyCallArgs(c.args);
    return !hasId && !hasName && !hasArgs;
  };

  const emptyBlocks = blocks.filter((b) => {
    if (!b || typeof b !== 'object') return true; // malformed block == empty
    const calls = Array.isArray(b.toolCalls) ? b.toolCalls : [];
    if (calls.length === 0) return true;
    return calls.every(isEmptyCall);
  }).length;

  const frac = emptyBlocks / blocks.length;
  return clamp(frac * scale, 0, 1);
}

/**
 * Penalty for large amounts of repeated content in a single turn
 * ("single-turn continuous repetition" signal). Uses the longest run of a
 * repeated whitespace-normalized token. Penalty is 0 below `minRun`, rises
 * non-linearly toward 1 for pathological repetition (> ~ 5× minRun).
 *
 * @param {object} opts
 * @param {string} opts.text    assistant turn text (or joined content)
 * @param {number} [opts.minRun=6]   minimum token run required to register
 * @param {number} [opts.penaltyScale=1]
 * @returns {number} penalty in [0,1]
 */
export function repetitionPenalty({ text = '', minRun = 6, penaltyScale = 1 } = {}) {
  if (typeof text !== 'string' || text.trim().length === 0) return 0;
  const scale = numOpt(penaltyScale, 1, 0);
  const minR = numOpt(minRun, 6, 1);
  const MAX_CHARS = 100_000;
  const slice = text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text;
  const tokens = slice.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const run = longestRun(tokens);
  if (run < minR) return 0;
  // run/minRun ratio; saturate near 1 for runs ≥ ~5× minRun (pathological).
  const ratio = run / minR;
  const raw = 1 - Math.pow(0.5, ratio - 1);
  return clamp(raw * scale, 0, 1);
}

/**
 * Hierarchical credit: partial reward for an unsuccessful trajectory that still
 * made meaningful progress. This is the KAT-Coder anti-collapse "credit for
 * meaningful progress" pattern — the model is not punished to 0 just because the
 * final outcome failed, as long as it reduced failures / advanced.
 *
 * Returns credit in [0,1]. With `failed=false` the turn is a success and credit
 * is ignored by the composer (full base reward applies).
 *
 * @param {object} opts
 * @param {boolean} opts.failed
 * @param {number}  [opts.partialProgress=0] 0..1 how much meaningful progress
 * @param {number}  [opts.progressWeight=1]
 * @param {number}  [opts.failurePenalty=0.5] cap on credit when failed
 * @returns {number}
 */
export function hierarchicalCredit({
  failed,
  partialProgress = 0,
  progressWeight = 1,
  failurePenalty = 0.5,
} = {}) {
  if (failed !== true) return 0; // success path: no residual-credit signal needed
  const p = clamp(typeof partialProgress === 'number' ? partialProgress : 0, 0, 1);
  const pw = numOpt(progressWeight, 1, 0);
  const fp = clamp(numOpt(failurePenalty, 0.5, 0), 0, 1);
  const raw = p * pw;
  // Even perfect progress can't fully recover the failure penalty — bounded by
  // (1 - failurePenalty) so failure still costs the model, but not to 0. The
  // clamp to (1-fp) upper-bound keeps the guarantee real even when weight > 1.
  return clamp(raw * (1 - fp), 0, 1 - fp);
}

/**
 * Compose all signals into a single scalar reward in [-1,1].
 *
 *   reward = base - Σ(penalties × weight) + hierarchy_credit × credit_weight
 *
 * clamped to [-1,1] for stable RL. Returns both the scalar and a per-component
 * breakdown for inspectability / trajectory analysis (the vendor's own
 * recommendation: analyze early runs for pathological behaviors).
 *
 * @param {object} turn   normalized turn: { toolCalls, toolBlocks, text, failed, partialProgress }
 * @param {object} [weights]  override DEFAULT_WEIGHTS
 * @returns {{reward:number, components:Object, breakdown:Object}}
 */
export function scoreTrajectory(turn = {}, weights = DEFAULT_WEIGHTS) {
  const src = { ...DEFAULT_WEIGHTS, ...(weights || {}) };
  // Sanitize every weight at merge (Cross-Model audit): NaN/string weights
  // silently pin the reward, and NEGATIVE penalty weights flip penalties into
  // rewards (a fully-failed turn could get max reward). Floor penalties/credit
  // at 0 so sign can never invert; allow base to go negative legitimately.
  const w = {
    [COMPONENTS.PARALLEL_TOOL]: numOpt(src[COMPONENTS.PARALLEL_TOOL], DEFAULT_WEIGHTS[COMPONENTS.PARALLEL_TOOL], 0),
    [COMPONENTS.FAILED_TOOL]: numOpt(src[COMPONENTS.FAILED_TOOL], DEFAULT_WEIGHTS[COMPONENTS.FAILED_TOOL], 0),
    [COMPONENTS.EMPTY_TOOL_BLOCK]: numOpt(src[COMPONENTS.EMPTY_TOOL_BLOCK], DEFAULT_WEIGHTS[COMPONENTS.EMPTY_TOOL_BLOCK], 0),
    [COMPONENTS.REPETITION]: numOpt(src[COMPONENTS.REPETITION], DEFAULT_WEIGHTS[COMPONENTS.REPETITION], 0),
    credit: numOpt(src.credit, DEFAULT_WEIGHTS.credit, 0),
    base: numOpt(src.base, DEFAULT_WEIGHTS.base),
  };

  const pParallel = parallelToolCallPenalty({ toolCalls: turn.toolCalls });
  const pFailed = failedToolCallPenalty({ toolCalls: turn.toolCalls });
  const pEmpty = emptyToolBlockPenalty({ toolBlocks: turn.toolBlocks });
  const pRep = repetitionPenalty({ text: turn.text });
  const credit = hierarchicalCredit({
    failed: turn.failed,
    partialProgress: turn.partialProgress,
  });

  const penaltyTotal =
    pParallel * w[COMPONENTS.PARALLEL_TOOL] +
    pFailed * w[COMPONENTS.FAILED_TOOL] +
    pEmpty * w[COMPONENTS.EMPTY_TOOL_BLOCK] +
    pRep * w[COMPONENTS.REPETITION];

  let reward = w.base - penaltyTotal;

  // For success turns, hierarchical credit is 0 (no residual-credit needed).
  // For failed turns, add back a bounded amount of recovered credit reflecting
  // meaningful progress on an otherwise unsuccessful trajectory.
  const creditApplied = turn.failed === true ? credit * w.credit : 0;
  reward = reward + creditApplied;

  reward = clamp(reward);

  return {
    reward,
    components: {
      parallelToolCall: pParallel,
      failedToolCall: pFailed,
      emptyToolBlock: pEmpty,
      repetition: pRep,
      hierarchicalCredit: credit,
    },
    breakdown: {
      penaltyTotal,
      creditApplied,
      weights: w,
    },
  };
}
