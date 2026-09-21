#!/usr/bin/env node
/**
 * Checks every number the documentation states against the repository:
 *
 *   node evidence/numbers.mjs
 *
 * The README, docs/architecture.md and docs/explainer.html quote versions,
 * line counts and test counts by hand. They drift. Each claim below names
 * where it is written, the pattern that finds it, and the fact it must equal —
 * read from package.json, from `wc -l`, from the CI matrix, or from running a
 * test file and reading its summary. A claim that no longer matches fails, and
 * the message says which file to correct.
 *
 * Exits 1 on any mismatch. Test counts need `node:sqlite` (Node >= 22.5);
 * on an older Node the suites that need it skip, so those claims are skipped
 * too rather than checked against a smaller number.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const lines = (rel) => read(rel).split('\n').length - 1;
const total = (...rels) => rels.reduce((n, rel) => n + lines(rel), 0);

const pkg = JSON.parse(read('package.json'));
const TEST_FILES = ['protocol', 'typesafe', 'server', 'history', 'examples'].map((n) => `test/${n}.test.mjs`);

let sqlite = true;
try { await import('node:sqlite'); } catch { sqlite = false; }

/** What a test file reports for itself, which is what the documentation counts. */
function testsIn(file) {
  const r = spawnSync(process.execPath, ['--test', file], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.replace(/\u001b\[[0-9;]*m/g, '');
  const m = out.match(/^(?:ℹ|#) tests (\d+)$/m);
  if (!m) throw new Error(`could not read a test count from ${file}:\n${out.slice(-400)}`);
  if (!/^(?:ℹ|#) fail 0$/m.test(out)) throw new Error(`${file} has failing tests; fix those before checking the documentation`);
  return Number(m[1]);
}

const counts = sqlite ? Object.fromEntries(TEST_FILES.map((f) => [f, testsIn(f)])) : {};
const suite = sqlite ? Object.values(counts).reduce((a, b) => a + b, 0) : null;
const nodeMatrix = [...read('.github/workflows/ci.yml').match(/node: \[([^\]]+)\]/)[1].matchAll(/\d+/g)].map((m) => Number(m[0]));

/** Every hand-written number, and the fact it must equal. */
const CLAIMS = [
  ['README.md', /[├└]── protocol\.test\.mjs\s+(\d+) tests/, () => counts['test/protocol.test.mjs'], 'tests in test/protocol.test.mjs'],
  ['README.md', /[├└]── typesafe\.test\.mjs\s+(\d+) tests/, () => counts['test/typesafe.test.mjs'], 'tests in test/typesafe.test.mjs'],
  ['README.md', /[├└]── server\.test\.mjs\s+(\d+) tests/, () => counts['test/server.test.mjs'], 'tests in test/server.test.mjs'],
  ['README.md', /[├└]── history\.test\.mjs\s+(\d+) tests/, () => counts['test/history.test.mjs'], 'tests in test/history.test.mjs'],
  ['README.md', /[├└]── examples\.test\.mjs\s+(\d+) tests/, () => counts['test/examples.test.mjs'], 'tests in test/examples.test.mjs'],
  ['README.md', /### 1\. Node\.js (\d+) or newer/, () => Number(pkg.engines.node.replace(/\D/g, '')), 'the lowest Node in package.json engines'],

  ['docs/architecture.md', /^(\d+) tests on the built-in/m, () => suite, 'tests in the suite'],
  ['docs/architecture.md', /\*\*CI runs Node ([\d, and]+)\.\*\*/, () => nodeMatrix.join(', ').replace(/, (\d+)$/, ' and $1'), 'the CI matrix'],

  ['docs/explainer.html', /jev-bridge (\d+\.\d+\.\d+) — written/, () => pkg.version, 'the version in package.json'],
  ['docs/explainer.html', /jev-bridge (\d+\.\d+\.\d+) · MIT/, () => pkg.version, 'the version in package.json'],
  ['docs/explainer.html', /<b>(\d+)<\/b><span>tests, all green/, () => suite, 'tests in the suite'],
  ['docs/explainer.html', /(\d+) tests, no test framework installed/, () => suite, 'tests in the suite'],
  ['docs/explainer.html', /<span class="d">test\/<\/span>\s+<span class="s">([\d,]+) lines/, () => total(...TEST_FILES, 'test/schema-check.mjs'), 'lines in test/'],
  ['docs/explainer.html', /<span class="s">([\d,]+) lines<\/span>\s+<span class="m">\d+ tests, run by/, () => total(...TEST_FILES, 'test/schema-check.mjs'), 'lines in test/'],
  ['docs/explainer.html', /test\/<\/span>\s+<span class="s">[\d,]+ lines<\/span>\s+<span class="m">(\d+) tests/, () => suite, 'tests in the suite'],
  ['docs/explainer.html', /<span class="d">examples\/<\/span>\s+<span class="s">([\d,]+) lines/, () => total('examples/eval-set.mjs', 'examples/replay.mjs'), 'lines in examples/'],
  ['docs/explainer.html', /<b>([\d,]+) lines of JavaScript/, () => total(...SRC, ...TEST_FILES, 'test/schema-check.mjs', 'examples/eval-set.mjs', 'examples/replay.mjs'),
    'lines in src/, test/ and examples/ (the tree above it)'],
  ['docs/explainer.html', /<code>server\.mjs<\/code> \((\d+) lines\)/, () => lines('src/server.mjs'), 'lines in src/server.mjs'],
  ['docs/explainer.html', /<code>store\.mjs<\/code> \((\d+)\)/, () => lines('src/store.mjs'), 'lines in src/store.mjs'],
  ['docs/explainer.html', /<code>server\.test\.mjs<\/code> \((\d+)\)/, () => lines('test/server.test.mjs'), 'lines in test/server.test.mjs'],
];

/** The tree in the explainer names every source file and its length. */
const SRC = ['server', 'mcp', 'catalog', 'typesafe', 'store', 'history', 'ui'].map((n) => `src/${n}.mjs`);
for (const rel of [...SRC, 'src/ui.html']) {
  const name = rel.slice(4).replace('.', '\\.');
  CLAIMS.push(['docs/explainer.html', new RegExp(`[├└]── ${name}\\s+<span class="s">([\\d,]+) lines`), () => lines(rel), `lines in ${rel}`]);
}

const skipped = [];
const failed = [];
for (const [file, pattern, fact, what] of CLAIMS) {
  const found = read(file).match(pattern);
  if (!found) { failed.push(`${file}: nothing matches ${pattern} any more — the claim moved or was reworded`); continue; }
  const expected = fact();
  if (expected === null || expected === undefined) { skipped.push(`${file}: ${what} (needs node:sqlite)`); continue; }
  const claimed = found[1].replace(/,/g, '');
  const want = String(expected).replace(/,/g, '');
  if (claimed !== want) failed.push(`${file} says ${found[1]}, but ${what} is ${expected} (${found[0].trim().slice(0, 60)})`);
}

const checked = CLAIMS.length - skipped.length;
for (const f of failed) process.stderr.write(`✗ ${f}\n`);
if (skipped.length) process.stdout.write(`${skipped.length} claims skipped: no node:sqlite on ${process.version}, so the suite is smaller\n`);
process.stdout.write(`${checked - failed.length}/${checked} documented numbers match the repository\n`);
if (failed.length) process.exitCode = 1;
