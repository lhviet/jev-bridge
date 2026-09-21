#!/usr/bin/env node
/**
 * Checks jev-bridge against the official MCP JSON Schema, with Ajv — the
 * validator the MCP TypeScript SDK (and so Claude Code) uses.
 *
 *   node evidence/validate-wire.mjs              installs Ajv into the temp directory once
 *   AJV_DIR=/path node evidence/validate-wire.mjs  or uses an Ajv already installed there
 *
 * Three checks, written to evidence/validation.json:
 *
 *   1. recorded  Every message in evidence/runs/<scenario>/wire.jsonl — what
 *                real Claude Code sessions actually exchanged — against the
 *                schema of the protocol revision that message used: results
 *                by the method they answer, requests and notifications by
 *                their own method.
 *   2. sweep     The server started here against a fake TypeSafe API and
 *                asked every method it implements, in both eras, including
 *                the ones Claude Code did not happen to use (completions,
 *                subscriptions, every error path).
 *   3. schemas   Each tool's inputSchema and outputSchema against the JSON
 *                Schema 2020-12 meta-schema, the check Claude Code applies
 *                before it will offer a tool to the model.
 *
 * Ajv is only needed here; jev-bridge itself has no dependencies. The two
 * schema files are fetched from the MCP repository and their SHA-256 recorded.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SCHEMA_URL = (v) => `https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/${v}/schema.json`;
const MODERN = '2026-07-28';
const LEGACY = '2025-11-25';
const M = 'io.modelcontextprotocol/';

/* ── Ajv and the official schemas ────────────────────────────────────────── */

// Ajv lives outside the project: AJV_DIR if given, else a scratch install in the temp directory.
const AJV_DIR = process.env.AJV_DIR || join(tmpdir(), 'jev-bridge-ajv');
const require = createRequire(join(AJV_DIR, 'node_modules', '/'));
let Ajv2020;
try {
  Ajv2020 = require('ajv/dist/2020.js').default;
} catch {
  process.stderr.write(`installing ajv@8 into ${AJV_DIR} (outside the project) …\n`);
  const npm = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--silent', '--no-save', '--prefix', AJV_DIR, 'ajv@8'], { stdio: 'inherit' });
  if (npm.status !== 0) {
    process.stderr.write('Could not install Ajv. Run:  npm install --prefix /tmp/ajv ajv@8  then  AJV_DIR=/tmp/ajv node evidence/validate-wire.mjs\n');
    process.exit(2);
  }
  Ajv2020 = require('ajv/dist/2020.js').default;
}
const ajvVersion = require('ajv/package.json').version;

const schemas = {};
for (const v of [LEGACY, MODERN]) {
  const text = await (await fetch(SCHEMA_URL(v))).text();
  const doc = JSON.parse(text);
  // Formats (uri, byte) are not asserted: the MCP schemas use them as annotations.
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
  ajv.addSchema(doc, 'mcp');
  schemas[v] = { ajv, sha256: createHash('sha256').update(text).digest('hex'), url: SCHEMA_URL(v), defs: doc.$defs };
}

const RESULT_DEF = {
  initialize: 'InitializeResult', ping: 'EmptyResult', 'server/discover': 'DiscoverResult',
  'tools/list': 'ListToolsResult', 'tools/call': 'CallToolResult',
  'prompts/list': 'ListPromptsResult', 'prompts/get': 'GetPromptResult',
  'resources/list': 'ListResourcesResult', 'resources/templates/list': 'ListResourceTemplatesResult',
  'resources/read': 'ReadResourceResult', 'resources/subscribe': 'EmptyResult', 'resources/unsubscribe': 'EmptyResult',
  'completion/complete': 'CompleteResult', 'subscriptions/listen': 'SubscriptionsListenResult',
};
const REQUEST_DEF = {
  initialize: 'InitializeRequest', ping: 'PingRequest', 'server/discover': 'DiscoverRequest',
  'tools/list': 'ListToolsRequest', 'tools/call': 'CallToolRequest',
  'prompts/list': 'ListPromptsRequest', 'prompts/get': 'GetPromptRequest',
  'resources/list': 'ListResourcesRequest', 'resources/templates/list': 'ListResourceTemplatesRequest',
  'resources/read': 'ReadResourceRequest', 'resources/subscribe': 'SubscribeRequest', 'resources/unsubscribe': 'UnsubscribeRequest',
  'completion/complete': 'CompleteRequest', 'subscriptions/listen': 'SubscriptionsListenRequest',
};
const NOTIFICATION_DEF = {
  'notifications/initialized': 'InitializedNotification', 'notifications/cancelled': 'CancelledNotification',
  'notifications/progress': 'ProgressNotification', 'notifications/resources/updated': 'ResourceUpdatedNotification',
  'notifications/subscriptions/acknowledged': 'SubscriptionsAcknowledgedNotification',
};

function validate(version, def, value) {
  const { ajv, defs } = schemas[version];
  if (!defs[def]) return { ok: false, errors: [`no definition ${def} in the ${version} schema`] };
  const check = ajv.getSchema(`mcp#/$defs/${def}`);
  const ok = check(value);
  return { ok, errors: ok ? [] : check.errors.map((e) => `${e.instancePath || '/'} ${e.message}`).slice(0, 5) };
}

/**
 * Validates one conversation, in order. The era of a request is read off the
 * request itself, as the server reads it; a response is checked in its
 * request's era, against the result type of its method.
 */
function validateConversation(messages) {
  const pending = new Map();
  const checked = [];
  const eraOf = (msg) => (msg?.params?._meta?.[`${M}protocolVersion`] === MODERN ? MODERN : LEGACY);
  let lastEra = LEGACY;
  for (const { dir, msg, negative } of messages) {
    const fromClient = dir.startsWith('client');
    let version;
    let def;
    let value = msg;
    if (msg.method && msg.id !== undefined) {
      version = eraOf(msg);
      lastEra = version;
      pending.set(JSON.stringify(msg.id), { method: msg.method, version, expect: negative });
      def = REQUEST_DEF[msg.method];
    } else if (msg.method) {
      version = msg.params?._meta?.[`${M}subscriptionId`] !== undefined ? MODERN : lastEra;
      def = NOTIFICATION_DEF[msg.method];
    } else {
      const req = pending.get(JSON.stringify(msg.id));
      version = req?.version ?? LEGACY;
      if (req?.expect !== undefined) {
        // The answer to a deliberately malformed request: it must be the error the spec names.
        const envelope = validate(version, 'JSONRPCErrorResponse', msg);
        const code = msg.error?.code;
        checked.push({ dir, what: `rejection of ${req.method} with ${req.expect}`, version, def: 'JSONRPCErrorResponse',
          ok: envelope.ok && code === req.expect, errors: [...envelope.errors, ...(code === req.expect ? [] : [`got ${code ?? 'a result'}`])] });
        continue;
      }
      if (msg.error) {
        def = 'JSONRPCErrorResponse';
      } else {
        const envelope = validate(version, 'JSONRPCResultResponse', msg);
        if (!envelope.ok) { checked.push({ dir, what: 'response envelope', version, ...envelope }); continue; }
        def = RESULT_DEF[req?.method];
        value = msg.result;
      }
    }
    const what = msg.method ?? `${pending.get(JSON.stringify(msg.id))?.method ?? '?'} ${msg.error ? 'error' : 'result'}`;
    if (negative !== undefined) { checked.push({ dir, what, version, def, ok: true, negative: true, errors: [] }); continue; }
    if (!def) { checked.push({ dir, what, version, ok: null, errors: ['no schema definition for this message'] }); continue; }
    checked.push({ dir, what, version, def, ...validate(version, def, value), client: fromClient });
  }
  return checked;
}

const summarise = (checked) => ({
  messages: checked.filter((c) => !c.negative).length,
  valid: checked.filter((c) => c.ok === true && !c.negative).length,
  deliberately_malformed: checked.filter((c) => c.negative).map((c) => c.what),
  invalid: checked.filter((c) => c.ok === false),
  unchecked: checked.filter((c) => c.ok === null).map((c) => c.what),
  by_type: Object.entries(checked.reduce((acc, c) => {
    const k = `${c.version} ${c.def ?? c.what}`;
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {})).sort().map(([k, n]) => `${k} x${n}`),
});

/* ── 1. what real Claude Code sessions exchanged ─────────────────────────── */

const recorded = {};
const runs = join(HERE, 'runs');
for (const name of existsSync(runs) ? readdirSync(runs).sort() : []) {
  const file = join(runs, name, 'wire.jsonl');
  if (!existsSync(file)) continue;
  const messages = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const checked = validateConversation(messages);
  recorded[name] = {
    server: summarise(checked.filter((c) => c.dir.startsWith('server'))),
    client: summarise(checked.filter((c) => c.dir.startsWith('client'))),
  };
}

/* ── 2. a sweep of every method, both eras ───────────────────────────────── */

const REAL = {
  model: 'jev-1.13.0',
  answers: {
    urgent: { type: 'noul', noul: 0.95 },
    team: { type: 'choice', choice: 'billing', confidence: 0.8, probabilities: { billing: 0.87, technical: 0.13 } },
    anger: { type: 'score', score: 1.05, confidence: 0.92, legend: { 0: 'Calm', 1: 'Cross', 2: 'Furious' }, probabilities: { 0: 0, 1: 0.95, 2: 0.05 } },
  },
  usage: { input_tokens: 399, output_tokens: 73 },
};
const QUESTIONS = {
  urgent: { type: 'noul', instructions: 'Is it urgent?' },
  team: { type: 'choice', instructions: 'Which team?', criteria: { billing: 'Payments', technical: 'Bugs' } },
  anger: { type: 'score', instructions: 'How angry?', criteria: ['Calm', 'Cross', 'Furious'] },
};
let overloadOnce = true;
const api = createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    if (req.url === '/v1/models') return res.writeHead(200).end(JSON.stringify({ models: [{ name: 'jev-latest', description: 'Stable', release_date: '2026-09-10' }] }));
    if (overloadOnce) { overloadOnce = false; return res.writeHead(529, { 'retry-after-ms': '1' }).end('{"detail":"overloaded"}'); }
    res.writeHead(200).end(JSON.stringify(REAL));
  });
});
await new Promise((r) => api.listen(0, '127.0.0.1', r));

async function sweep() {
  const child = spawn(process.execPath, [join(ROOT, 'src', 'server.mjs')], {
    env: { ...process.env, TYPESAFE_API_URL: `http://127.0.0.1:${api.address().port}/v1`, TYPESAFE_API_KEY: 'sweep',
      TYPESAFE_DB: join(tmpdir(), `jev-sweep-${process.pid}.db`), TYPESAFE_BACKOFF_INITIAL_MS: '1' },
  });
  const wire = [];
  const waiting = new Map();
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const msg = JSON.parse(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      wire.push({ dir: 'server->client', msg });
      if (msg.id !== undefined && (msg.result || msg.error)) waiting.get(JSON.stringify(msg.id))?.(msg);
    }
  });
  let n = 0;
  // A deliberately malformed request is recorded as such: the check is that the server rejects it.
  const out = (msg, negative) => { wire.push({ dir: 'client->server', msg, negative }); child.stdin.write(JSON.stringify(msg) + '\n'); };
  const send = (method, params, { negative } = {}) => {
    const id = ++n;
    const reply = new Promise((resolve) => waiting.set(JSON.stringify(id), resolve));
    out({ jsonrpc: '2.0', id, method, ...(params && { params }) }, negative);
    return reply;
  };
  const meta = (extra = {}) => ({ [`${M}protocolVersion`]: MODERN, [`${M}clientCapabilities`]: {}, [`${M}clientInfo`]: { name: 'sweep', version: '1' }, ...extra });
  const modern = (method, params = {}, options) => send(method, { ...params, _meta: meta(params._meta) }, options);

  // legacy
  await send('initialize', { protocolVersion: LEGACY, capabilities: {}, clientInfo: { name: 'sweep', version: '1' } });
  out({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await send('ping');
  for (const m of ['tools/list', 'prompts/list', 'resources/list', 'resources/templates/list']) await send(m);
  await send('resources/subscribe', { uri: 'jev://usage' });
  const asked = await send('tools/call', { name: 'jev_ask', arguments: { state: 'legacy sweep', questions: QUESTIONS }, _meta: { progressToken: 'p' } });
  const id = asked.result.structuredContent.bridge.call_id;
  for (const [name, args] of [['jev_usage', { days: 1 }], ['jev_history', {}], ['jev_history', { id }], ['jev_review', { id, verdict: 'correct' }], ['jev_models', {}], ['jev_ask', { state: 'x', questions: {} }]]) {
    await send('tools/call', { name, arguments: args });
  }
  for (const uri of ['jev://guide', 'jev://models', 'jev://usage', 'jev://history', `jev://history/${id}`, 'jev://nothing']) await send('resources/read', { uri });
  for (const p of [{ name: 'review_uncertain', arguments: { days: '7' } }, { name: 'cost_report' }, { name: 'question_design' }]) await send('prompts/get', p);
  await send('completion/complete', { ref: { type: 'ref/prompt', name: 'cost_report' }, argument: { name: 'days', value: '' } });
  await send('completion/complete', { ref: { type: 'ref/resource', uri: 'jev://history/{id}' }, argument: { name: 'id', value: '' } });
  await send('resources/unsubscribe', { uri: 'jev://usage' });
  await send('tools/call', { name: 'no_such_tool', arguments: {} });
  await send('no/such/method', undefined, { negative: -32601 });

  // modern
  await modern('server/discover');
  for (const m of ['tools/list', 'prompts/list', 'resources/list', 'resources/templates/list']) await modern(m);
  const listenId = ++n;
  out({ jsonrpc: '2.0', id: listenId, method: 'subscriptions/listen', params: { _meta: meta(), notifications: { resourceSubscriptions: ['jev://usage'] } } });
  await modern('tools/call', { name: 'jev_ask', arguments: { state: 'modern sweep', questions: QUESTIONS }, _meta: { progressToken: 9 } });
  for (const [name, args] of [['jev_usage', {}], ['jev_history', { filter: 'uncertain' }], ['jev_models', {}]]) await modern('tools/call', { name, arguments: args });
  for (const uri of ['jev://guide', 'jev://usage', 'jev://nothing']) await modern('resources/read', { uri });
  await modern('prompts/get', { name: 'cost_report', arguments: { days: '30' } });
  await modern('completion/complete', { ref: { type: 'ref/prompt', name: 'review_uncertain' }, argument: { name: 'below', value: '0.' } });
  await modern('tools/list', { _meta: { [`${M}protocolVersion`]: '1900-01-01' } }, { negative: -32022 });
  await send('tools/list', { _meta: { [`${M}protocolVersion`]: MODERN } }, { negative: -32602 }); // no clientCapabilities
  await modern('ping', {}, { negative: -32601 }); // removed in 2026-07-28
  await send('server/discover', {}, { negative: -32602 }); // a modern-only method without its metadata
  const closed = new Promise((resolve) => waiting.set(JSON.stringify(listenId), resolve));
  child.stdin.end(); // ends the listen stream with a completion result
  await closed;
  child.kill();
  return wire;
}

const sweepWire = await sweep();
api.close();
const sweepChecked = validateConversation(sweepWire);

/* ── 3. the tool schemas themselves ──────────────────────────────────────── */

const { TOOLS } = await import(join(ROOT, 'src', 'catalog.mjs'));
const meta = new Ajv2020({ strict: true, allowUnionTypes: true });
const toolSchemas = TOOLS.flatMap((t) => ['inputSchema', 'outputSchema'].map((k) => {
  const valid = meta.validateSchema(t[k]);
  let compiles = true;
  let error = null;
  try { meta.compile(t[k]); } catch (err) { compiles = false; error = err.message; }
  return { tool: t.name, schema: k, valid_2020_12: valid, compiles_strict: compiles, error: error ?? (valid ? null : meta.errorsText(meta.errors)) };
}));

/* ── the report ──────────────────────────────────────────────────────────── */

const report = {
  checked_at: new Date().toISOString(),
  validator: `ajv ${ajvVersion} (Ajv2020)`,
  schemas: Object.fromEntries(Object.entries(schemas).map(([v, s]) => [v, { url: s.url, sha256: s.sha256 }])),
  recorded,
  sweep: {
    server: summarise(sweepChecked.filter((c) => c.dir.startsWith('server'))),
    client: summarise(sweepChecked.filter((c) => c.dir.startsWith('client'))),
  },
  tool_schemas: toolSchemas,
};
writeFileSync(join(HERE, 'validation.json'), JSON.stringify(report, null, 2) + '\n');

const line = (label, s) => `${label.padEnd(40)} ${String(s.valid).padStart(3)}/${String(s.messages).padEnd(3)} valid`
  + `${s.invalid.length ? `  ${s.invalid.length} INVALID` : ''}${s.unchecked.length ? `  (${s.unchecked.length} without a schema definition)` : ''}`
  + `${s.deliberately_malformed?.length ? `  (+${s.deliberately_malformed.length} deliberately malformed requests)` : ''}`;
for (const [name, r] of Object.entries(recorded)) {
  process.stdout.write(line(`recorded ${name} (server)`, r.server) + '\n');
  process.stdout.write(line(`recorded ${name} (client)`, r.client) + '\n');
}
process.stdout.write(line('sweep (server)', report.sweep.server) + '\n');
process.stdout.write(line('sweep (client)', report.sweep.client) + '\n');
const badSchemas = toolSchemas.filter((s) => !s.valid_2020_12 || !s.compiles_strict);
process.stdout.write(`tool schemas valid under 2020-12:  ${toolSchemas.length - badSchemas.length}/${toolSchemas.length}\n`);
const failures = [...Object.values(recorded).flatMap((r) => [...r.server.invalid, ...r.client.invalid]),
  ...report.sweep.server.invalid, ...report.sweep.client.invalid];
for (const f of failures) process.stdout.write(`  INVALID ${f.version} ${f.what} (${f.def}): ${f.errors.join('; ')}\n`);
for (const s of badSchemas) process.stdout.write(`  BAD SCHEMA ${s.tool}.${s.schema}: ${s.error}\n`);
process.exit(failures.length || badSchemas.length ? 1 : 0);
