/**
 * Persistence for jev-bridge: an answer cache and a usage log.
 *
 * SQLite through `node:sqlite`, which is built into Node >= 22.5 — so the
 * bridge is still zero-dependency. It was chosen over JSON, CSV or JSONL for
 * one reason above the others: every Claude Code session spawns its OWN server
 * process, and they all share this one file. A JSON file rewritten on each
 * write loses whichever update lands second; SQLite in WAL mode is built for
 * concurrent writers. It also buys an indexed lookup, one-statement eviction
 * and one-statement roll-ups, all in a single file.
 *
 * When `node:sqlite` is unavailable — an older Node picked up from PATH — the
 * same interface is served from memory. The bridge keeps working and simply
 * forgets on exit, rather than failing to start.
 *
 * The cache stores ANSWERS keyed by a hash. It never stores the `state` or the
 * questions themselves, so the user's content is not retained on disk.
 */
import { createHash } from 'node:crypto';

const DAY = 86_400_000;
const KEY_VERSION = 2; // bump to orphan every existing cache key at once

/**
 * JSON with object keys sorted, so `{a,b}` and `{b,a}` hash alike.
 * Arrays keep their order: score levels are ORDERED, and reversing them is a
 * different question whose answer must never be served for the original.
 */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * One question reduced to its meaning. The id a caller chooses is deliberately
 * excluded: TypeSafe does not send ids to the model, so two requests differing
 * only in an id are the same question — and an LLM invents a new id every run,
 * which would otherwise miss the cache every time.
 */
export const questionFingerprint = (question) => canonical(question);

export function cacheKey(model, state, questions) {
  const asked = Object.values(questions).map(questionFingerprint).sort();
  return createHash('sha256').update(canonical({ v: KEY_VERSION, m: model, s: state, q: asked })).digest('hex');
}

const round3 = (n) => Math.round(n * 1000) / 1000;
const pad = (n) => String(n).padStart(2, '0');
const localDay = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** A call row with every column present, so node:sqlite never sees `undefined`. */
const row = (c) => ({
  ts: c.ts, requested_model: c.requested_model ?? null, resolved_model: c.resolved_model ?? null,
  cached: c.cached ? 1 : 0, questions: c.questions ?? 0,
  input_tokens: c.input_tokens ?? 0, output_tokens: c.output_tokens ?? 0,
  saved_input_tokens: c.saved_input_tokens ?? 0, saved_usd: c.saved_usd ?? 0,
  latency_ms: c.latency_ms ?? 0, cost_usd: c.cost_usd ?? 0, status: c.status ?? 0,
});

/**
 * @param {string|null} path  database file; null means memory
 * @param {object} opts
 * @param {object|null} opts.sqlite  the `node:sqlite` module, or null when unavailable
 */
export function openStore(path, { sqlite = null, ttlMs = 7 * DAY, maxEntries = 20_000, pruneEvery = 100 } = {}) {
  const o = { ttlMs, maxEntries, pruneEvery };
  return sqlite && path ? sqliteStore(path, sqlite, o) : memoryStore(o);
}

/* ── SQLite ──────────────────────────────────────────────────────────────── */

function sqliteStore(path, { DatabaseSync }, o) {
  const db = new DatabaseSync(path);
  // busy_timeout FIRST: switching to WAL needs a lock of its own, and a second
  // process opening at the same instant must wait for it, not fail on it.
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS cache (
      key             TEXT PRIMARY KEY,
      requested_model TEXT NOT NULL,
      resolved_model  TEXT NOT NULL,
      response        TEXT NOT NULL,
      created_at      INTEGER NOT NULL,
      last_hit_at     INTEGER NOT NULL,
      hits            INTEGER NOT NULL DEFAULT 0
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS cache_by_use ON cache (last_hit_at);

    CREATE TABLE IF NOT EXISTS aliases (
      requested TEXT PRIMARY KEY,
      resolved  TEXT NOT NULL,
      seen_at   INTEGER NOT NULL
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS calls (
      ts                 INTEGER NOT NULL,
      requested_model    TEXT,
      resolved_model     TEXT,
      cached             INTEGER NOT NULL,
      questions          INTEGER NOT NULL,
      input_tokens       INTEGER NOT NULL,
      output_tokens      INTEGER NOT NULL,
      saved_input_tokens INTEGER NOT NULL,
      saved_usd          REAL NOT NULL,
      latency_ms         REAL NOT NULL,
      cost_usd           REAL NOT NULL,
      status             INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS calls_by_time ON calls (ts);
  `);

  const q = {
    get: db.prepare(`SELECT c.response, c.resolved_model, c.created_at, a.resolved AS current
                     FROM cache c LEFT JOIN aliases a ON a.requested = c.requested_model WHERE c.key = ?`),
    touch: db.prepare('UPDATE cache SET last_hit_at = ?, hits = hits + 1 WHERE key = ?'),
    put: db.prepare(`INSERT OR REPLACE INTO cache (key, requested_model, resolved_model, response, created_at, last_hit_at, hits)
                     VALUES (?, ?, ?, ?, ?, ?, 0)`),
    alias: db.prepare('INSERT OR REPLACE INTO aliases (requested, resolved, seen_at) VALUES (?, ?, ?)'),
    expire: db.prepare('DELETE FROM cache WHERE created_at <= ?'),
    trim: db.prepare('DELETE FROM cache WHERE key IN (SELECT key FROM cache ORDER BY last_hit_at DESC LIMIT -1 OFFSET ?)'),
    record: db.prepare(`INSERT INTO calls (ts, requested_model, resolved_model, cached, questions, input_tokens, output_tokens,
                        saved_input_tokens, saved_usd, latency_ms, cost_usd, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`),
    totals: db.prepare(`SELECT COUNT(*) AS calls,
                          COALESCE(SUM(cached), 0) AS cache_hits,
                          COALESCE(SUM(1 - cached), 0) AS live_calls,
                          COALESCE(SUM(CASE WHEN cached = 0 AND status <> 200 THEN 1 ELSE 0 END), 0) AS errors,
                          COALESCE(SUM(input_tokens), 0) AS input_tokens,
                          COALESCE(SUM(output_tokens), 0) AS output_tokens,
                          COALESCE(SUM(cost_usd), 0) AS cost_usd,
                          COALESCE(SUM(saved_input_tokens), 0) AS saved_input_tokens,
                          COALESCE(SUM(saved_usd), 0) AS saved_usd,
                          AVG(CASE WHEN cached = 0 AND status = 200 THEN latency_ms END) AS avg_live_latency_ms
                        FROM calls WHERE ts >= ?`),
    byDay: db.prepare(`SELECT date(ts / 1000, 'unixepoch', 'localtime') AS day, COUNT(*) AS calls,
                         COALESCE(SUM(cached), 0) AS cache_hits, COALESCE(SUM(input_tokens), 0) AS input_tokens,
                         COALESCE(SUM(cost_usd), 0) AS cost_usd
                       FROM calls WHERE ts >= ? GROUP BY day ORDER BY day`),
    models: db.prepare(`SELECT resolved_model, COUNT(*) AS calls FROM calls
                        WHERE ts >= ? AND cached = 0 AND status = 200 GROUP BY resolved_model ORDER BY calls DESC`),
    entries: db.prepare('SELECT COUNT(*) AS n FROM cache'),
    bytes: db.prepare('SELECT page_count * page_size AS b FROM pragma_page_count(), pragma_page_size()'),
    clear: db.prepare('DELETE FROM cache'),
  };

  let puts = 0;
  const prune = (now) => {
    q.expire.run(now - o.ttlMs);
    q.trim.run(o.maxEntries);
  };

  return {
    kind: 'sqlite',
    getCached(key, now) {
      const hit = q.get.get(key);
      if (!hit) return null;
      if (hit.created_at <= now - o.ttlMs) return null; // too old
      if (hit.current && hit.current !== hit.resolved_model) return null; // the alias has moved on
      q.touch.run(now, key);
      return JSON.parse(hit.response);
    },
    putCached(key, requestedModel, response, now) {
      q.put.run(key, requestedModel, response.model, JSON.stringify(response), now, now);
      if (++puts % o.pruneEvery === 0) prune(now);
    },
    noteResolution(requested, resolved, now) {
      q.alias.run(requested, resolved, now);
    },
    recordCall(call) {
      const r = row(call);
      q.record.run(r.ts, r.requested_model, r.resolved_model, r.cached, r.questions, r.input_tokens, r.output_tokens,
        r.saved_input_tokens, r.saved_usd, r.latency_ms, r.cost_usd, r.status);
    },
    summary({ days = 7, now = Date.now() } = {}) {
      const since = now - days * DAY;
      const t = q.totals.get(since);
      return shape(t, q.byDay.all(since), q.models.all(since),
        { entries: q.entries.get().n, bytes: q.bytes.get().b }, days, o, 'sqlite');
    },
    prune,
    clearCache: () => q.clear.run().changes,
    close: () => db.close(),
  };
}

/* ── memory fallback — the same contract, forgotten on exit ─────────────── */

function memoryStore(o) {
  const cache = new Map();
  const aliases = new Map();
  const calls = [];
  let puts = 0;

  const prune = (now) => {
    for (const [k, e] of cache) if (e.created_at <= now - o.ttlMs) cache.delete(k);
    if (cache.size > o.maxEntries) {
      const byUse = [...cache.entries()].sort((a, b) => b[1].last_hit_at - a[1].last_hit_at);
      for (const [k] of byUse.slice(o.maxEntries)) cache.delete(k);
    }
  };

  return {
    kind: 'memory',
    getCached(key, now) {
      const e = cache.get(key);
      if (!e) return null;
      if (e.created_at <= now - o.ttlMs) return null;
      const current = aliases.get(e.requested_model);
      if (current && current !== e.resolved_model) return null;
      e.last_hit_at = now;
      e.hits++;
      return structuredClone(e.response);
    },
    putCached(key, requestedModel, response, now) {
      cache.set(key, { requested_model: requestedModel, resolved_model: response.model,
        response: structuredClone(response), created_at: now, last_hit_at: now, hits: 0 });
      if (++puts % o.pruneEvery === 0) prune(now);
    },
    noteResolution(requested, resolved) {
      aliases.set(requested, resolved);
    },
    recordCall(call) {
      calls.push(row(call));
    },
    summary({ days = 7, now = Date.now() } = {}) {
      const since = now - days * DAY;
      const w = calls.filter((c) => c.ts >= since);
      const sum = (f) => w.reduce((s, c) => s + f(c), 0);
      const live = w.filter((c) => !c.cached && c.status === 200);
      const t = {
        calls: w.length,
        cache_hits: sum((c) => c.cached),
        live_calls: sum((c) => 1 - c.cached),
        errors: w.filter((c) => !c.cached && c.status !== 200).length,
        input_tokens: sum((c) => c.input_tokens),
        output_tokens: sum((c) => c.output_tokens),
        cost_usd: sum((c) => c.cost_usd),
        saved_input_tokens: sum((c) => c.saved_input_tokens),
        saved_usd: sum((c) => c.saved_usd),
        avg_live_latency_ms: live.length ? live.reduce((s, c) => s + c.latency_ms, 0) / live.length : null,
      };
      const days_ = new Map();
      for (const c of w) {
        const d = localDay(c.ts);
        const a = days_.get(d) ?? { day: d, calls: 0, cache_hits: 0, input_tokens: 0, cost_usd: 0 };
        a.calls++; a.cache_hits += c.cached; a.input_tokens += c.input_tokens; a.cost_usd += c.cost_usd;
        days_.set(d, a);
      }
      const models = new Map();
      for (const c of live) models.set(c.resolved_model, (models.get(c.resolved_model) ?? 0) + 1);
      return shape(t, [...days_.values()].sort((a, b) => a.day.localeCompare(b.day)),
        [...models].map(([resolved_model, n]) => ({ resolved_model, calls: n })).sort((a, b) => b.calls - a.calls),
        { entries: cache.size, bytes: null }, days, o, 'memory');
    },
    prune,
    clearCache() { const n = cache.size; cache.clear(); return n; },
    close() {},
  };
}

/** One output shape for both stores, so a caller cannot tell them apart except by `store`. */
function shape(t, byDay, models, cacheInfo, days, o, store) {
  return {
    window_days: days,
    calls: t.calls,
    live_calls: t.live_calls,
    cache_hits: t.cache_hits,
    hit_rate: t.calls ? round3(t.cache_hits / t.calls) : 0,
    errors: t.errors,
    input_tokens: t.input_tokens,
    output_tokens: t.output_tokens,
    cost_usd: t.cost_usd,
    saved_input_tokens: t.saved_input_tokens,
    saved_usd: t.saved_usd,
    avg_live_latency_ms: t.avg_live_latency_ms == null ? null : Math.round(t.avg_live_latency_ms),
    by_day: byDay,
    models,
    cache: { ...cacheInfo, ttl_days: o.ttlMs / DAY, max_entries: o.maxEntries },
    store,
  };
}
