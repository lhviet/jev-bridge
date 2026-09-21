#!/usr/bin/env node
/**
 * Records real Claude Code sessions using jev-bridge, as evidence.
 *
 *   node evidence/run.mjs                        every scenario
 *   node evidence/run.mjs modern-rerank          just the ones named
 *   node evidence/run.mjs --trials 5 <names>     repeat each, to measure how reliably
 *                                                the agent does it (runs/<name>/trials/<n>/)
 *
 * Each scenario (evidence/scenarios.mjs) runs `claude -p` headless in an empty directory, with only
 * this server configured (--strict-mcp-config), registered through
 * evidence/tap.mjs so every JSON-RPC message is logged. Prompts say what the
 * user wants and never name a tool: choosing and calling the tools is left to
 * the agent. Written to evidence/runs/<scenario>/:
 *
 *   wire.jsonl        every message between Claude Code and the server
 *   transcript.jsonl  Claude Code's own stream-json record of the session
 *   meta.json         the command, environment switches and exit status
 *
 * Both logs are sanitised the same way: the home directory becomes "~", and
 * the init record keeps only what concerns this server (see sanitize()). The
 * run spends real money: a few cents of Claude per scenario, and fractions of
 * a cent of TypeSafe. It needs a TypeSafe key where the bridge finds one.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENARIOS } from './scenarios.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const RUNS = join(HERE, 'runs');
const CLAUDE = process.env.CLAUDE || 'claude';
const MODEL = process.env.EVIDENCE_MODEL || 'sonnet';
const HOOK_OUTPUT_REMOVED = '[removed by evidence/run.mjs: output of a hook from the recording machine\'s own Claude Code setup]';

/**
 * Keeps logs shareable: no home directory, and nothing about the rest of this machine's setup.
 * Returns null for a record that is only about the recording account, which is then left out.
 */
export function sanitize(line) {
  const home = homedir();
  const rec = JSON.parse(line.split(home).join('~'));
  // The account's own rate-limit windows: nothing to do with this server.
  if (rec.type === 'rate_limit_event') return null;
  // A hook from the recording machine's own settings or plugins. Record that it ran, not what it said.
  if (rec.type === 'system' && rec.subtype === 'hook_response') {
    for (const k of ['output', 'stdout', 'stderr']) if (rec[k]) rec[k] = HOOK_OUTPUT_REMOVED;
    return JSON.stringify(rec);
  }
  if (rec.type === 'system' && rec.subtype === 'init') {
    const keep = (xs = []) => xs.filter((x) => /jev|ToolSearch|McpResource/i.test(typeof x === 'string' ? x : x.name ?? ''));
    return JSON.stringify({
      type: rec.type, subtype: rec.subtype, session_id: rec.session_id, model: rec.model,
      claude_code_version: rec.claude_code_version, permissionMode: rec.permissionMode,
      mcp_servers: rec.mcp_servers, tools: keep(rec.tools), slash_commands: keep(rec.slash_commands),
      note: 'sanitised by evidence/run.mjs: only this server\'s entries are kept from tools and slash_commands',
    });
  }
  // Thinking signatures are opaque bytes; they prove nothing here and are long.
  for (const block of rec.message?.content ?? []) if (block && typeof block === 'object') delete block.signature;
  return JSON.stringify(rec);
}

function run(scenario, work, db, trial = null) {
  const dir = trial === null ? join(RUNS, scenario.name) : join(RUNS, scenario.name, 'trials', String(trial));
  if (trial === null) {
    for (const f of ['wire.jsonl', 'transcript.jsonl', 'meta.json']) rmSync(join(dir, f), { force: true });
  } else {
    rmSync(dir, { recursive: true, force: true });
  }
  mkdirSync(dir, { recursive: true });
  const cwd = join(work, trial === null ? scenario.name : `${scenario.name}-trial-${trial}`);
  mkdirSync(cwd, { recursive: true });
  const rawWire = join(cwd, 'wire.jsonl');
  rmSync(rawWire, { force: true }); // the tap appends: a re-run in the same work directory must not inherit a log
  const config = {
    mcpServers: {
      jev: {
        type: 'stdio',
        command: process.execPath,
        args: [join(HERE, 'tap.mjs'), rawWire, process.execPath, join(ROOT, 'src', 'server.mjs')],
        env: { TYPESAFE_DB: db },
      },
    },
  };
  writeFileSync(join(cwd, 'mcp.json'), JSON.stringify(config, null, 2));
  const model = scenario.model ?? MODEL;
  const args = ['-p', '--model', model, '--strict-mcp-config', '--mcp-config', join(cwd, 'mcp.json'),
    '--allowedTools', 'mcp__jev', 'ListMcpResourcesTool', 'ReadMcpResourceTool',
    '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--max-budget-usd', '1',
    ...scenario.args, scenario.prompt];

  return new Promise((resolve) => {
    const started = new Date().toISOString();
    const child = spawn(CLAUDE, args, { cwd, env: { ...process.env, ...scenario.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('close', (code) => {
      const lines = (text) => text.split('\n').filter((l) => l.trim());
      let wire = [];
      try { wire = lines(readFileSync(rawWire, 'utf8')); } catch { /* the server never started */ }
      const clean = (records) => records.map(sanitize).filter((r) => r !== null).join('\n') + '\n';
      writeFileSync(join(dir, 'wire.jsonl'), clean(wire));
      writeFileSync(join(dir, 'transcript.jsonl'), clean(lines(out)));
      writeFileSync(join(dir, 'meta.json'), JSON.stringify({
        scenario: scenario.name, trial, about: scenario.about, started, finished: new Date().toISOString(), exit_code: code,
        model, env: scenario.env,
        command: ['claude', ...args.map((a) => (a.startsWith(work) ? a.replace(work, '<workdir>') : a))],
        stderr: err.trim().split(homedir()).join('~').slice(0, 2000) || null,
      }, null, 2) + '\n');
      resolve(code);
    });
  });
}

/** Records the chosen scenarios. Only when run as a script: importing this file (for sanitize) records nothing. */
async function main() {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--trials');
  const trials = at === -1 ? 0 : Number(argv[at + 1]);
  const wanted = argv.filter((a, i) => at === -1 || (i !== at && i !== at + 1));
  const chosen = SCENARIOS.filter((s) => wanted.length === 0 || wanted.includes(s.name));
  if (chosen.length === 0) {
    process.stderr.write(`no such scenario; choose from: ${SCENARIOS.map((s) => s.name).join(', ')}\n`);
    process.exit(2);
  }
  const work = process.env.EVIDENCE_WORKDIR || mkdtempSync(join(tmpdir(), 'jev-evidence-'));
  // One database for the whole run, so later scenarios see earlier calls, as a user's sessions would.
  const db = join(work, 'evidence.db');
  for (const s of chosen) {
    for (const trial of trials ? Array.from({ length: trials }, (_, i) => i + 1) : [null]) {
      process.stderr.write(`▶ ${s.name}${trial ? ` trial ${trial}` : ''} … `);
      const code = await run(s, work, db, trial);
      process.stderr.write(`exit ${code}\n`);
    }
  }
  process.stderr.write(`work directory: ${work}\n`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
