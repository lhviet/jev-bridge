/**
 * Reading the call history: which calls deserve a second look, and the numbers
 * that say whether calls were fast, cheap, batched — and right.
 *
 * Pure functions over the rows a store hands back, so the SQLite store and the
 * memory fallback share one definition of every statistic. Nothing here runs
 * while an answer is being produced.
 */

const DAY = 86_400_000;
const round2 = (n) => Math.round(n * 100) / 100;
const round3 = (n) => Math.round(n * 1000) / 1000;

export const VERDICTS = ['correct', 'partial', 'incorrect'];

/**
 * How sure Jev was, 0..1, taken from its LEAST sure answer — one shaky answer
 * among confident ones is exactly what a reviewer should see first.
 *
 * A noul has no separate confidence, so its distance from 0.5 stands in: 0.5 is
 * 0, and 0.95 or 0.05 is 0.9. A choice or a score carries Jev's own confidence.
 */
export function certainty(answers) {
  let least = null;
  for (const a of Object.values(answers ?? {})) {
    const c = a?.type === 'noul'
      ? (typeof a.noul === 'number' ? Math.abs(2 * a.noul - 1) : null)
      : (typeof a?.confidence === 'number' ? a.confidence : null);
    if (c !== null && (least === null || c < least)) least = c;
  }
  return least === null ? null : round3(least);
}

/** Every answer on one line, `id=value`, so a list of calls can be read at a glance. */
export function digest(answers) {
  if (!answers) return null;
  const value = (a) => (a?.type === 'noul' ? a.noul : a?.type === 'choice' ? a.choice : a?.type === 'score' ? a.score : undefined);
  return Object.entries(answers).map(([id, a]) => `${id}=${value(a) ?? '?'}`).join(', ') || null;
}

/** The start of the state, whitespace folded, for telling calls apart in a list. */
export function preview(state, max = 160) {
  if (state === undefined || state === null) return null;
  const flat = (typeof state === 'string' ? state : JSON.stringify(state)).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/* ── choosing calls ──────────────────────────────────────────────────────── */

const ok = (r) => r.status === 200;
const liveOk = (r) => !r.cached && ok(r);

const FILTERS = {
  all: () => true,
  live: (r) => !r.cached,
  cached: (r) => r.cached,
  errors: (r) => !ok(r),
  uncertain: (r, below) => r.certainty !== null && r.certainty < below,
  slow: liveOk,
  unreviewed: (r) => ok(r) && !r.verdict,
  reviewed: (r) => !!r.verdict,
  correct: (r) => r.verdict === 'correct',
  partial: (r) => r.verdict === 'partial',
  incorrect: (r) => r.verdict === 'incorrect',
};
export const FILTER_NAMES = Object.keys(FILTERS);

/** Newest first, except where the filter exists to rank: least certain, or slowest. */
const ORDER = {
  uncertain: (a, b) => a.certainty - b.certainty,
  slow: (a, b) => b.latency_ms - a.latency_ms,
};

function select(rows, { filter, below, q }) {
  const keep = FILTERS[filter];
  if (!keep) throw new Error(`filter must be one of ${FILTER_NAMES.join(', ')} (got ${JSON.stringify(filter)}).`);
  const needle = q ? String(q).toLowerCase() : null;
  const picked = rows.filter((r) => keep(r, below)
    && (!needle || `${r.preview ?? ''}\n${r.digest ?? ''}`.toLowerCase().includes(needle)));
  return ORDER[filter] ? picked.sort(ORDER[filter]) : picked;
}

/* ── the numbers ─────────────────────────────────────────────────────────── */

/** Nearest-rank percentiles: every value reported is one that actually happened. */
function spread(values) {
  if (!values.length) return { p50: null, p95: null, max: null };
  const s = [...values].sort((a, b) => a - b);
  const at = (p) => s[Math.max(0, Math.ceil((p * s.length) / 100) - 1)];
  return { p50: at(50), p95: at(95), max: s[s.length - 1] };
}

function stats(rows, below) {
  const live = rows.filter(liveOk);
  const hits = rows.filter((r) => r.cached);

  // A live call re-sending a state already sent live in this window paid to
  // ingest it twice; its questions could have ridden in the earlier call. A
  // forced refresh (`cache: false`) is deliberate, so it is not counted.
  const seen = new Set();
  let resent = 0;
  for (const r of [...live].sort((a, b) => a.ts - b.ts)) {
    if (!r.state_hash) continue;
    if (seen.has(r.state_hash) && !r.forced) resent++;
    seen.add(r.state_hash);
  }

  const reviewed = rows.filter((r) => r.verdict);
  const count = (v) => reviewed.filter((r) => r.verdict === v).length;

  return {
    calls: rows.length,
    live_calls: rows.filter((r) => !r.cached).length,
    cache_hits: hits.length,
    errors: rows.filter((r) => !ok(r)).length,
    performance: {
      live_latency_ms: spread(live.map((r) => r.latency_ms)),
      cached_latency_ms: spread(hits.map((r) => r.latency_ms)),
      input_tokens: rows.reduce((s, r) => s + r.input_tokens, 0),
      cost_usd: rows.reduce((s, r) => s + r.cost_usd, 0),
    },
    efficiency: {
      hit_rate: rows.length ? round3(hits.length / rows.length) : 0,
      questions_per_live_call: live.length ? round2(live.reduce((s, r) => s + r.question_count, 0) / live.length) : null,
      resent_state_calls: resent,
      retried_calls: rows.filter((r) => r.attempts > 1).length,
    },
    quality: {
      below,
      uncertain: rows.filter((r) => FILTERS.uncertain(r, below)).length,
      reviewed: reviewed.length,
      correct: count('correct'),
      partial: count('partial'),
      incorrect: count('incorrect'),
      accuracy: reviewed.length ? round3(count('correct') / reviewed.length) : null,
    },
  };
}

/** A call as a list shows it: enough to recognise it and judge it, not the whole state. */
const present = (r) => ({
  id: r.id,
  at: new Date(r.ts).toISOString(),
  ts: r.ts,
  model: r.resolved_model ?? r.requested_model,
  cached: r.cached,
  status: r.status,
  latency_ms: r.latency_ms,
  cost_usd: r.cost_usd,
  input_tokens: r.input_tokens,
  questions: r.question_count,
  certainty: r.certainty,
  verdict: r.verdict,
  preview: r.preview,
  answers: r.digest,
  ...(r.error && { error: r.error }),
});

/**
 * The one read every surface shares — the MCP tool, the command line and the
 * dashboard: stats over the whole window, plus the calls the filter picks.
 */
export function historyReport(store, { days = 7, filter = 'all', below = 0.6, q, limit = 50, now = Date.now() } = {}) {
  const rows = store.listHistory({ since: now - days * DAY });
  const picked = select(rows, { filter, below, q });
  return {
    window_days: days,
    filter,
    history: store.historyMode,
    stats: stats(rows, below),
    total: picked.length,
    calls: picked.slice(0, limit).map(present),
  };
}

/**
 * Record what a person or an agent found out about a call. `verdict: null`
 * withdraws the review. A reviewed call outlives the retention window: it has
 * become a labelled example, which is worth more than the unlabelled rest.
 */
export function reviewCall(store, id, { verdict = null, note = null, expected = null } = {}, now = Date.now()) {
  if (verdict !== null && !VERDICTS.includes(verdict)) {
    throw new Error(`verdict must be one of ${VERDICTS.join(', ')}, or null to withdraw a review (got ${JSON.stringify(verdict)}).`);
  }
  if (note !== null && typeof note !== 'string') throw new Error('note must be a string.');
  if (expected !== null && (typeof expected !== 'object' || Array.isArray(expected))) {
    throw new Error('expected must be an object mapping question ids to the answer each should have been.');
  }
  const review = verdict === null
    ? { verdict: null, note: null, expected: null, reviewed_at: null }
    : { verdict, note: note ? note.slice(0, 4000) : null, expected, reviewed_at: now };
  if (!store.reviewHistory(id, review)) {
    throw new Error(`No call "${id}" in the history. It may have been pruned, or history may be off.`);
  }
  return store.getHistory(id);
}
