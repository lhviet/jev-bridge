/**
 * The smallest MCP client that does what any stdio client does: start the
 * server's command, open a session with `initialize`, then send requests and
 * wait for their responses. Used by evidence/install.mjs and
 * evidence/examples.mjs; it knows nothing about jev-bridge.
 */
import { spawn } from 'node:child_process';

export async function connect(command, args = [], { env = process.env, cwd } = {}) {
  const child = spawn(command, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const waiting = new Map();
  let buffer = '';
  let next = 0;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line); // anything but JSON-RPC on stdout is a broken server, and should fail loudly
      if (msg.id !== undefined && waiting.has(msg.id)) {
        waiting.get(msg.id)(msg);
        waiting.delete(msg.id);
      }
    }
  });
  const exited = new Promise((resolve) => child.on('close', resolve));

  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++next;
    waiting.set(id, (msg) => (msg.error ? reject(Object.assign(new Error(msg.error.message), { rpc: msg.error })) : resolve(msg.result)));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });

  const init = await request('initialize', {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'jev-bridge-evidence', version: '1' },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  return {
    init,
    request,
    stderr: () => stderr,
    close: async () => { child.stdin.end(); return exited; },
  };
}
