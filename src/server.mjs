#!/usr/bin/env node
/**
 * jev-bridge — a stdio MCP server for TypeSafe's System One model, Jev.
 *
 * The `typesafe@typesafe-ai` plugin ships a SKILL.md and nothing else: it is
 * prompt guidance with no network capability. This server is the missing wire.
 * It exposes TypeSafe's two endpoints — POST /v1/systemone and GET /v1/models —
 * as MCP tools and resources, so an agent can obtain a judgment instead of only
 * reading about how to design one.
 *
 * Zero dependencies — Node built-ins only. Caching needs Node >= 22.5 for
 * `node:sqlite`; on anything older the bridge still runs, from memory.
 *
 * Protocol note: MCP stdio framing is newline-delimited JSON-RPC 2.0. stdout
 * therefore carries protocol bytes and NOTHING else; every diagnostic goes to
 * stderr. A stray console.log here corrupts the stream and the failure reads
 * as "server disconnected" with no clue why.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GUIDE, GUIDE_URI, INSTRUCTIONS, PROMPTS, RESOURCES, TEMPLATES, TOOLS } from './catalog.mjs';
import { FILTER_NAMES, historyReport, reviewCall } from './history.mjs';
import { ERRORS, McpError, createProtocol } from './mcp.mjs';
import { HISTORY_MODES, cacheKey, openStore, questionFingerprint } from './store.mjs';
import { BASE, DEFAULT_MODEL, HOME, RETRY, describeFailure, loadKey as loadKeyFrom, request } from './typesafe.mjs';
import { startUi } from './ui.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const PKG = (() => {
  try { return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')); } catch { return { version: '0.0.0' }; }
})();

const DB_PATH = process.env.TYPESAFE_DB || join(HOME, 'jev.db');
const USD_PER_MTOK = Number(process.env.TYPESAFE_USD_PER_MTOK || 0.042); // published Jev 1.13 input price
const TTL_DAYS = Number(process.env.TYPESAFE_CACHE_TTL_DAYS || 7);
const MAX_ENTRIES = Number(process.env.TYPESAFE_CACHE_MAX || 20000);
const HISTORY = (process.env.TYPESAFE_HISTORY || 'full').trim().toLowerCase();
const HISTORY_DAYS = Number(process.env.TYPESAFE_HISTORY_DAYS || 30);
const HISTORY_MAX = Number(process.env.TYPESAFE_HISTORY_MAX || 10000);
const USER_AGENT = `jev-bridge/${PKG.version} (node ${process.version})`;

export const SERVER_INFO = {
  name: 'jev-bridge',
  title: 'Jev (TypeSafe System One)',
  version: PKG.version,
  description: 'Calibrated, typed judgments from TypeSafe\'s Jev, with a local answer cache, cost accounting and a reviewable call history.',
  websiteUrl: 'https://github.com/lhviet/jev-bridge',
};

const log = (...a) => process.stderr.write(`[jev-bridge] ${a.join(' ')}\n`);
const priceOf = (tokens, usdPerMtok) => (tokens * usdPerMtok) / 1e6;

/** The key, looked up afresh on every call so a rotated key needs no restart. */
export const loadKey = () => loadKeyFrom(ROOT);

/* ── transport ───────────────────────────────────────────────────────────── */

/** The live transport: one POST to /systemone. Swapped for a fake in tests. */
function liveTransport() {
  return async (body, { signal, onRetry } = {}) => {
    const key = loadKey();
    if (!key) {
      throw new Error(`No TypeSafe API key. Set TYPESAFE_API_KEY, or write it to ${join(HOME, '.env')} (chmod 600).`);
    }
    return request('/systemone', { method: 'POST', body, key, signal, onRetry, userAgent: USER_AGENT });
  };
}

/** GET /v1/models, shaped as the API documents it: `{ models: [{ name, description, release_date }] }`. */
async function listModels({ signal } = {}) {
  const key = loadKey();
  if (!key) throw new Error(`No TypeSafe API key. Set TYPESAFE_API_KEY, or write it to ${join(HOME, '.env')} (chmod 600).`);
  const res = await request('/models', { key, signal, userAgent: USER_AGENT });
  if (res.status !== 200) throw new Error(describeFailure(res.status, res.text, res.requestId));
  const body = JSON.parse(res.text);
  return { models: Array.isArray(body?.models) ? body.models : [] };
}

/* ── validation ──────────────────────────────────────────────────────────── */

const isTextish = (v) => typeof v === 'string' || (v !== null && typeof v === 'object');
const QUESTION_FIELDS = ['type', 'instructions', 'criteria'];
const ASK_ARGS = ['state', 'questions', 'model', 'cache'];

/**
 * Checked here rather than left to the API so a malformed question costs no
 * round trip and names itself. Mirrors the request body in docs.typesafe.ai/api:
 * instructions and criteria entries are `string | object | array`; a choice has
 * at most 255 options; a score has 2 to 10 levels in an ordered array.
 */
export function validateQuestions(questions) {
  if (!questions || typeof questions !== 'object' || Array.isArray(questions)) {
    return 'questions must be an object mapping your own question ids to question objects.';
  }
  const ids = Object.keys(questions);
  if (ids.length === 0) return 'questions must contain at least one question.';

  for (const id of ids) {
    const q = questions[id];
    const at = `questions["${id}"]`;
    if (!q || typeof q !== 'object' || Array.isArray(q)) return `${at} must be an object.`;
    const unknown = Object.keys(q).find((k) => !QUESTION_FIELDS.includes(k));
    if (unknown) return `${at} has an unknown field "${unknown}". A question has only type, instructions and criteria.`;
    if (!['noul', 'choice', 'score'].includes(q.type)) {
      return `${at}.type must be "noul", "choice" or "score" (got ${JSON.stringify(q.type)}).`;
    }
    if (q.instructions === undefined || q.instructions === null || q.instructions === '') {
      return `${at}.instructions is required.`;
    }
    if (!isTextish(q.instructions)) return `${at}.instructions must be a string, an object or an array.`;
    if (q.type === 'choice') {
      const c = q.criteria;
      if (!c || typeof c !== 'object' || Array.isArray(c)) {
        return `${at}.criteria is required for a choice and must be an object mapping option -> description (use null for no description).`;
      }
      const n = Object.keys(c).length;
      if (n < 2) return `${at}.criteria needs at least 2 options.`;
      if (n > 255) return `${at}.criteria allows at most 255 options (got ${n}).`;
      const bad = Object.keys(c).find((k) => c[k] !== null && !isTextish(c[k]));
      if (bad !== undefined) return `${at}.criteria["${bad}"] must be a string, an object, an array or null.`;
    }
    if (q.type === 'score') {
      if (!Array.isArray(q.criteria)) {
        return `${at}.criteria is required for a score and must be an ORDERED ARRAY of level descriptions, lowest first.`;
      }
      if (q.criteria.length < 2) return `${at}.criteria needs at least 2 levels.`;
      if (q.criteria.length > 10) return `${at}.criteria allows at most 10 levels (got ${q.criteria.length}).`;
      const bad = q.criteria.findIndex((level) => !isTextish(level) || level === '');
      if (bad !== -1) return `${at}.criteria[${bad}] must be a non-empty string, an object or an array.`;
    }
    if (q.type === 'noul' && q.criteria !== undefined) {
      const c = q.criteria;
      if (!c || typeof c !== 'object' || Array.isArray(c)) {
        return `${at}.criteria for a noul must be an object with "true" and/or "false" keys.`;
      }
      const key = Object.keys(c).find((k) => k !== 'true' && k !== 'false');
      if (key !== undefined) return `${at}.criteria for a noul takes only "true" and "false" (got "${key}").`;
    }
  }
  return null;
}

/** The whole jev_ask argument object, before anything is looked up or sent. */
export function validateAsk(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'arguments must be an object with state and questions.';
  const unknown = Object.keys(args).find((k) => !ASK_ARGS.includes(k));
  if (unknown) return `Unknown argument "${unknown}". jev_ask takes ${ASK_ARGS.join(', ')}.`;
  const { state, model, cache } = args;
  if (state === undefined || state === null) return '`state` is required: a string, a JSON object or an array.';
  if (!isTextish(state)) return '`state` must be a string, a JSON object or an array (text only).';
  if (model !== undefined && (typeof model !== 'string' || !model.trim())) return '`model` must be a model name such as "jev-latest".';
  if (cache !== undefined && typeof cache !== 'boolean') return '`cache` must be true or false.';
  return validateQuestions(args.questions);
}

/* ── the one operation ───────────────────────────────────────────────────── */

/**
 * Validate → look in the cache → call the API → store the answer and the cost.
 *
 * `transport` and `now` are injected so the whole path can be tested without
 * spending tokens. An error is never cached: a 529 today must not become a
 * week of stored failure.
 *
 * Every outcome — hit, answer, rejection, a network that never answered, a
 * client that cancelled — is recorded twice: in the usage log, and in the
 * history a reviewer reads later. Both are only queued here; the store writes
 * them after this answer has gone back, so recording costs the caller nothing
 * it can measure.
 */
export async function askJev(args, { store, transport, now = Date.now, usdPerMtok = USD_PER_MTOK, client = null, signal, progress }) {
  const bad = validateAsk(args);
  if (bad) throw new Error(bad);
  const { state, questions, model = DEFAULT_MODEL, cache = true } = args;

  const ts = now();
  const clock = performance.now();
  const key = cacheKey(model, state, questions);
  const count = Object.keys(questions).length;
  const took = () => Math.round((performance.now() - clock) * 100) / 100;
  const record = ({ answers, ...outcome }) => {
    store.recordCall({ ts, requested_model: model, questions: count, ...outcome });
    return store.recordHistory({ ts, client, requested_model: model, forced: cache === false, state, questions, answers, ...outcome });
  };
  const bridge = (facts, callId) => (callId ? { ...facts, call_id: callId } : facts);

  if (cache !== false) {
    const hit = store.getCached(key, ts);
    const answers = hit && rebuildAnswers(questions, hit.answers_by_question);
    if (answers) {
      const saved = hit.usage?.input_tokens ?? 0;
      const latency = took();
      const id = record({ resolved_model: hit.model, cached: 1, saved_input_tokens: saved, saved_usd: priceOf(saved, usdPerMtok),
        latency_ms: latency, status: 200, answers });
      return { model: hit.model, answers, usage: hit.usage, bridge: bridge({ cached: true, latency_ms: latency, cost_usd: 0 }, id) };
    }
  }

  progress?.(`Asking ${model} ${count} question${count === 1 ? '' : 's'}`);
  const onRetry = ({ retry, of, status, error, waitMs }) =>
    progress?.(`TypeSafe ${status ? `returned ${status}` : `failed (${error})`}; retry ${retry} of ${of} in ${(waitMs / 1000).toFixed(1)} s`);
  let res;
  try {
    res = await transport(JSON.stringify({ state, model, questions }), { signal, onRetry });
  } catch (err) {
    // A timeout, a refused connection or a cancellation is recorded too — as
    // status 0, since no HTTP status ever arrived.
    record({ cached: 0, latency_ms: took(), status: 0, error: String(err?.message || err) });
    throw err;
  }
  if (res.status !== 200) {
    const failure = describeFailure(res.status, res.text, res.requestId);
    record({ cached: 0, latency_ms: took(), status: res.status, attempts: res.attempts, error: failure });
    throw new Error(failure);
  }

  const body = JSON.parse(res.text);
  const input = body.usage?.input_tokens ?? 0;
  const cost = priceOf(input, usdPerMtok);
  store.noteResolution(model, body.model, ts);
  store.putCached(key, model, { model: body.model, usage: body.usage, answers_by_question: byQuestion(questions, body.answers) }, ts);
  const latency = took();
  const id = record({ resolved_model: body.model, cached: 0, input_tokens: input, output_tokens: body.usage?.output_tokens ?? 0,
    latency_ms: latency, cost_usd: cost, status: 200, attempts: res.attempts, answers: body.answers });
  const facts = { cached: false, latency_ms: latency, cost_usd: cost, ...(res.attempts && { attempts: res.attempts }),
    ...(res.requestId && { request_id: res.requestId }) };
  return { ...body, bridge: bridge(facts, id) };
}

/**
 * Answers are stored against the question that earned them, not against the id
 * the caller happened to use, and are handed back under whatever ids the
 * current caller used. Returns null if the entry cannot serve every question,
 * which makes a partial or malformed entry a miss rather than a wrong answer.
 */
function byQuestion(questions, answers) {
  const out = {};
  for (const [id, q] of Object.entries(questions)) out[questionFingerprint(q)] = answers?.[id];
  return out;
}

function rebuildAnswers(questions, stored) {
  if (!stored) return null;
  const out = {};
  for (const [id, q] of Object.entries(questions)) {
    const answer = stored[questionFingerprint(q)];
    if (answer === undefined) return null;
    out[id] = answer;
  }
  return out;
}

/* ── MCP methods ─────────────────────────────────────────────────────────── */

const HISTORY_URI = /^jev:\/\/history\/([^/?#]+)$/;
const subscribable = (uri) => uri === 'jev://usage' || uri === 'jev://history' || HISTORY_URI.test(uri);

const json = (value) => JSON.stringify(value);
const structured = (result) => ({ content: [{ type: 'text', text: json(result) }], structuredContent: result });
const intArg = (value, fallback, name, [min, max]) => {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new McpError(ERRORS.INVALID_PARAMS, `${name} must be a whole number from ${min} to ${max}.`);
  return n;
};
const fractionArg = (value, fallback, name) => {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new McpError(ERRORS.INVALID_PARAMS, `${name} must be a number from 0 to 1.`);
  return n;
};
/** A resource that is not there: -32602 from 2026-07-28, -32002 before it. */
const notFound = (uri, ctx) => new McpError(ctx.era === 'modern' ? ERRORS.INVALID_PARAMS : -32002, `Resource not found: ${uri}`, { uri });
const matching = (values, prefix) => {
  const hits = values.filter((v) => v.startsWith(prefix ?? ''));
  return { completion: { values: hits.slice(0, 100), total: hits.length, hasMore: hits.length > 100 } };
};
/** resource_link arrived in 2025-06-18; older clients would not know the content type. */
const linksAllowed = (ctx) => ctx.era === 'modern' || ctx.version >= '2025-06-18';

function historyOf(store, args) {
  const filter = args?.filter ?? 'all';
  if (!FILTER_NAMES.includes(filter)) throw new Error(`filter must be one of ${FILTER_NAMES.join(', ')} (got ${JSON.stringify(filter)}).`);
  return historyReport(store, { days: args?.days ?? 7, filter, below: args?.below ?? 0.6, q: args?.q,
    limit: Math.min(Math.max(1, args?.limit ?? 20), 200), now: Date.now() });
}

/**
 * The tools, resources, prompts and completions, bound to one store. Returned
 * as an MCP method table so the protocol layer stays free of Jev.
 */
export function makeMethods(deps, notify = () => {}) {
  const tools = {
    async jev_ask(args, ctx) {
      const result = await askJev(args, { ...deps, client: ctx.client, signal: ctx.signal, progress: ctx.progress });
      notify('jev://usage');
      notify('jev://history');
      const out = structured(result);
      const id = result.bridge.call_id;
      if (id && linksAllowed(ctx)) {
        out.content.push({ type: 'resource_link', uri: `jev://history/${id}`, name: `call ${id}`,
          description: 'This call in the history: state, questions, answers, timing, review.', mimeType: 'application/json' });
      }
      return out;
    },
    async jev_usage(args) {
      return structured(deps.store.summary({ days: args?.days ?? 7, now: Date.now() }));
    },
    async jev_history(args) {
      if (args?.id) {
        const call = deps.store.getHistory(args.id);
        if (!call) throw new Error(`No call "${args.id}" in the history. It may have been pruned, or history may be off.`);
        return structured(call);
      }
      return structured(historyOf(deps.store, args));
    },
    async jev_review(args) {
      const call = reviewCall(deps.store, args?.id, { verdict: args?.verdict ?? null, note: args?.note ?? null, expected: args?.expected ?? null });
      notify(`jev://history/${call.id}`);
      notify('jev://history');
      // Echo the review, not the whole call: the caller already has the state.
      return structured({ id: call.id, verdict: call.verdict, note: call.note, expected: call.expected, reviewed_at: call.reviewed_at });
    },
    async jev_models(_args, ctx) {
      return structured(await listModels({ signal: ctx.signal }));
    },
  };

  const reads = {
    [GUIDE_URI]: () => ({ mimeType: 'text/markdown', text: GUIDE }),
    'jev://models': async (ctx) => ({ mimeType: 'application/json', text: json(await listModels({ signal: ctx.signal })) }),
    'jev://usage': () => ({ mimeType: 'application/json', text: json(deps.store.summary({ days: 7, now: Date.now() })) }),
    'jev://history': () => ({ mimeType: 'application/json', text: json(historyOf(deps.store, {})) }),
  };

  const prompts = {
    review_uncertain(args) {
      const days = intArg(args.days, 7, 'days', [1, 3650]);
      const below = fractionArg(args.below, 0.6, 'below');
      return `Review the Jev calls from the last ${days} days that Jev was least sure of.\n\n` +
        `1. Call jev_history with {"filter": "uncertain", "below": ${below}, "days": ${days}}.\n` +
        '2. For each listed call, open it with jev_history {"id": "<id>"} and judge every answer against the state and ' +
        'anything else you know. Do not guess: skip a call you cannot judge.\n' +
        '3. Record each judgement with jev_review: verdict correct, partial or incorrect; `expected` with the answer ' +
        'each wrong question should have given; a one-sentence `note`.\n' +
        '4. Finish with a table of the calls reviewed, and say which questions look badly worded and how to fix them.';
    },
    cost_report(args) {
      const days = intArg(args.days, 7, 'days', [1, 3650]);
      return `Report what Jev has cost over the last ${days} days, and how to spend less.\n\n` +
        `1. Call jev_usage {"days": ${days}} and jev_history {"days": ${days}, "limit": 1} (its stats are all you need).\n` +
        '2. Report: calls, live calls, cache hit rate, USD spent and saved by the cache, p50/p95 live latency, errors and retries.\n' +
        '3. Name the savings: `efficiency.resent_state_calls` are live calls whose questions could have ridden in an ' +
        'earlier call on the same state; a low `questions_per_live_call` means questions are being asked one at a time. ' +
        'Say what to batch, in one short list.';
    },
    question_design() {
      return 'Design the jev_ask request for the task in this conversation, using the guide below. Choose each ' +
        'question\'s type by the answer needed, write complete instructions (ids are never sent to the model), give ' +
        'choices a "none" option where nothing may fit, and put every independent question in one call. Show the ' +
        'request, then send it unless the user asked to see it first.\n\n' + GUIDE;
    },
  };

  return {
    'tools/list': () => ({ tools: TOOLS }),
    async 'tools/call'(params, ctx) {
      const { name, arguments: args = {} } = params;
      const tool = tools[name];
      if (!tool) throw new McpError(ERRORS.INVALID_PARAMS, `Unknown tool: ${name}. Tools: ${Object.keys(tools).join(', ')}.`);
      if (args === null || typeof args !== 'object' || Array.isArray(args)) {
        throw new McpError(ERRORS.INVALID_PARAMS, '`arguments` must be an object.');
      }
      try {
        return await tool(args, ctx);
      } catch (err) {
        // Reported in-band so the model can read the reason and correct itself,
        // as the spec asks for input and API errors.
        return { content: [{ type: 'text', text: String(err?.message || err) }], isError: true };
      }
    },
    'resources/list': () => ({ resources: RESOURCES.map(({ cache, ...r }) => r) }),
    'resources/templates/list': () => ({ resourceTemplates: TEMPLATES }),
    async 'resources/read'(params, ctx) {
      const uri = params.uri;
      if (typeof uri !== 'string') throw new McpError(ERRORS.INVALID_PARAMS, '`uri` must be a string.');
      const fixed = RESOURCES.find((r) => r.uri === uri);
      if (fixed) {
        const body = await reads[uri](ctx);
        return { contents: [{ uri, ...body }], ...fixed.cache };
      }
      const id = uri.match(HISTORY_URI)?.[1];
      const call = id && deps.store.getHistory(decodeURIComponent(id));
      if (!call) throw notFound(uri, ctx);
      return { contents: [{ uri, mimeType: 'application/json', text: json(call) }], ttlMs: 0, cacheScope: 'private' };
    },
    'prompts/list': () => ({ prompts: PROMPTS }),
    'prompts/get'(params) {
      const prompt = PROMPTS.find((p) => p.name === params.name);
      if (!prompt) throw new McpError(ERRORS.INVALID_PARAMS, `Unknown prompt: ${params.name}. Prompts: ${PROMPTS.map((p) => p.name).join(', ')}.`);
      const text = prompts[prompt.name](params.arguments ?? {});
      return { description: prompt.description, messages: [{ role: 'user', content: { type: 'text', text } }] };
    },
    'completion/complete'(params) {
      const { ref, argument } = params;
      const value = argument?.value ?? '';
      if (ref?.type === 'ref/prompt') {
        if (argument?.name === 'days') return matching(['1', '7', '14', '30', '90'], value);
        if (argument?.name === 'below') return matching(['0.5', '0.6', '0.7', '0.8', '0.9'], value);
      }
      if (ref?.type === 'ref/resource' && ref.uri === TEMPLATES[0].uriTemplate && argument?.name === 'id') {
        const ids = deps.store.listHistory({ since: Date.now() - 30 * 86_400_000 }).map((r) => r.id);
        return matching(ids, value);
      }
      return matching([], value);
    },
  };
}

export const CAPABILITIES = {
  tools: { listChanged: false },
  resources: { subscribe: true, listChanged: false },
  prompts: { listChanged: false },
  completions: {},
};

/** One MCP server over a store: a protocol instance whose replies go to `write`. */
export function createServer(deps, write) {
  let protocol = null;
  const methods = makeMethods(deps, (uri) => protocol?.resourceUpdated(uri));
  protocol = createProtocol({ serverInfo: SERVER_INFO, instructions: INSTRUCTIONS, capabilities: CAPABILITIES, methods, subscribable, write });
  return protocol;
}

function serve(deps) {
  const protocol = createServer(deps, (msg) => process.stdout.write(JSON.stringify(msg) + '\n'));
  let buffer = '';
  // In-flight requests outlive the stdin stream when a client closes its pipe
  // immediately after writing. Exiting on 'end' without draining them truncates
  // the reply, and the caller sees a silent hang rather than an answer.
  const inFlight = new Set();
  let stdinClosed = false;
  const exitWhenDrained = () => {
    if (stdinClosed && inFlight.size === 0) process.exit(0);
  };
  const track = (p) => {
    inFlight.add(p);
    p.finally(() => { inFlight.delete(p); exitWhenDrained(); });
  };

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: ERRORS.PARSE, message: 'Parse error' } }) + '\n');
        continue;
      }
      track(Promise.resolve(protocol.receive(msg)).catch((err) => log('handler error:', err?.stack || err)));
    }
  });
  process.stdin.on('end', () => {
    stdinClosed = true;
    protocol.closeSubscriptions();
    exitWhenDrained();
  });
}

/* ── entry ───────────────────────────────────────────────────────────────── */

/** Best effort: if no browser opens, the address is already printed. */
function openInBrowser(url) {
  const [cmd, ...args] = process.platform === 'darwin' ? ['open', url]
    : process.platform === 'win32' ? ['cmd', '/c', 'start', '""', url]
    : ['xdg-open', url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch { /* printed above */ }
}

/** SQLite is optional: an older Node still runs the bridge, just without persistence. */
async function makeStore() {
  let sqlite = null;
  try {
    sqlite = await import('node:sqlite');
  } catch (err) {
    log(`node:sqlite unavailable on Node ${process.version} — caching in memory for this session only`);
  }
  // An unrecognised mode fails safe: better to keep nothing than to keep content
  // someone was trying to switch off.
  const history = HISTORY_MODES.includes(HISTORY) ? HISTORY : 'off';
  if (history !== HISTORY) log(`TYPESAFE_HISTORY="${HISTORY}" is not one of ${HISTORY_MODES.join(', ')} — keeping no history`);
  const options = { sqlite, ttlMs: TTL_DAYS * 86_400_000, maxEntries: MAX_ENTRIES, history, historyDays: HISTORY_DAYS, historyMax: HISTORY_MAX };
  let store;
  try {
    if (sqlite) mkdirSync(dirname(DB_PATH), { recursive: true, mode: 0o700 });
    store = openStore(DB_PATH, options);
    store.prune(Date.now());
  } catch (err) {
    log(`could not open ${DB_PATH} (${err.message}) — caching in memory for this session only`);
    store = openStore(null, { ...options, sqlite: null });
  }
  // Usage and history are written just after each answer. Whatever is still
  // queued when the process ends — a client closing its pipe, --selftest — is
  // written here; node:sqlite is synchronous, so it completes before exit.
  process.on('exit', () => store.flush());
  return store;
}

const HELP = `jev-bridge ${PKG.version} — an MCP server for TypeSafe's Jev

Usage:
  jev-bridge                 run as an MCP server over stdio (what an MCP client does)
  jev-bridge --selftest      list the models, then call the live API once, bypassing the cache
  jev-bridge --stats [days]  report calls, cache hits, tokens and cost (default 7 days)
  jev-bridge --ui [port]     open the call-history dashboard in a browser (--no-open to only print its address)
  jev-bridge --history [days] [filter]
                             print past calls and their stats; filters: ${FILTER_NAMES.join(', ')}
  jev-bridge --clear-cache   delete stored answers, keep the usage log and history
  jev-bridge --clear-history delete the call history, keep the cache and the usage log
  jev-bridge --version       print the version
  jev-bridge --help          print this

Key:     TYPESAFE_API_KEY, or TYPESAFE_API_KEY_FILE, or ${join(HOME, '.env')}
API:     ${BASE} · model ${DEFAULT_MODEL} · ${RETRY.timeoutMs} ms per attempt, ${RETRY.maxRetries} retries
Data:    ${DB_PATH}
History: ${HISTORY} (TYPESAFE_HISTORY=full|meta|off), ${HISTORY_DAYS} days
Docs:    https://github.com/lhviet/jev-bridge#readme`;

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(HELP + '\n'); process.exit(0); }
  if (argv.includes('--version') || argv.includes('-v')) { process.stdout.write(PKG.version + '\n'); process.exit(0); }

  const store = await makeStore();
  // By default a signal ends the process without an 'exit' event, which would
  // drop the few records still waiting to be written. Exiting routes through it.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => process.exit(0));
  const deps = { store, transport: liveTransport() };

  if (argv.includes('--selftest')) {
    const key = loadKey();
    process.stderr.write(`key: ${key ? `loaded (${key.length} chars, ${key.slice(0, 8)}…)` : 'MISSING'}\n`);
    if (!key) process.exit(1);
    process.stderr.write(`models: ${(await listModels()).models.map((m) => m.name).join(', ')}\n`);
    const out = await askJev({
      state: 'Help! My payouts have been failing for 3 days.',
      cache: false, // a self-test must reach the API, not the cache
      questions: {
        is_urgent: { type: 'noul', instructions: 'Does this convey urgency?' },
        department: { type: 'choice', instructions: 'Which team should handle this?',
          criteria: { billing: 'Payments, invoicing, refunds', technical: 'Bugs, outages, integrations', sales: 'Pricing, upgrades' } },
        frustration: { type: 'score', instructions: 'How frustrated is the customer?', criteria: ['Calm', 'Frustrated', 'Very angry'] },
      },
    }, deps);
    process.stderr.write(`store: ${store.kind} at ${store.kind === 'sqlite' ? DB_PATH : 'memory'}\n`);
    process.stderr.write(JSON.stringify(out, null, 2) + '\n');
    process.exit(0);
  }

  if (argv.includes('--stats')) {
    const days = Number(argv[argv.indexOf('--stats') + 1]) || 7;
    process.stderr.write(JSON.stringify(store.summary({ days, now: Date.now() }), null, 2) + '\n');
    process.exit(0);
  }

  if (argv.includes('--clear-cache')) {
    process.stderr.write(`cleared ${store.clearCache()} cached answers; the usage log and history are kept\n`);
    process.exit(0);
  }

  if (argv.includes('--clear-history')) {
    process.stderr.write(`cleared ${store.clearHistory()} calls from the history; the cache and usage log are kept\n`);
    process.exit(0);
  }

  if (argv.includes('--history')) {
    // Either order: `--history 30 uncertain` or `--history uncertain`.
    const rest = argv.slice(argv.indexOf('--history') + 1, argv.indexOf('--history') + 3);
    const days = Number(rest.find((a) => Number(a) > 0)) || 7;
    const filter = rest.find((a) => FILTER_NAMES.includes(a)) ?? 'all';
    const report = historyReport(store, { days, filter, now: Date.now() });
    process.stderr.write(JSON.stringify(report, null, 2) + '\n');
    process.exit(0);
  }

  if (argv.includes('--ui')) {
    const port = Number(argv[argv.indexOf('--ui') + 1]) || 0;
    const ui = await startUi({ store, port });
    process.stderr.write(`jev-bridge dashboard: ${ui.url}\n(history: ${store.historyMode}, ${store.kind} store at ${store.kind === 'sqlite' ? DB_PATH : 'memory'}) — Ctrl-C to stop\n`);
    if (store.kind !== 'sqlite') process.stderr.write('note: without node:sqlite this dashboard sees only its own process, so it will be empty\n');
    if (!argv.includes('--no-open')) openInBrowser(ui.url);
    return;
  }

  log(`ready — ${BASE}, model ${DEFAULT_MODEL}, ${store.kind} store, key ${loadKey() ? 'loaded' : 'MISSING'}`);
  serve(deps);
}

const invokedDirectly = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) await main();
