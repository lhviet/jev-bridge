/**
 * The TypeSafe client against a local fake API: the retry policy of the
 * official SDKs (docs.typesafe.ai, RetryPolicy), Retry-After in each of its
 * forms, per-attempt timeouts, cancellation, the request id, and the
 * environment variable names the SDKs read. Also the argument checks jev_ask
 * makes before anything is sent.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** Each test queues the replies it wants; the fake answers with them in order. */
const queue = [];
const seen = [];
const fake = createServer((req, res) => {
  seen.push({ url: req.url, agent: req.headers['user-agent'] });
  req.resume();
  req.on('end', () => {
    const step = queue.shift() ?? { status: 200 };
    if (step.hang) return; // never answers: an attempt timeout must end it
    res.writeHead(step.status, step.headers ?? {}).end(step.body ?? '{}');
  });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
// Unref'd, because Node 20 runs a root-level after() only once the process is otherwise idle.
fake.unref();
after(() => { fake.closeAllConnections?.(); fake.close(); });

// BASE is read when the module loads, so point it at the fake first.
process.env.TYPESAFE_API_URL = `http://127.0.0.1:${fake.address().port}/v1`;
const { request, describeFailure, isRetryable, retryAfterMs, RETRY } = await import('../src/typesafe.mjs');
const { validateAsk } = await import('../src/server.mjs');

const FAST = { ...RETRY, backoffInitialMs: 1, backoffMaxMs: 5 };
const send = (policy = FAST, extra = {}) => request('/systemone', { method: 'POST', body: '{}', key: 'k', policy, ...extra });

describe('the retry policy of the TypeSafe SDKs', () => {
  before(() => { queue.length = 0; seen.length = 0; });

  test('the defaults are the SDKs\' defaults', () => {
    assert.equal(RETRY.maxRetries, 2);
    assert.equal(RETRY.backoffInitialMs, 500);
    assert.equal(RETRY.backoffMaxMs, 5000);
    assert.equal(RETRY.backoffJitter, 0.25);
    assert.equal(RETRY.maxRetryAfterMs, 60000);
    assert.equal(RETRY.timeoutMs, 10000);
  });

  test('408, 429 and every 5xx are retried; other statuses are answers', () => {
    for (const s of [408, 429, 500, 502, 503, 529, 599]) assert.ok(isRetryable(s), String(s));
    for (const s of [200, 400, 401, 403, 404, 422]) assert.ok(!isRetryable(s), String(s));
  });

  test('a 529 then a 200 is one success after two attempts', async () => {
    queue.push({ status: 529 }, { status: 200, body: '{"ok":true}' });
    const res = await send();
    assert.equal(res.status, 200);
    assert.equal(res.attempts, 2);
  });

  test('a 422 is returned at once, never retried', async () => {
    queue.push({ status: 422, body: '{"detail":"bad"}' }, { status: 200 });
    const res = await send();
    assert.equal(res.status, 422);
    assert.equal(res.attempts, 1);
    queue.length = 0;
  });

  test('after two retries the last response is returned as it is', async () => {
    queue.push({ status: 503 }, { status: 503 }, { status: 503 }, { status: 200 });
    const res = await send();
    assert.equal(res.status, 503);
    assert.equal(res.attempts, 3);
    queue.length = 0;
  });

  test('retry-after-ms is honoured', async () => {
    queue.push({ status: 429, headers: { 'retry-after-ms': '120' } }, { status: 200 });
    const t = performance.now();
    await send();
    assert.ok(performance.now() - t >= 110, 'waited the 120 ms asked for');
  });

  test('Retry-After is read in seconds and as an HTTP date', () => {
    const h = (o) => new Headers(o);
    assert.equal(retryAfterMs(h({ 'retry-after': '2' })), 2000);
    assert.equal(retryAfterMs(h({ 'retry-after': new Date(Date.now() - 5000).toUTCString() })), 0);
    assert.ok(retryAfterMs(h({ 'retry-after': new Date(Date.now() + 3000).toUTCString() })) > 1000);
    assert.equal(retryAfterMs(h({ 'retry-after-ms': '250', 'retry-after': '9' })), 250, 'the millisecond header wins');
    assert.equal(retryAfterMs(h({})), null);
    assert.equal(retryAfterMs(h({ 'retry-after': 'soon' })), null);
  });

  test('a Retry-After longer than 60 s is ignored in favour of backoff', async () => {
    queue.push({ status: 429, headers: { 'retry-after': '3600' } }, { status: 200 });
    const t = performance.now();
    const res = await send();
    assert.equal(res.status, 200);
    assert.ok(performance.now() - t < 1000, 'did not wait an hour');
  });

  test('an attempt that never answers times out, is retried, and then fails with the timeout', async () => {
    queue.push({ hang: true }, { hang: true });
    const before = seen.length;
    await assert.rejects(send({ ...FAST, timeoutMs: 50, maxRetries: 1 }), /No answer within 50 ms/);
    assert.equal(seen.length - before, 2, 'one retry after the timeout');
  });

  test('a refused connection is retried, then reported', async () => {
    const closed = createServer();
    await new Promise((r) => closed.listen(0, '127.0.0.1', r));
    const port = closed.address().port;
    await new Promise((r) => closed.close(r));
    const out = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const { request } = await import(${JSON.stringify(join(SRC, 'typesafe.mjs'))});
      let retries = 0;
      try { await request('/models', { key: 'k', onRetry: () => retries++, policy: { timeoutMs: 1000, maxRetries: 2, backoffInitialMs: 1, backoffMaxMs: 2, backoffJitter: 0, maxRetryAfterMs: 0 } }); }
      catch (err) { console.log(JSON.stringify({ retries, message: String(err.message) })); }
    `], { env: { ...process.env, TYPESAFE_API_URL: `http://127.0.0.1:${port}/v1` }, encoding: 'utf8' });
    const { retries, message } = JSON.parse(out.stdout);
    assert.equal(retries, 2);
    assert.match(message, /fetch failed/);
  });

  test('cancelling during a backoff wait ends the request at once, without another attempt', async () => {
    queue.push({ status: 529, headers: { 'retry-after-ms': '5000' } }, { status: 200 });
    const controller = new AbortController();
    const before = seen.length;
    const t = performance.now();
    const pending = send(FAST, { signal: controller.signal, onRetry: () => setTimeout(() => controller.abort(), 20) });
    await assert.rejects(pending, (err) => err.name === 'AbortError' && /Cancelled by the client/.test(err.message));
    assert.ok(performance.now() - t < 1000);
    assert.equal(seen.length - before, 1);
    queue.length = 0;
  });

  test('the request id is kept, and quoted when the call fails', async () => {
    queue.push({ status: 401, headers: { 'x-typesafe-request-id': 'req_abc' }, body: '{"detail":"no"}' });
    const res = await send();
    assert.equal(res.requestId, 'req_abc');
    const message = describeFailure(res.status, res.text, res.requestId);
    assert.match(message, /returned 401 \(request id req_abc\)\. The API key was missing or rejected/);
    assert.match(describeFailure(503, 'x'), /server error/);
  });

  test('User-Agent is sent when given', async () => {
    await request('/models', { key: 'k', userAgent: 'jev-bridge/test', policy: FAST });
    assert.equal(seen.at(-1).agent, 'jev-bridge/test');
  });
});

describe('the environment variable names', () => {
  const read = (env) => {
    const out = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const m = await import(${JSON.stringify(join(SRC, 'typesafe.mjs'))});
      console.log(JSON.stringify({ base: m.BASE, model: m.DEFAULT_MODEL, retries: m.RETRY.maxRetries, timeout: m.RETRY.timeoutMs }));
    `], { env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, encoding: 'utf8' });
    return JSON.parse(out.stdout);
  };

  test('the SDKs\' names work: TYPESAFE_BASE_URL is the API root, TYPESAFE_DEFAULT_MODEL the model', () => {
    assert.deepEqual(read({ TYPESAFE_BASE_URL: 'https://example.test/', TYPESAFE_DEFAULT_MODEL: 'jev-preview' }),
      { base: 'https://example.test/v1', model: 'jev-preview', retries: 2, timeout: 10000 });
  });

  test('the bridge\'s older names still work, and TYPESAFE_API_URL wins over TYPESAFE_BASE_URL', () => {
    const r = read({ TYPESAFE_API_URL: 'http://x.test/v1', TYPESAFE_BASE_URL: 'https://ignored.test', TYPESAFE_MODEL: 'jev-1.13.0' });
    assert.equal(r.base, 'http://x.test/v1');
    assert.equal(r.model, 'jev-1.13.0');
  });

  test('with nothing set, the documented defaults', () => {
    assert.deepEqual(read({}), { base: 'https://api.typesafe.ai/v1', model: 'jev-latest', retries: 2, timeout: 10000 });
  });

  test('retries and timeout can be tuned', () => {
    const r = read({ TYPESAFE_MAX_RETRIES: '0', TYPESAFE_TIMEOUT_MS: '2500' });
    assert.equal(r.retries, 0);
    assert.equal(r.timeout, 2500);
  });
});

describe('jev_ask arguments, checked before anything is sent', () => {
  const q = { u: { type: 'noul', instructions: 'Urgent?' } };
  const cases = [
    [{ questions: q }, /`state` is required/],
    [{ state: 42, questions: q }, /`state` must be a string, a JSON object or an array/],
    [{ state: 'x', questions: q, question: q }, /Unknown argument "question"/],
    [{ state: 'x', questions: q, model: '' }, /`model` must be a model name/],
    [{ state: 'x', questions: q, cache: 'no' }, /`cache` must be true or false/],
    [{ state: 'x', questions: { u: { type: 'noul', instructions: 7 } } }, /instructions must be a string, an object or an array/],
    [{ state: 'x', questions: { u: { type: 'noul', instructions: 'i', criteria: { yes: 'y' } } } }, /takes only "true" and "false"/],
    [{ state: 'x', questions: { u: { type: 'choice', instructions: 'i', criteria: { a: 'x', b: 3 } } } }, /criteria\["b"\] must be a string, an object, an array or null/],
    [{ state: 'x', questions: { u: { type: 'score', instructions: 'i', criteria: ['low', null] } } }, /criteria\[1\] must be a non-empty string/],
    [{ state: 'x', questions: { u: { type: 'score', instructions: 'i', criteria: Array(11).fill('l') } } }, /at most 10 levels/],
    [{ state: 'x', questions: { u: { type: 'choice', instructions: 'i', options: ['a', 'b'] } } }, /unknown field "options"/],
  ];
  for (const [args, message] of cases) {
    test(`rejects ${JSON.stringify(args).slice(0, 90)}`, () => assert.match(validateAsk(args), message));
  }

  test('accepts structured instructions, null choice descriptions and object score levels, as the API does', () => {
    assert.equal(validateAsk({
      state: { ticket: { body: 'x' } },
      questions: {
        a: { type: 'noul', instructions: { question: 'Is `ticket.body` urgent?' }, criteria: { true: 'Time-sensitive' } },
        b: { type: 'choice', instructions: ['Pick one', 'for `ticket.body`'], criteria: { yes: null, no: { meaning: 'not so' } } },
        c: { type: 'score', instructions: 'How bad?', criteria: [{ level: 'fine' }, 'bad'] },
      },
      model: 'jev-1.13.0',
      cache: false,
    }), null);
  });
});
