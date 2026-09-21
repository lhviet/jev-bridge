# jev-bridge

**Let Claude Code ask TypeSafe's Jev a question, and get a probability back.**

A zero-dependency [MCP](https://modelcontextprotocol.io) server for
[TypeSafe](https://typesafe.ai)'s System One model, Jev. It gives Claude Code — or
any MCP client — calibrated, typed judgments: yes/no probabilities, one-of-N
choices and graded scores, instead of generated prose. Repeated questions are
answered from a local cache for free, and every call's cost is recorded.

[![CI](https://github.com/lhviet/jev-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/lhviet/jev-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A518-43853d.svg)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)

```text
state:  "Help! My payouts have been failing for 3 days."
ask:    Which team should handle this?

        billing    ████████████████████  0.87
        technical  ███                   0.13
        sales      ·                     0.00      confidence 0.80 · $0.0000168
```

> jev-bridge is an independent project. It is not affiliated with or endorsed by
> TypeSafe AI.

---

## Contents

- [Why this exists](#why-this-exists)
- [Prerequisites](#prerequisites)
- [Install](#install)
- [Configure your API key](#configure-your-api-key)
- [Connect it to Claude Code](#connect-it-to-claude-code)
- [Other MCP clients](#other-mcp-clients)
- [Check it works](#check-it-works)
- [Using it](#using-it)
- [Tools](#tools)
- [Caching](#caching)
- [Cost and usage](#cost-and-usage)
- [Configuration](#configuration)
- [Where your data lives](#where-your-data-lives)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Related projects](#related-projects)
- [Licence](#licence)

## Why this exists

TypeSafe publishes a Claude Code plugin, `typesafe@typesafe-ai`. It is a
*skill*: six files, 14 KB, and not one byte of executable code. It teaches an
agent how to write a good Jev question — but it has no way to send one. A skill
is text loaded into the model's context; it cannot hold an API key or open a
socket.

jev-bridge is the missing wire. It runs as a small child process that Claude
Code talks to over stdin and stdout, and it is the only thing that reaches the
TypeSafe API. It works well **alongside** the plugin: the skill teaches the
agent to design questions, and jev-bridge lets it ask them.

**Features**

- **Three tools** — `jev_ask`, `jev_usage`, `jev_models`.
- **Typed output** — `jev_ask` declares an MCP `outputSchema` and returns
  `structuredContent`.
- **An answer cache** — a repeated question returns in about 0.08 ms instead of
  about 180 ms, and costs nothing.
- **Cost accounting** — tokens, cost, latency and outcome for every call.
- **Zero dependencies** — Node built-ins only, SQLite included.
- **Degrades instead of failing** — on a Node without SQLite it caches in memory.

## Prerequisites

You need three things.

### 1. Node.js 18 or newer — 22.5+ recommended

```bash
node --version
```

jev-bridge runs on any Node from 18. The **persistent** cache uses
[`node:sqlite`](https://nodejs.org/api/sqlite.html), which arrived in Node 22.5;
on older versions everything still works, but the cache lasts only as long as
the session. The current LTS is the simplest choice.

If you need to install or upgrade Node:

```bash
# with nvm (https://github.com/nvm-sh/nvm)
nvm install --lts

# or with Homebrew on macOS
brew install node
```

Or download it from [nodejs.org](https://nodejs.org).

### 2. A TypeSafe API key

Create one in the [TypeSafe console](https://console.typesafe.ai/keys). You can
try Jev without any code in the
[Playground](https://console.typesafe.ai/playground) first.

### 3. An MCP client

These instructions use [Claude Code](https://claude.com/claude-code). jev-bridge
is a standard stdio MCP server, so Claude Desktop, Cursor, and other MCP clients
work too — see [Other MCP clients](#other-mcp-clients).

## Install

```bash
git clone https://github.com/lhviet/jev-bridge.git
cd jev-bridge
```

That is the whole installation. There is **no `npm install` step**, because
there are no dependencies. Optionally, run the tests:

```bash
npm test
```

Note the absolute path of the server — you will need it in a moment:

```bash
echo "$(pwd)/src/server.mjs"
```

## Configure your API key

There are two ways. The first is recommended.

### Option A — a key file (recommended)

```bash
mkdir -p ~/.jev-bridge && chmod 700 ~/.jev-bridge
printf 'TYPESAFE_API_KEY=%s\n' 'your-key-here' > ~/.jev-bridge/.env
chmod 600 ~/.jev-bridge/.env
```

This keeps the secret **out of your MCP client's configuration file** — a file
people often sync between machines, paste into issues, or commit to dotfile
repositories. jev-bridge reads the key fresh on every call, so rotating it is a
one-file edit and needs no restart.

### Option B — an environment variable

Pass `TYPESAFE_API_KEY` through your client's configuration, shown in the next
section. Simpler, but the key then sits in that config file in plain text.

## Connect it to Claude Code

```bash
claude mcp add --scope user jev -- node /absolute/path/to/jev-bridge/src/server.mjs
```

- `--scope user` makes it available in **every** project. Use `--scope project`
  to share it with one repository through its `.mcp.json`, or omit `--scope`
  to add it to the current project only.
- If you chose Option B, add the key with `-e`:

  ```bash
  claude mcp add --scope user jev -e TYPESAFE_API_KEY=your-key-here \
    -- node /absolute/path/to/jev-bridge/src/server.mjs
  ```

> **Use nvm, or have several Node versions installed?** Give Claude Code the
> absolute path to the interpreter, not bare `node`. Otherwise the server runs
> on whichever Node is first on `PATH` when Claude Code starts — possibly an
> old one without SQLite.
>
> ```bash
> claude mcp add --scope user jev -- "$(which node)" /absolute/path/to/jev-bridge/src/server.mjs
> ```

## Other MCP clients

Any client that launches stdio servers can use the same command. The usual JSON
shape — for Claude Desktop's `claude_desktop_config.json`, Cursor's
`.cursor/mcp.json`, and similar:

```json
{
  "mcpServers": {
    "jev": {
      "command": "node",
      "args": ["/absolute/path/to/jev-bridge/src/server.mjs"]
    }
  }
}
```

With Option B, add `"env": { "TYPESAFE_API_KEY": "your-key-here" }` beside
`args`.

## Check it works

**1. Call the API directly.** This bypasses the cache and proves the key is good:

```bash
node src/server.mjs --selftest
```

You should see `key: loaded (…)` followed by a JSON answer from `jev-1.13.0`.

**2. Check Claude Code can reach the server:**

```bash
claude mcp list
```

```text
jev: node /…/jev-bridge/src/server.mjs - ✔ Connected
```

**3. Start a new Claude Code session.** A session that was already running
when you added the server fixed its tool list at startup and will not see it.

## Using it

Ask for it in plain language. Claude Code writes the request:

```text
Use jev_ask to decide whether this support message is urgent and which team
should handle it: "Help! My payouts have been failing for 3 days."
```

### The three question types

| Type | Ask it when | You get back |
| --- | --- | --- |
| `noul` | A condition either holds or it doesn't | One probability from 0 to 1. **0.5 means genuinely torn**, not "medium". |
| `choice` | Exactly one option from a set you define | The winner, the full distribution, and a confidence. |
| `score` | A degree along a rubric you describe | A weighted position that can land *between* your levels, plus the distribution. |

### A complete request

```json
{
  "state": "Help! My payouts have been failing for 3 days.",
  "questions": {
    "is_urgent":   { "type": "noul",   "instructions": "Does this convey urgency?" },
    "department":  { "type": "choice", "instructions": "Which team should handle this?",
                     "criteria": { "billing": "Payments, invoicing, refunds",
                                   "technical": "Bugs, outages, integrations",
                                   "sales": "Pricing, upgrades" } },
    "frustration": { "type": "score",  "instructions": "How frustrated is the customer?",
                     "criteria": ["Calm", "Frustrated", "Very angry"] }
  }
}
```

```json
{
  "model": "jev-1.13.0",
  "answers": {
    "is_urgent":   { "type": "noul", "noul": 0.95 },
    "department":  { "type": "choice", "choice": "billing", "confidence": 0.8,
                     "probabilities": { "billing": 0.87, "technical": 0.13, "sales": 0 } },
    "frustration": { "type": "score", "score": 1.05, "confidence": 0.92,
                     "legend": { "0": "Calm", "1": "Frustrated", "2": "Very angry" },
                     "probabilities": { "0": 0, "1": 0.95, "2": 0.05 } }
  },
  "usage": { "input_tokens": 399, "output_tokens": 73 },
  "bridge": { "cached": false, "latency_ms": 184, "cost_usd": 0.0000168 }
}
```

### Getting good answers

- **Batch independent questions into one call.** Jev reads the state once and
  answers every question in parallel — cheaper and faster than separate calls.
- **Use one `noul` per label** when several can be true at once. A `choice`
  forces a single winner and discards the rest.
- **Include a no-match option** in a `choice` when nothing may fit, or the model
  is forced to pick a wrong answer confidently.
- **Question ids are not sent to the model.** Put the full meaning in
  `instructions`.
- **Keep policy in your code.** Take the probabilities and apply your own
  thresholds; changing a threshold then costs nothing.

**[docs/recipes.md](docs/recipes.md)** has six worked patterns with real output —
routing, reranking, claim verification, multi-label triage, extraction by
selection, and composite scoring.

## Tools

### `jev_ask`

Evaluate a `state` against typed questions.

| Input | Required | Description |
| --- | --- | --- |
| `state` | yes | Text, or a JSON object or array. Text only — no images or binaries. |
| `questions` | yes | A map of your own ids to `{ type, instructions, criteria }`. |
| `model` | no | Model or alias. Defaults to `jev-latest`. |
| `cache` | no | `false` forces a live call and refreshes the stored answer. |

Returns `model`, `answers`, `usage`, and a `bridge` object: `cached`,
`latency_ms`, and `cost_usd` — what **this** call cost, which is `0` on a hit.
On a cache hit, `usage` describes the original call.

### `jev_usage`

Calls, cache hits, hit rate, tokens, cost, money saved by the cache, and a
per-day breakdown. Input: `days` (default 7).

### `jev_models`

The model names and aliases your account may use. Also a cheap way to check a key.

## Caching

A repeated question is answered from `~/.jev-bridge/jev.db` without touching
the network.

- **What makes two requests "the same":** the state, the model, and the
  *meaning* of each question. **Question ids are deliberately ignored.**
  TypeSafe never sends them to the model, and an agent invents a fresh id every
  run — so `{"urgency": q}` and `{"urgency_check": q}` share one cache entry,
  and the answer comes back under whichever id you used.
- **Object key order does not matter; array order does.** The levels of a
  `score` are ordered, and reversing them is a different question.
- **Entries expire after 7 days** and the least-recently-used are evicted past
  20,000 entries.
- **A moved alias invalidates itself.** Each entry records which model answered
  it. When `jev-latest` starts resolving to a newer version, older entries stop
  being served.
- **Failures are never cached.** Only a successful answer is stored.

**A note on determinism.** Jev's *decisions* are stable across repeated calls,
but its probabilities vary slightly — about ±0.02 in the second decimal. A
cached answer freezes one sample of that. Pass `"cache": false` when you are
measuring rather than deciding.

**Expect hits within a session, and from code that sends a fixed question.**
Across separate agent sessions the model tends to rephrase, and a genuinely
different question is correctly a miss.

## Cost and usage

Jev bills input tokens only; output is free. At the published price of $0.042
per million input tokens, a typical 400-token call costs about **$0.000017** —
roughly 60,000 calls to the dollar.

Ask Claude Code to run `jev_usage`, or use the command line:

```bash
node src/server.mjs --stats 7
```

```json
{
  "calls": 24, "live_calls": 3, "cache_hits": 21, "hit_rate": 0.875,
  "input_tokens": 1197, "cost_usd": 0.00005027,
  "saved_input_tokens": 8379, "saved_usd": 0.00035192
}
```

## Configuration

Everything is optional.

| Variable | Default | Purpose |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | — | The API key, if not using a key file. |
| `TYPESAFE_API_KEY_FILE` | — | Read the key from this file instead. |
| `JEV_BRIDGE_HOME` | `~/.jev-bridge` | Where the key file and database live. |
| `TYPESAFE_DB` | `$JEV_BRIDGE_HOME/jev.db` | The database path. |
| `TYPESAFE_MODEL` | `jev-latest` | Default model. Pin a version such as `jev-1.13.0` if you tune thresholds against it. |
| `TYPESAFE_CACHE_TTL_DAYS` | `7` | How long an answer stays fresh. |
| `TYPESAFE_CACHE_MAX` | `20000` | Cache entries kept before eviction. |
| `TYPESAFE_USD_PER_MTOK` | `0.042` | Price used to compute cost. |
| `TYPESAFE_TIMEOUT_MS` | `60000` | Per-request timeout. |
| `TYPESAFE_API_URL` | `https://api.typesafe.ai/v1` | API base URL. |

The key is looked up in this order: `TYPESAFE_API_KEY`,
`TYPESAFE_API_KEY_FILE`, `~/.jev-bridge/.env`, then a `.env` at the repository
root.

## Where your data lives

| Path | Contents |
| --- | --- |
| `~/.jev-bridge/` | Created with mode `0700`. |
| `~/.jev-bridge/.env` | Your API key, if you used Option A. |
| `~/.jev-bridge/jev.db` | Cached answers and the usage log. |

The database stores **answers**, keyed by a hash of the request, plus token
counts, costs and timings. It **does not store your `state` or your
questions** — the hash cannot be reversed into them. Your key is sent only to
the TypeSafe API and is never logged. See [SECURITY.md](SECURITY.md).

## Troubleshooting

**`claude mcp list` shows the server as failed.** Run the command it shows by
hand — `node /path/to/src/server.mjs --version` — to see the real error. The
usual causes are a wrong path or a `node` that is not on Claude Code's `PATH`.
Use absolute paths for both.

**The tools do not appear in Claude Code.** Start a new session. A running
session fixed its tool list at startup.

**`TypeSafe API returned 401`.** The key is missing or rejected. Run
`--selftest`: it prints which key it loaded, by length and first eight
characters.

**The log says `node:sqlite unavailable`.** Your Node is older than 22.5.
Everything works, but the cache is in memory and resets each session. Upgrade
Node, or register the server with the absolute path of a newer one.

**`429` or `529` errors.** jev-bridge already retries these with backoff. If
they persist, you are over your rate limit or TypeSafe is under load.

**Answers seem stale.** Pass `"cache": false` for one call, or clear the cache:

```bash
node src/server.mjs --clear-cache
```

## Development

```bash
npm test          # the full suite, on the built-in node --test runner
npm run selftest  # one live call against the real API
npm run stats     # usage over the last 7 days
```

```text
jev-bridge/
├── src/
│   ├── server.mjs        MCP protocol, the three tools, CLI, retries
│   └── store.mjs         SQLite cache and usage log, memory fallback
├── test/
│   └── server.test.mjs   35 tests
└── docs/
    ├── recipes.md        six worked patterns with real output
    └── explainer.html    an illustrated walkthrough of the design
```

Only the TypeSafe API is faked in tests. SQLite, the MCP protocol and
multi-process database contention run for real. See
[CONTRIBUTING.md](CONTRIBUTING.md) — in particular, the project takes **no
runtime dependencies**.

## Related projects

- **[typesafe-ai/skills](https://github.com/typesafe-ai/skills)** — TypeSafe's
  official Claude Code skill. It teaches an agent to design Jev questions;
  jev-bridge lets the agent send them. They complement each other.
- **[rashedInt32/jev-mcp](https://github.com/rashedInt32/jev-mcp)** — another
  Jev MCP server, built on the official TypeSafe and MCP SDKs, with a
  file-reading triage tool. Choose it if you want those; choose jev-bridge if
  you want no dependencies, an answer cache and cost tracking.
- **[TypeSafe documentation](https://docs.typesafe.ai)** — the API, the
  question types, and cookbooks.

## Licence

[MIT](LICENSE) © 2026 Hoang Viet Le.

"TypeSafe" and "Jev" are names belonging to TypeSafe AI, used here only to
describe what this project connects to.
