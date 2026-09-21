#!/usr/bin/env node
/**
 * Writes evidence/README.md from the recorded sessions in evidence/runs and
 * the schema checks in evidence/validation.json. Nothing in the report is
 * typed by hand: every table row, check mark, request and diagram is read
 * from those files, so re-recording re-writes it.
 *
 *   node evidence/report.mjs
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENARIOS } from './scenarios.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const M = 'io.modelcontextprotocol/';
const readLines = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)) : []);

/** One session's wire log, reduced to what the checks and the report need. */
function digest(name, sub = '') {
  const dir = join(HERE, 'runs', name, sub);
  const wire = readLines(join(dir, 'wire.jsonl'));
  const transcript = readLines(join(dir, 'transcript.jsonl'));
  const meta = existsSync(join(dir, 'meta.json')) ? JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) : {};
  const requests = new Map();
  const w = { name, wire, transcript, meta, methods: [], calls: [], reads: [], prompts: [], errors: [], notifications: [], allModern: true };
  for (const { dir, msg } of wire) {
    if (dir.startsWith('client') && msg.method) {
      if (msg.id === undefined) continue;
      requests.set(JSON.stringify(msg.id), msg);
      w.methods.push(msg.method);
      w.handshake ??= msg.method === 'initialize' || msg.method === 'server/discover' ? msg.method : undefined;
      if (msg.params?._meta?.[`${M}protocolVersion`] !== '2026-07-28') w.allModern = false;
      w.client ??= msg.params?.clientInfo ?? msg.params?._meta?.[`${M}clientInfo`];
      if (msg.method === 'resources/read') w.reads.push(msg.params.uri);
      if (msg.method === 'prompts/get') w.prompts.push(msg.params);
    } else if (dir.startsWith('server')) {
      if (msg.method) { w.notifications.push(msg); continue; }
      const req = requests.get(JSON.stringify(msg.id));
      if (msg.error) { w.errors.push({ method: req?.method, error: msg.error }); continue; }
      if (req?.method === 'initialize') w.negotiated = msg.result.protocolVersion;
      if (req?.method === 'server/discover') w.negotiated = '2026-07-28';
      if (req?.method === 'tools/call') {
        w.calls.push({ name: req.params.name, args: req.params.arguments ?? {}, result: msg.result.structuredContent, isError: !!msg.result.isError });
      }
    }
  }
  const final = transcript.find((r) => r.type === 'result');
  const init = transcript.find((r) => r.type === 'system' && r.subtype === 'init');
  w.cost = final?.total_cost_usd;
  w.turns = final?.num_turns;
  w.answer = final?.result ?? '';
  w.model = init?.model ?? meta.model;
  w.version = init?.claude_code_version;
  w.slash = init?.slash_commands ?? [];
  w.agentTools = transcript.filter((r) => r.type === 'assistant' && !r.parent_tool_use_id)
    .flatMap((r) => r.message.content.filter((b) => b.type === 'tool_use').map((b) => b.name));
  return w;
}

const short = (method) => method.replace('notifications/', 'n/');
const compactMethods = (methods) => {
  const out = [];
  for (const m of methods) {
    const last = out.at(-1);
    if (last && last.m === m) last.n++;
    else out.push({ m, n: 1 });
  }
  return out.map(({ m, n }) => `\`${short(m)}\`${n > 1 ? ` ×${n}` : ''}`).join(' → ');
};
const clip = (text, n) => (text.length > n ? `${text.slice(0, n - 1).trimEnd()}…` : text);
const money = (usd) => (usd === undefined ? '—' : `$${usd.toFixed(3)}`);
const quote = (text) => text.split('\n').map((l) => `> ${l}`).join('\n');

/** A sequence diagram of the conversation as it happened, one arrow per message. */
function diagram(w) {
  const lines = ['sequenceDiagram', '  autonumber', '  participant C as Claude Code', '  participant B as jev-bridge', '  participant T as TypeSafe API'];
  const requests = new Map();
  for (const { dir, msg } of w.wire) {
    if (dir.startsWith('client') && msg.method) {
      if (msg.id !== undefined) requests.set(JSON.stringify(msg.id), msg);
      if (msg.method === 'notifications/initialized') continue;
      let label = msg.method;
      if (msg.method === 'initialize') label += ` ${msg.params.protocolVersion}`;
      if (msg.method === 'server/discover') label += ` (_meta ${msg.params._meta[`${M}protocolVersion`]})`;
      if (msg.method === 'tools/call') {
        const q = msg.params.arguments?.questions;
        const n = q ? Object.keys(q).length : 0;
        label += ` ${msg.params.name}${q ? ` · ${n} question${n === 1 ? '' : 's'}` : ''}`;
      }
      if (msg.method === 'resources/read') label += ` ${msg.params.uri}`;
      if (msg.method === 'prompts/get') label += ` ${msg.params.name}`;
      lines.push(`  C->>B: ${label}`);
    } else if (dir.startsWith('server')) {
      if (msg.method) { lines.push(`  B--)C: ${msg.method}`); continue; }
      const req = requests.get(JSON.stringify(msg.id));
      let label = msg.error ? `error ${msg.error.code}` : 'result';
      if (req?.method === 'initialize') label = `protocolVersion ${msg.result.protocolVersion}`;
      if (req?.method === 'server/discover') label = `supportedVersions ${msg.result.supportedVersions.join(', ')}`;
      // The trip to TypeSafe is drawn where it happened: after any progress, before the answer.
      if (req?.method === 'tools/call' && ['jev_ask', 'jev_models'].includes(req.params.name) && !msg.result?.isError) {
        if (msg.result?.structuredContent?.bridge?.cached) lines.push('  B->>B: answered from the local cache');
        else {
          lines.push(`  B->>T: ${req.params.name === 'jev_ask' ? 'POST /v1/systemone' : 'GET /v1/models'}`);
          lines.push('  T-->>B: 200');
        }
      }
      if (req?.method === 'tools/call' && msg.result?.structuredContent) {
        const s = msg.result.structuredContent;
        label = s.bridge ? `answers · call_id ${s.bridge.call_id}` : req.params.name === 'jev_review' ? `review ${s.verdict}` : 'structuredContent';
      }
      lines.push(`  B-->>C: ${label}`);
    }
  }
  return ['```mermaid', ...lines, '```'].join('\n');
}

/* ── the report ──────────────────────────────────────────────────────────── */

function safe(fn) { try { return fn(); } catch { return false; } }
const grade = (scenario, w) => scenario.expect.map((e) => ({ label: e.label, ok: !!safe(() => e.test(w)) }));
const sessions = SCENARIOS.map((s) => ({ scenario: s, w: digest(s.name) })).filter(({ w }) => w.wire.length);
const graded = sessions.map(({ scenario, w }) => ({ scenario, w, checks: grade(scenario, w) }));

/** Repeated recordings of one scenario (run.mjs --trials), graded by the same checks. */
const trials = SCENARIOS.map((scenario) => {
  const root = join(HERE, 'runs', scenario.name, 'trials');
  const runs = existsSync(root) ? readdirSync(root).sort((a, b) => a - b).map((n) => digest(scenario.name, join('trials', n))).filter((w) => w.wire.length) : [];
  const per = runs.map((w) => grade(scenario, w));
  return { scenario, runs, checks: scenario.expect.map((e, i) => ({ label: e.label, passed: per.filter((g) => g[i].ok).length })) };
}).filter((t) => t.runs.length);

const validation = existsSync(join(HERE, 'validation.json')) ? JSON.parse(readFileSync(join(HERE, 'validation.json'), 'utf8')) : null;
const versions = [...new Set(sessions.map(({ w }) => w.version).filter(Boolean))];
const recordedOn = [...new Set(sessions.map(({ w }) => w.meta.started?.slice(0, 10)).filter(Boolean))];
const passed = graded.reduce((n, g) => n + g.checks.filter((c) => c.ok).length, 0);
const total = graded.reduce((n, g) => n + g.checks.length, 0);
const allCalls = graded.flatMap((g) => g.w.calls);
const clients = [...new Set(graded.map((g) => g.w.client?.name).filter(Boolean))];
const historyClients = [...new Set(allCalls.filter((c) => c.name === 'jev_history').flatMap((c) => (c.result?.calls ?? []).map((x) => x.client)).filter(Boolean))];

const out = [];
out.push('# Evidence: Claude Code calls jev-bridge');
out.push('');
out.push('<!-- Generated by evidence/report.mjs from evidence/runs and evidence/validation.json. Do not edit by hand. -->');
out.push('');
out.push(`Recorded ${recordedOn.join(', ')} (UTC) with Claude Code ${versions.join(', ')}, headless (\`claude -p\`), with only this server configured. `
  + 'Each session ran through [`tap.mjs`](tap.mjs), which sits between Claude Code and the server and logs every JSON-RPC message. '
  + 'The prompts ask for an outcome and never name a tool, so the agent had to choose the tools itself.');
out.push('');
out.push(`**${passed} of ${total} checks passed across ${graded.length} sessions.** `
  + `Every session identified itself as \`${clients.join(', ')}\`, and the server's own history filed the calls under ${historyClients.map((c) => `\`${c}\``).join(', ') || 'that client'}.`);
out.push('');
out.push('| Session | Model | Protocol | What Claude Code sent | Tools the agent called | Checks |');
out.push('| --- | --- | --- | --- | --- | --- |');
for (const { scenario, w, checks } of graded) {
  const ok = checks.filter((c) => c.ok).length;
  const tools = [...new Set(w.calls.map((c) => c.name))].map((n) => `\`${n}\``).join(', ') || '—';
  out.push(`| [${scenario.title}](#${scenario.name}) | ${w.model?.replace('claude-', '').replace(/-\d{8}$/, '')} | ${w.negotiated ?? '?'} | ${compactMethods(w.methods)} | ${tools} | ${ok === checks.length ? '✅' : '⚠️'} ${ok}/${checks.length} |`);
}
out.push('');

if (validation) {
  const rec = Object.values(validation.recorded);
  const sum = (k, side) => rec.reduce((n, r) => n + r[side][k], 0);
  const schemasOk = validation.tool_schemas.filter((s) => s.valid_2020_12 && s.compiles_strict).length;
  out.push('## Checked against the official MCP schema');
  out.push('');
  out.push(`[\`validate-wire.mjs\`](validate-wire.mjs) validated every message with ${validation.validator} against the official JSON Schema of the revision it used, `
    + `fetched from the MCP repository (${Object.entries(validation.schemas).map(([v, s]) => `[${v}](${s.url}) sha256 \`${s.sha256.slice(0, 12)}…\``).join(', ')}). Full output: [\`validation.json\`](validation.json).`);
  out.push('');
  out.push('| What | Valid |');
  out.push('| --- | --- |');
  out.push(`| Server messages in the recorded sessions | ${sum('valid', 'server')} / ${sum('messages', 'server')} |`);
  out.push(`| Claude Code's messages in the recorded sessions | ${sum('valid', 'client')} / ${sum('messages', 'client')} |`);
  out.push(`| Server messages in a sweep of every method, both revisions, error paths included | ${validation.sweep.server.valid} / ${validation.sweep.server.messages} |`);
  out.push(`| Tool \`inputSchema\` and \`outputSchema\` against the JSON Schema 2020-12 meta-schema | ${schemasOk} / ${validation.tool_schemas.length} |`);
  out.push('');
  out.push(`The sweep also sent ${validation.sweep.client.deliberately_malformed.length} deliberately malformed requests `
    + `(${validation.sweep.client.deliberately_malformed.map((m) => `\`${m}\``).join(', ')}); each got the error code the spec names for it, and those error responses are counted above.`);
  out.push('');
}

out.push('## The two protocol revisions, as recorded');
out.push('');
const legacy = graded.find((g) => g.scenario.name === 'legacy-multilabel');
const modern = graded.find((g) => g.scenario.name === 'modern-review-workflow');
if (legacy) {
  out.push(`**2025-11-25**, Claude Code's default for a stdio server: \`initialize\` first, then plain requests (${legacy.scenario.title.toLowerCase()}).`);
  out.push('');
  out.push(diagram(legacy.w));
  out.push('');
}
if (modern) {
  out.push('**2026-07-28**, with `MCP_SDK_GENERATION=v2 MCP_PROTOCOL_NEGOTIATION=auto`: Claude Code probes with `server/discover`, '
    + 'gets a list of supported versions, and from then on sends every request with `_meta` and no handshake at all.');
  out.push('');
  out.push(diagram(modern.w));
  out.push('');
  const discover = modern.w.wire.find((x) => x.msg.method === 'server/discover');
  const firstCall = modern.w.wire.find((x) => x.msg.method === 'tools/call');
  out.push('The probe and the first tool call, verbatim from the log:');
  out.push('');
  out.push('```json');
  out.push(JSON.stringify(discover.msg));
  out.push(JSON.stringify({ ...firstCall.msg, params: { ...firstCall.msg.params, arguments: '…' } }));
  out.push('```');
  out.push('');
}

if (trials.length) {
  out.push('## How reliably');
  out.push('');
  out.push('One recording shows that something happened, not how often it does. These scenarios were recorded again, several times each, '
    + 'with the same prompt and code, and each run graded by the same checks ([`runs/<scenario>/trials/`](runs)). '
    + 'Trial 0 of `resource-guide-haiku` is an earlier recording of the same prompt whose wire log was kept but whose transcript was not.');
  out.push('');
  out.push('| Scenario | Model | Check | Runs that passed |');
  out.push('| --- | --- | --- | --- |');
  for (const t of trials) {
    const model = (t.runs.find((w) => w.transcript.length) ?? t.runs[0]).model?.replace('claude-', '').replace(/-\d{8}$/, '');
    t.checks.forEach((c, i) => out.push(`| ${i === 0 ? `[${t.scenario.name}](#${t.scenario.name})` : ''} | ${i === 0 ? model : ''} | ${c.label} | ${c.passed} / ${t.runs.length} |`));
  }
  out.push('');
}

out.push('## Sessions');
out.push('');
for (const { scenario, w, checks } of graded) {
  out.push(`### ${scenario.name}`);
  out.push('');
  out.push(`**${scenario.title}.** ${scenario.about}`);
  out.push('');
  out.push(`Model \`${w.model}\` · protocol ${w.negotiated ?? '?'} · ${w.turns ?? '?'} turns · Claude ${money(w.cost)} · `
    + `[wire](runs/${scenario.name}/wire.jsonl) · [transcript](runs/${scenario.name}/transcript.jsonl) · [command](runs/${scenario.name}/meta.json)`);
  out.push('');
  out.push(quote(scenario.prompt));
  out.push('');
  for (const c of checks) out.push(`- ${c.ok ? '✅' : '❌'} ${c.label}`);
  out.push('');
  out.push(`Agent steps: ${w.agentTools.map((t) => `\`${t}\``).join(' → ') || '—'}`);
  out.push('');
  for (const call of w.calls.filter((c) => c.name === 'jev_ask')) {
    out.push('<details><summary><code>jev_ask</code> as the agent wrote it, and what came back</summary>');
    out.push('');
    out.push('```json');
    out.push(JSON.stringify(call.args, null, 2));
    out.push('```');
    out.push('');
    out.push('```json');
    out.push(JSON.stringify({ model: call.result?.model, answers: call.result?.answers, bridge: call.result?.bridge }, null, 2));
    out.push('```');
    out.push('');
    out.push('</details>');
    out.push('');
  }
  for (const call of w.calls.filter((c) => c.name !== 'jev_ask')) {
    out.push(`- \`${call.name}\` ${JSON.stringify(call.args)} → ${clip(JSON.stringify(call.result), 220)}`);
  }
  if (w.calls.some((c) => c.name !== 'jev_ask')) out.push('');
  out.push('What the agent told the user:');
  out.push('');
  out.push(quote(clip(w.answer.trim(), 900)));
  out.push('');
}

out.push('## Reproduce');
out.push('');
out.push('```bash');
out.push('node evidence/run.mjs                    # record every session: needs claude and a TypeSafe key; costs about $0.60');
out.push('node evidence/validate-wire.mjs         # installs Ajv into the temp directory, outside the project');
out.push('node evidence/report.mjs                 # rewrite this page');
out.push('```');
out.push('');
out.push('Logs are sanitised as they are written ([`run.mjs`](run.mjs), `sanitize()`): the home directory becomes `~`, '
  + 'thinking signatures are dropped, and the init record keeps only this server\'s tools and commands. '
  + 'Records about the recording account (`rate_limit_event`) are left out, and the output of hooks from the recording machine\'s own '
  + 'Claude Code setup is replaced by a note saying so; the `hook_started` and `hook_response` records stay, so it is visible that a hook ran. '
  + 'In these recordings those were two `SessionStart` hooks from installed plugins: one injected a general guide to using skills, '
  + 'the other a CLI update notice. Neither mentions Jev, TypeSafe or MCP. Nothing else is changed.');
out.push('');

writeFileSync(join(HERE, 'README.md'), out.join('\n'));
process.stdout.write(`wrote evidence/README.md: ${passed}/${total} checks passed over ${graded.length} sessions\n`);
for (const g of graded) for (const c of g.checks) if (!c.ok) process.stdout.write(`  ✗ ${g.scenario.name}: ${c.label}\n`);
