# Architecture

The request path — where each piece runs, and what happens during one call — is
drawn in the [README](../README.md#how-it-works). This page covers what sits
underneath it: the components, the storage, how cache keys work, and how the
whole thing is tested.

- [Components](#components)
- [Storage](#storage)
- [Cache keys](#cache-keys)
- [Is Jev deterministic?](#is-jev-deterministic)
- [Performance](#performance)
- [How it is tested](#how-it-is-tested)
- [Design decisions](#design-decisions)

## Components

Two modules, no dependencies. Colours and shapes follow the
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
    SQL[("sqliteStore<br/>Node 22.5+, persisted")]
    MEM("memoryStore<br/>older Node, not persisted")
  end
  API(["TypeSafe API"])

  CLIENT --> RPC
  RPC --> ASK
  CLI --> ASK
  ASK --> NET
  ASK --> STORE
  NET -- "cache miss only" --> API
  FP -- "key" --> SQL
  FP -. "key" .-> MEM

  classDef client fill:#ede9fe,stroke:#7c3aed,color:#3b0764
  classDef bridge fill:#dbeafe,stroke:#2563eb,color:#1e3a8a,stroke-width:2px
  classDef store fill:#dcfce7,stroke:#16a34a,color:#14532d
  classDef ephemeral fill:#f8fafc,stroke:#94a3b8,color:#334155,stroke-dasharray:5 3
  classDef external fill:#ffedd5,stroke:#ea580c,color:#7c2d12
  class CLIENT client
  class RPC,CLI,ASK,NET,FP bridge
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
| `src/server.mjs` | The MCP protocol, the three tools, question validation, the HTTP client with retries, key loading, and the command line. |
| `src/store.mjs` | Cache keys, the SQLite store, and an in-memory store with the same interface for Node versions that lack `node:sqlite`. |

Two rules hold everywhere. **stdout carries protocol bytes and nothing else** —
a stray `console.log` corrupts the JSON-RPC stream, and the only symptom is a
client reporting the server as disconnected. And **only a 200 is ever cached**.

## Storage

Two things are saved: answers, so a repeat costs nothing, and usage, so spend is
a number you can look at.

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
  aliases ||--o{ cache : "a moved alias retires its entries"
```

The cache stores **answers only**. Your `state` and your questions are never
written to disk: the key is a SHA-256 hash of them, which cannot be read back.
`cache` is a `WITHOUT ROWID` table indexed on `last_hit_at`, so a lookup is one
index probe and eviction is one statement.

### Where it lives

```text
~/.jev-bridge/          created 0700 on first use
├── .env                your API key, if you keep it in a file (0600)
└── jev.db              the three tables above
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

35 tests on the built-in `node --test` runner — no test framework installed.

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

Beyond the suite, jev-bridge was driven end to end from a real Claude Code
session — which is how the question-id bug was found, and something no unit test
had thought to ask.

## Design decisions

### Built

- **An answer cache**, keyed on meaning rather than ids, with TTL and LRU eviction.
- **A usage log**, surfaced through `jev_usage` and `--stats`.
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
- **Pruning the usage log.** The cache evicts itself; the log grows without a
  ceiling, at roughly 80 bytes a call.
