/**
 * The call-history dashboard: a small HTTP server on 127.0.0.1, started by
 * `jev-bridge --ui`. It runs in its own process, apart from any MCP server, so
 * looking back at calls never competes with answering one.
 *
 * The page can show every state the history kept, so it is guarded the way a
 * local notebook server is: a random token on every request, and a Host check
 * so that a web page cannot reach it through DNS rebinding. It loads nothing
 * from the network — no fonts, no scripts — and its CSP forbids it to.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { historyReport, reviewCall } from './history.mjs';

const PAGE = new URL('./ui.html', import.meta.url);
const MAX_BODY = 64 * 1024;

const number = (raw, fallback) => {
  const n = Number(raw);
  return raw !== null && raw !== '' && Number.isFinite(n) ? n : fallback;
};

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('Request body too large.'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(Object.assign(new Error('Body is not valid JSON.'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

/**
 * @returns {Promise<{ url: string, port: number, token: string, close: () => Promise<void> }>}
 */
export function startUi({ store, host = '127.0.0.1', port = 0, token = randomBytes(24).toString('base64url'), now = Date.now }) {
  const html = readFileSync(PAGE, 'utf8');
  const secret = Buffer.from(token);
  const tokenOk = (given) => {
    const b = Buffer.from(String(given ?? ''));
    return b.length === secret.length && timingSafeEqual(b, secret);
  };
  let hosts = new Set();

  const server = createServer(async (req, res) => {
    const send = (status, body, type = 'application/json; charset=utf-8', headers = {}) => {
      res.writeHead(status, {
        'content-type': type, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', ...headers,
      });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    try {
      if (!hosts.has(req.headers.host)) return send(403, { error: 'This dashboard answers only on 127.0.0.1 and localhost.' });
      const url = new URL(req.url, 'http://local');

      if (url.pathname === '/' && req.method === 'GET') {
        if (!tokenOk(url.searchParams.get('token'))) {
          return send(401, 'Open the address that `jev-bridge --ui` printed: it carries the access token.\n', 'text/plain; charset=utf-8');
        }
        const nonce = randomBytes(16).toString('base64');
        return send(200, html.replaceAll('__NONCE__', nonce), 'text/html; charset=utf-8', {
          'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; ` +
            "connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        });
      }

      if (!url.pathname.startsWith('/api/')) return send(404, { error: 'Not found.' });
      if (!tokenOk(req.headers['x-jev-token'])) return send(401, { error: 'Missing or wrong access token.' });

      if (url.pathname === '/api/report' && req.method === 'GET') {
        const p = url.searchParams;
        try {
          return send(200, historyReport(store, {
            days: number(p.get('days'), 7), filter: p.get('filter') || 'all', below: number(p.get('below'), 0.6),
            q: p.get('q') || undefined, limit: Math.min(number(p.get('limit'), 200), 5000), now: now(),
          }));
        } catch (err) {
          return send(400, { error: err.message });
        }
      }

      const call = url.pathname.match(/^\/api\/calls\/([^/]+)(\/review)?$/);
      if (call) {
        const id = decodeURIComponent(call[1]);
        if (!call[2] && req.method === 'GET') {
          const found = store.getHistory(id);
          return found ? send(200, found) : send(404, { error: `No call "${id}".` });
        }
        if (call[2] && req.method === 'POST') {
          if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) return send(415, { error: 'Send JSON.' });
          const body = await readJson(req);
          if (!store.getHistory(id)) return send(404, { error: `No call "${id}".` });
          try {
            return send(200, reviewCall(store, id, { verdict: body.verdict ?? null, note: body.note || null, expected: body.expected ?? null }, now()));
          } catch (err) {
            return send(400, { error: err.message });
          }
        }
      }
      return send(404, { error: 'Not found.' });
    } catch (err) {
      return send(err.status ?? 500, { error: err.message });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const actual = server.address().port;
      hosts = new Set([`127.0.0.1:${actual}`, `localhost:${actual}`, `[::1]:${actual}`]);
      resolve({
        url: `http://${host}:${actual}/?token=${token}`,
        port: actual,
        token,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
