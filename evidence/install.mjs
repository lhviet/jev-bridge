#!/usr/bin/env node
/**
 * Follows the README's install guide as a new user would, in a sandbox, and
 * records what every step printed:
 *
 *   node evidence/install.mjs                   clone from GitHub
 *   node evidence/install.mjs --source <path>   clone a local checkout instead, e.g. before pushing
 *
 * Writes evidence/install.md. The commands are read out of the README itself,
 * so what runs is what a reader types. The sandbox is a temporary directory
 * with a HOME of its own: ~/.jev-bridge and Claude Code's user configuration
 * start empty, and nothing of this machine's setup is read or changed. In it:
 * a fresh clone, `npm test`, the key written as Option A says, `claude mcp add
 * --scope user`, `--selftest`, `claude mcp list`, the JSON other clients use,
 * one real Claude Code session with the "Using it" prompt, `--stats` and an
 * update.
 *
 * That session is the one step outside the sandbox's HOME, because Claude Code
 * keeps its login in this machine's keychain. It loads exactly the server entry
 * `claude mcp add` wrote into the sandbox (--strict-mcp-config), with hooks and
 * skills off, and the server keeps its data in the sandbox (JEV_BRIDGE_HOME).
 *
 * Needs git, a logged-in claude, and a TypeSafe key where the bridge finds one.
 * The key is copied into the sandbox, never printed, and deleted with it. Costs
 * a few cents of Claude and a fraction of a cent of TypeSafe. Exits 1 if any
 * check fails.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { arch, homedir, platform, release, tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keyFromFile, loadKey } from '../src/typesafe.mjs';
import { render } from './examples.mjs';
import { connect } from './stdio-client.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const argv = process.argv.slice(2);
const given = argv.includes('--source') ? argv[argv.indexOf('--source') + 1] : 'https://github.com/lhviet/jev-bridge.git';
const remote = /^[a-z]+:\/\/|^git@/.test(given);
const SOURCE = remote ? given : resolve(given); // a local checkout, by its absolute path
const SOURCE_SHOWN = remote ? given : 'a local checkout of the same commit';
const CLAUDE = process.env.CLAUDE || 'claude';
const TOOLS = ['jev_ask', 'jev_usage', 'jev_history', 'jev_review', 'jev_models'];

/** The first ```<lang> block under a README heading, before the next heading of any level. */
function readmeBlock(heading, lang) {
  const lines = readFileSync(join(ROOT, 'README.md'), 'utf8').split('\n');
  const at = lines.indexOf(heading);
  if (at === -1) throw new Error(`README.md has no heading "${heading}"`);
  for (let j = at + 1; j < lines.length && !/^#{1,6} /.test(lines[j]); j++) {
    if (lines[j].trim() !== '```' + lang) continue;
    return lines.slice(j + 1, lines.indexOf('```', j + 1)).join('\n');
  }
  throw new Error(`README.md has no \`\`\`${lang} block under "${heading}"`);
}
/** A command the README shows on a line of its own, wherever it is in the guide. */
function inReadme(command) {
  if (!readFileSync(join(ROOT, 'README.md'), 'utf8').split('\n').includes(command)) throw new Error(`README.md no longer shows: ${command}`);
  return command;
}
const anchor = (heading) => heading.replace(/^#+ /, '').toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');

const key = loadKey(ROOT);
if (!key) {
  process.stderr.write('No TypeSafe key: set TYPESAFE_API_KEY or write ~/.jev-bridge/.env first.\n');
  process.exit(2);
}

const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'jev-install-')));
const home = join(sandbox, 'home');
const work = join(sandbox, 'work');
const project = join(sandbox, 'project');
// The Quick start is followed by a second new user, with a home and a clone of their own.
const quickHome = join(sandbox, 'quick-home');
const quickWork = join(sandbox, 'quick-work');
for (const d of [home, work, project, quickHome, quickWork]) mkdirSync(d);
const clone = join(work, 'jev-bridge');
const quickClone = join(quickWork, 'jev-bridge');

// A new user: this machine's PATH and tools, none of its TypeSafe, jev-bridge or
// Claude Code session settings, and a HOME of their own.
const base = Object.fromEntries(Object.entries(process.env)
  .filter(([k]) => !/^(TYPESAFE_|JEV_BRIDGE_|MCP_|CLAUDE_CODE_|CLAUDECODE$|CLAUDE_PID$|CLAUDE_EFFORT$)/.test(k)));
const sandboxEnv = { ...base, HOME: home };

/** Keeps the record shareable: no key, no real paths, no user name. */
const user = userInfo().username;
function redact(text) {
  let t = String(text).split(key).join('<key>').split(key.slice(0, 8)).join('••••••••');
  for (const [path, shown] of [[clone, '<clone>'], [quickClone, '<clone>'], [home, '~'], [quickHome, '~'], [sandbox, '<sandbox>'], [homedir(), '~']]) {
    t = t.split(path).join(shown);
  }
  return t.replace(new RegExp(`\\b${user}\\b`, 'g'), '<user>');
}

function sh(command, { cwd = work, env = sandboxEnv } = {}) {
  const r = spawnSync('/bin/sh', ['-c', `{\n${command}\n} 2>&1`], { cwd, env, encoding: 'utf8', maxBuffer: 64 << 20 });
  return { code: r.status, out: r.stdout ?? '' };
}

const steps = [];
const check = (label, ok) => ({ label, ok: Boolean(ok) });
function step(s) {
  steps.push(s);
  process.stderr.write(`${s.checks.every((c) => c.ok) ? '✔' : '✗'} ${s.title}\n`);
}
/** The first `{` that starts a line, to the end: the JSON the CLI prints after its status lines. */
const jsonTail = (out) => JSON.parse(out.slice(out.search(/^\{/m)));
const mode = (path) => (statSync(path).mode & 0o777).toString(8);

let claudeJson = null;
try {
  // ── Quick start, in one go ──
  {
    const heading = '## Quick start';
    const block = readmeBlock(heading, 'bash');
    const script = block.replace("'your-key-here'", '"$JEV_KEY"')
      .replace('https://github.com/lhviet/jev-bridge.git', JSON.stringify(SOURCE));
    const r = sh(script, { cwd: quickWork, env: { ...base, HOME: quickHome, JEV_KEY: key } });
    const list = sh(`${CLAUDE} mcp list`, { cwd: project, env: { ...base, HOME: quickHome } });
    let out = null;
    try { out = jsonTail(r.out); } catch { /* reported by the checks */ }
    step({ heading, title: 'Quick start, in one go', shown: block,
      ran: 'the same, as a second new user, with the key in place of your-key-here; then claude mcp list',
      code: r.code, out: `${r.out}$ claude mcp list\n${list.out}`,
      checks: [check('the whole block exits 0', r.code === 0),
        check('the self-test loaded the key and got an answer from a jev model', /^key: loaded /m.test(r.out) && /^jev-/.test(out?.model ?? '')),
        check('Claude Code lists jev as connected', /^jev: node .*src\/server\.mjs - ✔ Connected$/m.test(list.out))] });
  }

  // ── Prerequisites ──
  {
    const r = sh('node --version');
    step({ heading: '## Prerequisites', title: 'Node.js 18 or newer', shown: 'node --version', ...r,
      checks: [check('Node is 18 or newer', Number(r.out.trim().slice(1).split('.')[0]) >= 18)] });
  }

  // ── Install ──
  {
    const r = sh(`git clone ${JSON.stringify(SOURCE)} jev-bridge`);
    const head = r.code === 0 ? sh('git log -1 --format="%h %s"', { cwd: clone }).out : '';
    const pkg = r.code === 0 ? JSON.parse(readFileSync(join(clone, 'package.json'), 'utf8')) : {};
    step({ heading: '## Install', title: 'Clone', shown: 'git clone https://github.com/lhviet/jev-bridge.git\ncd jev-bridge',
      ran: `git clone ${remote ? SOURCE : "<a local checkout>"} jev-bridge`, code: r.code, out: `${r.out}$ git log -1 --oneline\n${head}`,
      checks: [check('the clone succeeded', r.code === 0),
        check('package.json declares no dependencies, so there is nothing to install', !pkg.dependencies && !pkg.devDependencies)] });
  }
  {
    const r = sh(inReadme('npm test'), { cwd: clone });
    const summary = r.out.split('\n').filter((l) => /^(ℹ|#) (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) /.test(l)).join('\n');
    step({ heading: '## Install', title: 'Run the tests', shown: 'npm test', code: r.code, out: `… (${r.out.split('\n').length} lines, summary below)\n${summary}\n`,
      checks: [check('npm test exits 0', r.code === 0), check('no test failed', /^(ℹ|#) fail 0$/m.test(r.out))] });
  }
  {
    const r = sh(inReadme('echo "$(pwd)/src/server.mjs"'), { cwd: clone });
    step({ heading: '## Install', title: 'Note the server\'s absolute path', shown: 'echo "$(pwd)/src/server.mjs"', ...r,
      checks: [check('the path exists', existsSync(r.out.trim()))] });
  }

  // ── Configure your API key: Option A ──
  {
    const heading = '### Option A — a key file (recommended)';
    const block = readmeBlock(heading, 'bash');
    const r = sh(block.replace("'your-key-here'", '"$JEV_KEY"'), { env: { ...sandboxEnv, JEV_KEY: key } });
    const listing = sh('ls -la ~/.jev-bridge');
    const file = join(home, '.jev-bridge', '.env');
    step({ heading, title: 'Write the key file', shown: block, ran: 'the same, with the key in place of your-key-here',
      code: r.code, out: `${r.out}$ ls -la ~/.jev-bridge\n${listing.out}`,
      checks: [check('~/.jev-bridge is mode 700', mode(join(home, '.jev-bridge')) === '700'),
        check('~/.jev-bridge/.env is mode 600', mode(file) === '600'),
        check('the bridge reads the key back from it', keyFromFile(readFileSync(file, 'utf8')) === key)] });
  }

  // ── Connect it to Claude Code ──
  {
    const heading = '## Connect it to Claude Code';
    const block = readmeBlock(heading, 'bash');
    const r = sh(block.replaceAll('/absolute/path/to/jev-bridge', clone), { cwd: project });
    const configFile = join(home, '.claude.json');
    const raw = existsSync(configFile) ? readFileSync(configFile, 'utf8') : '{}';
    claudeJson = JSON.parse(raw);
    const entry = claudeJson.mcpServers?.jev;
    step({ heading, title: 'Register the server with Claude Code', shown: block, code: r.code,
      out: `${r.out}$ # what it wrote to ~/.claude.json\n${JSON.stringify({ mcpServers: claudeJson.mcpServers }, null, 2)}\n`,
      checks: [check('claude mcp add exits 0', r.code === 0),
        check('~/.claude.json has a user-scope "jev" server running node on the server\'s path',
          entry?.command === 'node' && entry?.args?.[0] === join(clone, 'src', 'server.mjs')),
        check('the key is not in Claude Code\'s configuration', !raw.includes(key))] });
  }

  // ── Check it works ──
  {
    const heading = '## Check it works';
    const block = readmeBlock(heading, 'bash');
    const r = sh(block, { cwd: clone });
    let out = null;
    try { out = jsonTail(r.out); } catch { /* reported by the checks */ }
    const sqlite = Number(process.versions.node.split('.')[0]) > 22 || (process.versions.node.startsWith('22.') && Number(process.versions.node.split('.')[1]) >= 5);
    step({ heading, title: 'Call the API directly', shown: block, ...r,
      checks: [check('the key was loaded from the key file', /^key: loaded /m.test(r.out)),
        check('a JSON answer came back from a jev model', /^jev-/.test(out?.model ?? '') && Object.keys(out?.answers ?? {}).length === 3),
        check(sqlite ? 'answers persist in ~/.jev-bridge/jev.db' : 'without node:sqlite the store is in memory, as documented',
          sqlite ? r.out.includes(`store: sqlite at ${join(home, '.jev-bridge', 'jev.db')}`) : /store: memory/.test(r.out))] });
  }
  {
    const r = sh(inReadme('claude mcp list').replace(/^claude/, CLAUDE), { cwd: project });
    step({ heading: '## Check it works', title: 'Check Claude Code can reach the server', shown: 'claude mcp list', ...r,
      checks: [check('jev is listed as connected', /^jev: node .*src\/server\.mjs - ✔ Connected$/m.test(r.out))] });
  }

  // ── Using it: a real Claude Code session ──
  {
    const heading = '## Using it';
    const prompt = readmeBlock(heading, 'text').replace(/\n/g, ' ');
    const mcpFile = join(sandbox, 'jev.mcp.json');
    writeFileSync(mcpFile, JSON.stringify({ mcpServers: { jev: claudeJson?.mcpServers?.jev } }, null, 2));
    const args = ['-p', prompt, '--model', 'sonnet', '--strict-mcp-config', '--mcp-config', mcpFile,
      '--allowedTools', 'mcp__jev', '--settings', '{"disableAllHooks":true}', '--disable-slash-commands',
      '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--max-budget-usd', '1'];
    const r = spawnSync(CLAUDE, args, { cwd: project, env: { ...base, JEV_BRIDGE_HOME: join(home, '.jev-bridge') },
      encoding: 'utf8', maxBuffer: 64 << 20, timeout: 300_000 });
    const recs = (r.stdout ?? '').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
    const init = recs.find((x) => x.type === 'system' && x.subtype === 'init');
    const final = recs.find((x) => x.type === 'result');
    const blocks = (type, role) => recs.filter((x) => x.type === role && Array.isArray(x.message?.content))
      .flatMap((x) => x.message.content.filter((b) => b.type === type));
    const uses = blocks('tool_use', 'assistant');
    const results = blocks('tool_result', 'user');
    const ask = uses.find((u) => u.name === 'mcp__jev__jev_ask');
    const answer = results.find((x) => x.tool_use_id === ask?.id);
    // The result arrives as blocks: a line for the resource link, then the answer's JSON.
    const parts = Array.isArray(answer?.content) ? answer.content.map((c) => c.text ?? '') : [String(answer?.content ?? '')];
    const text = parts.join('\n');
    const asked = parts.flatMap((p) => { try { return [JSON.parse(p)]; } catch { return []; } }).find((o) => o?.answers) ?? null;
    const jev = init?.mcp_servers?.find((s) => s.name === 'jev');
    const lines = [
      `Claude Code ${init?.claude_code_version ?? '?'} · ${init?.model ?? '?'} · MCP server jev: ${jev?.status ?? 'absent'}`,
      `jev tools offered: ${(init?.tools ?? []).filter((t) => /jev/.test(t)).join(', ')}`,
      `tools Claude called: ${uses.map((u) => u.name).join(', ') || 'none'}`,
      '',
      '── the request Claude wrote ──',
      JSON.stringify(ask?.input ?? null, null, 2),
      '',
      '── what Jev answered ──',
      asked?.answers ? render(ask.input.questions, asked.answers) : text.slice(0, 2000),
      asked?.bridge ? `${asked.model} · ${asked.bridge.latency_ms} ms · $${asked.bridge.cost_usd.toFixed(7)} · cached: ${asked.bridge.cached}` : '',
      '',
      '── Claude\'s reply ──',
      final?.result ?? '(none)',
      '',
      `${final?.num_turns ?? '?'} turns · ${((final?.duration_ms ?? 0) / 1000).toFixed(1)} s · $${(final?.total_cost_usd ?? 0).toFixed(4)} of Claude`,
    ];
    step({ heading, title: 'Ask for it in plain language, in a real Claude Code session',
      shown: 'claude', typed: readmeBlock(heading, 'text'),
      ran: 'claude -p "<that prompt>" --model sonnet --strict-mcp-config --mcp-config <the jev entry claude mcp add wrote> '
        + '--allowedTools mcp__jev --settings \'{"disableAllHooks":true}\' --disable-slash-commands --output-format stream-json --verbose',
      code: r.status, out: lines.join('\n') + '\n',
      checks: [check('the session exits 0', r.status === 0 && final?.is_error === false),
        check('Claude Code connected to jev', jev?.status === 'connected'),
        check('Claude called jev_ask', Boolean(ask)),
        check('jev_ask returned answers, not an error', answer && !answer.is_error && asked?.answers && Object.keys(asked.answers).length > 0)] });
  }

  // ── Cost and usage, and the call history ──
  {
    const heading = '## Cost and usage';
    const block = readmeBlock(heading, 'bash');
    const r = sh(block, { cwd: clone });
    const h = sh('node src/server.mjs --history 7', { cwd: clone });
    let stats = null;
    let history = null;
    try { stats = jsonTail(r.out); history = jsonTail(h.out); } catch { /* reported by the checks */ }
    const calls = (history?.calls ?? []).map((c) => `${c.id}  ${String(c.client ?? '—').padEnd(18)} ${c.cached ? 'cached' : 'live  '}  status ${c.status}`);
    step({ heading, title: 'Usage, and who made each call', shown: `${block}\nnode src/server.mjs --history 7`, code: r.code,
      out: `${r.out}$ node src/server.mjs --history 7   # the calls, one per line\n${calls.join('\n')}\n`,
      checks: [check('both live calls were recorded: --selftest and the session', stats?.live_calls >= 2),
        check('the history files the session\'s call under claude-code', (history?.calls ?? []).some((c) => c.client === 'claude-code'))] });
  }

  // ── Other MCP clients ──
  {
    const heading = '## Other MCP clients';
    const block = readmeBlock(heading, 'json');
    const cfg = JSON.parse(block.replaceAll('/absolute/path/to/jev-bridge', clone)).mcpServers.jev;
    const client = await connect(cfg.command, cfg.args, { env: sandboxEnv, cwd: project });
    const { tools } = await client.request('tools/list');
    await client.close();
    const names = tools.map((t) => t.name);
    step({ heading, title: 'Launch it from the JSON other clients use', shown: block, shownLang: 'json',
      ran: 'the command and args from that JSON, launched over stdio: initialize, then tools/list', code: 0,
      out: `serverInfo: ${JSON.stringify(client.init.serverInfo)}\nprotocolVersion: ${client.init.protocolVersion}\ntools: ${names.join(', ')}\n`,
      checks: [check('the server answers initialize', client.init.protocolVersion === '2025-11-25'),
        check('all five tools are listed', TOOLS.every((t) => names.includes(t)))] });
  }

  // ── Updating ──
  {
    const shown = inReadme('git -C /path/to/jev-bridge pull');
    const r = sh(shown.replace('/path/to/jev-bridge', clone));
    step({ heading: '## Install', title: 'Update', shown, ...r,
      checks: [check('git pull succeeds', r.code === 0)] });
  }
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

// ── The report ──
const version = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' }).stdout?.trim().split('\n')[0] ?? '?';
const os = platform() === 'darwin' ? `macOS ${version('sw_vers', ['-productVersion'])}` : `${platform()} ${release()}`;
const checks = steps.flatMap((s) => s.checks);
const passed = checks.filter((c) => c.ok).length;
const installed = redact(steps.find((s) => s.title === 'Clone')?.out.split('\n').at(-2) ?? '?');
const md = [
  '# The install guide, followed',
  '',
  `Every step of the [README](../README.md#install)'s install guide, run as written on ${new Date().toISOString().slice(0, 10)} `
    + 'by a new user with an empty home directory. **Generated by [`install.mjs`](install.mjs); do not edit by hand.**',
  '',
  `**${passed} of ${checks.length} checks passed** over ${steps.length} steps.`,
  '',
  '| | |',
  '| --- | --- |',
  `| Machine | ${os}, ${arch()} |`,
  `| Node | ${process.version} |`,
  `| git | ${version('git', ['--version']).replace('git version ', '')} |`,
  `| Claude Code | ${version(CLAUDE, ['--version'])} |`,
  `| Installed | \`${installed}\`, cloned from ${SOURCE_SHOWN} |`,
  '',
  '**How it was run.** A temporary directory stood in for a new machine: `~` below is its home directory, empty at the start, '
    + 'and `<clone>` is where the repository was cloned. Each command was read out of the README and run as a shell would. '
    + 'The key was written where Option A puts it, and is shown as `<key>`. '
    + 'The Claude Code session is the one step with this machine\'s real home directory, since that is where Claude Code keeps its login. '
    + 'It was given only the `jev` entry that `claude mcp add` wrote (`--strict-mcp-config`), with hooks and skills turned off, and '
    + 'the server kept its data in the sandbox (`JEV_BRIDGE_HOME`). In an interactive session Claude Code asks before a tool runs; '
    + '`--allowedTools mcp__jev` answers yes in advance. The sandbox, and the copy of the key in it, were deleted at the end.',
  '',
  '| Step | README section | Checks |',
  '| --- | --- | --- |',
  ...steps.map((s, i) => `| ${i + 1}. ${s.title} | [${s.heading.replace(/^#+ /, '')}](../README.md#${anchor(s.heading)}) `
    + `| ${s.checks.every((c) => c.ok) ? '✔' : '✗'} ${s.checks.filter((c) => c.ok).length}/${s.checks.length} |`),
  '',
];
steps.forEach((s, i) => {
  md.push(`## ${i + 1}. ${s.title}`, '', `README: [${s.heading.replace(/^#+ /, '')}](../README.md#${anchor(s.heading)})`, '');
  if (s.shownLang === 'json') md.push('```json', s.shown, '```', '');
  else md.push('```console', ...s.shown.split('\n').map((l) => (l.startsWith('#') || l === '' ? l : `$ ${l}`)), '```', '');
  if (s.typed) md.push('Then, in the session:', '', '```text', s.typed, '```', '');
  if (s.ran) md.push(`Ran: ${redact(s.ran)}`, '');
  md.push('```text', redact(s.out).trimEnd() || '(no output)', '```', '');
  if (s.code !== 0 && s.code !== null) md.push(`Exit code ${s.code}.`, '');
  for (const c of s.checks) md.push(`- ${c.ok ? '✔' : '✗'} ${c.label}`);
  md.push('');
});
md.push('## Reproduce', '', '```bash',
  'node evidence/install.mjs                 # from GitHub: needs git, a logged-in claude and a TypeSafe key',
  'node evidence/install.mjs --source .      # from this checkout\'s committed HEAD instead',
  '```', '');
const report = md.join('\n');
if (report.includes(key) || report.includes(key.slice(0, 8))) throw new Error('refusing to write a report that contains the key');
writeFileSync(join(HERE, 'install.md'), report);
process.stdout.write(`wrote evidence/install.md: ${passed}/${checks.length} checks passed over ${steps.length} steps\n`);
if (passed !== checks.length) process.exitCode = 1;
