#!/usr/bin/env node
/**
 * Writes every reviewed call as one line of JSON: the state, the questions, what
 * Jev answered, and what the reviewer said it should have been. That file is an
 * evaluation set. Keep it, add cases to it by hand, and replay it against any
 * model with examples/replay.mjs.
 *
 *   node examples/eval-set.mjs > eval.jsonl
 *   node examples/eval-set.mjs incorrect partial > wrong.jsonl    only these verdicts
 *
 * Reads the bridge's own database: $TYPESAFE_DB, else $JEV_BRIDGE_HOME/jev.db,
 * else ~/.jev-bridge/jev.db. The output holds your states, so keep it private.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { VERDICTS } from '../src/history.mjs';
import { openStore } from '../src/store.mjs';

const fail = (message) => { process.stderr.write(`${message}\n`); process.exit(1); };

let sqlite;
try { sqlite = await import('node:sqlite'); } catch { fail('This needs node:sqlite, which arrived in Node 22.5.'); }

const only = new Set(process.argv.slice(2));
for (const v of only) if (!VERDICTS.includes(v)) fail(`Unknown verdict "${v}". Use any of: ${VERDICTS.join(', ')}.`);

const path = process.env.TYPESAFE_DB || join(process.env.JEV_BRIDGE_HOME || join(homedir(), '.jev-bridge'), 'jev.db');
// Opening a missing path would quietly create an empty database; say so instead.
if (!existsSync(path)) fail(`No database at ${path}. Set TYPESAFE_DB to the one the bridge uses.`);

const store = openStore(path, { sqlite, history: 'off' });
let written = 0;
let skipped = 0;
for (const row of store.listHistory({ since: 0 }).reverse()) {
  if (!row.verdict || (only.size && !only.has(row.verdict))) continue;
  const call = store.getHistory(row.id);
  if (call.state === null || call.questions === null) { skipped++; continue; } // recorded on "meta"
  process.stdout.write(JSON.stringify({
    id: call.id,
    at: new Date(call.ts).toISOString(),
    model: call.resolved_model,
    verdict: call.verdict,
    note: call.note,
    state: call.state,
    questions: call.questions,
    answers: call.answers,
    expected: call.expected,
  }) + '\n');
  written++;
}
store.close();
process.stderr.write(`${written} reviewed calls written` +
  (skipped ? `; ${skipped} skipped, recorded without their state (history on "meta")` : '') + '\n');
