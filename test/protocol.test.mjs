/**
 * The MCP surface, driven the way a client drives it: a real server process
 * over stdio, both protocol eras, every tool, resource, prompt and completion.
 * Only the TypeSafe API is faked. The limits Claude Code applies to what a
 * server declares are checked too, since a tool that breaks one is dropped.
 *
 * Spec: modelcontextprotocol.io/specification/2026-07-28 and /2025-11-25.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

import { INSTRUCTIONS, TOOLS } from '../src/catalog.mjs';
import { check, unknownKeywords } from './schema-check.mjs';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.mjs');

const REAL = {
  model: 'jev-1.13.0',
  answers: {
    is_urgent: { type: 'noul', noul: 0.95 },
    department: { type: 'choice', choice: 'billing', confidence: 0.8, probabilities: { sales: 0.0, technical: 0.13, billing: 0.87 } },
    frustration: { type: 'score', score: 1.05, confidence: 0.92, legend: { 0: 'Calm', 1: 'Frustrated', 2: 'Very angry' }, probabilities: { 0: 0.0, 1: 0.95, 2: 0.05 } },
  },
  usage: { input_tokens: 399, output_tokens: 73 },
};
const MODELS = { models: [{ name: 'jev-latest', description: 'Stable', release_date: '2026-09-01' }, { name: 'jev-preview', description: 'Newest', release_date: '2026-09-01' }] };
const QUESTIONS = {
  is_urgent: { type: 'noul', instructions: 'Does this convey urgency?' },
  department: { type: 'choice', instructions: 'Which team should handle this?', criteria: { billing: 'Payments', technical: 'Bugs', sales: 'Pricing' } },
  frustration: { type: 'score', instructions: 'How frustrated is the customer?', criteria: ['Calm', 'Frustrated', 'Very angry'] },
};
const MODERN = '2026-07-28';
const META = (extra = {}) => ({
  'io.modelcontextprotocol/protocolVersion': MODERN,
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'protocol-test', version: '1' },
  ...extra,
});
const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

const tmp = mkdtempSync(join(tmpdir(), 'jev-protocol-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

/* ── a fake TypeSafe API ─────────────────────────────────────────────────── */

const api = { posts: 0, agents: [], plan: [] };
const fake = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    api.agents.push(req.headers['user-agent']);
    if (req.headers.authorization !== 'Bearer test-key') return res.writeHead(401).end('{"detail":"bad key"}');
    if (req.method === 'GET' && req.url === '/v1/models') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(MODELS));
    if (req.method !== 'POST' || req.url !== '/v1/systemone') return res.writeHead(404).end();
    api.posts++;
    const { state } = JSON.parse(body);
    if (state === 'slow') return setTimeout(() => res.writeHead(200).end(JSON.stringify(REAL)), 3000);
    const step = api.plan.shift();
    if (step) return res.writeHead(step.status, step.headers).end(step.body ?? '{"detail":"try later"}');
    res.writeHead(200, { 'content-type': 'application/json', 'x-typesafe-request-id': 'req_123' }).end(JSON.stringify(REAL));
  });
});
// Listening before any suite starts: Node 20 runs a suite's before() ahead of a root-level one.
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
// Unref'd, because Node 20 runs a root-level after() only once the process is otherwise idle.
fake.unref();
after(() => { fake.closeAllConnections?.(); fake.close(); });

/* ── a client ────────────────────────────────────────────────────────────── */

let seq = 0;
function start(env = {}) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, TYPESAFE_API_URL: `http://127.0.0.1:${fake.address().port}/v1`, TYPESAFE_API_KEY: 'test-key',
      TYPESAFE_DB: join(tmp, `p${seq++}.db`), JEV_BRIDGE_HOME: join(tmp, 'home'), TYPESAFE_BACKOFF_INITIAL_MS: '1', ...env },
  });
  const messages = [];
  const waiters = [];
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const msg = JSON.parse(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      messages.push(msg);
      for (const w of [...waiters]) if (w.match(msg)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
    }
  });
  const waitFor = (match, ms = 5000) => {
    const seen = messages.find(match);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const w = { match, resolve };
      waiters.push(w);
      setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); reject(new Error('timed out waiting for a message')); }, ms);
    });
  };
  let id = 0;
  const raw = (line) => child.stdin.write(line + '\n');
  const send = (method, params, msgId = ++id) => {
    raw(JSON.stringify({ jsonrpc: '2.0', id: msgId, method, ...(params !== undefined && { params }) }));
    return waitFor((m) => m.id === msgId && (m.result || m.error));
  };
  const notify = (method, params) => raw(JSON.stringify({ jsonrpc: '2.0', method, ...(params !== undefined && { params }) }));
  const modern = (method, params = {}, extraMeta) => send(method, { ...params, _meta: META(extraMeta) });
  return { child, messages, send, notify, modern, raw, waitFor, nextId: () => ++id, stop: () => child.kill() };
}

const call = (c, name, args, era = 'legacy') =>
  (era === 'modern' ? c.modern('tools/call', { name, arguments: args }) : c.send('tools/call', { name, arguments: args }));

/* ── what Claude Code accepts ────────────────────────────────────────────── */

describe('the schema checker these tests rely on', () => {
  test('flags a wrong type, a missing field, an ambiguous oneOf and a misspelt keyword', () => {
    const schema = { type: 'object', properties: { n: { type: 'integer' } }, required: ['n', 'm'] };
    assert.deepEqual(check(schema, { n: 1.5 }), ['$: missing "m"', '$.n: expected integer, got number']);
    assert.equal(check({ oneOf: [{ type: 'number' }, { type: 'integer' }] }, 3).length, 1, 'matches both branches');
    assert.deepEqual(check({ oneOf: [{ const: 'a' }, { const: 'b' }] }, 'b'), []);
    assert.deepEqual(unknownKeywords({ type: 'object', requried: ['x'] }), ['$.requried']);
  });
});

describe('declarations Claude Code will accept', () => {
  test('the server instructions and every tool description fit in 2 KB, the cut-off Claude Code applies', () => {
    assert.ok(Buffer.byteLength(INSTRUCTIONS) <= 2048, `instructions are ${Buffer.byteLength(INSTRUCTIONS)} bytes`);
    for (const t of TOOLS) assert.ok(Buffer.byteLength(t.description) <= 2048, `${t.name} is ${Buffer.byteLength(t.description)} bytes`);
  });

  test('every input schema is an object at the root, with no root combinator and API-safe property names', () => {
    for (const t of TOOLS) {
      assert.equal(t.inputSchema.type, 'object', t.name);
      for (const k of ['oneOf', 'anyOf', 'allOf']) assert.ok(!(k in t.inputSchema), `${t.name} has a root ${k}`);
      for (const p of Object.keys(t.inputSchema.properties ?? {})) assert.match(p, /^[A-Za-z0-9_.-]{1,64}$/, `${t.name}.${p}`);
    }
  });

  test('every schema uses only known keywords, so a typo cannot pass silently', () => {
    for (const t of TOOLS) {
      assert.deepEqual(unknownKeywords(t.inputSchema), [], `${t.name} inputSchema`);
      assert.deepEqual(unknownKeywords(t.outputSchema), [], `${t.name} outputSchema`);
    }
  });

  test('every tool declares an output schema, a title and all four behaviour hints', () => {
    for (const t of TOOLS) {
      assert.equal(t.outputSchema?.type, 'object', t.name);
      assert.ok(t.title, t.name);
      for (const h of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
        assert.equal(typeof t.annotations?.[h], 'boolean', `${t.name}.${h}`);
      }
    }
    assert.equal(byName.jev_review.annotations.readOnlyHint, false, 'jev_review writes a review');
    assert.equal(byName.jev_ask.annotations.openWorldHint, true, 'jev_ask reaches TypeSafe');
  });
});

/* ── legacy: the initialize handshake ───────────────────────────────────── */

describe('legacy era (initialize, 2025-11-25 and earlier)', () => {
  let c;
  before(() => { c = start(); });
  after(() => c.stop());

  test('initialize echoes a version it supports, with every capability, identity and instructions', async () => {
    const { result } = await c.send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'legacy-test', version: '1' } });
    assert.equal(result.protocolVersion, '2025-06-18');
    assert.deepEqual(Object.keys(result.capabilities).sort(), ['completions', 'prompts', 'resources', 'tools']);
    assert.equal(result.serverInfo.name, 'jev-bridge');
    assert.ok(result.serverInfo.title && result.serverInfo.version && result.serverInfo.websiteUrl);
    assert.equal(result.instructions, INSTRUCTIONS);
    assert.equal(result.resultType, undefined, 'resultType belongs to 2026-07-28');
  });

  test('initialize answers an unknown version, or the handshake-free 2026-07-28, with its newest legacy version', async () => {
    const other = start();
    try {
      for (const asked of ['2099-01-01', MODERN]) {
        const { result } = await other.send('initialize', { protocolVersion: asked, capabilities: {}, clientInfo: { name: 'x', version: '1' } });
        assert.equal(result.protocolVersion, '2025-11-25', asked);
      }
    } finally { other.stop(); }
  });

  test('tools/list carries no modern-only fields, and ping still answers', async () => {
    const { result } = await c.send('tools/list');
    assert.deepEqual(result.tools.map((t) => t.name), TOOLS.map((t) => t.name));
    for (const k of ['resultType', 'ttlMs', 'cacheScope']) assert.equal(result[k], undefined, k);
    assert.deepEqual((await c.send('ping')).result, {});
  });

  test('jev_ask answers with structured content that fits its output schema, a text copy, and a link to the call', async () => {
    const { result } = await call(c, 'jev_ask', { state: 'Help! My payouts failed.', questions: QUESTIONS });
    assert.equal(result.isError, undefined, result.content[0].text);
    assert.deepEqual(check(byName.jev_ask.outputSchema, result.structuredContent), []);
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    assert.equal(result.structuredContent.bridge.request_id, 'req_123');
    const link = result.content.find((b) => b.type === 'resource_link');
    assert.equal(link.uri, `jev://history/${result.structuredContent.bridge.call_id}`);
    assert.match(api.agents.at(-1), /^jev-bridge\//, 'the bridge names itself in User-Agent');
  });

  test('every other tool answers with structured content that fits its output schema', async () => {
    const asked = (await call(c, 'jev_ask', { state: 'Help! My payouts failed.', questions: QUESTIONS })).result.structuredContent;
    assert.equal(asked.bridge.cached, true, 'the repeat is a cache hit');
    assert.deepEqual(check(byName.jev_ask.outputSchema, asked), []);
    const id = asked.bridge.call_id;
    const results = {
      jev_usage: await call(c, 'jev_usage', { days: 1 }),
      jev_history: await call(c, 'jev_history', {}),
      jev_history_one: await call(c, 'jev_history', { id }),
      jev_review: await call(c, 'jev_review', { id, verdict: 'correct', note: 'billing is right' }),
      jev_models: await call(c, 'jev_models', {}),
    };
    for (const [label, { result }] of Object.entries(results)) {
      const tool = byName[label.replace('_one', '')];
      assert.equal(result.isError, undefined, `${label}: ${result.content[0].text}`);
      assert.deepEqual(check(tool.outputSchema, result.structuredContent), [], label);
    }
    assert.deepEqual(results.jev_models.result.structuredContent, MODELS);
    assert.equal(results.jev_history_one.result.structuredContent.client, 'legacy-test', 'the call is filed under the client that made it');
    assert.equal(results.jev_history.result.structuredContent.calls[0].client, 'legacy-test');
  });

  test('a bad argument comes back as a tool error the model can read and fix, naming the field', async () => {
    const { result } = await call(c, 'jev_ask', { state: 'x', questions: { q: { type: 'choice', instructions: 'Pick', options: ['a', 'b'] } } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /questions\["q"\] has an unknown field "options"/);
  });

  test('an unknown tool is a protocol error, -32602, not a tool result', async () => {
    const { error } = await call(c, 'jev_nope', {});
    assert.equal(error.code, -32602);
    assert.match(error.message, /Unknown tool: jev_nope/);
  });

  test('an unknown method is -32601; a modern-only method is refused outside 2026-07-28', async () => {
    assert.equal((await c.send('does/not/exist')).error.code, -32601);
    // Without per-request metadata it is a malformed modern request…
    assert.equal((await c.send('subscriptions/listen', {})).error.code, -32602);
    // …and under a legacy version it does not exist.
    const legacyMeta = { ...META(), 'io.modelcontextprotocol/protocolVersion': '2025-11-25' };
    assert.equal((await c.send('server/discover', { _meta: legacyMeta })).error.code, -32601);
  });

  test('a resource that is not there is -32002, the legacy code', async () => {
    const { error } = await c.send('resources/read', { uri: 'jev://history/nope' });
    assert.equal(error.code, -32002);
  });

  test('a client older than 2025-06-18 gets no resource_link, a content type it would not know', async () => {
    const old = start();
    try {
      await old.send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'old', version: '1' } });
      const { result } = await call(old, 'jev_ask', { state: 'an older client', questions: QUESTIONS });
      assert.deepEqual(result.content.map((b) => b.type), ['text']);
    } finally { old.stop(); }
  });

  test('resources/subscribe brings notifications/resources/updated after a call', async () => {
    assert.deepEqual((await c.send('resources/subscribe', { uri: 'jev://usage' })).result, {});
    await call(c, 'jev_ask', { state: 'a subscribed call', questions: QUESTIONS });
    const note = await c.waitFor((m) => m.method === 'notifications/resources/updated' && m.params.uri === 'jev://usage');
    assert.equal(note.params._meta, undefined, 'no subscriptionId outside 2026-07-28');
    assert.equal((await c.send('resources/subscribe', { uri: 'file:///etc/passwd' })).error.code, -32602);
  });
});

/* ── modern: 2026-07-28, stateless ──────────────────────────────────────── */

describe('modern era (2026-07-28, no handshake)', () => {
  let c;
  before(() => { c = start(); });
  after(() => c.stop());

  test('server/discover names every supported version, the capabilities, identity and caching hints', async () => {
    const { result } = await c.modern('server/discover');
    assert.equal(result.resultType, 'complete');
    assert.deepEqual(result.supportedVersions, [MODERN, '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
    assert.deepEqual(Object.keys(result.capabilities).sort(), ['completions', 'prompts', 'resources', 'tools']);
    assert.equal(result.instructions, INSTRUCTIONS);
    assert.equal(result._meta['io.modelcontextprotocol/serverInfo'].name, 'jev-bridge');
    assert.equal(result.cacheScope, 'public');
    assert.ok(result.ttlMs > 0);
  });

  test('server/discover without request metadata is malformed: -32602', async () => {
    assert.equal((await c.send('server/discover', {})).error.code, -32602);
  });

  test('an unsupported version is -32022, listing what is supported', async () => {
    const { error } = await c.modern('tools/list', {}, { 'io.modelcontextprotocol/protocolVersion': '1900-01-01' });
    assert.equal(error.code, -32022);
    assert.equal(error.data.requested, '1900-01-01');
    assert.ok(error.data.supported.includes(MODERN));
  });

  test('a request without client capabilities is malformed: -32602', async () => {
    const { error } = await c.send('tools/list', { _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN } });
    assert.equal(error.code, -32602);
    assert.match(error.message, /clientCapabilities/);
  });

  test('list results carry resultType, the server identity, and ttlMs and cacheScope', async () => {
    for (const method of ['tools/list', 'prompts/list', 'resources/list', 'resources/templates/list']) {
      const { result } = await c.modern(method);
      assert.equal(result.resultType, 'complete', method);
      assert.equal(result._meta['io.modelcontextprotocol/serverInfo'].name, 'jev-bridge', method);
      assert.equal(result.cacheScope, 'public', method);
      assert.equal(typeof result.ttlMs, 'number', method);
    }
  });

  test('tools come back in the same order every time, so a client can cache them', async () => {
    const a = (await c.modern('tools/list')).result.tools.map((t) => t.name);
    const b = (await c.modern('tools/list')).result.tools.map((t) => t.name);
    assert.deepEqual(a, b);
  });

  test('ping and initialize are gone in 2026-07-28: -32601', async () => {
    assert.equal((await c.modern('ping')).error.code, -32601);
  });

  test('tools/call works with no handshake at all, and files the call under the per-request client', async () => {
    const { result } = await call(c, 'jev_ask', { state: 'A modern ticket.', questions: QUESTIONS }, 'modern');
    assert.equal(result.resultType, 'complete');
    assert.deepEqual(check(byName.jev_ask.outputSchema, result.structuredContent), []);
    const one = await c.modern('resources/read', { uri: `jev://history/${result.structuredContent.bridge.call_id}` });
    assert.equal(JSON.parse(one.result.contents[0].text).client, 'protocol-test');
    assert.equal(one.result.cacheScope, 'private');
  });

  test('a resource that is not there is -32602 in 2026-07-28', async () => {
    assert.equal((await c.modern('resources/read', { uri: 'jev://nothing' })).error.code, -32602);
  });

  test('subscriptions/listen acknowledges only what it can honour, then streams updates tagged with its id', async () => {
    const listenId = c.nextId();
    c.raw(JSON.stringify({ jsonrpc: '2.0', id: listenId, method: 'subscriptions/listen',
      params: { _meta: META(), notifications: { toolsListChanged: true, resourceSubscriptions: ['jev://usage', 'file:///x'] } } }));
    const ack = await c.waitFor((m) => m.method === 'notifications/subscriptions/acknowledged');
    assert.equal(ack.params._meta['io.modelcontextprotocol/subscriptionId'], listenId);
    assert.deepEqual(ack.params.notifications, { resourceSubscriptions: ['jev://usage'] }, 'fixed lists never change, so no list notifications');

    await call(c, 'jev_ask', { state: 'while listening', questions: QUESTIONS }, 'modern');
    const update = await c.waitFor((m) => m.method === 'notifications/resources/updated' && m.params._meta);
    assert.equal(update.params.uri, 'jev://usage');
    assert.equal(update.params._meta['io.modelcontextprotocol/subscriptionId'], listenId);

    c.notify('notifications/cancelled', { requestId: listenId });
    await call(c, 'jev_ask', { state: 'after cancelling', questions: QUESTIONS }, 'modern');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(c.messages.filter((m) => m.method === 'notifications/resources/updated').length, 1, 'nothing after the client cancelled');
    assert.ok(!c.messages.some((m) => m.id === listenId && (m.result || m.error)), 'a client-cancelled stream gets no response');
  });

  test('closing stdin ends an open subscription gracefully, with a completion result', async () => {
    const s = start();
    const listenId = s.nextId();
    s.raw(JSON.stringify({ jsonrpc: '2.0', id: listenId, method: 'subscriptions/listen', params: { _meta: META(), notifications: {} } }));
    await s.waitFor((m) => m.method === 'notifications/subscriptions/acknowledged');
    s.child.stdin.end();
    const done = await s.waitFor((m) => m.id === listenId && m.result);
    assert.equal(done.result.resultType, 'complete');
    assert.equal(done.result._meta['io.modelcontextprotocol/subscriptionId'], listenId);
  });
});

/* ── cancellation and progress ───────────────────────────────────────────── */

describe('cancellation and progress', () => {
  let c;
  before(async () => {
    c = start();
    await c.send('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'cancel-test', version: '1' } });
  });
  after(() => c.stop());

  test('a cancelled call gets no response, and the server keeps serving', async () => {
    const id = c.nextId();
    c.raw(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'jev_ask', arguments: { state: 'slow', questions: QUESTIONS } } }));
    await new Promise((r) => setTimeout(r, 100));
    c.notify('notifications/cancelled', { requestId: id, reason: 'user pressed Esc' });
    const next = await call(c, 'jev_usage', {});
    assert.equal(next.result.isError, undefined);
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(!c.messages.some((m) => m.id === id), 'no response for the cancelled request');
    const history = (await call(c, 'jev_history', { filter: 'errors' })).result.structuredContent;
    assert.match(history.calls[0].error, /Cancelled by the client/);
  });

  test('a call that asked for progress hears about each retry, then gets its answer', async () => {
    api.plan.push({ status: 529, headers: { 'retry-after-ms': '5' } });
    const id = c.nextId();
    c.raw(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call',
      params: { name: 'jev_ask', arguments: { state: 'overloaded once', questions: QUESTIONS }, _meta: { progressToken: 'p1' } } }));
    const answer = await c.waitFor((m) => m.id === id && m.result);
    const progress = c.messages.filter((m) => m.method === 'notifications/progress' && m.params.progressToken === 'p1');
    assert.ok(progress.length >= 2, 'a start and a retry');
    assert.deepEqual(progress.map((p) => p.params.progress), progress.map((_, i) => i + 1), 'progress only increases');
    assert.match(progress.at(-1).params.message, /529; retry 1 of 2/);
    assert.ok(c.messages.indexOf(progress.at(-1)) < c.messages.indexOf(answer), 'progress stops before the response');
    assert.equal(answer.result.structuredContent.bridge.attempts, 2);
  });

  test('no progress is sent to a request that did not ask for it', async () => {
    const before = c.messages.filter((m) => m.method === 'notifications/progress').length;
    await call(c, 'jev_ask', { state: 'no token here', questions: QUESTIONS });
    assert.equal(c.messages.filter((m) => m.method === 'notifications/progress').length, before);
  });
});

/* ── resources, prompts, completions ─────────────────────────────────────── */

describe('resources, prompts and completions', () => {
  let c, callId;
  before(async () => {
    c = start();
    await c.send('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'rpc-test', version: '1' } });
    callId = (await call(c, 'jev_ask', { state: 'for the resources', questions: QUESTIONS })).result.structuredContent.bridge.call_id;
  });
  after(() => c.stop());

  test('the guide, models, usage and history are readable resources', async () => {
    const { result } = await c.send('resources/list');
    assert.deepEqual(result.resources.map((r) => r.uri), ['jev://guide', 'jev://models', 'jev://usage', 'jev://history']);
    const read = (await c.send('resources/read', { uri: 'jev://guide' })).result;
    for (const k of ['ttlMs', 'cacheScope', 'resultType']) assert.equal(read[k], undefined, `${k} is 2026-07-28 only`);
    const guide = read.contents[0];
    assert.equal(guide.mimeType, 'text/markdown');
    assert.match(guide.text, /Question ids are never sent to the model/);
    assert.deepEqual(JSON.parse((await c.send('resources/read', { uri: 'jev://models' })).result.contents[0].text), MODELS);
    assert.equal(JSON.parse((await c.send('resources/read', { uri: 'jev://usage' })).result.contents[0].text).calls, 1);
    assert.equal(JSON.parse((await c.send('resources/read', { uri: 'jev://history' })).result.contents[0].text).calls[0].id, callId);
  });

  test('one call is readable through the history template', async () => {
    const { result } = await c.send('resources/templates/list');
    assert.equal(result.resourceTemplates[0].uriTemplate, 'jev://history/{id}');
    const one = JSON.parse((await c.send('resources/read', { uri: `jev://history/${callId}` })).result.contents[0].text);
    assert.equal(one.state, 'for the resources');
  });

  test('the prompts render with their arguments, and reject a bad one', async () => {
    const { result } = await c.send('prompts/list');
    assert.deepEqual(result.prompts.map((p) => p.name), ['review_uncertain', 'cost_report', 'question_design']);
    const review = (await c.send('prompts/get', { name: 'review_uncertain', arguments: { days: '30', below: '0.7' } })).result;
    assert.equal(review.messages[0].role, 'user');
    assert.match(review.messages[0].content.text, /"filter": "uncertain", "below": 0.7, "days": 30/);
    assert.match((await c.send('prompts/get', { name: 'question_design' })).result.messages[0].content.text, /Designing Jev questions/);
    assert.equal((await c.send('prompts/get', { name: 'cost_report', arguments: { days: 'lots' } })).error.code, -32602);
    assert.equal((await c.send('prompts/get', { name: 'nope' })).error.code, -32602);
  });

  test('completion suggests prompt arguments and call ids', async () => {
    const days = await c.send('completion/complete', { ref: { type: 'ref/prompt', name: 'cost_report' }, argument: { name: 'days', value: '3' } });
    assert.deepEqual(days.result.completion.values, ['30']);
    const ids = await c.send('completion/complete', { ref: { type: 'ref/resource', uri: 'jev://history/{id}' }, argument: { name: 'id', value: callId.slice(0, 4) } });
    assert.ok(ids.result.completion.values.includes(callId));
  });
});

/* ── JSON-RPC edges ──────────────────────────────────────────────────────── */

describe('JSON-RPC edges', () => {
  let c;
  before(() => { c = start(); });
  after(() => c.stop());

  test('a line that is not JSON is a parse error with a null id', async () => {
    c.raw('{not json');
    const err = await c.waitFor((m) => m.error?.code === -32700);
    assert.equal(err.id, null);
  });

  test('a batch is refused: batching left MCP in 2025-06-18', async () => {
    c.raw(JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }]));
    await c.waitFor((m) => m.error?.code === -32600);
  });

  test('an unknown notification is ignored, with nothing written back', async () => {
    const before = c.messages.length;
    c.notify('notifications/whatever', {});
    await c.send('ping');
    assert.equal(c.messages.length, before + 1, 'only the ping answer');
  });
});
