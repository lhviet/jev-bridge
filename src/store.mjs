/**
 * Persistence for jev-bridge: an answer cache, a usage log, and a call history.
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
 * The cache stores ANSWERS keyed by hashes; it never stores the `state` or the
 * question text. The call history is what does, and only when its mode is
 * "full": see `openStore`.
 */
import { createHash, randomUUID } from 'node:crypto';
import { certainty, digest, preview } from './history.mjs';

const DAY = 86_400_000;
const KEY_VERSION = 2; // bump to orphan every existing cache key at once

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

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
 *
 * Hashed, because cached answers are stored under it: the canonical JSON itself
 * would put the question text on disk.
 */
export const questionFingerprint = (question) => sha256(canonical(question));

export function cacheKey(model, state, questions) {
  const asked = Object.values(questions).map(questionFingerprint).sort();
  return sha256(canonical({ v: KEY_VERSION, m: model, s: state, q: asked }));
}

const round3 = (n) => Math.round(n * 1000) / 1000;
const pad = (n) => String(n).padStart(2, '0');
const localDay = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const parse = (json) => (json === null || json === undefined ? null : JSON.parse(json));
const stderrLog = (m) => process.stderr.write(`[jev-bridge] ${m}\n`);

/** A call row with every column present, so node:sqlite never sees `undefined`. */
const row = (c) => ({
  ts: c.ts, requested_model: c.requested_model ?? null, resolved_model: c.resolved_model ?? null,
  cached: c.cached ? 1 : 0, questions: c.questions ?? 0,
  input_tokens: c.input_tokens ?? 0, output_tokens: c.output_tokens ?? 0,
  saved_input_tokens: c.saved_input_tokens ?? 0, saved_usd: c.saved_usd ?? 0,
  latency_ms: c.latency_ms ?? 0, cost_usd: c.cost_usd ?? 0, status: c.status ?? 0,
});

/* ── the history record, shared by both stores ───────────────────────────── */

export const HISTORY_MODES = ['full', 'meta', 'off'];

/** The columns a list of calls needs. The answers, the review detail and the content stay behind until one call is opened. */
const LEAN = ['id', 'ts', 'session', 'client', 'requested_model', 'resolved_model', 'cached', 'forced', 'status', 'error',
  'latency_ms', 'attempts', 'input_tokens', 'output_tokens', 'cost_usd', 'question_count', 'certainty', 'state_hash',
  'preview', 'digest', 'verdict', 'note', 'reviewed_at'];
const HISTORY_COLUMNS = [...LEAN.filter((c) => !['verdict', 'note', 'reviewed_at'].includes(c)), 'questions_hash', 'kept', 'answers'];

/**
 * What askJev handed over, turned into a row plus the content worth keeping.
 * This is the expensive part — hashing, serialising, scoring — and it runs when
 * the queue is flushed, after the answer has gone back to the caller.
 *
 * "full" keeps the state and questions, each stored once however often it is
 * sent. "meta" keeps timings, answers and hashes — enough to measure speed and
 * spot a re-sent state, not enough to read what was asked — and trims an error
 * to its first line, since an API's validation detail can quote the input.
 */
function historyRecord({ id, session, e }, mode) {
  const full = mode === 'full';
  const stateHash = e.state === undefined ? null : sha256(canonical(e.state));
  const questionsHash = e.questions === undefined ? null : sha256(canonical(e.questions));
  const error = e.error ? String(e.error) : null;
  return {
    row: {
      id, ts: e.ts, session, client: e.client ?? null,
      requested_model: e.requested_model ?? null, resolved_model: e.resolved_model ?? null,
      cached: e.cached ? 1 : 0, forced: e.forced ? 1 : 0, status: e.status ?? 0,
      error: error && (full ? error.slice(0, 4000) : error.split('\n')[0]),
      latency_ms: e.latency_ms ?? 0, attempts: e.attempts ?? null,
      input_tokens: e.input_tokens ?? 0, output_tokens: e.output_tokens ?? 0, cost_usd: e.cost_usd ?? 0,
      question_count: e.questions ? Object.keys(e.questions).length : 0,
      certainty: certainty(e.answers), state_hash: stateHash, questions_hash: questionsHash,
      preview: full ? preview(e.state) : null, digest: digest(e.answers),
      kept: full ? 1 : 0, answers: e.answers ? JSON.stringify(e.answers) : null,
    },
    payloads: full
      ? [[stateHash, JSON.stringify(e.state)], [questionsHash, JSON.stringify(e.questions)]].filter(([h, body]) => h && body !== undefined)
      : [],
  };
}

const lean = (r) => {
  const out = {};
  for (const c of LEAN) out[c] = r[c] ?? null;
  out.cached = !!r.cached;
  out.forced = !!r.forced;
  return out;
};
const whole = (r, stateBody, questionsBody) => ({
  ...lean(r),
  state: parse(stateBody),
  questions: parse(questionsBody),
  answers: parse(r.answers),
  expected: parse(r.expected),
});

/**
 * Writes that must not hold up an answer. They queue, and are written together
 * once the bridge falls idle: `idleMs` after the last call, and never later than
 * `maxWaitMs` after the first, or as soon as `maxItems` are waiting.
 *
 * Writing on the very next tick was measured and rejected: a client sending
 * calls back to back found each request queued behind the previous call's
 * commit, which added ~0.3 ms at the median and several at p95. Waiting for a
 * gap moves that work to where nobody is waiting, and turns a burst into one
 * transaction. Any read of the same store flushes first, so a process always
 * sees its own writes; the server also flushes on exit.
 */
function writeBehind(apply, log, { idleMs = 20, maxWaitMs = 500, maxItems = 100 } = {}) {
  let pending = [];
  let timer = null;
  let firstAt = 0;
  const flush = () => {
    clearTimeout(timer);
    timer = null;
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    try {
      apply(batch);
    } catch (err) {
      log(`could not save ${batch.length} usage/history record(s): ${err.message}`);
    }
  };
  return {
    push(item) {
      const now = performance.now();
      if (!pending.length) firstAt = now;
      pending.push(item);
      clearTimeout(timer);
      // Even a full queue waits for a timer, never flushing inline: the caller
      // is still on its way to sending an answer.
      const wait = pending.length >= maxItems ? 0 : Math.max(0, Math.min(idleMs, maxWaitMs - (now - firstAt)));
      timer = setTimeout(flush, wait);
    },
    flush,
  };
}

/**
 * @param {string|null} path  database file; null means memory
 * @param {object} opts
 * @param {object|null} opts.sqlite    the `node:sqlite` module, or null when unavailable
 * @param {'full'|'meta'|'off'} opts.history  how much of each call to keep for review
 * @param {number} opts.historyDays    unreviewed calls older than this are pruned
 * @param {number} opts.historyMax     unreviewed calls kept at most
 * @param {(msg: string) => void} opts.log  where a failed background write is reported
 */
export function openStore(path, {
  sqlite = null, ttlMs = 7 * DAY, maxEntries = 20_000, pruneEvery = 100,
  history = 'full', historyDays = 30, historyMax = 10_000, log = stderrLog,
} = {}) {
  if (!HISTORY_MODES.includes(history)) throw new Error(`history must be one of ${HISTORY_MODES.join(', ')} (got ${JSON.stringify(history)}).`);
  const o = { ttlMs, maxEntries, pruneEvery, history, historyMs: historyDays * DAY, historyMax, log, session: randomUUID().slice(0, 8) };
  return sqlite && path ? sqliteStore(path, sqlite, o) : memoryStore(o);
}

/** The id handed back as `bridge.call_id`: this process's session, then a counter. */
function callIds(session) {
  let n = 0;
  return () => `${session}-${++n}`;
}

/* ── SQLite ──────────────────────────────────────────────────────────────── */

/**
 * The first open of a new file switches it to WAL, and every process opening it
 * at that instant must upgrade a shared lock at once. SQLite refuses that with
 * SQLITE_BUSY rather than risk a deadlock — busy_timeout is never consulted — so
 * the switch is retried. Once one opener wins, the mode is stored in the file and
 * the others find it already set.
 */
function enableWal(db) {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 1; ; attempt++) {
    try {
      db.exec('PRAGMA journal_mode = WAL');
      return;
    } catch (err) {
      const busy = err?.errcode === 5 || /database is locked/.test(err?.message);
      if (!busy || attempt >= 40) throw err;
      Atomics.wait(pause, 0, 0, 5 + Math.random() * 20);
    }
  }
}

function sqliteStore(path, { DatabaseSync }, o) {
  const db = new DatabaseSync(path);
  // busy_timeout FIRST: once in WAL, a writer arriving mid-write must wait for
  // the lock, not fail on it.
  db.exec('PRAGMA busy_timeout = 5000');
  enableWal(db);
  db.exec('PRAGMA synchronous = NORMAL');
  // A deleted or pruned call is overwritten with zeros, not left readable in free pages.
  db.exec('PRAGMA secure_delete = ON');
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

    CREATE TABLE IF NOT EXISTS history (
      id              TEXT PRIMARY KEY,
      ts              INTEGER NOT NULL,
      session         TEXT NOT NULL,
      client          TEXT,
      requested_model TEXT,
      resolved_model  TEXT,
      cached          INTEGER NOT NULL,
      forced          INTEGER NOT NULL,
      status          INTEGER NOT NULL,
      error           TEXT,
      latency_ms      REAL NOT NULL,
      attempts        INTEGER,
      input_tokens    INTEGER NOT NULL,
      output_tokens   INTEGER NOT NULL,
      cost_usd        REAL NOT NULL,
      question_count  INTEGER NOT NULL,
      certainty       REAL,
      state_hash      TEXT,
      questions_hash  TEXT,
      kept            INTEGER NOT NULL,
      preview         TEXT,
      digest          TEXT,
      answers         TEXT,
      verdict         TEXT,
      note            TEXT,
      expected        TEXT,
      reviewed_at     INTEGER
    );
    CREATE INDEX IF NOT EXISTS history_by_time ON history (ts);

    -- A rowid table on purpose: bodies run to kilobytes, and SQLite's own
    -- guidance is that WITHOUT ROWID suits only small rows.
    CREATE TABLE IF NOT EXISTS payloads (
      hash TEXT PRIMARY KEY,
      body TEXT NOT NULL
    );
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

    histPut: db.prepare(`INSERT INTO history (${HISTORY_COLUMNS.join(', ')}) VALUES (${HISTORY_COLUMNS.map(() => '?').join(', ')})`),
    payloadPut: db.prepare('INSERT OR IGNORE INTO payloads (hash, body) VALUES (?, ?)'),
    histList: db.prepare(`SELECT ${LEAN.join(', ')} FROM history WHERE ts >= ? ORDER BY ts DESC, rowid DESC`),
    histGet: db.prepare(`SELECT h.*, s.body AS state_body, qs.body AS questions_body FROM history h
                         LEFT JOIN payloads s  ON h.kept = 1 AND s.hash  = h.state_hash
                         LEFT JOIN payloads qs ON h.kept = 1 AND qs.hash = h.questions_hash
                         WHERE h.id = ?`),
    histReview: db.prepare('UPDATE history SET verdict = ?, note = ?, expected = ?, reviewed_at = ? WHERE id = ?'),
    // A reviewed call is never pruned: it has become a labelled example.
    histExpire: db.prepare('DELETE FROM history WHERE ts < ? AND verdict IS NULL'),
    histTrim: db.prepare(`DELETE FROM history WHERE id IN (SELECT id FROM history WHERE verdict IS NULL
                          ORDER BY ts DESC, rowid DESC LIMIT -1 OFFSET ?)`),
    payloadOrphans: db.prepare(`DELETE FROM payloads WHERE hash NOT IN (
                                  SELECT state_hash FROM history WHERE kept = 1 AND state_hash IS NOT NULL
                                  UNION SELECT questions_hash FROM history WHERE kept = 1 AND questions_hash IS NOT NULL)`),
    histClear: db.prepare('DELETE FROM history'),
    payloadClear: db.prepare('DELETE FROM payloads'),
  };

  const pruneHistory = (now) => {
    q.histExpire.run(now - o.historyMs);
    q.histTrim.run(o.historyMax);
    q.payloadOrphans.run();
  };

  const writeCall = (call) => {
    const r = row(call);
    q.record.run(r.ts, r.requested_model, r.resolved_model, r.cached, r.questions, r.input_tokens, r.output_tokens,
      r.saved_input_tokens, r.saved_usd, r.latency_ms, r.cost_usd, r.status);
  };
  let sincePrune = 0;
  const writeHistory = (item) => {
    const { row: h, payloads } = historyRecord(item, o.history);
    for (const [hash, body] of payloads) q.payloadPut.run(hash, body);
    q.histPut.run(...HISTORY_COLUMNS.map((c) => h[c]));
    // Pruning at start-up alone would let one long session outgrow the limit.
    if (++sincePrune >= 500) { sincePrune = 0; pruneHistory(h.ts); }
  };

  // One transaction per batch. Each record is tried on its own, so one that
  // cannot be written — a history row, say — never takes the usage log with it.
  const queue = writeBehind((batch) => {
    db.exec('BEGIN');
    try {
      for (const { kind, value } of batch) {
        try {
          if (kind === 'call') writeCall(value); else writeHistory(value);
        } catch (err) {
          o.log(`could not save a ${kind === 'call' ? 'usage' : 'history'} record: ${err.message}`);
        }
      }
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* nothing was open */ }
      throw err;
    }
  }, o.log);
  const nextId = callIds(o.session);

  let puts = 0;
  const prune = (now) => {
    queue.flush();
    q.expire.run(now - o.ttlMs);
    q.trim.run(o.maxEntries);
    pruneHistory(now);
  };

  return {
    kind: 'sqlite',
    historyMode: o.history,
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
      queue.push({ kind: 'call', value: call });
    },
    /** Queues one call for the history and returns its id, or null when history is off. */
    recordHistory(e) {
      if (o.history === 'off') return null;
      const id = nextId();
      queue.push({ kind: 'history', value: { id, session: o.session, e } });
      return id;
    },
    listHistory({ since }) {
      queue.flush();
      return q.histList.all(since).map(lean);
    },
    getHistory(id) {
      queue.flush();
      const r = q.histGet.get(id);
      return r ? whole(r, r.state_body, r.questions_body) : null;
    },
    reviewHistory(id, { verdict, note, expected, reviewed_at }) {
      queue.flush();
      const expectedJson = expected === null || expected === undefined ? null : JSON.stringify(expected);
      return q.histReview.run(verdict, note, expectedJson, reviewed_at, id).changes > 0;
    },
    clearHistory() {
      queue.flush();
      const n = q.histClear.run().changes;
      q.payloadClear.run();
      // The write-ahead log still holds the pages as they were; fold it in and empty it.
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      return n;
    },
    summary({ days = 7, now = Date.now() } = {}) {
      queue.flush();
      const since = now - days * DAY;
      const t = q.totals.get(since);
      return shape(t, q.byDay.all(since), q.models.all(since),
        { entries: q.entries.get().n, bytes: q.bytes.get().b }, days, o, 'sqlite');
    },
    flush: queue.flush,
    prune,
    clearCache: () => q.clear.run().changes,
    close: () => { queue.flush(); db.close(); },
  };
}

/* ── memory fallback — the same contract, forgotten on exit ─────────────── */

function memoryStore(o) {
  const cache = new Map();
  const aliases = new Map();
  const calls = [];
  const history = new Map(); // id -> row, in insertion order
  const payloads = new Map(); // hash -> body
  let puts = 0;

  const pruneHistory = (now) => {
    for (const [id, h] of history) if (h.ts < now - o.historyMs && !h.verdict) history.delete(id);
    const open = [...history.values()].filter((h) => !h.verdict);
    for (const h of newestFirst(open).slice(o.historyMax)) history.delete(h.id);
    const used = new Set();
    for (const h of history.values()) if (h.kept) used.add(h.state_hash).add(h.questions_hash);
    for (const hash of payloads.keys()) if (!used.has(hash)) payloads.delete(hash);
  };

  let sincePrune = 0;
  const queue = writeBehind((batch) => {
    for (const { kind, value } of batch) {
      try {
        if (kind === 'call') { calls.push(row(value)); continue; }
        const { row: h, payloads: bodies } = historyRecord(value, o.history);
        for (const [hash, body] of bodies) if (!payloads.has(hash)) payloads.set(hash, body);
        history.set(h.id, { ...h, verdict: null, note: null, expected: null, reviewed_at: null });
        if (++sincePrune >= 500) { sincePrune = 0; pruneHistory(h.ts); }
      } catch (err) {
        o.log(`could not save a ${kind === 'call' ? 'usage' : 'history'} record: ${err.message}`);
      }
    }
  }, o.log);
  const nextId = callIds(o.session);

  const prune = (now) => {
    queue.flush();
    for (const [k, e] of cache) if (e.created_at <= now - o.ttlMs) cache.delete(k);
    if (cache.size > o.maxEntries) {
      const byUse = [...cache.entries()].sort((a, b) => b[1].last_hit_at - a[1].last_hit_at);
      for (const [k] of byUse.slice(o.maxEntries)) cache.delete(k);
    }
    pruneHistory(now);
  };

  return {
    kind: 'memory',
    historyMode: o.history,
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
      queue.push({ kind: 'call', value: call });
    },
    recordHistory(e) {
      if (o.history === 'off') return null;
      const id = nextId();
      queue.push({ kind: 'history', value: { id, session: o.session, e } });
      return id;
    },
    listHistory({ since }) {
      queue.flush();
      return newestFirst([...history.values()].filter((h) => h.ts >= since)).map(lean);
    },
    getHistory(id) {
      queue.flush();
      const h = history.get(id);
      if (!h) return null;
      const body = (hash) => (h.kept ? payloads.get(hash) ?? null : null);
      return whole(h, body(h.state_hash), body(h.questions_hash));
    },
    reviewHistory(id, { verdict, note, expected, reviewed_at }) {
      queue.flush();
      const h = history.get(id);
      if (!h) return false;
      Object.assign(h, { verdict, note, reviewed_at, expected: expected === null || expected === undefined ? null : JSON.stringify(expected) });
      return true;
    },
    clearHistory() {
      queue.flush();
      const n = history.size;
      history.clear();
      payloads.clear();
      return n;
    },
    summary({ days = 7, now = Date.now() } = {}) {
      queue.flush();
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
    flush: queue.flush,
    prune,
    clearCache() { const n = cache.size; cache.clear(); return n; },
    close() { queue.flush(); },
  };
}

/** Newest first; among calls in the same millisecond, the one recorded last comes first — as SQLite's rowid order gives. */
const newestFirst = (rows) => rows.reverse().sort((a, b) => b.ts - a.ts);

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
