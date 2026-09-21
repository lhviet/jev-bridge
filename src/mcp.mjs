/**
 * The Model Context Protocol over stdio: the JSON-RPC plumbing, with no
 * knowledge of Jev. server.mjs hands it the methods; this module decides
 * which protocol revision each message speaks and shapes the reply to match.
 *
 * jev-bridge is a *dual-era* server (spec 2026-07-28, "Versioning and
 * Compatibility"):
 *
 *   legacy   2025-11-25 and earlier. The client opens with `initialize`; the
 *            negotiated version and client identity hold for the process.
 *            What Claude Code speaks to a stdio server by default.
 *   modern   2026-07-28. No handshake: every request carries its version,
 *            client capabilities and identity in `params._meta`. Results carry
 *            `resultType`, the server's identity, and caching hints; the
 *            client may probe with `server/discover`. What Claude Code speaks
 *            with MCP_PROTOCOL_NEGOTIATION=auto.
 *
 * A request is modern when its `_meta` names a protocol version, and legacy
 * otherwise; each is answered in its own era's shape. Also implemented:
 * cancellation (both eras), progress (both), resource subscriptions
 * (`resources/subscribe` in legacy, `subscriptions/listen` in modern).
 * Deliberately absent: logging, sampling and roots, all deprecated in
 * 2026-07-28 (SEP-2577) — diagnostics go to stderr, as the stdio transport
 * says they may.
 */

export const MODERN_VERSIONS = ['2026-07-28'];
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const SUPPORTED_VERSIONS = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];

export const ERRORS = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  UNSUPPORTED_PROTOCOL_VERSION: -32022,
};

const M = 'io.modelcontextprotocol/';

export class McpError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

/** Methods whose results a modern client may cache, and the default hint for each. */
const CACHEABLE = {
  'server/discover': { ttlMs: 3_600_000, cacheScope: 'public' },
  'tools/list': { ttlMs: 3_600_000, cacheScope: 'public' },
  'prompts/list': { ttlMs: 3_600_000, cacheScope: 'public' },
  'resources/list': { ttlMs: 3_600_000, cacheScope: 'public' },
  'resources/templates/list': { ttlMs: 3_600_000, cacheScope: 'public' },
  'resources/read': { ttlMs: 0, cacheScope: 'private' },
};

/** Methods that exist in only one era. Anything else in `methods` serves both. */
const LEGACY_ONLY = new Set(['initialize', 'ping', 'resources/subscribe', 'resources/unsubscribe']);
const MODERN_ONLY = new Set(['server/discover', 'subscriptions/listen']);

const idKey = (id) => JSON.stringify(id);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * @param {object} o
 * @param {object} o.serverInfo     Implementation: name, version, title, …
 * @param {string} o.instructions   Guidance an LLM reads; Claude Code puts it in the system prompt.
 * @param {object} o.capabilities   What the methods below implement.
 * @param {object} o.methods        method -> async (params, ctx) => result
 * @param {(uri: string) => boolean} [o.subscribable]  Which resource URIs can report updates.
 * @param {(msg: object) => void} o.write   Sends one message.
 */
export function createProtocol({ serverInfo, instructions, capabilities, methods, subscribable = () => false, write }) {
  const legacy = { version: null, clientInfo: null }; // set by `initialize`, legacy era only
  const inFlight = new Map(); // idKey -> { controller, cancelled }
  const listeners = new Map(); // idKey -> { id, uris }   modern subscriptions/listen streams
  const legacySubscriptions = new Set(); // URIs a legacy client subscribed to

  const reply = (id, result) => write({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message, data) =>
    write({ jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } });

  /** Shapes a result for its era: modern results gain resultType, serverInfo and, where cacheable, cache hints. */
  function shape(method, result, era) {
    const out = { ...result };
    const hint = CACHEABLE[method];
    if (era === 'modern') {
      out.resultType = 'complete';
      if (hint) {
        out.ttlMs ??= hint.ttlMs;
        out.cacheScope ??= hint.cacheScope;
      }
      out._meta = { ...out._meta, [`${M}serverInfo`]: serverInfo };
    } else {
      delete out.ttlMs;
      delete out.cacheScope;
    }
    return out;
  }

  /**
   * Reads the era off one request. Modern requests must name a version this
   * server implements and declare their capabilities; a malformed one is
   * rejected before any work is done.
   */
  function eraOf(method, params) {
    const meta = isObject(params?._meta) ? params._meta : null;
    const version = meta?.[`${M}protocolVersion`];
    if (version === undefined) {
      if (MODERN_ONLY.has(method)) {
        throw new McpError(ERRORS.INVALID_PARAMS, `${method} needs _meta["${M}protocolVersion"] and _meta["${M}clientCapabilities"].`);
      }
      return { era: 'legacy', version: legacy.version ?? LEGACY_VERSIONS[0], clientInfo: legacy.clientInfo };
    }
    if (typeof version !== 'string' || !SUPPORTED_VERSIONS.includes(version)) {
      throw new McpError(ERRORS.UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version',
        { supported: SUPPORTED_VERSIONS, requested: String(version) });
    }
    if (!isObject(meta[`${M}clientCapabilities`])) {
      throw new McpError(ERRORS.INVALID_PARAMS, `Missing required _meta["${M}clientCapabilities"].`);
    }
    const clientInfo = isObject(meta[`${M}clientInfo`]) ? meta[`${M}clientInfo`] : null;
    return { era: MODERN_VERSIONS.includes(version) ? 'modern' : 'legacy', version, clientInfo };
  }

  /* ── the protocol's own methods ──────────────────────────────────────── */

  const own = {
    initialize(params) {
      const requested = params?.protocolVersion;
      legacy.version = LEGACY_VERSIONS.includes(requested) ? requested : LEGACY_VERSIONS[0];
      legacy.clientInfo = isObject(params?.clientInfo) ? params.clientInfo : null;
      return { protocolVersion: legacy.version, capabilities, serverInfo, instructions };
    },
    ping: () => ({}),
    'server/discover': () => ({ supportedVersions: SUPPORTED_VERSIONS, capabilities, instructions }),
    'resources/subscribe'(params) {
      legacySubscriptions.add(checkedUri(params));
      return {};
    },
    'resources/unsubscribe'(params) {
      legacySubscriptions.delete(checkedUri(params));
      return {};
    },
  };

  function checkedUri(params) {
    const uri = params?.uri;
    if (typeof uri !== 'string') throw new McpError(ERRORS.INVALID_PARAMS, '`uri` must be a string.');
    if (!subscribable(uri)) throw new McpError(ERRORS.INVALID_PARAMS, `Updates are not available for ${uri}.`);
    return uri;
  }

  /**
   * subscriptions/listen stays open: acknowledge what will be honoured, then
   * answer only when the stream ends. List changes are never offered — the
   * lists are fixed — so only resource updates can be acknowledged.
   */
  function listen(id, params) {
    const asked = isObject(params?.notifications) ? params.notifications : {};
    const uris = (Array.isArray(asked.resourceSubscriptions) ? asked.resourceSubscriptions : [])
      .filter((u) => typeof u === 'string' && subscribable(u));
    listeners.set(idKey(id), { id, uris: new Set(uris) });
    write({
      jsonrpc: '2.0',
      method: 'notifications/subscriptions/acknowledged',
      params: { _meta: { [`${M}subscriptionId`]: id }, notifications: uris.length ? { resourceSubscriptions: uris } : {} },
    });
  }

  /** Tells every subscriber of `uri`, in the era it subscribed in, that the resource changed. */
  function resourceUpdated(uri) {
    if (legacySubscriptions.has(uri)) write({ jsonrpc: '2.0', method: 'notifications/resources/updated', params: { uri } });
    for (const { id, uris } of listeners.values()) {
      if (uris.has(uri)) {
        write({ jsonrpc: '2.0', method: 'notifications/resources/updated', params: { _meta: { [`${M}subscriptionId`]: id }, uri } });
      }
    }
  }

  /* ── dispatch ────────────────────────────────────────────────────────── */

  function onNotification(method, params) {
    if (method !== 'notifications/cancelled') return; // initialized, roots changes and the rest need nothing
    const key = idKey(params?.requestId);
    if (listeners.delete(key)) return; // a client closing its own stream gets no response
    const running = inFlight.get(key);
    if (!running) return; // unknown or already answered: ignore, as the spec asks
    running.cancelled = true;
    running.controller.abort(params?.reason ?? 'cancelled');
  }

  async function onRequest(id, method, params) {
    const call = { controller: new AbortController(), cancelled: false };
    const key = idKey(id);
    let era = 'legacy';
    try {
      const context = eraOf(method, params);
      era = context.era;
      if (era === 'modern' ? LEGACY_ONLY.has(method) : MODERN_ONLY.has(method)) {
        throw new McpError(ERRORS.METHOD_NOT_FOUND, `Method not found: ${method} (not part of protocol ${context.version})`);
      }
      if (method === 'subscriptions/listen') return listen(id, params);
      const handler = own[method] ?? methods[method];
      if (!handler) throw new McpError(ERRORS.METHOD_NOT_FOUND, `Method not found: ${method}`);

      if (method !== 'initialize') inFlight.set(key, call); // initialize may not be cancelled
      const token = params?._meta?.progressToken;
      let progress = 0;
      let done = false;
      const ctx = {
        ...context,
        client: typeof context.clientInfo?.name === 'string' ? context.clientInfo.name.slice(0, 100) : null,
        signal: call.controller.signal,
        /** Sends notifications/progress when the request asked for them, and only while it runs. */
        progress(message, total) {
          if (done || call.cancelled || (typeof token !== 'string' && typeof token !== 'number')) return;
          write({ jsonrpc: '2.0', method: 'notifications/progress',
            params: { progressToken: token, progress: ++progress, ...(total !== undefined && { total }), ...(message && { message }) } });
        },
      };
      const result = await handler(params ?? {}, ctx);
      done = true;
      if (call.cancelled) return; // a cancelled request gets no response
      reply(id, shape(method, result, era));
    } catch (err) {
      if (call.cancelled) return;
      if (err instanceof McpError) fail(id, err.code, err.message, err.data);
      else fail(id, ERRORS.INTERNAL, String(err?.message || err));
    } finally {
      inFlight.delete(key);
    }
  }

  return {
    /** Handles one parsed message. Resolves when its response, if any, has been written. */
    receive(msg) {
      if (Array.isArray(msg)) return fail(null, ERRORS.INVALID_REQUEST, 'JSON-RPC batches are not supported.');
      if (!isObject(msg) || msg.jsonrpc !== '2.0') return fail(msg?.id ?? null, ERRORS.INVALID_REQUEST, 'Not a JSON-RPC 2.0 message.');
      const { id, method, params } = msg;
      if (typeof method !== 'string') return; // a response to nothing: this server never sends requests
      if (id === undefined) return onNotification(method, params);
      if (id === null || (typeof id !== 'string' && typeof id !== 'number')) {
        return fail(null, ERRORS.INVALID_REQUEST, 'A request id must be a string or a number.');
      }
      return onRequest(id, method, params);
    },
    resourceUpdated,
    /** Ends every open subscription gracefully: a completion result tagged with its id. */
    closeSubscriptions() {
      for (const { id } of listeners.values()) {
        reply(id, shape('subscriptions/listen', { _meta: { [`${M}subscriptionId`]: id } }, 'modern'));
      }
      listeners.clear();
    },
  };
}
