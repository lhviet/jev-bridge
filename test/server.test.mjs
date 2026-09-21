/**
 * Tests for jev-bridge.  Run:  npm test   (or: node --test)
 *
 * The TypeSafe API is the only thing faked — it is external, billed and slow.
 * Everything else is real: SQLite on disk, the MCP stdio protocol in a child
 * process, and two processes contending for one database file.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

import { cacheKey, openStore } from '../src/store.mjs';
import { askJev } from '../src/server.mjs';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

// node:sqlite arrived in Node 22.5. On older Node the SQLite cases are skipped and
// the memory fallback is still exercised, which is exactly what CI checks there.
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
const NOON = Date.UTC(2026, 8, 20, 12); // mid-day, so no timezone moves it off 2026-09-20
const DAY = 86_400_000;

const tmp = mkdtempSync(join(tmpdir(), 'jev-test-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
let seq = 0;
const tmpDb = () => join(tmp, `t${seq++}.db`);

const reply = (body, status = 200) => ({ status, text: typeof body === 'string' ? body : JSON.stringify(body) });

/** Replays the given replies in order (the last one repeats) and records every request body. */
function fakeTransport(...replies) {
  const calls = [];
  const send = async (body) => {
    calls.push(JSON.parse(body));
    return replies[Math.min(calls.length - 1, replies.length - 1)];
  };
  send.calls = calls;
  return send;
}

const near = (actual, expected, msg) => assert.ok(Math.abs(actual - expected) < 1e-12, `${msg}: ${actual} != ${expected}`);

/* ── cache keys ──────────────────────────────────────────────────────────── */

describe('cacheKey', () => {
  test('the same request with object keys in another order is the same entry', () => {
    const a = cacheKey('jev-latest', { user: 'x', msg: 'y' }, { q1: { type: 'noul', instructions: 'i' }, q2: { type: 'noul', instructions: 'j' } });
    const b = cacheKey('jev-latest', { msg: 'y', user: 'x' }, { q2: { instructions: 'j', type: 'noul' }, q1: { instructions: 'i', type: 'noul' } });
    assert.equal(a, b);
  });

  test('score levels in another order are a different question', () => {
    const q = (levels) => ({ s: { type: 'score', instructions: 'rate', criteria: levels } });
    assert.notEqual(cacheKey('m', 't', q(['Calm', 'Angry'])), cacheKey('m', 't', q(['Angry', 'Calm'])));
  });

  test('the same question under a different id is the same entry', () => {
    // TypeSafe does not send question ids to the model, so an id is not part of
    // the question's meaning. An agent invents a fresh id on every run.
    const a = cacheKey('jev-latest', STATE, { urgency: { type: 'noul', instructions: 'Does this convey urgency?' } });
    const b = cacheKey('jev-latest', STATE, { urgency_check: { type: 'noul', instructions: 'Does this convey urgency?' } });
    assert.equal(a, b);
  });

  test('a different model is a different entry', () => {
    assert.notEqual(cacheKey('jev-1.13.0', STATE, QUESTIONS), cacheKey('jev-preview', STATE, QUESTIONS));
  });

  test('a different state is a different entry', () => {
    assert.notEqual(cacheKey('m', 'first text', QUESTIONS), cacheKey('m', 'second text', QUESTIONS));
  });
});

/* ── behaviour, run against both the SQLite store and the memory fallback ── */

const KINDS = {
  sqlite: (opts = {}) => openStore(tmpDb(), { sqlite, ...opts }),
  memory: (opts = {}) => openStore(null, { sqlite: null, ...opts }),
};

for (const [kind, makeStore] of Object.entries(KINDS)) {
  describe(`askJev with the ${kind} store`, { skip: kind === 'sqlite' && noSqlite }, () => {
    const ask = (store, transport, args = {}, now = () => NOON) =>
      askJev({ state: STATE, questions: QUESTIONS, model: 'jev-latest', ...args }, { store, transport, now, usdPerMtok: 0.042 });

    test('a repeated question is answered from the cache without calling the API', async () => {
      const store = makeStore();
      const api = fakeTransport(reply(REAL));
      const first = await ask(store, api);
      const second = await ask(store, api);
      assert.equal(api.calls.length, 1);
      assert.equal(first.bridge.cached, false);
      assert.equal(second.bridge.cached, true);
      assert.deepEqual(second.answers, REAL.answers);
    });

    test('cache:false calls the API even when an answer is stored', async () => {
      const store = makeStore();
      const api = fakeTransport(reply(REAL));
      await ask(store, api);
      await ask(store, api, { cache: false });
      assert.equal(api.calls.length, 2);
    });

    test('a forced refresh replaces the stored answer', async () => {
      const store = makeStore();
      const newer = { ...REAL, answers: { ...REAL.answers, department: { ...REAL.answers.department, choice: 'technical' } } };
      const api = fakeTransport(reply(REAL), reply(newer));
      await ask(store, api);
      await ask(store, api, { cache: false });
      const third = await ask(store, api);
      assert.equal(api.calls.length, 2);
      assert.equal(third.answers.department.choice, 'technical');
    });

    test('a failed call is not cached', async () => {
      const store = makeStore();
      const api = fakeTransport(reply('{"detail":"overloaded"}', 529), reply(REAL));
      await assert.rejects(ask(store, api), /529/);
      const retry = await ask(store, api);
      assert.equal(api.calls.length, 2);
      assert.deepEqual(retry.answers, REAL.answers);
    });

    test('an answer older than the TTL is fetched again', async () => {
      const store = makeStore({ ttlMs: 1000 });
      const api = fakeTransport(reply(REAL));
      await ask(store, api, {}, () => 0);
      await ask(store, api, {}, () => 999);
      assert.equal(api.calls.length, 1, 'still fresh at 999ms');
      await ask(store, api, {}, () => 1001);
      assert.equal(api.calls.length, 2, 'expired at 1001ms');
    });

    test('when an alias moves to a new model, answers from the old one stop being served', async () => {
      const store = makeStore();
      const moved = { ...REAL, model: 'jev-1.14.0' };
      const api = fakeTransport(reply(REAL), reply(moved), reply(moved));
      await ask(store, api); // cached under jev-latest, answered by 1.13.0
      await ask(store, api, { state: 'an unrelated ticket' }); // jev-latest now answers as 1.14.0
      const again = await ask(store, api); // the 1.13.0 answer must not be reused
      assert.equal(api.calls.length, 3);
      assert.equal(again.model, 'jev-1.14.0');
    });

    test('an answer is reused when only the question id differs, under the new id', async () => {
      const store = makeStore();
      const asked = { urgency: { type: 'noul', instructions: 'Does this convey urgency?' } };
      const renamed = { urgency_check: { type: 'noul', instructions: 'Does this convey urgency?' } };
      // the API keys its answers by whatever ids the request used
      const api = fakeTransport(reply({ model: 'jev-1.13.0', answers: { urgency: { type: 'noul', noul: 0.97 } }, usage: { input_tokens: 283, output_tokens: 21 } }));
      await ask(store, api, { questions: asked });
      const second = await ask(store, api, { questions: renamed });
      assert.equal(api.calls.length, 1, 'the renamed question is the same question');
      assert.equal(second.bridge.cached, true);
      assert.deepEqual(second.answers, { urgency_check: { type: 'noul', noul: 0.97 } });
    });

    test('a malformed question is rejected before the API is called', async () => {
      const store = makeStore();
      const api = fakeTransport(reply(REAL));
      const bad = { s: { type: 'score', instructions: 'rate', criteria: { not: 'an array' } } };
      await assert.rejects(ask(store, api, { questions: bad }), /questions\["s"\]\.criteria/);
      assert.equal(api.calls.length, 0);
    });

    test('usage counts live and cached calls and prices only the live one', async () => {
      const store = makeStore();
      const api = fakeTransport(reply(REAL));
      await ask(store, api);
      await ask(store, api);
      const u = store.summary({ days: 7, now: NOON });
      assert.equal(u.calls, 2);
      assert.equal(u.live_calls, 1);
      assert.equal(u.cache_hits, 1);
      assert.equal(u.hit_rate, 0.5);
      assert.equal(u.input_tokens, 399);
      assert.equal(u.output_tokens, 73);
      near(u.cost_usd, 0.000016758, 'cost is 399 tokens at $0.042/Mtok');
      assert.equal(u.saved_input_tokens, 399);
      near(u.saved_usd, 0.000016758, 'the hit saved one full call');
      assert.equal(u.errors, 0);
      assert.deepEqual(u.by_day.map((d) => [d.day, d.calls, d.cache_hits]), [['2026-09-20', 2, 1]]);
    });

    test('usage counts a failed call as an error that cost nothing', async () => {
      const store = makeStore();
      const api = fakeTransport(reply('{"detail":"bad key"}', 401));
      await assert.rejects(ask(store, api), /401/);
      const u = store.summary({ days: 7, now: NOON });
      assert.equal(u.errors, 1);
      assert.equal(u.input_tokens, 0);
      assert.equal(u.cost_usd, 0);
    });

    test('usage outside the window is left out', async () => {
      const store = makeStore();
      const api = fakeTransport(reply(REAL));
      await ask(store, api, {}, () => NOON - 10 * DAY);
      assert.equal(store.summary({ days: 7, now: NOON }).calls, 0);
      assert.equal(store.summary({ days: 30, now: NOON }).calls, 1);
    });

    test('when the cache is full, the least recently used entry is evicted', () => {
      const store = makeStore({ maxEntries: 3, pruneEvery: 1 });
      store.putCached('k1', 'jev-latest', REAL, 1);
      store.putCached('k2', 'jev-latest', REAL, 2);
      store.putCached('k3', 'jev-latest', REAL, 3);
      assert.ok(store.getCached('k1', 4), 'k1 is read, so it is now the most recently used');
      store.putCached('k4', 'jev-latest', REAL, 5);
      assert.equal(store.getCached('k2', 6), null, 'k2 was used longest ago');
      assert.ok(store.getCached('k1', 6));
      assert.ok(store.getCached('k3', 6));
      assert.ok(store.getCached('k4', 6));
    });
  });
}

describe('the memory fallback', () => {
  test('with no SQLite module, the store falls back to memory and still caches', async () => {
    const store = openStore(join(tmp, 'never-created.db'), { sqlite: null });
    assert.equal(store.kind, 'memory');
    const api = fakeTransport(reply(REAL));
    const deps = { store, transport: api, now: () => NOON, usdPerMtok: 0.042 };
    await askJev({ state: STATE, questions: QUESTIONS }, deps);
    await askJev({ state: STATE, questions: QUESTIONS }, deps);
    assert.equal(api.calls.length, 1);
    assert.equal(existsSync(join(tmp, 'never-created.db')), false, 'nothing is written to disk');
  });
});

/* ── the reason SQLite was chosen ────────────────────────────────────────── */

describe('concurrency', { skip: noSqlite }, () => {
  test('two processes writing one database at once lose nothing', async () => {
    const db = tmpDb();
    const worker = join(tmp, 'worker.mjs');
    writeFileSync(worker, `
      import * as sqlite from 'node:sqlite';
      import { openStore } from ${JSON.stringify(join(SRC, 'store.mjs'))};
      const [db, id] = process.argv.slice(2);
      const store = openStore(db, { sqlite });
      const response = ${JSON.stringify(REAL)};
      for (let i = 0; i < 400; i++) {
        store.putCached('p' + id + '-' + i, 'jev-latest', response, ${NOON});
        store.recordCall({ ts: ${NOON}, requested_model: 'jev-latest', resolved_model: 'jev-1.13.0', cached: 0, questions: 3,
          input_tokens: 399, output_tokens: 73, saved_input_tokens: 0, latency_ms: 1, cost_usd: 0, status: 200 });
      }
      store.close();
    `);
    const run = (id) => new Promise((resolve) => {
      const child = spawn(process.execPath, [worker, db, String(id)]);
      let err = '';
      child.stderr.on('data', (d) => (err += d));
      child.on('close', (code) => resolve({ code, err }));
    });
    const results = await Promise.all([run(1), run(2)]);
    for (const r of results) assert.equal(r.code, 0, `a writer failed: ${r.err}`);

    const u = openStore(db, { sqlite }).summary({ days: 1, now: NOON });
    assert.equal(u.cache.entries, 800);
    assert.equal(u.calls, 800);
  });

  test('several sessions opening a brand-new database at the same moment all succeed', async () => {
    // Switching a fresh file to WAL makes every opener upgrade a shared lock at
    // once. SQLite answers that with SQLITE_BUSY instead of calling the busy
    // handler, so busy_timeout alone lost roughly one opener in fifteen.
    const opener = join(tmp, 'opener.mjs');
    writeFileSync(opener, `
      import * as sqlite from 'node:sqlite';
      import { openStore } from ${JSON.stringify(join(SRC, 'store.mjs'))};
      openStore(process.argv[2], { sqlite }).close();
    `);
    const open = (db) => new Promise((resolve) => {
      const child = spawn(process.execPath, [opener, db]);
      let err = '';
      child.stderr.on('data', (d) => (err += d));
      child.on('close', (code) => resolve({ code, err }));
    });
    for (let round = 0; round < 20; round++) {
      const db = tmpDb();
      const results = await Promise.all(Array.from({ length: 6 }, () => open(db)));
      for (const r of results) assert.equal(r.code, 0, `an opener failed: ${r.err}`);
    }
  });
});

/* ── end to end over MCP: a real server process, only the API is faked ───── */

describe('over MCP', { skip: noSqlite }, () => {
  let api, server, db, send;
  const seen = { posts: 0, auth: null };

  before(async () => {
    api = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        seen.auth = req.headers.authorization;
        if (seen.auth !== 'Bearer test-key') return res.writeHead(401).end('{"detail":"bad key"}');
        if (req.method === 'POST' && req.url === '/v1/systemone') {
          seen.posts++;
          return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(REAL));
        }
        res.writeHead(404).end();
      });
    });
    await new Promise((r) => api.listen(0, '127.0.0.1', r));

    db = tmpDb();
    server = spawn(process.execPath, [join(SRC, 'server.mjs')], {
      // JEV_BRIDGE_HOME too, so a test run can never touch a real ~/.jev-bridge
      env: { ...process.env, TYPESAFE_API_URL: `http://127.0.0.1:${api.address().port}/v1`, TYPESAFE_API_KEY: 'test-key',
        TYPESAFE_DB: db, JEV_BRIDGE_HOME: join(tmp, 'home') },
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
    await send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  });

  after(() => { server.kill(); api.close(); });

  const call = (name, args) => send('tools/call', { name, arguments: args }).then((m) => m.result);

  test('jev_ask declares an output schema, and jev_usage is listed', async () => {
    const { result } = await send('tools/list', {});
    const byName = Object.fromEntries(result.tools.map((t) => [t.name, t]));
    assert.equal(byName.jev_ask.outputSchema?.type, 'object');
    assert.ok(byName.jev_usage, 'jev_usage is offered');
  });

  test('jev_ask returns structured content and sends the key as a Bearer token', async () => {
    const r = await call('jev_ask', { state: STATE, questions: QUESTIONS });
    assert.equal(r.isError, undefined, r.content?.[0]?.text);
    assert.equal(r.structuredContent.answers.department.choice, 'billing');
    assert.equal(r.structuredContent.bridge.cached, false);
    assert.deepEqual(JSON.parse(r.content[0].text).answers, r.structuredContent.answers);
    assert.equal(seen.auth, 'Bearer test-key');
  });

  test('a repeated jev_ask is answered without reaching the API', async () => {
    const before = seen.posts;
    await call('jev_ask', { state: 'a second, different ticket', questions: QUESTIONS });
    const repeat = await call('jev_ask', { state: 'a second, different ticket', questions: QUESTIONS });
    assert.equal(seen.posts - before, 1);
    assert.equal(repeat.structuredContent.bridge.cached, true);
  });

  test('jev_usage reports the calls made, from the database it was pointed at', async () => {
    // runs after the two tests above: 2 live calls and 1 cache hit
    const r = await call('jev_usage', { days: 1 });
    assert.equal(r.structuredContent.calls, 3);
    assert.equal(r.structuredContent.cache_hits, 1);
    assert.equal(r.structuredContent.input_tokens, 798);
    assert.ok(existsSync(db), 'the TYPESAFE_DB path was used, not the real database');
  });
});
