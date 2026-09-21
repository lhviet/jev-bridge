#!/usr/bin/env node
/**
 * Runs every documented jev_ask request live, through jev-bridge over MCP
 * stdio as a client would, and writes what came back:
 *
 *   node evidence/examples.mjs      → evidence/examples.md and evidence/examples.json
 *
 * The requests are read out of the documents — the six in docs/recipes.md and
 * "A complete request" in the README — so what runs is exactly what a reader
 * copies. Each answer is checked against the decision its document describes:
 * which option wins, the order, which side of 0.5. Exact probabilities are not
 * checked; they move by about ±0.02 from call to call.
 *
 * Every call is live (`cache: false`) and lands in a temporary database, never
 * ~/.jev-bridge/jev.db. Needs a TypeSafe key where the bridge finds one.
 * Costs a fraction of a cent. Exits 1 if any check fails.
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from './stdio-client.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/** The first ```json block under each heading that `heading` matches, up to the next heading of that level. */
function requestsUnder(file, heading) {
  const lines = readFileSync(join(ROOT, file), 'utf8').split('\n');
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(heading);
    if (!m) continue;
    const level = lines[i].match(/^#+/)[0];
    for (let j = i + 1; j < lines.length && !lines[j].startsWith(`${level} `); j++) {
      if (lines[j].trim() !== '```json') continue;
      const end = lines.indexOf('```', j + 1);
      found.push({ title: m[1], source: `${file}#${anchor(m[1])}`, request: JSON.parse(lines.slice(j + 1, end).join('\n')) });
      break;
    }
  }
  return found;
}

/** GitHub's heading anchors. */
const anchor = (title) => title.toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');

const noul = (a, id) => a[id]?.noul;
const pick = (a, id) => a[id]?.choice;
const score = (a, id) => a[id]?.score;

/** What each document says the answer shows. Keyed by heading. */
const EXPECT = {
  'A complete request': [
    ['is_urgent is above 0.5', (a) => noul(a, 'is_urgent') > 0.5],
    ['department is billing', (a) => pick(a, 'department') === 'billing'],
    ['frustration lands at "Frustrated" (between 0.5 and 1.5)', (a) => score(a, 'frustration') > 0.5 && score(a, 'frustration') < 1.5],
  ],
  '1. Route a request and fill its arguments in one trip': [
    ['handler is issue_refund', (a) => pick(a, 'handler') === 'issue_refund'],
    ['refund_reason is damaged', (a) => pick(a, 'refund_reason') === 'damaged'],
    ['has_evidence is above 0.5', (a) => noul(a, 'has_evidence') > 0.5],
    ['needs_human is below 0.5', (a) => noul(a, 'needs_human') < 0.5],
  ],
  '2. Rerank what your search returned': [
    ['b scores highest', (a) => ['a', 'c', 'd'].every((p) => score(a, 'b') > score(a, p))],
    ['c, on topic but not an answer, ranks second', (a) => score(a, 'c') > score(a, 'a') && score(a, 'c') > score(a, 'd')],
  ],
  '3. Check a claim against its evidence': [
    ['supported is below 0.5', (a) => noul(a, 'supported') < 0.5],
    ['contradicted is above 0.5', (a) => noul(a, 'contradicted') > 0.5],
  ],
  '4. Apply labels that can all be true at once': [
    ['all four labels are above 0.5', (a) => ['reports_bug', 'mentions_billing', 'requests_refund', 'churn_risk'].every((q) => noul(a, q) > 0.5)],
  ],
  '5. Let code find candidates, and Jev pick the right one': [
    ['delivery_date is 11 Jan', (a) => pick(a, 'delivery_date') === '11 Jan'],
  ],
  '6. Score dimensions once, decide the policy in code': [
    ['clarity is below 1 of 3', (a) => score(a, 'clarity') < 1],
    ['testability is below 1 of 2', (a) => score(a, 'testability') < 1],
  ],
};

/** A 20-cell bar for a value between 0 and 1. */
function bar(v) {
  const eighths = Math.round(Math.max(0, Math.min(1, v)) * 160);
  const partial = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'][eighths % 8];
  return (eighths === 0 ? '·' : '█'.repeat(Math.floor(eighths / 8)) + partial).padEnd(20, ' ');
}
const n2 = (v) => (typeof v === 'number' ? v.toFixed(2) : String(v));

/** Answers as bars, one line per noul or score and one per choice option. */
export function render(questions, answers) {
  const width = Math.max(...Object.keys(answers).map((k) => k.length));
  const out = [];
  for (const [id, a] of Object.entries(answers)) {
    const pad = id.padEnd(width);
    if (a.type === 'noul') out.push(`${pad}  noul    ${bar(a.noul)}  ${n2(a.noul)}`);
    if (a.type === 'choice') {
      out.push(`${pad}  choice  ${a.choice}   confidence ${n2(a.confidence)}`);
      const opts = Object.entries(a.probabilities ?? {}).sort((x, y) => y[1] - x[1]);
      const w = Math.max(...opts.map(([o]) => o.length));
      for (const [o, p] of opts) out.push(`${' '.repeat(width)}    ${o.padEnd(w)}  ${bar(p)}  ${n2(p)}`);
    }
    if (a.type === 'score') {
      const top = (questions[id]?.criteria?.length ?? 2) - 1;
      out.push(`${pad}  score   ${bar(a.score / top)}  ${n2(a.score)} of ${top}   confidence ${n2(a.confidence)}`);
    }
  }
  return out.join('\n');
}

/** Which code answered: the commit, and whether anything that shapes a request or its answer had uncommitted changes. */
export function provenance(root = ROOT) {
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' }).trim();
  try {
    return { commit: git('rev-parse', '--short', 'HEAD'), modified: git('status', '--porcelain', '--', 'src', 'docs', 'README.md') !== '' };
  } catch {
    return { commit: null, modified: null };
  }
}

const stateText = (s) => (typeof s === 'string' ? s : JSON.stringify(s));

async function main() {
  const examples = [
    ...requestsUnder('README.md', /^### (A complete request)$/),
    ...requestsUnder('docs/recipes.md', /^## (\d\. .+)$/),
  ];
  const missing = Object.keys(EXPECT).filter((t) => !examples.some((e) => e.title === t));
  if (missing.length) throw new Error(`no request found under: ${missing.join('; ')}`);

  const work = mkdtempSync(join(tmpdir(), 'jev-examples-'));
  const client = await connect(process.execPath, [join(ROOT, 'src', 'server.mjs')],
    { env: { ...process.env, TYPESAFE_DB: join(work, 'examples.db') } });
  const started = new Date();
  const results = [];
  try {
    for (const ex of examples) {
      const res = await client.request('tools/call', { name: 'jev_ask', arguments: { ...ex.request, cache: false } });
      if (res.isError) throw new Error(`${ex.title}: ${res.content?.[0]?.text}`);
      const out = res.structuredContent;
      const checks = EXPECT[ex.title].map(([label, test]) => ({ label, ok: Boolean(test(out.answers)) }));
      results.push({ ...ex, result: out, checks });
      process.stderr.write(`${checks.every((c) => c.ok) ? '✔' : '✗'} ${ex.title} (${out.bridge.latency_ms} ms)\n`);
    }
  } finally {
    await client.close();
    rmSync(work, { recursive: true, force: true });
  }

  const checks = results.flatMap((r) => r.checks);
  const passed = checks.filter((c) => c.ok).length;
  const models = [...new Set(results.map((r) => r.result.model))].join(', ');
  const ms = Math.round(results.reduce((t, r) => t + r.result.bridge.latency_ms, 0));
  const usd = results.reduce((t, r) => t + r.result.bridge.cost_usd, 0);
  const code = provenance();
  const at = code.commit ? `jev-bridge at commit \`${code.commit}\`${code.modified ? ' with uncommitted changes' : ''}` : 'jev-bridge';

  writeFileSync(join(HERE, 'examples.json'), JSON.stringify({
    generated: started.toISOString(), commit: code.commit, modified: code.modified, node: process.version, models, passed, total: checks.length,
    examples: results.map(({ title, source, request, result, checks: c }) => ({ title, source, request, result, checks: c })),
  }, null, 2) + '\n');

  const md = [
    '# The documented examples, run live',
    '',
    `Every \`jev_ask\` request in the documentation, sent through ${at} over MCP stdio on ${started.toISOString().slice(0, 10)}, Node ${process.version}. `
      + 'The requests were read out of the documents themselves, so each one is exactly what a reader copies. '
      + '**Generated by [`examples.mjs`](examples.mjs); do not edit by hand.** Raw requests and responses: [`examples.json`](examples.json).',
    '',
    `**${passed} of ${checks.length} checks passed** over ${results.length} requests, answered by \`${models}\`: `
      + `${ms} ms of live calls in all, $${usd.toFixed(6)}.`,
    '',
    'Each check is the decision the document describes. The probabilities are this run\'s. They differ slightly from the figures in the '
      + 'documents, which came from an earlier run: Jev\'s decisions are stable, but its probabilities move by about ±0.02 between calls.',
    '',
    '| Example | Checks | Latency | Cost | TypeSafe request id |',
    '| --- | --- | --- | --- | --- |',
    ...results.map((r) => `| [${r.title}](../${r.source}) | ${r.checks.filter((c) => c.ok).length}/${r.checks.length} `
      + `| ${r.result.bridge.latency_ms} ms | $${r.result.bridge.cost_usd.toFixed(7)} | \`${r.result.bridge.request_id ?? '—'}\` |`),
    '',
  ];
  for (const r of results) {
    md.push(`## ${r.title}`, '', `From [${r.source}](../${r.source}).`, '');
    md.push(`> ${stateText(r.request.state).slice(0, 400)}`, '');
    md.push('```text', render(r.request.questions, r.result.answers), '```', '');
    for (const c of r.checks) md.push(`- ${c.ok ? '✔' : '✗'} ${c.label}`);
    md.push('', `${r.result.usage?.input_tokens ?? '?'} input tokens · ${r.result.bridge.latency_ms} ms · $${r.result.bridge.cost_usd.toFixed(7)} · \`${r.result.model}\``, '');
  }
  md.push('## Reproduce', '', '```bash', 'node evidence/examples.mjs   # needs a TypeSafe key; costs a fraction of a cent', '```', '');
  writeFileSync(join(HERE, 'examples.md'), md.join('\n'));
  process.stdout.write(`wrote evidence/examples.md: ${passed}/${checks.length} checks passed over ${results.length} requests\n`);
  if (passed !== checks.length) process.exitCode = 1;
}

// Only when run as a script: evidence/install.mjs imports render().
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
