/**
 * Tests for the call history.  Run:  npm test   (or: node --test)
 *
 * Two promises are under test. A reviewer can later see what was asked, what
 * came back, how long it took and what it cost — and keeping that record never
 * slows down or breaks the answer itself. As in the main suite, only the
 * TypeSafe API is faked.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';

import { openStore } from '../src/store.mjs';
import { askJev } from '../src/server.mjs';
import { certainty, historyReport, reviewCall } from '../src/history.mjs';
import { startUi } from '../src/ui.mjs';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

let sqlite = null;
try { sqlite = await import('node:sqlite'); } catch { /* older Node */ }
const noSqlite = !sqlite && 'node:sqlite needs Node >= 22.5';

/* A real response from jev-1.13.0, captured 2026-09-20 — every documented field. */
const REAL = {
  model: 'jev-1.13.0',
  answers: {
    is_urgent: { type: 'noul', noul: 0.95 },
    department: { type: 'choice', choice: 'billing', confidence: 0.8, probabilities: { sales: 0.0, technical: 0.13, billing: 0.87 } },
    frustration: {
      type: 'score', score: 1.05, confidence: 0.92,
      legend: { 0: 'Calm', 1: 'Frustrated', 2: 'Very angry' },
      probabilities: { 0: 0.0, 1: 0.95, 2: 0.05 },
    },
  },
  usage: { input_tokens: 399, output_tokens: 73 },
};
const STATE = 'Help! My payouts have been failing for 3 days.';
const QUESTIONS = {
  is_urgent: { type: 'noul', instructions: 'Does this convey urgency?' },
  department: {
    type: 'choice', instructions: 'Which team should handle this?',
    criteria: { billing: 'Payments, invoicing, refunds', technical: 'Bugs, outages, integrations', sales: 'Pricing, upgrades' },
  },
  frustration: { type: 'score', instructions: 'How frustrated is the customer?', criteria: ['Calm', 'Frustrated', 'Very angry'] },
};
const NOON = Date.UTC(2026, 8, 20, 12);
const DAY = 86_400_000;

const tmp = mkdtempSync(join(tmpdir(), 'jev-history-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
let seq = 0;
const tmpDb = () => join(tmp, `h${seq++}.db`);

const reply = (body, status = 200) => ({ status, text: typeof body === 'string' ? body : JSON.stringify(body) });
function fakeTransport(...replies) {
  const calls = [];
  const send = async (body) => {
    calls.push(JSON.parse(body));
    return replies[Math.min(calls.length - 1, replies.length - 1)];
  };
  send.calls = calls;
  return send;
}
const noul = (p) => ({ model: 'jev-1.13.0', answers: { q: { type: 'noul', noul: p } }, usage: { input_tokens: 100, output_tokens: 10 } });
const ONE = { q: { type: 'noul', instructions: 'Is it urgent?' } };

const near = (actual, expected, msg) => assert.ok(Math.abs(actual - expected) < 1e-12, `${msg}: ${actual} != ${expected}`);
/** Polls until `check` holds, so a test waits for the event and not for a guessed delay. */
async function eventually(check, what, ms = 2000) {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A history entry as askJev hands it over, with every field a caller could set. */
const entry = (over = {}) => ({
  ts: NOON, requested_model: 'jev-latest', resolved_model: 'jev-1.13.0', cached: false, forced: false, status: 200,
  latency_ms: 100, attempts: 1, input_tokens: 100, output_tokens: 10, cost_usd: 0.0000042,
  state: STATE, questions: ONE, answers: noul(0.9).answers, ...over,
});

/* ── certainty: the number a reviewer sorts by ───────────────────────────── */

describe('certainty', () => {
  test('a noul at 0.5 carries no certainty, and one at 0.95 or 0.05 carries 0.9', () => {
    assert.equal(certainty({ a: { type: 'noul', noul: 0.5 } }), 0);
    assert.equal(certainty({ a: { type: 'noul', noul: 0.95 } }), 0.9);
    assert.equal(certainty({ a: { type: 'noul', noul: 0.05 } }), 0.9);
  });

  test('a choice or a score is as certain as the confidence Jev gave it', () => {
    assert.equal(certainty({ a: REAL.answers.department }), 0.8);
    assert.equal(certainty({ a: REAL.answers.frustration }), 0.92);
  });

  test('a call is only as certain as its least certain answer', () => {
    // is_urgent 0.9, department 0.8, frustration 0.92
    assert.equal(certainty(REAL.answers), 0.8);
  });

  test('a call with no answers has no certainty', () => {
    assert.equal(certainty(undefined), null);
    assert.equal(certainty({}), null);
  });
});

/* ── behaviour, run against both the SQLite store and the memory fallback ── */

const KINDS = {
  sqlite: (opts = {}) => openStore(tmpDb(), { sqlite, ...opts }),
  memory: (opts = {}) => openStore(null, { sqlite: null, ...opts }),
};

for (const [kind, makeStore] of Object.entries(KINDS)) {
  describe(`history with the ${kind} store`, { skip: kind === 'sqlite' && noSqlite }, () => {
    const ask = (store, transport, args = {}, now = () => NOON) =>
      askJev({ state: STATE, questions: QUESTIONS, model: 'jev-latest', ...args }, { store, transport, now, usdPerMtok: 0.042 });
    const report = (store, opts = {}) => historyReport(store, { now: NOON, ...opts });

    test('a live call keeps its input, its answers, its timing and its cost', async () => {
      const store = makeStore();
      const out = await ask(store, fakeTransport(reply(REAL)));
      const call = store.getHistory(out.bridge.call_id);
      assert.equal(call.state, STATE);
      assert.deepEqual(call.questions, QUESTIONS);
      assert.deepEqual(call.answers, REAL.answers);
      assert.equal(call.cached, false);
      assert.equal(call.status, 200);
      assert.equal(call.ts, NOON);
      assert.equal(call.requested_model, 'jev-latest');
      assert.equal(call.resolved_model, 'jev-1.13.0');
      assert.equal(call.input_tokens, 399);
      assert.equal(call.output_tokens, 73);
      near(call.cost_usd, 0.000016758, 'cost is 399 tokens at $0.042/Mtok');
      assert.equal(call.latency_ms, out.bridge.latency_ms);
      assert.equal(call.certainty, 0.8);
      assert.equal(call.question_count, 3);
    });

    test('a cache hit is its own entry: free, marked cached, with the same answers', async () => {
      const store = makeStore();
      const api = fakeTransport(reply(REAL));
      const first = await ask(store, api);
      const second = await ask(store, api);
      assert.notEqual(first.bridge.call_id, second.bridge.call_id);
      const hit = store.getHistory(second.bridge.call_id);
      assert.equal(hit.cached, true);
      assert.equal(hit.cost_usd, 0);
      assert.equal(hit.input_tokens, 0);
      assert.equal(hit.state, STATE);
      assert.deepEqual(hit.answers, REAL.answers);
    });

    test('a forced refresh is marked as forced', async () => {
      const store = makeStore();
      const out = await ask(store, fakeTransport(reply(REAL)), { cache: false });
      assert.equal(store.getHistory(out.bridge.call_id).forced, true);
    });

    test('a rejected call keeps its status and the reason', async () => {
      const store = makeStore();
      await assert.rejects(ask(store, fakeTransport(reply('{"detail":"bad key"}', 401))), /401/);
      const [call] = report(store).calls;
      assert.equal(call.status, 401);
      assert.match(call.error, /bad key/);
    });

    test('a call that never reached the API is kept, and counted as an error in usage too', async () => {
      const store = makeStore();
      const down = async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:443'); };
      await assert.rejects(ask(store, down), /ECONNREFUSED/);
      const [call] = report(store).calls;
      assert.equal(call.status, 0);
      assert.match(call.error, /ECONNREFUSED/);
      assert.equal(store.summary({ days: 1, now: NOON }).errors, 1);
    });

    test('on "meta", timings and answers are kept but the state and the questions are not', async () => {
      const store = makeStore({ history: 'meta' });
      const out = await ask(store, fakeTransport(reply(REAL)));
      const call = store.getHistory(out.bridge.call_id);
      assert.equal(call.state, null);
      assert.equal(call.questions, null);
      assert.equal(call.preview, null);
      assert.deepEqual(call.answers, REAL.answers);
      assert.equal(call.input_tokens, 399);
    });

    test('on "off", nothing is kept and the answer carries no call id, while usage still counts', async () => {
      const store = makeStore({ history: 'off' });
      const out = await ask(store, fakeTransport(reply(REAL)));
      assert.equal(out.bridge.call_id, undefined);
      assert.equal(report(store).calls.length, 0);
      assert.equal(store.summary({ days: 1, now: NOON }).calls, 1);
    });

    test('a review is kept with its call, and reviewed calls give an accuracy', async () => {
      const store = makeStore();
      const api = fakeTransport(reply(REAL));
      const a = await ask(store, api, { state: 'first ticket' });
      const b = await ask(store, api, { state: 'second ticket' });
      const c = await ask(store, api, { state: 'third ticket' });
      reviewCall(store, a.bridge.call_id, { verdict: 'correct' }, NOON);
      reviewCall(store, b.bridge.call_id, { verdict: 'incorrect', note: 'an outage, not billing', expected: { department: 'technical' } }, NOON);
      reviewCall(store, c.bridge.call_id, { verdict: 'partial' }, NOON);

      const wrong = store.getHistory(b.bridge.call_id);
      assert.equal(wrong.verdict, 'incorrect');
      assert.equal(wrong.note, 'an outage, not billing');
      assert.deepEqual(wrong.expected, { department: 'technical' });
      assert.equal(wrong.reviewed_at, NOON);

      const { stats } = report(store);
      assert.equal(stats.quality.reviewed, 3);
      assert.equal(stats.quality.correct, 1);
      assert.equal(stats.quality.partial, 1);
      assert.equal(stats.quality.incorrect, 1);
      assert.equal(stats.quality.accuracy, 0.333);
    });

    test('a review can be withdrawn', async () => {
      const store = makeStore();
      const out = await ask(store, fakeTransport(reply(REAL)));
      reviewCall(store, out.bridge.call_id, { verdict: 'incorrect', note: 'misread it' }, NOON);
      reviewCall(store, out.bridge.call_id, { verdict: null }, NOON);
      const call = store.getHistory(out.bridge.call_id);
      assert.equal(call.verdict, null);
      assert.equal(call.note, null);
      assert.equal(report(store).stats.quality.reviewed, 0);
    });

    test('a review of an unknown call, or with an unknown verdict, is refused', async () => {
      const store = makeStore();
      const out = await ask(store, fakeTransport(reply(REAL)));
      assert.throws(() => reviewCall(store, 'nope-1', { verdict: 'correct' }, NOON), /No call "nope-1"/);
      assert.throws(() => reviewCall(store, out.bridge.call_id, { verdict: 'great' }, NOON), /verdict/);
      assert.equal(store.getHistory(out.bridge.call_id).verdict, null);
    });

    test('"uncertain" lists only calls below the cut, least certain first', async () => {
      const store = makeStore();
      // asked least certain first, so newest-first order would list them the wrong way round
      const api = fakeTransport(reply(noul(0.55)), reply(noul(0.99)), reply(noul(0.7)));
      for (const s of ['a', 'b', 'c']) await ask(store, api, { state: s, questions: ONE });
      const got = report(store, { filter: 'uncertain', below: 0.5 }).calls.map((c) => c.certainty);
      assert.deepEqual(got, [0.1, 0.4]); // 0.55 -> 0.1, 0.7 -> 0.4; 0.99 -> 0.98 is left out
    });

    test('filters pick errors, cached calls, unreviewed and incorrect ones', async () => {
      const store = makeStore();
      store.recordHistory(entry({ ts: NOON - 4 }));
      store.recordHistory(entry({ ts: NOON - 3, cached: true, cost_usd: 0, input_tokens: 0 }));
      store.recordHistory(entry({ ts: NOON - 2, status: 529, error: 'overloaded', answers: undefined }));
      const wrong = store.recordHistory(entry({ ts: NOON - 1 }));
      reviewCall(store, wrong, { verdict: 'incorrect' }, NOON);
      const pick = (filter) => report(store, { filter }).calls.map((c) => c.ts - NOON);
      assert.deepEqual(pick('all'), [-1, -2, -3, -4], 'newest first');
      assert.deepEqual(pick('errors'), [-2]);
      assert.deepEqual(pick('cached'), [-3]);
      assert.deepEqual(pick('live'), [-1, -2, -4]);
      assert.deepEqual(pick('unreviewed'), [-3, -4], 'an error has nothing to review');
      assert.deepEqual(pick('incorrect'), [-1]);
    });

    test('"slow" lists live calls, slowest first', async () => {
      const store = makeStore();
      for (const [i, ms] of [30, 900, 5, 120].entries()) store.recordHistory(entry({ ts: NOON - i, latency_ms: ms }));
      store.recordHistory(entry({ ts: NOON - 9, latency_ms: 2000, cached: true }));
      assert.deepEqual(report(store, { filter: 'slow' }).calls.map((c) => c.latency_ms), [900, 120, 30, 5]);
    });

    test('a search matches the start of the state and the answers', async () => {
      const store = makeStore();
      const api = fakeTransport(reply(REAL));
      await ask(store, api, { state: 'Refund please, the mug arrived CRACKED' });
      await ask(store, api, { state: 'Where is my parcel?' });
      assert.equal(report(store, { q: 'cracked' }).calls.length, 1);
      assert.equal(report(store, { q: 'billing' }).calls.length, 2);
    });

    test('performance stats give nearest-rank latency percentiles over live calls only', async () => {
      const store = makeStore();
      for (let ms = 1; ms <= 20; ms++) store.recordHistory(entry({ latency_ms: ms, state: `s${ms}` }));
      store.recordHistory(entry({ latency_ms: 9999, cached: true }));
      store.recordHistory(entry({ latency_ms: 8888, status: 529, error: 'overloaded', answers: undefined }));
      const { performance } = report(store).stats;
      assert.equal(performance.live_latency_ms.p50, 10);
      assert.equal(performance.live_latency_ms.p95, 19);
      assert.equal(performance.live_latency_ms.max, 20);
      assert.equal(performance.cached_latency_ms.p50, 9999);
    });

    test('efficiency stats count retried calls and live calls that re-sent a state', async () => {
      const store = makeStore();
      store.recordHistory(entry({ ts: NOON - 5, state: 'A', questions: { x: { type: 'noul', instructions: 'x?' } } }));
      store.recordHistory(entry({ ts: NOON - 4, state: 'B', attempts: 3 }));
      store.recordHistory(entry({ ts: NOON - 3, state: 'A', questions: { y: { type: 'noul', instructions: 'y?' } } }));
      store.recordHistory(entry({ ts: NOON - 2, state: 'A', forced: true })); // a deliberate refresh
      store.recordHistory(entry({ ts: NOON - 1, state: 'A', cached: true })); // a hit re-sends nothing
      const { efficiency } = report(store).stats;
      assert.equal(efficiency.resent_state_calls, 1);
      assert.equal(efficiency.retried_calls, 1);
      assert.equal(efficiency.questions_per_live_call, 1);
    });

    test('calls older than the retention are pruned, but a reviewed call is kept however old', async () => {
      const store = makeStore({ historyDays: 30 });
      const kept = store.recordHistory(entry({ ts: NOON - 40 * DAY }));
      store.recordHistory(entry({ ts: NOON - 40 * DAY }));
      const recent = store.recordHistory(entry({ ts: NOON - DAY }));
      reviewCall(store, kept, { verdict: 'correct' }, NOON);
      store.prune(NOON);
      assert.deepEqual(report(store, { days: 365 }).calls.map((c) => c.id).sort(), [kept, recent].sort());
    });

    test('past the row limit the oldest unreviewed calls go first', async () => {
      const store = makeStore({ historyMax: 3 });
      const ids = [1, 2, 3, 4, 5].map((t) => store.recordHistory(entry({ ts: NOON - 10 + t })));
      reviewCall(store, ids[0], { verdict: 'correct' }, NOON);
      store.prune(NOON);
      assert.deepEqual(report(store).calls.map((c) => c.id).sort(), [ids[0], ids[2], ids[3], ids[4]].sort());
    });

    test('clearing the history empties it and leaves usage alone', async () => {
      const store = makeStore();
      await ask(store, fakeTransport(reply(REAL)));
      assert.equal(store.clearHistory(), 1);
      assert.equal(report(store).calls.length, 0);
      assert.equal(store.summary({ days: 1, now: NOON }).calls, 1);
    });
  });
}

/* ── SQLite, observed from a second connection ───────────────────────────── */

describe('history with SQLite, seen from outside the process', { skip: noSqlite }, () => {
  const ask = (store, args = {}) =>
    askJev({ state: STATE, questions: QUESTIONS, ...args }, { store, transport: fakeTransport(reply(REAL)), now: () => NOON, usdPerMtok: 0.042 });
  const count = (path, table) => {
    const peek = new sqlite.DatabaseSync(path);
    try { return peek.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n; } finally { peek.close(); }
  };

  test('the answer is returned before anything about it is written, which then happens unprompted', async () => {
    const path = tmpDb();
    const store = openStore(path, { sqlite });
    const out = await ask(store);
    assert.ok(out.answers);
    assert.equal(count(path, 'history'), 0, 'history waits until the answer is on its way');
    assert.equal(count(path, 'calls'), 0, 'so does the usage log');
    await eventually(() => count(path, 'history') === 1 && count(path, 'calls') === 1, 'the deferred write');
  });

  test('a burst of calls is written together, once the burst is over', async () => {
    const path = tmpDb();
    const store = openStore(path, { sqlite });
    for (let i = 0; i < 5; i++) {
      await ask(store, { state: `ticket ${i}` });
      await new Promise((r) => setImmediate(r)); // the event loop turns between calls, as it does between MCP requests
    }
    assert.equal(count(path, 'history'), 0, 'nothing is written while calls keep arriving');
    await eventually(() => count(path, 'history') === 5, 'the burst to be written');
  });

  test('a state asked about many times is stored once', async () => {
    const path = tmpDb();
    const store = openStore(path, { sqlite });
    for (let i = 0; i < 10; i++) await ask(store);
    store.flush();
    assert.equal(count(path, 'history'), 10);
    assert.equal(count(path, 'payloads'), 2, 'one state, one question set');
  });

  test('on "meta", neither the state nor any question text reaches the disk', async () => {
    const path = tmpDb();
    const store = openStore(path, { sqlite, history: 'meta' });
    await ask(store);
    await ask(store); // a hit, so the cache is read back too
    store.close();
    const bytes = readdirSync(dirname(path))
      .filter((f) => f.startsWith(basename(path)))
      .map((f) => readFileSync(join(dirname(path), f), 'latin1'))
      .join('');
    // Answers do repeat option names and score level labels ("billing", "Calm") —
    // a score's `legend` is part of the answer — so those are not listed here.
    const secrets = [STATE, 'Does this convey urgency?', 'Which team should handle this?', 'How frustrated is the customer?',
      'Payments, invoicing, refunds', 'Bugs, outages, integrations'];
    for (const secret of secrets) {
      assert.ok(!bytes.includes(secret), `found on disk: ${secret}`);
    }
  });

  test('a cleared history is not left readable in the database\'s free pages or its log', async () => {
    const path = tmpDb();
    const store = openStore(path, { sqlite });
    const marker = 'cleared-state-marker';
    for (let i = 0; i < 20; i++) await ask(store, { state: `${marker} ${i}: ${STATE}` });
    store.flush();
    store.clearHistory();
    // Read while the database is still open, as it is when an MCP server holds it
    // and `--clear-history` runs beside it: closing would fold the log in regardless.
    const bytes = readdirSync(dirname(path))
      .filter((f) => f.startsWith(basename(path)))
      .map((f) => readFileSync(join(dirname(path), f), 'latin1'))
      .join('');
    store.close();
    assert.ok(!bytes.includes(marker), 'a cleared state is still on disk');
  });

  test('a history write that fails is logged, and neither the answer nor the usage log suffers', async () => {
    const path = tmpDb();
    const logged = [];
    const store = openStore(path, { sqlite, log: (m) => logged.push(m) });
    const vandal = new sqlite.DatabaseSync(path);
    vandal.exec('DROP TABLE history');
    vandal.close();
    const out = await ask(store);
    assert.deepEqual(out.answers, REAL.answers);
    await eventually(() => logged.some((m) => /history/.test(m)), 'the failure to be logged');
    assert.equal(store.summary({ days: 1, now: NOON }).calls, 1);
  });
});

/* ── over MCP: a real server process, only the API is faked ──────────────── */

describe('history over MCP', { skip: noSqlite }, () => {
  let api, server, send;

  before(async () => {
    api = createServer((req, res) => {
      req.resume();
      req.on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(REAL)));
    });
    await new Promise((r) => api.listen(0, '127.0.0.1', r));
    server = spawn(process.execPath, [join(SRC, 'server.mjs')], {
      env: { ...process.env, TYPESAFE_API_URL: `http://127.0.0.1:${api.address().port}/v1`, TYPESAFE_API_KEY: 'test-key',
        TYPESAFE_DB: tmpDb(), JEV_BRIDGE_HOME: join(tmp, 'home'), TYPESAFE_HISTORY: '' },
    });
    let buffer = '', id = 0;
    const waiting = new Map();
    server.stdout.on('data', (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const msg = JSON.parse(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        waiting.get(msg.id)?.(msg);
      }
    });
    send = (method, params) => new Promise((resolve) => {
      const msgId = ++id;
      waiting.set(msgId, resolve);
      server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msgId, method, params }) + '\n');
    });
    await send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-client', version: '1' } });
  });

  after(() => { server.kill(); api.close(); });

  const call = (name, args) => send('tools/call', { name, arguments: args }).then((m) => m.result);

  test('jev_history and jev_review are listed, and history is read-only', async () => {
    const { result } = await send('tools/list', {});
    const byName = Object.fromEntries(result.tools.map((t) => [t.name, t]));
    assert.ok(byName.jev_history && byName.jev_review);
    assert.equal(byName.jev_history.annotations?.readOnlyHint, true);
    assert.equal(byName.jev_ask.outputSchema.properties.bridge.properties.call_id?.type, 'string');
  });

  test('a call can be found, read in full, and reviewed through the tools', async () => {
    const asked = await call('jev_ask', { state: STATE, questions: QUESTIONS });
    const id = asked.structuredContent.bridge.call_id;
    assert.match(id, /^[0-9a-f]{8}-\d+$/);

    const listed = await call('jev_history', {});
    assert.equal(listed.isError, undefined, listed.content?.[0]?.text);
    const row = listed.structuredContent.calls.find((c) => c.id === id);
    assert.equal(row.answers, 'is_urgent=0.95, department=billing, frustration=1.05');
    assert.equal(row.preview, STATE);

    const full = await call('jev_history', { id });
    assert.equal(full.structuredContent.state, STATE);
    assert.equal(full.structuredContent.client, 'test-client');
    assert.equal(full.structuredContent.attempts, 1, 'the real HTTP transport reports how many tries it took');

    const reviewed = await call('jev_review', { id, verdict: 'incorrect', expected: { department: 'technical' } });
    assert.equal(reviewed.isError, undefined, reviewed.content?.[0]?.text);
    const after_ = await call('jev_history', { filter: 'incorrect' });
    assert.deepEqual(after_.structuredContent.calls.map((c) => c.id), [id]);
    assert.equal(after_.structuredContent.stats.quality.incorrect, 1);
  });

  test('a review of an unknown call comes back as a tool error the model can read', async () => {
    const r = await call('jev_review', { id: 'nope-1', verdict: 'correct' });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /No call "nope-1"/);
  });
});

/* ── the local dashboard ─────────────────────────────────────────────────── */

describe('the dashboard', () => {
  let ui, store, id;
  const TOKEN = 'a-long-random-token';

  before(async () => {
    store = openStore(null, { sqlite: null });
    const out = await askJev({ state: STATE, questions: QUESTIONS },
      { store, transport: fakeTransport(reply(REAL)), now: () => NOON, usdPerMtok: 0.042 });
    id = out.bridge.call_id;
    ui = await startUi({ store, port: 0, token: TOKEN, now: () => NOON });
  });
  after(() => ui.close());

  /** node:http rather than fetch, so the Host header can be forged. */
  const hit = (path, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: ui.port, path, method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (text += d));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], csp: res.headers['content-security-policy'], text }));
    });
    req.on('error', reject);
    req.end(body);
  });
  const auth = { 'x-jev-token': TOKEN };

  test('the printed address carries the token and serves the page', async () => {
    assert.match(ui.url, new RegExp(`^http://127\\.0\\.0\\.1:${ui.port}/\\?token=${TOKEN}$`));
    const page = await hit(`/?token=${TOKEN}`);
    assert.equal(page.status, 200);
    assert.match(page.type, /text\/html/);
  });

  test('every response, not only the page, forbids scripts and framing', async () => {
    for (const r of [await hit('/'), await hit('/api/report', { headers: auth }), await hit('/nowhere', { headers: auth })]) {
      assert.match(r.csp ?? '', /default-src 'none'/, `${r.status} ${r.type}`);
      assert.match(r.csp ?? '', /frame-ancestors 'none'/, `${r.status} ${r.type}`);
    }
    assert.match((await hit(`/?token=${TOKEN}`)).csp, /script-src 'nonce-/);
  });

  test('without the token, nothing is served', async () => {
    assert.equal((await hit('/')).status, 401);
    assert.equal((await hit('/api/report')).status, 401);
    assert.equal((await hit('/api/report', { headers: { 'x-jev-token': 'guess' } })).status, 401);
  });

  test('a request naming another host is refused, token or not', async () => {
    // what a DNS-rebinding page would send
    const r = await hit('/api/report', { headers: { ...auth, host: 'evil.example' } });
    assert.equal(r.status, 403);
  });

  test('the report and a call are served as JSON', async () => {
    const r = await hit('/api/report?days=7&filter=all', { headers: auth });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.text).calls.map((c) => c.id), [id]);
    const one = JSON.parse((await hit(`/api/calls/${id}`, { headers: auth })).text);
    assert.equal(one.state, STATE);
    assert.equal((await hit('/api/calls/nope-1', { headers: auth })).status, 404);
  });

  test('a review posted from the page is saved', async () => {
    const body = JSON.stringify({ verdict: 'partial', note: 'right team, wrong urgency' });
    const r = await hit(`/api/calls/${id}/review`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body });
    assert.equal(r.status, 200, r.text);
    assert.equal(store.getHistory(id).verdict, 'partial');
    const bad = await hit(`/api/calls/${id}/review`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{"verdict":"great"}' });
    assert.equal(bad.status, 400);
  });
});
