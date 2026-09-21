#!/usr/bin/env node
/**
 * Re-asks an evaluation set and scores the new answers against the truth.
 *
 *   node examples/replay.mjs eval.jsonl                 against jev-latest
 *   node examples/replay.mjs eval.jsonl jev-preview     before you switch to it
 *
 * The truth for a question is what the reviewer said it should have been (its
 * `expected` answer). On a call marked correct, a question without one counts
 * Jev's original answer as right. Any other question is not scored. Answers are
 * compared as decisions — yes or no, the option chosen, the nearest level —
 * because probabilities wobble by about ±0.02 between identical calls.
 *
 * Each line is one live call, about $0.00002 for a 400-token state. It goes
 * straight to the API: no cache, and nothing is added to the history.
 */
import { readFileSync } from 'node:fs';
import { loadKey } from '../src/server.mjs';
import { DEFAULT_MODEL, request } from '../src/typesafe.mjs';

const [file, model = DEFAULT_MODEL] = process.argv.slice(2);
if (!file) {
  process.stderr.write('usage: node examples/replay.mjs <eval.jsonl> [model]\n');
  process.exit(2);
}
const key = loadKey();
if (!key) {
  process.stderr.write('No TypeSafe API key. See "Configure your API key" in the README.\n');
  process.exit(1);
}

/** What an answer settled on, in the terms a review records it. */
const decision = (a) => (a?.type === 'noul' ? a.noul >= 0.5 : a?.type === 'choice' ? a.choice : a?.type === 'score' ? Math.round(a.score) : undefined);
const same = (a, b) => a !== undefined && JSON.stringify(a) === JSON.stringify(b);
const truthOf = (c, q) => (c.expected && q in c.expected ? c.expected[q] : c.verdict === 'correct' ? decision(c.answers?.[q]) : undefined);
const show = (v) => (v === undefined ? '—' : JSON.stringify(v));

/** One POST, retried exactly as the bridge retries: the TypeSafe SDKs' policy. */
const ask = (body) => request('/systemone', { method: 'POST', body, key });

const cases = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const rows = [['call', 'question', 'should be', 'was', 'now', '']];
let checked = 0, right = 0, rightBefore = 0, changed = 0, failed = 0, tokens = 0;

for (const c of cases) {
  let res;
  try {
    res = await ask(JSON.stringify({ state: c.state, model, questions: c.questions }));
  } catch (err) {
    failed++;
    rows.push([c.id, '', '', '', '', `failed: ${err.message}`]);
    continue;
  }
  if (res.status !== 200) {
    failed++;
    rows.push([c.id, '', '', '', '', `failed: HTTP ${res.status}`]);
    continue;
  }
  const body = JSON.parse(res.text);
  tokens += body.usage?.input_tokens ?? 0;
  for (const q of Object.keys(c.questions)) {
    const truth = truthOf(c, q);
    if (truth === undefined) continue;
    const was = decision(c.answers?.[q]);
    const now = decision(body.answers?.[q]);
    checked++;
    if (same(now, truth)) right++;
    if (same(was, truth)) rightBefore++;
    if (!same(now, was)) changed++;
    const outcome = same(now, truth) ? (same(was, truth) ? 'right' : 'right, fixed') : (same(was, truth) ? 'wrong, broke' : 'wrong');
    rows.push([c.id, q, show(truth), show(was), show(now), outcome]);
  }
}

const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
for (const r of rows) process.stdout.write(r.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd() + '\n');
process.stdout.write(`\n${right} of ${checked} answers right with ${model}, against ${rightBefore} of ${checked} when reviewed. ` +
  `${changed} changed; ${failed} of ${cases.length} calls failed; ${tokens} input tokens.\n`);
