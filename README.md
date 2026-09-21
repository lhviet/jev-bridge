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
- [How it works](#how-it-works)
- [Use cases](#use-cases)
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
- [Call history](#call-history)
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

```text
typesafe@typesafe-ai 0.5.7
├── .claude-plugin/
│   ├── marketplace.json      382 B
│   └── plugin.json           320 B
├── skills/typesafe-ai/
│   ├── LICENSE              1068 B   identical to the LICENSE below
│   └── SKILL.md            10040 B   the whole product: guidance for the agent
├── LICENSE                  1068 B
└── README.md                1336 B

6 files · 14,214 bytes · 0 bytes executable
```

jev-bridge is the missing wire. It runs as a small child process that Claude
Code talks to over stdin and stdout, and it is the only thing that reaches the
TypeSafe API. It works well **alongside** the plugin: the skill teaches the
agent to design questions, and jev-bridge lets it ask them.

**Features**

- **Five tools** — `jev_ask`, `jev_usage`, `jev_history`, `jev_review`, `jev_models`.
- **Typed output** — `jev_ask` declares an MCP `outputSchema` and returns
  `structuredContent`.
- **An answer cache** — a repeated question returns in about 0.08 ms instead of
  about 180 ms, and costs nothing.
- **Cost accounting** — tokens, cost, latency and outcome for every call.
- **A call history you can review** — what was asked, what came back, how long
  it took and whether it was right, in a local dashboard (`--ui`). Written after
  each answer has gone back, so it costs the answer nothing.
- **Zero dependencies** — Node built-ins only, SQLite included.
- **Degrades instead of failing** — on a Node without SQLite it caches in memory.

## How it works

jev-bridge is a **child process, not a service**. Your MCP client starts it and
talks to it over stdin and stdout; it opens no port and exits with the session.
(The history dashboard is a separate command you start yourself, and it listens
only on 127.0.0.1.)
The only thing that leaves your machine is a cache miss.

```mermaid
flowchart TB
  subgraph MAC["Your machine"]
    direction TB
    CC("Claude Code<br/>or any MCP client")
    SRV["jev-bridge<br/>child process, stdio only"]
    KEY[("API key<br/>~/.jev-bridge/.env · 0600")]
    DB[("jev.db<br/>answers, usage, history")]
    CC <== "JSON-RPC over<br/>stdin and stdout" ==> SRV
    KEY -. "read per call" .-> SRV
    SRV <== "cache hit, about 0.08 ms" ==> DB
  end

  subgraph ANT["Anthropic"]
    MODEL("Claude<br/>decides when to ask")
  end

  subgraph TS["TypeSafe"]
    API(["api.typesafe.ai/v1"]) --> JEV{{"Jev"}}
  end

  CC <-- "conversation and<br/>tool results" --> MODEL
  SRV -- "cache miss only<br/>HTTPS + Bearer" --> API

  classDef client fill:#ede9fe,stroke:#7c3aed,color:#3b0764
  classDef bridge fill:#dbeafe,stroke:#2563eb,color:#1e3a8a,stroke-width:2px
  classDef store fill:#dcfce7,stroke:#16a34a,color:#14532d
  classDef secret fill:#fee2e2,stroke:#dc2626,color:#7f1d1d,stroke-width:2px
  classDef external fill:#ffedd5,stroke:#ea580c,color:#7c2d12
  classDef jev fill:#ffedd5,stroke:#ea580c,color:#7c2d12,stroke-width:2px
  class CC,MODEL client
  class SRV bridge
  class DB store
  class KEY secret
  class API external
  class JEV jev
  style MAC fill:#2563eb12,stroke:#2563eb,stroke-dasharray:6 4
  style ANT fill:#7c3aed12,stroke:#7c3aed,stroke-dasharray:6 4
  style TS fill:#ea580c12,stroke:#ea580c,stroke-dasharray:6 4
  linkStyle 0 stroke:#2563eb,stroke-width:2px
  linkStyle 1 stroke:#dc2626,stroke-width:2px
  linkStyle 2 stroke:#16a34a,stroke-width:3px
  linkStyle 3 stroke:#ea580c
  linkStyle 4 stroke:#7c3aed
  linkStyle 5 stroke:#ea580c,stroke-width:2px
```

Three trust zones. The key is read on your machine and attached only to a
request bound for TypeSafe — it never travels to Anthropic, and it is never
written into a config file. A repeated question never leaves your machine at all.

### One request, start to finish

```mermaid
sequenceDiagram
  autonumber
  box rgba(37,99,235,0.08) Your machine
    participant C as Claude Code
    participant B as jev-bridge
    participant D as jev.db
  end
  box rgba(234,88,12,0.08) TypeSafe
    participant T as api.typesafe.ai
  end

  C->>B: tools/call jev_ask {state, questions}
  B->>B: validate every question
  Note right of B: a malformed question stops here,<br/>naming its own field, at no cost
  B->>B: fingerprint the questions (ids excluded)
  B->>D: look up state + questions + model

  alt a fresh answer is stored for the same model
    rect rgba(22,163,74,0.14)
      D-->>B: answers
      B->>D: log a hit, 0 tokens
      B-->>C: answers · cached: true · about 0.08 ms
    end
  else nothing usable is stored
    rect rgba(234,88,12,0.12)
      B->>T: POST /v1/systemone with Bearer key
      opt 429 or 529
        T-->>B: rate limited or overloaded
        B->>B: back off, honouring retry-after, then retry
      end
      T-->>B: 200 · answers and usage
      B->>D: store the answers, log tokens and cost
      B-->>C: answers · cached: false · about 180 ms
    end
  end
```

Three things happen before any network call: every question is checked, the
questions are fingerprinted by their meaning rather than their ids, and the
cache is consulted. Only a successful answer is ever stored, so a transient
failure can never be served back to you as a cached one.

### Reading the diagrams

Every diagram in this repository uses the same vocabulary. **Shape** says what a
thing is; **colour** says whose it is.

| Colour | Shape | Means |
| --- | --- | --- |
| 🟦 blue | rectangle | jev-bridge — code that runs on your machine |
| 🟪 violet | rounded box | an MCP client, or Claude |
| 🟩 green | cylinder | stored data — the answer cache, usage log and call history |
| 🟥 red | cylinder | your API key |
| 🟧 orange | pill · hexagon | TypeSafe's API · Jev making a judgment |
| 🟨 yellow | parallelogram | input you supply |
| ⬜ grey | rectangle | your own code |

Lines are coloured by what they carry: **green** is a cache hit, **orange** is a
trip to TypeSafe, **red** is the key being read. A dashed outline marks a trust
zone — a boundary your data crosses.

**Going deeper:** components, the storage decision, the database schema, how
cache keys work and how it is tested are in
**[docs/architecture.md](docs/architecture.md)**.

## Use cases

Six patterns, each shown with the **real** output it produced from
`jev-1.13.0`. All six together ran in 1.3 seconds and cost $0.000162. Each links
to its full request in [docs/recipes.md](docs/recipes.md).

### Route a request and fill its arguments in one trip

Choose the handler **and** the arguments every branch would need, in parallel. Your code takes one branch and reads only its answers.

> "Can you refund my last order? The mug arrived cracked and I have photos."

```text
handler        choice  ████████████████████  issue_refund  confidence 1.00
refund_reason  choice  ████████████████████  damaged       confidence 1.00
has_evidence   noul    ███████████████████▊  0.99
needs_human    noul    ████                  0.20
```

A router and its arguments in one round trip: 233 ms, $0.000022. [Full request →](docs/recipes.md#1-route-a-request-and-fill-its-arguments-in-one-trip)

### Rerank what your search returned

Retrieval returns candidates but cannot tell which one answers the question. Give each its own comparable `score` against the query, then sort in code.

> "How do I rotate the API key without downtime?"

```text
How well does each passage answer the query?   (score, 0–3)

b  ███████████████████▉  2.99  ← answers the query
c  ███████▏              1.06  ← on topic, but never answers it
d  ▋                     0.10
a  ▍                     0.06
```

Passage **c** is *about* API keys and never answers the question. A keyword search would have ranked it first. [Full request →](docs/recipes.md#2-rerank-what-your-search-returned)

### Check a claim against its evidence

The guard in front of anything a language model asserts. Ask about support and contradiction **separately** — they are different failures.

> claim: "The free plan includes 10 GB of storage."  
source: "Free accounts may store up to 2 GB…"

```text
supported     noul  ▎                     0.01
contradicted  noul  ███████████████████   0.95  ← the source says otherwise
```

Not merely unsupported: contradicted. That is the case to escalate rather than quietly drop. [Full request →](docs/recipes.md#3-check-a-claim-against-its-evidence)

### Apply labels that can all be true at once

Reach for one `noul` per label, not a `choice` — a choice forces a single winner and would throw three true facts away.

> "Third time this week the export button does nothing. I am on the Pro plan paying $40/mo and I want a refund if this is not fixed today."

```text
reports_bug       noul  ███████████████████▍  0.97
mentions_billing  noul  ███████████████████▊  0.99
requests_refund   noul  ███████████████████▍  0.97
churn_risk        noul  █████████████████▋    0.88  ← inferred rather than stated
```

All four are true, in one sentence. [Full request →](docs/recipes.md#4-apply-labels-that-can-all-be-true-at-once)

### Let code find candidates, and Jev pick the right one

Do not ask a model to *extract* a date — ask it to *choose* one. A regular expression finds every candidate; only the choice needs judgment, and the value you copy is guaranteed to be in the text.

> "Ordered 3 Jan, dispatched 5 Jan, and it should reach you by 11 Jan. Returns close 25 Jan."

```text
Which candidate is the expected DELIVERY date?   (choice)

11 Jan  ████████████████████  1.00  the delivery date
3 Jan   ·                     0.00  ordered
5 Jan   ·                     0.00  dispatched
25 Jan  ·                     0.00  returns close
none    ·                     0.00
```

The three decoy dates land at zero. Always offer a `none`, or a list that misses the answer forces a confident wrong pick. [Full request →](docs/recipes.md#5-let-code-find-candidates-and-jev-pick-the-right-one)

### Score dimensions once, decide the policy in code

Keep judgment and policy apart. Jev rates each dimension; your code weights them — so changing a weight costs nothing and needs no new call.

> A pull request description, in full: "Fixes the thing. See ticket."

```text
clarity      score 0–3  ▍                     0.05  confidence 0.95
testability  score 0–2  ██                    0.20  confidence 0.69  ← least certain answer here
```

In code, `0.6 × clarity/3 + 0.4 × testability/2 = 0.05`. The 0.69 confidence is the model saying there is little to judge. [Full request →](docs/recipes.md#6-score-dimensions-once-decide-the-policy-in-code)

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

See [Use cases](#use-cases) for six patterns with real output, and
[docs/recipes.md](docs/recipes.md) for each full request.

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
`latency_ms`, `cost_usd` — what **this** call cost, which is `0` on a hit — and
`call_id`, which names the call in the history. On a cache hit, `usage`
describes the original call.

### `jev_usage`

Calls, cache hits, hit rate, tokens, cost, money saved by the cache, and a
per-day breakdown. Input: `days` (default 7).

### `jev_history`

Looks back at earlier calls. With no `id`, it returns stats for the period and
the matching calls, each with the start of its state and its answers on one
line. With `id`, it returns that call in full: state, questions, answers,
timing, cost and review. Read-only.

| Input | Default | Description |
| --- | --- | --- |
| `id` | — | A `bridge.call_id`. Returns that one call in full. |
| `days` | `7` | How far back to look. |
| `filter` | `all` | `all`, `live`, `cached`, `errors`, `uncertain`, `slow`, `unreviewed`, `reviewed`, `correct`, `partial`, `incorrect`. |
| `below` | `0.6` | The certainty cut for `uncertain`. |
| `q` | — | Only calls whose state or answers contain this text. |
| `limit` | `20` | Most calls to list. |

### `jev_review`

Records whether a past call was right: `verdict` is `correct`, `partial` or
`incorrect` (or `null` to withdraw a review). Optional `expected` records what
the answers should have been, by question id, and `note` says why. Claude can
call it itself when you correct an answer, or you can review in the
[dashboard](#call-history).

### `jev_models`

The model names and aliases your account may use. Also a cheap way to check a key.

## Caching

A repeated question is answered from `~/.jev-bridge/jev.db` without touching
the network.

| | Live call | Cached |
| --- | --- | --- |
| Latency | 184 ms (average of 3) | **0.077 ms** (median of 20) |
| Cost | about $0.000017 | **$0** |
| Leaves your machine | yes | no |

That is roughly **2,370× faster** on a repeat.

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

Why ids are excluded — and how a real Claude Code session exposed the cache
missing almost every time before they were — is told in
[docs/architecture.md](docs/architecture.md#cache-keys).

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

## Call history

Every `jev_ask` — answered live, from the cache, rejected, or timed out — is
kept for review, so you can come back later and ask two questions of it:
**was it efficient**, and **was it right**.

```bash
node src/server.mjs --ui
```

That opens a dashboard in your browser. It shows:

- **Speed and cost:** typical and 95th-percentile latency of live calls, the
  cache hit rate, what was spent, and a dot per live call over time. Failed
  calls and calls that were retried after a rate limit stand out.
- **Batching:** *re-sent states* counts live calls that sent a state already
  sent earlier. Their questions could have gone in the earlier call, which
  would have been cheaper and faster.
- **Certainty:** each call is scored by its **least** sure answer — a `choice`
  or `score` by Jev's own confidence, a `noul` by its distance from 0.5 (so
  0.5 is 0, and 0.95 is 0.9). The *Least certain* filter lists the calls most
  worth a second look first.
- **Accuracy:** open a call to see the state, every question, and each answer
  as bars. Mark it *Correct*, *Partly right* or *Wrong*, click the option that
  should have won, and add a note. Accuracy is the share of reviewed calls
  marked correct.

The same history is available to Claude through `jev_history` and
`jev_review`, and on the command line:

```bash
node src/server.mjs --history 7 uncertain   # stats and calls as JSON
node src/server.mjs --clear-history         # forget it all; the cache and usage log stay
```

**What is kept.** `TYPESAFE_HISTORY` decides:

| Mode | Keeps | Use it when |
| --- | --- | --- |
| `full` (default) | the state and questions, the answers, timing, tokens, cost | you want to judge whether answers were right |
| `meta` | answers, timing, tokens, cost, and hashes of the state and questions — **not** the state or question text | the state is sensitive, and speed and cost are what you need |
| `off` | nothing | you want no history |

Each state is stored once however often it is sent. Calls older than 30 days
are pruned, and no more than 10,000 are kept — except **reviewed calls, which
are never pruned**: they have become labelled examples.

**It does not slow calls down.** Nothing is written while a call is being
answered: records queue in memory and are written in one transaction once the
bridge has been idle for 20 ms (at most 500 ms later, or after 100 calls).
Measured end to end over MCP, against the version without history, with an
instant fake API so that only the bridge's own time shows:

| | Before | With `full` history |
| --- | --- | --- |
| Cache hit, median | 114–119 µs | 108–116 µs |
| Cache hit, 95th percentile | 0.17–0.25 ms | 0.21–0.31 ms |
| Live call, median | 450–533 µs | 437–484 µs |
| Live call, 95th percentile | 0.8–2.0 ms | 0.9–1.1 ms |

Medians are unchanged — slightly faster, since the usage log moved off the
answer's path too — and the 95th percentiles move by a tenth of a millisecond
at most. The one cost shows only in an unbroken burst of thousands of
back-to-back calls: the call that lands on a 100-call write waits for it, which
adds 2–4 ms at the 99th percentile. Against the real API the write happens
while the next call is waiting for the network, and between Claude's turns
nobody is waiting at all.

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
| `TYPESAFE_HISTORY` | `full` | `full`, `meta` or `off`: how much of each call to keep for review. See [Call history](#call-history). |
| `TYPESAFE_HISTORY_DAYS` | `30` | How long an unreviewed call is kept. |
| `TYPESAFE_HISTORY_MAX` | `10000` | Unreviewed calls kept before the oldest go. |
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
| `~/.jev-bridge/jev.db` | Cached answers, the usage log and the call history. |

The **cache** stores answers, keyed by hashes of the request, and the **usage
log** stores token counts, costs and timings. Neither holds your `state` or
your question text. The **call history** does, when `TYPESAFE_HISTORY` is
`full` — the default — because judging whether an answer was right needs what
was asked. Set it to `meta` to keep only answers, timings and hashes, or `off`
to keep nothing. Answers repeat your option names and score level labels, in
every mode. Nothing in the database leaves your machine. Your key is sent only
to the TypeSafe API and is never logged. See [SECURITY.md](SECURITY.md).

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

**The dashboard is empty.** It reads the same database as the MCP server, so
check both see the same `TYPESAFE_DB` and `JEV_BRIDGE_HOME`, and that the MCP
server was not started with `TYPESAFE_HISTORY=off`. Calls made before history
existed are not in it. Without `node:sqlite` (Node < 22.5) each process keeps
its history in memory, and the dashboard cannot see it.

**Answers seem stale.** Pass `"cache": false` for one call, or clear the cache:

```bash
node src/server.mjs --clear-cache
```

## Development

```bash
npm test          # the full suite, on the built-in node --test runner
npm run selftest  # one live call against the real API
npm run stats     # usage over the last 7 days
npm run ui        # the call-history dashboard
```

```text
jev-bridge/
├── src/
│   ├── server.mjs        MCP protocol, the five tools, CLI, retries
│   ├── store.mjs         SQLite cache, usage log and history; memory fallback
│   ├── history.mjs       certainty, filters and the stats a review reads
│   ├── ui.mjs            the dashboard's local server: token, Host check, JSON API
│   └── ui.html           the dashboard page, no network dependencies
├── test/
│   ├── server.test.mjs   36 tests
│   └── history.test.mjs  55 tests
└── docs/
    ├── architecture.md   components, storage, cache keys, testing, decisions
    ├── recipes.md        six worked patterns with real output
    └── explainer.html    the same material as one illustrated page
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
