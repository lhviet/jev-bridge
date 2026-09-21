/**
 * The TypeSafe HTTP API, and nothing else: configuration, the key, one request
 * with retries, and error messages that name a remedy.
 *
 * It follows the official contract rather than guessing at it:
 *
 *   endpoints   POST /v1/systemone, GET /v1/models         docs.typesafe.ai/api, /models
 *   retries     408, 429 and 500-599; connection errors and timeouts;
 *               at most 2 retries; backoff 500 ms doubling to 5 s, 25 % jitter;
 *               Retry-After and retry-after-ms honoured up to 60 s
 *                                                           the SDKs' RetryPolicy defaults
 *   timeout     10 s per attempt, no total budget          TypeSafeClientConfig.timeout
 *   env names   TYPESAFE_API_KEY, TYPESAFE_BASE_URL, TYPESAFE_DEFAULT_MODEL
 *                                                           typesafe_sdk.constants
 *   request id  x-typesafe-request-id, quoted in errors     TypeSafeAPIError.request_id
 *
 * The bridge's own older names (TYPESAFE_API_URL, TYPESAFE_MODEL) still work.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const env = process.env;
const numberFrom = (value, fallback) => {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(n) && n >= 0 ? n : fallback;
};

/** Where the key file and the database live unless told otherwise. */
export const HOME = env.JEV_BRIDGE_HOME || join(homedir(), '.jev-bridge');

/**
 * TYPESAFE_API_URL (the bridge's name, already ending in /v1) wins when set;
 * otherwise the SDKs' TYPESAFE_BASE_URL, the API root, gains /v1.
 */
export const BASE = (env.TYPESAFE_API_URL?.trim()
  || `${(env.TYPESAFE_BASE_URL?.trim() || 'https://api.typesafe.ai').replace(/\/+$/, '')}/v1`).replace(/\/+$/, '');
export const DEFAULT_MODEL = env.TYPESAFE_DEFAULT_MODEL?.trim() || env.TYPESAFE_MODEL?.trim() || 'jev-latest';

export const RETRY = {
  timeoutMs: numberFrom(env.TYPESAFE_TIMEOUT_MS, 10_000),
  maxRetries: Math.floor(numberFrom(env.TYPESAFE_MAX_RETRIES, 2)),
  backoffInitialMs: numberFrom(env.TYPESAFE_BACKOFF_INITIAL_MS, 500),
  backoffMaxMs: 5_000,
  backoffJitter: 0.25,
  maxRetryAfterMs: 60_000,
};

/** 408, 429 and every 5xx — 529, TypeSafe's "overloaded", among them. */
export const isRetryable = (status) => status === 408 || status === 429 || (status >= 500 && status <= 599);

/* ── the key ─────────────────────────────────────────────────────────────── */

/**
 * Resolution order: a real environment variable wins, then an explicit
 * TYPESAFE_API_KEY_FILE, then `~/.jev-bridge/.env`, then a `.env` at the
 * package root (convenient when running from a clone). A file may hold
 * `TYPESAFE_API_KEY=…` or just the bare key on its own line.
 */
export function loadKey(root) {
  const fromEnv = env.TYPESAFE_API_KEY?.trim();
  if (fromEnv) return fromEnv;

  for (const path of [env.TYPESAFE_API_KEY_FILE, join(HOME, '.env'), root && join(root, '.env')].filter(Boolean)) {
    if (!existsSync(path)) continue;
    const text = readFileSync(path, 'utf8');
    const assigned = text.match(/^\s*(?:export\s+)?TYPESAFE_API_KEY\s*=\s*(.+)$/m);
    const raw = assigned ? assigned[1] : text;
    const key = raw.trim().replace(/^['"]|['"]$/g, '').trim();
    if (key && !key.startsWith('#')) return key;
  }
  return null;
}

/* ── waiting ─────────────────────────────────────────────────────────────── */

const cancelled = (signal) => Object.assign(new Error('Cancelled by the client before TypeSafe answered.'), { name: 'AbortError', cause: signal?.reason });

/** A pause that a cancellation ends early, by rejecting. */
function pause(ms, signal) {
  if (signal?.aborted) return Promise.reject(cancelled(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(cancelled(signal)); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** One attempt's signal: the caller's cancellation, or this attempt's own timeout, whichever comes first. */
function attemptSignal(outer, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(Object.assign(new Error(`No answer within ${ms} ms.`), { name: 'TimeoutError' })), ms);
  const onAbort = () => controller.abort(outer.reason);
  outer?.addEventListener('abort', onAbort, { once: true });
  return { signal: controller.signal, done: () => { clearTimeout(timer); outer?.removeEventListener('abort', onAbort); } };
}

/**
 * The server's own delay, when it gives one: `retry-after-ms`, or `Retry-After`
 * in seconds or as an HTTP date. Null when absent or unreadable.
 */
export function retryAfterMs(headers, now = Date.now()) {
  const ms = headers.get('retry-after-ms');
  if (ms !== null && ms.trim() !== '' && Number.isFinite(Number(ms)) && Number(ms) >= 0) return Number(ms);
  const after = headers.get('retry-after');
  if (after === null || after.trim() === '') return null;
  if (Number.isFinite(Number(after))) return Number(after) >= 0 ? Number(after) * 1000 : null;
  const at = Date.parse(after);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

const backoff = (retry, policy) => {
  const base = Math.min(policy.backoffInitialMs * 2 ** retry, policy.backoffMaxMs);
  return base * (1 - Math.random() * policy.backoffJitter);
};

/* ── one request ─────────────────────────────────────────────────────────── */

/**
 * Sends one request, retrying what the SDKs retry. Resolves with the final
 * response whatever its status — a 4xx is an answer, not an exception — and
 * rejects only when no response ever arrived. `onRetry` hears about each wait,
 * so a caller can report progress; `signal` cancels the attempt and the wait.
 */
export async function request(path, { method = 'GET', body, key, signal, onRetry, userAgent, policy = RETRY } = {}) {
  for (let retry = 0; ; retry++) {
    if (signal?.aborted) throw cancelled(signal);
    const attempt = attemptSignal(signal, policy.timeoutMs);
    let res;
    try {
      res = await fetch(`${BASE}${path}`, {
        method,
        body,
        signal: attempt.signal,
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: 'application/json',
          ...(body !== undefined && { 'Content-Type': 'application/json' }),
          ...(userAgent && { 'User-Agent': userAgent }),
        },
      });
      const text = await res.text();
      attempt.done();
      const out = { status: res.status, text, attempts: retry + 1, requestId: res.headers.get('x-typesafe-request-id') };
      if (!isRetryable(res.status) || retry >= policy.maxRetries) return out;
      const told = retryAfterMs(res.headers);
      const wait = told !== null && told <= policy.maxRetryAfterMs ? told : backoff(retry, policy);
      onRetry?.({ retry: retry + 1, of: policy.maxRetries, status: res.status, waitMs: Math.round(wait) });
      await pause(wait, signal);
    } catch (err) {
      attempt.done();
      if (signal?.aborted) throw cancelled(signal);
      if (err?.name === 'AbortError' && !signal?.aborted) err = attempt.signal.reason ?? err; // this attempt timed out
      if (retry >= policy.maxRetries) throw err;
      const wait = backoff(retry, policy);
      onRetry?.({ retry: retry + 1, of: policy.maxRetries, error: String(err?.message || err), waitMs: Math.round(wait) });
      await pause(wait, signal);
    }
  }
}

/** Turns a non-2xx into a sentence that names the remedy rather than the status alone. */
export function describeFailure(status, body, requestId = null) {
  const detail = typeof body === 'string' ? body.slice(0, 600) : JSON.stringify(body).slice(0, 600);
  const remedy = {
    400: 'The request was malformed. The detail below says how.',
    401: `The API key was missing or rejected. Check TYPESAFE_API_KEY, or ${join(HOME, '.env')}.`,
    403: 'The API key is not permitted to use this model or endpoint.',
    404: `No such endpoint at ${BASE}, or no such model. Check TYPESAFE_BASE_URL and the \`model\` field (jev_models lists the names).`,
    408: 'TypeSafe timed out reading the request, and the retries timed out too.',
    422: 'The request body failed validation. The detail below names the offending field.',
    429: 'Rate limited, and the retries were also rate limited. Back off and try again, or batch more questions per call.',
    529: 'TypeSafe is overloaded, and the retries also failed. Try again shortly.',
  }[status] ?? (status >= 500 ? 'TypeSafe had a server error, and the retries failed too. Try again shortly.' : null);
  const id = requestId ? ` (request id ${requestId})` : '';
  return `TypeSafe API returned ${status}${id}.${remedy ? ` ${remedy}` : ''}\n\n${detail}`;
}
