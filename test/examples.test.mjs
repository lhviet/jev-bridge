/**
 * Tests for the evaluation examples.  Run:  npm test   (or: node --test)
 *
 * examples/eval-set.mjs turns reviewed calls into an evaluation set, and
 * examples/replay.mjs scores a model against it. Both run as real processes
 * against a real database; only the TypeSafe API is faked.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

import { openStore } from '../src/store.mjs';
import { askJev } from '../src/server.mjs';
import { reviewCall } from '../src/history.mjs';

const EXAMPLES = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples');

let sqlite = null;
try { sqlite = await import('node:sqlite'); } catch { /* older Node */ }
const noSqlite = !sqlite && 'node:sqlite needs Node >= 22.5';

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
const QUESTIONS = {
  is_urgent: { type: 'noul', instructions: 'Does this convey urgency?' },
  department: {
    type: 'choice', instructions: 'Which team should handle this?',
    criteria: { billing: 'Payments, invoicing, refunds', technical: 'Bugs, outages, integrations', sales: 'Pricing, upgrades' },
  },
  frustration: { type: 'score', instructions: 'How frustrated is the customer?', criteria: ['Calm', 'Frustrated', 'Very angry'] },
};
const NOON = Date.UTC(2026, 8, 20, 12);

const tmp = mkdtempSync(join(tmpdir(), 'jev-examples-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

/** Runs a script to completion, as a user would from the shell. */
function run(script, args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(EXAMPLES, script), ...args],
      { env: { ...process.env, JEV_BRIDGE_HOME: join(tmp, 'home'), TYPESAFE_API_KEY: 'test-key', ...env } });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('an evaluation set from reviewed calls, replayed against a model', { skip: noSqlite }, () => {
  const db = join(tmp, 'eval.db');
  const ids = {};

  before(async () => {
    const reply = async () => ({ status: 200, text: JSON.stringify(REAL) });
    const ask = (store, state, at) => askJev({ state, questions: QUESTIONS }, { store, transport: reply, now: () => NOON + at });
    const store = openStore(db, { sqlite });
    ids.right = (await ask(store, 'The export button does nothing.', 1)).bridge.call_id;
    ids.wrong = (await ask(store, 'The app crashes when I upload a file.', 2)).bridge.call_id;
    ids.unreviewed = (await ask(store, 'Just saying thanks.', 3)).bridge.call_id;
    // Jev said billing to everything. The first is right as it stands; the second was a technical problem.
    reviewCall(store, ids.right, { verdict: 'correct' }, NOON);
    reviewCall(store, ids.wrong, { verdict: 'incorrect', expected: { department: 'technical' }, note: 'A crash is technical.' }, NOON);
    store.close();
    // Reviewed, but recorded without its state: it cannot be replayed.
    const meta = openStore(db, { sqlite, history: 'meta' });
    ids.meta = (await ask(meta, 'Sensitive text', 4)).bridge.call_id;
    reviewCall(meta, ids.meta, { verdict: 'correct' }, NOON);
    meta.close();
  });

  test('the set holds each reviewed call with its content, oldest first, and skips calls kept without it', async () => {
    const r = await run('eval-set.mjs', [], { TYPESAFE_DB: db });
    assert.equal(r.code, 0, r.stderr);
    const lines = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => l.id), [ids.right, ids.wrong]);
    assert.equal(lines[1].state, 'The app crashes when I upload a file.');
    assert.deepEqual(lines[1].questions, QUESTIONS);
    assert.deepEqual(lines[1].answers, REAL.answers);
    assert.deepEqual(lines[1].expected, { department: 'technical' });
    assert.equal(lines[1].verdict, 'incorrect');
    assert.match(r.stderr, /2 reviewed calls written; 1 skipped/);
  });

  test('the set can be limited to one verdict', async () => {
    const r = await run('eval-set.mjs', ['incorrect'], { TYPESAFE_DB: db });
    assert.deepEqual(r.stdout.trim().split('\n').map((l) => JSON.parse(l).id), [ids.wrong]);
  });

  test('a database that does not exist is reported, not created', async () => {
    const missing = join(tmp, 'no-such.db');
    const r = await run('eval-set.mjs', [], { TYPESAFE_DB: missing });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no-such\.db/);
    assert.equal(existsSync(missing), false);
  });

  test('a replay scores the new decisions against the truth, and shows what changed', async () => {
    // The "new model" answers technical to everything.
    const seen = [];
    const api = createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        seen.push({ auth: req.headers.authorization, body: JSON.parse(body) });
        const answers = { ...REAL.answers, department: { ...REAL.answers.department, choice: 'technical' } };
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ...REAL, model: 'jev-1.14.0', answers }));
      });
    });
    await new Promise((r) => api.listen(0, '127.0.0.1', r));
    try {
      const set = join(tmp, 'eval.jsonl');
      writeFileSync(set, (await run('eval-set.mjs', [], { TYPESAFE_DB: db })).stdout);
      const r = await run('replay.mjs', [set, 'jev-preview'], { TYPESAFE_API_URL: `http://127.0.0.1:${api.address().port}/v1` });
      assert.equal(r.code, 0, r.stderr);

      // Scored: the correct call's three answers, and the corrected call's department — 4 in all.
      // Before: all three on the first call were right, the department on the second was not: 3 of 4.
      // Now: the first call's department turns wrong, the second's turns right: 3 of 4, 2 changed.
      assert.match(r.stdout, /3 of 4 answers right with jev-preview, against 3 of 4 when reviewed\. 2 changed/);
      assert.match(r.stdout, new RegExp(`${ids.wrong}\\s+department\\s+"technical"\\s+"billing"\\s+"technical"\\s+right, fixed`));
      assert.match(r.stdout, new RegExp(`${ids.right}\\s+department\\s+"billing"\\s+"billing"\\s+"technical"\\s+wrong, broke`));
      assert.equal(seen.length, 2, 'one live call per line of the set');
      assert.equal(seen[0].body.model, 'jev-preview');
      assert.equal(seen[0].auth, 'Bearer test-key');
    } finally {
      api.close();
    }
  });
});
