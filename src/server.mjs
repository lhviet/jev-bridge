#!/usr/bin/env node
/**
 * jev-bridge — a stdio MCP server for TypeSafe's System One model, Jev.
 *
 * The `typesafe@typesafe-ai` plugin ships a SKILL.md and nothing else: it is
 * prompt guidance with no network capability. This server is the missing wire.
 * It exposes the one TypeSafe endpoint as MCP tools so an agent can actually
 * obtain a judgment instead of only reading about how to design one.
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
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILTER_NAMES, VERDICTS, historyReport, reviewCall } from './history.mjs';
import { HISTORY_MODES, cacheKey, openStore, questionFingerprint } from './store.mjs';
import { startUi } from './ui.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const PKG = (() => {
  try { return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')); } catch { return { version: '0.0.0' }; }
})();

/** Where the key and the database live unless told otherwise. Created 0700 on first use. */
const HOME = process.env.JEV_BRIDGE_HOME || join(homedir(), '.jev-bridge');
const BASE = (process.env.TYPESAFE_API_URL || 'https://api.typesafe.ai/v1').replace(/\/+$/, '');
const DEFAULT_MODEL = process.env.TYPESAFE_MODEL || 'jev-latest';
const TIMEOUT_MS = Number(process.env.TYPESAFE_TIMEOUT_MS || 60000);
const DB_PATH = process.env.TYPESAFE_DB || join(HOME, 'jev.db');
const USD_PER_MTOK = Number(process.env.TYPESAFE_USD_PER_MTOK || 0.042); // published Jev 1.13 input price
const TTL_DAYS = Number(process.env.TYPESAFE_CACHE_TTL_DAYS || 7);
const MAX_ENTRIES = Number(process.env.TYPESAFE_CACHE_MAX || 20000);
const HISTORY = (process.env.TYPESAFE_HISTORY || 'full').trim().toLowerCase();
const HISTORY_DAYS = Number(process.env.TYPESAFE_HISTORY_DAYS || 30);
const HISTORY_MAX = Number(process.env.TYPESAFE_HISTORY_MAX || 10000);
const SERVER = { name: 'jev-bridge', version: PKG.version };
const FALLBACK_PROTOCOL = '2025-06-18';

const log = (...a) => process.stderr.write(`[jev-bridge] ${a.join(' ')}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const priceOf = (tokens, usdPerMtok) => (tokens * usdPerMtok) / 1e6;

/* ── credential ──────────────────────────────────────────────────────────── */

/**
 * Resolution order: a real environment variable wins, then an explicit
 * TYPESAFE_API_KEY_FILE, then `~/.jev-bridge/.env`, then a `.env` at the
 * package root (convenient when running from a clone). A file may hold
 * `TYPESAFE_API_KEY=…` or just the bare key on its own line.
 */
export function loadKey() {
  const fromEnv = process.env.TYPESAFE_API_KEY?.trim();
  if (fromEnv) return fromEnv;

  for (const path of [process.env.TYPESAFE_API_KEY_FILE, join(HOME, '.env'), join(ROOT, '.env')].filter(Boolean)) {
    if (!existsSync(path)) continue;
    const text = readFileSync(path, 'utf8');
    const assigned = text.match(/^\s*(?:export\s+)?TYPESAFE_API_KEY\s*=\s*(.+)$/m);
    const raw = assigned ? assigned[1] : text;
    const key = raw.trim().replace(/^['"]|['"]$/g, '').trim();
    if (key && !key.startsWith('#')) return key;
  }
  return null;
}

/* ── HTTP ────────────────────────────────────────────────────────────────── */

/**
 * 429 and 529 are the documented back-off statuses; honour retry-after when
 * present. The response carries `attempts`, so a slow call can be told apart
 * from one that spent its time waiting out a rate limit.
 */
async function request(path, init, retries = 3) {
  let delay = 500;
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(`${BASE}${path}`, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      if (attempt >= retries) throw err;
      await sleep(delay);
      delay *= 2;
      continue;
    }
    if ((res.status === 429 || res.status === 529) && attempt < retries) {
      const after = Number(res.headers.get('retry-after'));
      await res.text().catch(() => {}); // drain so the socket is reusable
      await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : delay);
      delay *= 2;
      continue;
    }
    return Object.assign(res, { attempts: attempt + 1 });
  }
}

/** The live transport: one POST to /systemone. Swapped for a fake in tests. */
function liveTransport() {
  return async (body) => {
    const key = loadKey();
    if (!key) {
      throw new Error(`No TypeSafe API key. Set TYPESAFE_API_KEY, or write it to ${join(HOME, '.env')} (chmod 600).`);
    }
    const res = await request('/systemone', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body,
    });
    return { status: res.status, text: await res.text(), attempts: res.attempts };
  };
}

/** Turns a non-2xx into a sentence that names the remedy rather than the status alone. */
function describeFailure(status, body) {
  const detail = typeof body === 'string' ? body.slice(0, 600) : JSON.stringify(body).slice(0, 600);
  const remedy = {
    401: `The API key was missing or rejected. Check TYPESAFE_API_KEY, or ${join(HOME, '.env')}.`,
    403: 'The API key is not permitted to use this model or endpoint.',
    404: `No such endpoint at ${BASE}. Check TYPESAFE_API_URL.`,
    422: 'The request body failed validation. The detail below names the offending field.',
    429: 'Rate limited, and the retries were also rate limited. Back off and try again.',
    529: 'TypeSafe is overloaded, and the retries also failed. Try again shortly.',
  }[status];
  return `TypeSafe API returned ${status}.${remedy ? ` ${remedy}` : ''}\n\n${detail}`;
}

/* ── validation ──────────────────────────────────────────────────────────── */

/**
 * Checked here rather than left to the API so a malformed question costs no
 * round trip and names itself. Mirrors the contract in docs.typesafe.ai/api.
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
    if (!['noul', 'choice', 'score'].includes(q.type)) {
      return `${at}.type must be "noul", "choice" or "score" (got ${JSON.stringify(q.type)}).`;
    }
    if (q.instructions === undefined || q.instructions === null || q.instructions === '') {
      return `${at}.instructions is required.`;
    }
    if (q.type === 'choice') {
      const c = q.criteria;
      if (!c || typeof c !== 'object' || Array.isArray(c)) {
        return `${at}.criteria is required for a choice and must be an object mapping option -> description (use null for no description).`;
      }
      const n = Object.keys(c).length;
      if (n < 2) return `${at}.criteria needs at least 2 options.`;
      if (n > 255) return `${at}.criteria allows at most 255 options (got ${n}).`;
    }
    if (q.type === 'score') {
      if (!Array.isArray(q.criteria)) {
        return `${at}.criteria is required for a score and must be an ORDERED ARRAY of level descriptions, lowest first.`;
      }
      if (q.criteria.length < 2) return `${at}.criteria needs at least 2 levels.`;
      if (q.criteria.length > 10) return `${at}.criteria allows at most 10 levels (got ${q.criteria.length}).`;
    }
    if (q.type === 'noul' && q.criteria !== undefined) {
      const c = q.criteria;
      if (!c || typeof c !== 'object' || Array.isArray(c)) {
        return `${at}.criteria for a noul must be an object with "true" and/or "false" keys.`;
      }
    }
  }
  return null;
}

/* ── the one operation ───────────────────────────────────────────────────── */

/**
 * Validate → look in the cache → call the API → store the answer and the cost.
 *
 * `transport` and `now` are injected so the whole path can be tested without
 * spending tokens. An error is never cached: a 529 today must not become a
 * week of stored failure.
 *
 * Every outcome — hit, answer, rejection, a network that never answered — is
 * recorded twice: in the usage log, and in the history a reviewer reads later.
 * Both are only queued here; the store writes them after this answer has gone
 * back, so recording costs the caller nothing it can measure.
 */
export async function askJev(args, { store, transport, now = Date.now, usdPerMtok = USD_PER_MTOK, client = null }) {
  const { state, questions, model = DEFAULT_MODEL, cache = true } = args ?? {};
  if (state === undefined || state === null) throw new Error('`state` is required.');
  const bad = validateQuestions(questions);
  if (bad) throw new Error(bad);

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

  let res;
  try {
    res = await transport(JSON.stringify({ state, model, questions }));
  } catch (err) {
    // A timeout or a refused connection is the slowest outcome of all, so it is
    // recorded too — as status 0, since no HTTP status ever arrived.
    record({ cached: 0, latency_ms: took(), status: 0, error: String(err?.message || err) });
    throw err;
  }
  if (res.status !== 200) {
    const failure = describeFailure(res.status, res.text);
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
  return { ...body, bridge: bridge({ cached: false, latency_ms: latency, cost_usd: cost }, id) };
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

/* ── tools ───────────────────────────────────────────────────────────────── */

const ANSWER_SCHEMA = {
  type: 'object',
  properties: { type: { type: 'string', enum: ['noul', 'choice', 'score'] } },
  required: ['type'],
};

const TOOLS = [
  {
    name: 'jev_ask',
    title: 'Ask Jev (TypeSafe System One)',
    description:
      'Evaluate a `state` against typed questions and get calibrated, structured answers back. ' +
      'Jev returns judgments and probabilities, not generated prose or reasoning — use it where code needs ' +
      'semantic understanding (routing, ranking, extraction, verification, classification).\n\n' +
      'Every question is one of three primitives:\n' +
      '  • noul   — a yes/no question. Returns `noul`: probability of yes (0..1). No separate confidence. ' +
      'Use one noul per label when several labels may apply at once. A value near 0.5 means yes and no are ' +
      'similarly likely, NOT "medium intensity".\n' +
      '  • choice — picks one option from a set. `criteria` is an object mapping option -> description ' +
      '(null for no description), 2..255 options. Returns the winning `choice`, the full `probabilities` map, ' +
      'and `confidence`. Include a no-match option when nothing may fit.\n' +
      '  • score  — rates along a rubric. `criteria` is an ORDERED ARRAY of 2..10 concrete level descriptions, ' +
      'lowest first. Returns a probability-weighted `score` (can land between levels), a `legend`, ' +
      '`probabilities` and `confidence`.\n\n' +
      'Ask every INDEPENDENT question about the same state in ONE call — they run in parallel against a single ' +
      'ingest of the state, which is cheaper and faster than separate calls. Make a second call only when an ' +
      'answer is needed to fetch new evidence or decide the next options. Question ids are for your code and ' +
      'are NOT sent to the model, so put the full meaning in `instructions`. Reference nested state with ' +
      'backticked paths such as `ticket.messages[0].text`. Typed output guarantees the interface, not truth.\n\n' +
      'Identical requests are answered from a local cache at no cost; `bridge.cached` says which happened, and ' +
      '`bridge.cost_usd` is what THIS call cost. On a cache hit `usage` describes the original call. ' +
      '`bridge.call_id` names this call in jev_history; pass it to jev_review once you learn whether the answer was right.',
    inputSchema: {
      type: 'object',
      properties: {
        state: {
          description:
            'The content to evaluate: a plain string for text, or a JSON object/array for structured data ' +
            '(chat logs, records, application state). Named fields help when the context has several parts. ' +
            'Text only — pre-process images, audio or binaries into text first.',
        },
        questions: {
          type: 'object',
          description: 'A map of your own question id -> question object. Answers come back under the same ids.',
          minProperties: 1,
          additionalProperties: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['noul', 'choice', 'score'] },
              instructions: {
                description:
                  'The judgment to make. A string, or an object holding the question in one field and the data ' +
                  'it refers to in others (refer to those fields by name in backticks).',
              },
              criteria: {
                description:
                  'noul: optional object with "true"/"false" meanings. choice: REQUIRED object of option -> ' +
                  'description. score: REQUIRED ordered array of level descriptions, lowest first.',
              },
            },
            required: ['type', 'instructions'],
          },
        },
        model: {
          type: 'string',
          description: `Model or alias. Defaults to "${DEFAULT_MODEL}". Aliases: jev-latest, jev-preview. Pin a versioned id (e.g. jev-1.13.0) if you have tuned thresholds against it.`,
        },
        cache: {
          type: 'boolean',
          description: 'Default true. Set false to force a live call; the fresh answer then replaces the stored one.',
        },
      },
      required: ['state', 'questions'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'The versioned model that answered, e.g. jev-1.13.0.' },
        answers: { type: 'object', additionalProperties: ANSWER_SCHEMA },
        usage: {
          type: 'object',
          properties: { input_tokens: { type: 'integer' }, output_tokens: { type: 'integer' } },
        },
        bridge: {
          type: 'object',
          properties: {
            cached: { type: 'boolean' },
            latency_ms: { type: 'number' },
            cost_usd: { type: 'number' },
            call_id: { type: 'string', description: 'This call in jev_history. Absent when history is off.' },
          },
          required: ['cached'],
        },
      },
      required: ['model', 'answers', 'bridge'],
    },
  },
  {
    name: 'jev_usage',
    title: 'What Jev has been asked, and what it cost',
    description:
      'Report calls, cache hits, tokens and spend over the last N days, from the bridge\'s local log. ' +
      'Use it to see what a workflow costs before scaling it up, or to check the cache is earning its place.',
    inputSchema: {
      type: 'object',
      properties: { days: { type: 'integer', minimum: 1, maximum: 365, description: 'Window in days. Default 7.' } },
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        window_days: { type: 'integer' },
        calls: { type: 'integer' },
        live_calls: { type: 'integer' },
        cache_hits: { type: 'integer' },
        hit_rate: { type: 'number' },
        errors: { type: 'integer' },
        input_tokens: { type: 'integer' },
        output_tokens: { type: 'integer' },
        cost_usd: { type: 'number' },
        saved_input_tokens: { type: 'integer' },
        saved_usd: { type: 'number' },
        avg_live_latency_ms: { type: ['number', 'null'] },
        by_day: { type: 'array', items: { type: 'object' } },
        models: { type: 'array', items: { type: 'object' } },
        cache: { type: 'object' },
        store: { type: 'string' },
      },
      required: ['calls', 'cache_hits', 'cost_usd'],
    },
  },
  {
    name: 'jev_history',
    title: 'Past Jev calls: speed, cost and whether they were right',
    description:
      'Look back at earlier jev_ask calls, from the bridge\'s local history. Without `id`: stats for the window ' +
      '(latency percentiles, cache hits, retries, live calls that re-sent a state and should have been batched, ' +
      'reviewed accuracy) and the matching calls, each with the start of its state and its answers on one line. ' +
      'With `id`: that call in full — state, questions, answers, timing, cost and review. ' +
      'Use filter "uncertain" to see the calls Jev was least sure of, and "slow" for the slowest.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'A `bridge.call_id`, or an id from this list. Returns that call in full.' },
        days: { type: 'integer', minimum: 1, maximum: 3650, description: 'Window in days. Default 7.' },
        filter: { type: 'string', enum: FILTER_NAMES, description: 'Which calls to list. Default "all", newest first.' },
        below: { type: 'number', minimum: 0, maximum: 1, description: 'The certainty cut for "uncertain". Default 0.6.' },
        q: { type: 'string', description: 'Only calls whose state or answers contain this text.' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Most calls to list. Default 20.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'jev_review',
    title: 'Record whether a Jev answer was right',
    description:
      'Mark a past call correct, partial or incorrect once the truth is known — the user corrected it, or the ' +
      'evidence says otherwise. `expected` records what the answers should have been, by question id; `note` says ' +
      'why. `verdict: null` withdraws a review. Reviewed calls are never pruned, and give jev_history its accuracy.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The `bridge.call_id` of the call being judged.' },
        verdict: { type: ['string', 'null'], enum: [...VERDICTS, null] },
        note: { type: 'string', description: 'Why, in a sentence.' },
        expected: { type: 'object', description: 'Question id -> the answer it should have been, e.g. {"department": "technical"}.' },
      },
      required: ['id', 'verdict'],
      additionalProperties: false,
    },
  },
  {
    name: 'jev_models',
    title: 'List TypeSafe models',
    description:
      'List the model names this account may send in the `model` field, with a description and release date. ' +
      'Lists aliases; versioned ids are accepted whether or not they appear here. Also a cheap credential check.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

/* ── JSON-RPC plumbing ───────────────────────────────────────────────────── */

const missing = (id) => { throw new Error(`No call "${id}" in the history. It may have been pruned, or history may be off.`); };

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const ok = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

function makeHandler(deps) {
  return async function handle(msg) {
    const { id, method, params } = msg;
    const isNotification = id === undefined || id === null;

    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion;
        deps.client = typeof params?.clientInfo?.name === 'string' ? params.clientInfo.name.slice(0, 100) : null;
        return ok(id, {
          protocolVersion: typeof requested === 'string' ? requested : FALLBACK_PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER,
          instructions:
            'TypeSafe System One (Jev). Use jev_ask for calibrated typed judgments over a state. ' +
            'Batch all independent questions into a single jev_ask call. jev_usage reports what it has cost; ' +
            'jev_history shows past calls, and jev_review records whether an answer turned out right.',
        });
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return;
      case 'ping':
        return ok(id, {});
      case 'tools/list':
        return ok(id, { tools: TOOLS });
      case 'tools/call': {
        try {
          const { name, arguments: args } = params ?? {};
          if (name === 'jev_ask') {
            const result = await askJev(args, deps);
            return ok(id, { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result });
          }
          if (name === 'jev_usage') {
            const result = deps.store.summary({ days: args?.days ?? 7, now: Date.now() });
            return ok(id, { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result });
          }
          if (name === 'jev_history') {
            const result = args?.id
              ? deps.store.getHistory(args.id) ?? missing(args.id)
              : historyReport(deps.store, { days: args?.days ?? 7, filter: args?.filter ?? 'all', below: args?.below ?? 0.6,
                q: args?.q, limit: Math.min(Math.max(1, args?.limit ?? 20), 200), now: Date.now() });
            return ok(id, { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result });
          }
          if (name === 'jev_review') {
            const call = reviewCall(deps.store, args?.id, { verdict: args?.verdict ?? null, note: args?.note ?? null,
              expected: args?.expected ?? null });
            // Echo the review, not the whole call: the caller already has the state.
            const result = { id: call.id, verdict: call.verdict, note: call.note, expected: call.expected, reviewed_at: call.reviewed_at };
            return ok(id, { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result });
          }
          if (name === 'jev_models') {
            const key = loadKey();
            if (!key) throw new Error('No TypeSafe API key.');
            const res = await request('/models', { method: 'GET', headers: { Authorization: `Bearer ${key}` } });
            const text = await res.text();
            if (!res.ok) throw new Error(describeFailure(res.status, text));
            return ok(id, { content: [{ type: 'text', text }] });
          }
          throw new Error(`Unknown tool: ${name}`);
        } catch (err) {
          // Reported in-band so the model can read and react to it, rather than
          // as a protocol error it never sees.
          return ok(id, { content: [{ type: 'text', text: String(err?.message || err) }], isError: true });
        }
      }
      default:
        if (isNotification) return;
        return fail(id, -32601, `Method not found: ${method}`);
    }
  };
}

function serve(deps) {
  const handle = makeHandler(deps);
  let buffer = '';
  // In-flight tool calls outlive the stdin stream when a client closes its pipe
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
        fail(null, -32700, 'Parse error');
        continue;
      }
      track(
        Promise.resolve(handle(msg)).catch((err) => {
          log('handler error:', err?.stack || err);
          if (msg?.id !== undefined && msg?.id !== null) fail(msg.id, -32603, String(err?.message || err));
        }),
      );
    }
  });
  process.stdin.on('end', () => { stdinClosed = true; exitWhenDrained(); });
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
  jev-bridge --selftest      call the live API once, bypassing the cache
  jev-bridge --stats [days]  report calls, cache hits, tokens and cost (default 7 days)
  jev-bridge --ui [port]     open the call-history dashboard in a browser (--no-open to only print its address)
  jev-bridge --history [days] [filter]
                             print past calls and their stats; filters: ${FILTER_NAMES.join(', ')}
  jev-bridge --clear-cache   delete stored answers, keep the usage log and history
  jev-bridge --clear-history delete the call history, keep the cache and the usage log
  jev-bridge --version       print the version
  jev-bridge --help          print this

Key:     TYPESAFE_API_KEY, or TYPESAFE_API_KEY_FILE, or ${join(HOME, '.env')}
Data:    ${DB_PATH}
History: ${HISTORY} (TYPESAFE_HISTORY=full|meta|off), ${HISTORY_DAYS} days
Docs:    https://github.com/lhviet/jev-bridge#readme`;

async function main() {
  const argv0 = process.argv.slice(2);
  if (argv0.includes('--help') || argv0.includes('-h')) { process.stdout.write(HELP + '\n'); process.exit(0); }
  if (argv0.includes('--version') || argv0.includes('-v')) { process.stdout.write(PKG.version + '\n'); process.exit(0); }

  const store = await makeStore();
  // By default a signal ends the process without an 'exit' event, which would
  // drop the few records still waiting to be written. Exiting routes through it.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => process.exit(0));
  const deps = { store, transport: liveTransport() };
  const argv = process.argv.slice(2);

  if (argv.includes('--selftest')) {
    const key = loadKey();
    process.stderr.write(`key: ${key ? `loaded (${key.length} chars, ${key.slice(0, 8)}…)` : 'MISSING'}\n`);
    if (!key) process.exit(1);
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
