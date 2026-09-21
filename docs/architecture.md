# Architecture

The request path — where each piece runs, and what happens during one call — is
drawn in the [README](../README.md#how-it-works). This page covers what sits
underneath it: the components, the storage, how cache keys work, and how the
whole thing is tested.

- [Components](#components)
- [Storage](#storage)
- [Cache keys](#cache-keys)
- [Call history](#call-history)
- [Is Jev deterministic?](#is-jev-deterministic)
- [Performance](#performance)
- [How it is tested](#how-it-is-tested)
- [Design decisions](#design-decisions)

## Components

Four modules and a page, no dependencies. Colours and shapes follow the
[key in the README](../README.md#reading-the-diagrams); a **dashed grey** box is
not persisted, and **teal** marks a claim proven by a test.

```mermaid
flowchart TB
  CLIENT("MCP client")
  subgraph SERVER["src/server.mjs"]
    RPC["serve · makeHandler<br/>JSON-RPC over stdio"]
    CLI["main<br/>the command line"]
    ASK["askJev<br/>validate · look up · call · record"]
    NET["request · loadKey<br/>Bearer auth, retries on 429 / 529"]
  end
  subgraph STORE["src/store.mjs"]
    direction TB
    FP["cacheKey<br/>canonical JSON, ids excluded"]
    WB["writeBehind<br/>usage and history, written when idle"]
    SQL[("sqliteStore<br/>Node 22.5+, persisted")]
    MEM("memoryStore<br/>older Node, not persisted")
  end
  HIST["src/history.mjs<br/>certainty · filters · stats · reviews"]
  UI["src/ui.mjs + ui.html<br/>dashboard, its own process"]
  API(["TypeSafe API"])

  CLIENT --> RPC
  RPC --> ASK
  CLI --> ASK
  ASK --> NET
  ASK --> STORE
  NET -- "cache miss only" --> API
  FP -- "key" --> SQL
  FP -. "key" .-> MEM
  WB --> SQL
  RPC -- "jev_history · jev_review" --> HIST
  UI --> HIST
  HIST --> STORE

  classDef client fill:#ede9fe,stroke:#7c3aed,color:#3b0764
  classDef bridge fill:#dbeafe,stroke:#2563eb,color:#1e3a8a,stroke-width:2px
  classDef store fill:#dcfce7,stroke:#16a34a,color:#14532d
  classDef ephemeral fill:#f8fafc,stroke:#94a3b8,color:#334155,stroke-dasharray:5 3
  classDef external fill:#ffedd5,stroke:#ea580c,color:#7c2d12
  class CLIENT client
  class RPC,CLI,ASK,NET,FP,WB,HIST,UI bridge
  class SQL store
  class MEM ephemeral
  class API external
  style SERVER fill:#2563eb12,stroke:#2563eb,stroke-dasharray:6 4
  style STORE fill:#16a34a12,stroke:#16a34a,stroke-dasharray:6 4
  linkStyle 0 stroke:#7c3aed
  linkStyle 4 stroke:#16a34a,stroke-width:2px
  linkStyle 5 stroke:#ea580c,stroke-width:2px
  linkStyle 6 stroke:#16a34a
  linkStyle 7 stroke:#94a3b8
```

| Module | Responsibility |
| --- | --- |
| `src/server.mjs` | The MCP protocol, the five tools, question validation, the HTTP client with retries, key loading, and the command line. |
| `src/store.mjs` | Cache keys, the write-behind queue, the SQLite store, and an in-memory store with the same interface for Node versions that lack `node:sqlite`. |
| `src/history.mjs` | Pure functions over history rows: certainty, filters, latency percentiles, batching and accuracy stats, and review validation. The MCP tools, the CLI and the dashboard all use it, so they cannot disagree. |
| `src/ui.mjs`, `src/ui.html` | The dashboard: a token-guarded server on 127.0.0.1 and one self-contained page. |

Two rules hold everywhere. **stdout carries protocol bytes and nothing else** —
a stray `console.log` corrupts the JSON-RPC stream, and the only symptom is a
client reporting the server as disconnected. And **only a 200 is ever cached**.

## Storage

Three things are saved: answers, so a repeat costs nothing; usage, so spend is
a number you can look at; and a history of calls, so speed and accuracy can be
judged afterwards.

### Why SQLite, and not a JSON file

The deciding constraint is not speed. It is that **every MCP client session
starts its own jev-bridge process**, and they all share one store. That rules
out most of the simple formats before performance is even discussed.

| Option | Find one answer | Two sessions writing at once | Evicting old entries |
| --- | --- | --- | --- |
| JSON file | load the whole file | **loses whichever write lands second** | rewrite everything |
| CSV | scan every row | appends survive, edits do not | rewrite everything |
| JSONL | load it all into memory | appends survive | needs compaction, which races |
| XML | parse the whole document | the same failure as JSON | rewrite everything |
| **SQLite** | indexed lookup | **built for it** (WAL) | one statement |

It costs no dependency: [`node:sqlite`](https://nodejs.org/api/sqlite.html) is
built into Node from 22.5 onward.

### Proven, not argued

```mermaid
flowchart LR
  A["session A<br/>jev-bridge"] --> DB[("jev.db<br/>WAL + busy_timeout")]
  B["session B<br/>jev-bridge"] --> DB
  C["session C<br/>jev-bridge"] --> DB
  DB --> R["800 concurrent writes<br/>from 2 processes: none lost"]

  classDef bridge fill:#dbeafe,stroke:#2563eb,color:#1e3a8a,stroke-width:2px
  classDef store fill:#dcfce7,stroke:#16a34a,color:#14532d
  classDef proof fill:#ccfbf1,stroke:#0d9488,color:#134e4a
  class A,B,C bridge
  class DB store
  class R proof
  linkStyle 0,1,2 stroke:#2563eb,stroke-width:2px
  linkStyle 3 stroke:#0d9488,stroke-width:2px
```

The concurrency claim is a test, not an argument: two real processes each write
400 entries to one database file at the same moment, and all 800 survive.
Remove the `busy_timeout` line and that test fails — which is exactly what a
JSON file would do, quietly, with no line to remove.

That test also turned up a race of its own, about one run in fifteen. When
several processes open a **brand-new** file together, each must upgrade a shared
lock to switch the file to WAL, and SQLite answers that with `SQLITE_BUSY` at
once rather than call the busy handler and risk a deadlock — so `busy_timeout`
never helps. Reproduced, it failed 9–12 opens in 180. The switch is now retried
with a short jittered pause (the mode is stored in the file, so only the very
first open can meet it), and a dedicated test opens a new database from six
processes at once, twenty times over: it failed five runs in five before the
fix and has not failed since.

### Schema

```mermaid
erDiagram
  cache {
    TEXT key PK "sha256 of state, questions and model"
    TEXT requested_model "what the caller asked for"
    TEXT resolved_model "what actually answered"
    TEXT response "answers only, never the input"
    INTEGER created_at
    INTEGER last_hit_at "drives eviction"
    INTEGER hits
  }
  aliases {
    TEXT requested PK "for example jev-latest"
    TEXT resolved "for example jev-1.13.0"
    INTEGER seen_at
  }
  calls {
    INTEGER ts
    TEXT requested_model
    TEXT resolved_model
    INTEGER cached "1 for a hit"
    INTEGER questions
    INTEGER input_tokens
    INTEGER output_tokens
    INTEGER saved_input_tokens "what a hit avoided"
    REAL saved_usd
    REAL latency_ms
    REAL cost_usd
    INTEGER status "HTTP status"
  }
  history {
    TEXT id PK "the bridge.call_id"
    INTEGER ts
    TEXT session "one per server process"
    TEXT client "from the MCP handshake"
    INTEGER cached
    INTEGER forced "cache false"
    INTEGER status "0 when no reply came"
    TEXT error
    REAL latency_ms
    INTEGER attempts "more than 1 after a rate limit"
    INTEGER input_tokens
    REAL cost_usd
    REAL certainty "least sure answer"
    TEXT state_hash FK
    TEXT questions_hash FK
    INTEGER kept "1 when the content was kept"
    TEXT preview "start of the state"
    TEXT answers
    TEXT verdict "correct, partial, incorrect"
    TEXT note
    TEXT expected
  }
  payloads {
    TEXT hash PK "sha256 of canonical JSON"
    TEXT body "a state or a question set, stored once"
  }
  aliases ||--o{ cache : "a moved alias retires its entries"
  payloads ||--o{ history : "one body, many calls"
```

The **cache** stores answers only. Your `state` and your question text are
never written into it: the key is a SHA-256 hash, and each answer is filed under
a hash of its question. It was not always so: answers used to be filed under
the question's canonical JSON, which put the question text on disk in plain
sight. The test that holds `meta` mode to its promise, by reading the database
file's raw bytes, is what caught it. `cache` is a `WITHOUT ROWID` table indexed
on `last_hit_at`, so a lookup is one index probe and eviction is one statement.

The **history** is the one table that holds content, and only when
`TYPESAFE_HISTORY` is `full`. `payloads` stores each state and question set
once, under a hash of its canonical JSON, so a state asked about a hundred times
costs one body. It is an ordinary rowid table on purpose: bodies run to
kilobytes, and `WITHOUT ROWID` suits only small rows. Measured, the switch cut
the write behind a live call from about 470 µs to 400 µs.

### Where it lives

```text
~/.jev-bridge/          created 0700 on first use
├── .env                your API key, if you keep it in a file (0600)
└── jev.db              the five tables above
```

While the database is open, SQLite keeps `jev.db-wal` and `jev.db-shm` beside
it; a checkpoint folds them back in.

## Cache keys

### What makes two requests the same

- The **state**, the **model**, and the **meaning** of each question.
- **Question ids are excluded.** Answers are stored against the question that
  earned them and handed back under whatever ids the current caller used.
- **Object key order is ignored; array order is not.** The levels of a `score`
  are ordered, and reversing them is a different question whose answer must
  never be served for the original.
- **Entries expire after 7 days**, and the least recently used are evicted past
  20,000.

### The bug a real session found

The unit tests passed while the cache was effectively broken. Driving jev-bridge
from a real Claude Code session showed back-to-back identical questions missing
every time. The only difference between them:

```jsonc
// session A
{ "urgency":       { "type": "noul", "instructions": "Does this convey urgency?" } }
// session B
{ "urgency_check": { "type": "noul", "instructions": "Does this convey urgency?" } }
```

Same state, same question, same type — a different **id**, invented by the
model. TypeSafe's contract says ids are never sent to the model, so to Jev these
are one question. The first version keyed on them anyway, and because an agent
picks a fresh id on every run, the cache would have missed nearly every time it
mattered.

After the fix, against the live API:

```text
call 1   id = alpha           cached: false   {"alpha": {"noul": 0.97}}   166.02 ms
call 2   id = beta            cached: true    {"beta":  {"noul": 0.97}}     0.15 ms
call 3   reworded question    cached: false   a different question must miss
```

A caveat worth keeping in mind: agents also **rephrase**. Two independent
sessions asked the same thing in wording 46 tokens apart, and correctly missed.
Expect hits within a session and from code that sends a fixed question, not
across sessions where the model writes the question afresh.

### A moved alias invalidates itself

Each cache entry records the model that actually answered it, and the `aliases`
table records what each alias currently resolves to. When `jev-latest` starts
resolving to a newer version, entries answered by the older one stop being
served, instead of silently outliving the release.

## Call history

### What a reviewer can ask of it

| Question | Where the answer comes from |
| --- | --- |
| Was it fast? | `latency_ms` per call; nearest-rank p50, p95 and max over live calls, so every figure is a latency that happened |
| Was time lost to rate limits? | `attempts`: more than one means the call waited out a 429 or 529 |
| Was it cheap? | `input_tokens` and `cost_usd`, and the cache hit rate |
| Was it batched? | *Re-sent states*: live calls whose state had already been sent live in the window. A forced refresh is deliberate, so it is not counted |
| Did it fail? | `status`, which is `0` when no HTTP reply ever came. The usage log used to miss those entirely |
| Was Jev sure? | `certainty`, from the least sure answer: a `choice` or `score` by Jev's `confidence`, a `noul` by `abs(2p − 1)` |
| Was it right? | A review: `verdict`, `expected` answers by question id, and a `note` |

The certainty cut for "uncertain" (0.6 by default) is a triage filter that
decides what to look at first. It is not a decision rule, and nothing acts on
it. TypeSafe's guidance to keep policy in your own code still stands.

### Writing it without slowing anything down

```mermaid
sequenceDiagram
  participant C as MCP client
  participant B as jev-bridge
  participant Q as write-behind queue
  participant D as jev.db
  C->>B: jev_ask
  B->>Q: push usage and history (references only)
  B-->>C: answer, with bridge.call_id
  Note over B,Q: idle 20 ms, or 500 ms after the first, or 100 waiting
  Q->>D: one transaction: hash, serialise, insert
```

`askJev` only queues references to what it already holds. Hashing, JSON, the
certainty score and the SQLite insert all run later, together, when the bridge
falls idle. Two versions were measured end to end over MCP:

- **Writing on the next tick** kept each answer's own time unchanged. But a
  client sending calls back to back found each request queued behind the
  previous call's commit: about 0.3 ms at the median, and up to 6 ms at p95
  when a WAL checkpoint landed there.
- **Writing when idle**, which is what shipped, left the median and p95
  unchanged against the version without history, and turns a burst into one
  transaction. Its cost shows at p99 of an unbroken synthetic burst, where the
  call that lands on a 100-record write waits 2–4 ms for it.

Every read of the store flushes first, so a process sees its own writes. The
server also flushes on exit and on SIGINT, SIGTERM and SIGHUP. A record that
cannot be written is logged to stderr and dropped. It never fails the call, and
never takes the usage record beside it down with it.

### Keeping it bounded

Unreviewed calls are pruned after `TYPESAFE_HISTORY_DAYS` (30) and beyond
`TYPESAFE_HISTORY_MAX` (10,000), at start-up and every 500 writes. **Reviewed
calls are never pruned**: a review turns a call into a labelled example, which
is worth more than the unlabelled rest. Bodies no longer referenced by a kept
call are deleted in the same pass.

## Is Jev deterministic?

Nearly. Three identical live calls:

| Run | `is_urgent` | billing | `frustration` | Latency |
| --- | --- | --- | --- | --- |
| 1 | 0.95 | 0.89 | 1.05 | 235 ms |
| 2 | 0.95 | 0.85 | 1.04 | 195 ms |
| 3 | 0.95 | 0.86 | 1.04 | 121 ms |

The **decisions** never move — billing every time, the same noul. The
probabilities wobble by about 0.02 in the second decimal. Caching is therefore
safe, and it makes repeated runs more reproducible than the API itself. The one
caution: a threshold tuned right at a boundary would be pinned to one sample of
that wobble. Pass `"cache": false` when you are measuring rather than deciding.

## Performance

| Measurement | Result |
| --- | --- |
| Live call | 184 ms, average of 3 |
| Cached call | **0.077 ms**, median of 20 |
| Speed-up on a repeat | about **2,370×** |
| Cost of a cache hit | **$0** |
| Cost of a typical 400-token call | about $0.000017 |
| A small database on disk | around 40 KB, mostly SQLite page overhead |

## How it is tested

91 tests on the built-in `node --test` runner — no test framework installed.

- **Only the TypeSafe API is faked**, because it is external and billed.
  SQLite, the MCP protocol over a real child process, and two processes
  contending for one file all run for real.
- **Every behaviour runs twice**: against the SQLite store and against the
  memory fallback.
- **CI runs Node 20, 22 and 24.** Node 20 has no `node:sqlite`, so there the
  SQLite suites skip and the fallback is what gets tested.
- **The suite never touches a real key or a real home directory**: every server
  it starts gets `TYPESAFE_API_KEY`, `TYPESAFE_DB` and `JEV_BRIDGE_HOME`.

A passing test proves nothing until it has been seen to fail. Each of these was
checked by breaking the code on purpose and confirming a test noticed:

| Mutation | Caught |
| --- | --- |
| The cache key stops ignoring object key order | ✅ |
| The cache key includes the caller's question ids | ✅ |
| Score levels get sorted, losing their order | ✅ |
| Answers come back without being remapped to the caller's ids | ✅ |
| The TTL never expires an entry | ✅ |
| Failed calls get cached | ✅ |
| A moved model alias goes undetected | ✅ |
| Eviction by age instead of by use | ✅ |
| `busy_timeout` removed | ✅ |
| Question validation skipped | ✅ |
| The question fingerprint stored as text, not hashed | ✅ |
| History written on the answer's path instead of after it | ✅ |
| History written on the next tick instead of when idle | ✅ |
| One failed history record taking the usage record down with it | ✅ |
| `meta` keeping the state | ✅ |
| Reviewed calls pruned by age (SQLite and memory) | ✅ |
| A call that never reached the API left unrecorded | ✅ |
| Certainty taken from the most sure answer, or from `p` instead of `abs(2p − 1)` | ✅ |
| Percentiles off by one rank | ✅ |
| "Uncertain" left unsorted | ✅ |
| Forced refreshes counted as re-sent states | ✅ |
| An unknown verdict accepted | ✅ |
| The dashboard skipping its Host check, or its token | ✅ |

Beyond the suite, jev-bridge was driven end to end from a real Claude Code
session — which is how the question-id bug was found, and something no unit test
had thought to ask.

## Design decisions

### Built

- **An answer cache**, keyed on meaning rather than ids, with TTL and LRU eviction.
- **A usage log**, surfaced through `jev_usage` and `--stats`.
- **A call history** with reviews, surfaced through `jev_history`, `jev_review`,
  `--history` and the `--ui` dashboard, and written only after each answer has
  gone back.
- **Typed output** — `jev_ask` declares an `outputSchema` and returns `structuredContent`.
- **Alias-drift invalidation**, so a model release retires stale answers.
- **An in-memory fallback**, so an old Node degrades instead of failing to start.

### Declined, on purpose

- **The official SDKs.** They would bring maintained retries and types, but
  cost the zero-dependency property — which is what lets a bare
  `node src/server.mjs` start with nothing installed and nothing to rot.
- **A `jev_decide` tool** that bakes confidence thresholds into the bridge.
  TypeSafe's own guidance is to keep raw judgments reusable and policy in your
  code. A threshold baked in here would be a decision every caller inherits and
  none can see.

### Not yet

- **Normalising question text.** Case and whitespace differences still miss.
  Real rephrasing should miss; `"Does this convey urgency?"` and
  `"does this convey urgency? "` need not.
- **A shared rate-limit budget.** Each process retries on its own. That is
  invisible at modest volume and would not be at a thousand calls a minute.
- **History writes on a worker thread.** Idle-time writing already keeps them
  off every call anyone waits for. A worker would also take the 2–4 ms off p99
  in an unbroken burst, at the price of a second isolate and asynchronous
  reads.
- **Replaying reviewed calls.** Reviewed calls with `expected` answers form a
  regression set. Re-asking them when `jev-latest` moves to a new version would
  show whether it got better or worse on your own questions.
- **Pruning the usage log.** The cache evicts itself; the log grows without a
  ceiling, at roughly 80 bytes a call.
