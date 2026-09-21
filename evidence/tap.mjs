#!/usr/bin/env node
/**
 * A wire tap for a stdio MCP server.
 *
 *   node evidence/tap.mjs <wire.jsonl> <command> [args...]
 *
 * Runs <command> as the MCP server and sits between it and the client,
 * forwarding every byte unchanged in both directions and appending each
 * JSON-RPC message to <wire.jsonl> as {t, dir, msg}. The client never knows
 * it is there, so what the log shows is exactly what the client sent and
 * received. evidence/run.sh registers it in Claude Code in place of the server.
 */
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const [log, cmd, ...args] = process.argv.slice(2);
if (!log || !cmd) {
  process.stderr.write('usage: node evidence/tap.mjs <wire.jsonl> <command> [args...]\n');
  process.exit(2);
}

const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'inherit'], env: process.env });

/** Splits a byte stream into lines and records each as one message. */
function recorder(dir) {
  let buffer = '';
  return (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { msg = { unparsed: line }; }
      appendFileSync(log, JSON.stringify({ t: new Date().toISOString(), dir, msg }) + '\n');
    }
  };
}

const fromClient = recorder('client->server');
const fromServer = recorder('server->client');
process.stdin.setEncoding('utf8');
child.stdout.setEncoding('utf8');
process.stdin.on('data', (chunk) => { fromClient(chunk); child.stdin.write(chunk); });
process.stdin.on('end', () => child.stdin.end());
child.stdout.on('data', (chunk) => { fromServer(chunk); process.stdout.write(chunk); });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => child.kill(s));
