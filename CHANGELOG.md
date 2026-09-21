# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- MCP 2026-07-28, alongside the `initialize` handshake of 2025-11-25 and
  earlier (a dual-era server). A request whose `_meta` names a protocol
  version is served statelessly: `server/discover`, `resultType`, `serverInfo`
  in each result's `_meta`, `ttlMs` and `cacheScope` on cacheable results,
  `-32022` for an unsupported version, `-32602` for missing request metadata,
  and `subscriptions/listen`. Claude Code uses it with
  `MCP_PROTOCOL_NEGOTIATION=auto`.
- Resources: `jev://guide` (how to design Jev questions, condensed from
  TypeSafe's docs), `jev://models`, `jev://usage`, `jev://history` and the
  template `jev://history/{id}`, with update notifications for subscribers.
- Prompts, which Claude Code offers as slash commands: `review_uncertain`,
  `cost_report` and `question_design`. Completions for their arguments and for
  call ids.
- Cancellation: `notifications/cancelled` aborts the HTTP request and any
  backoff wait, and the cancelled request gets no response.
- Progress: a call that sends a `progressToken` hears when it starts and about
  each retry.
- Every tool now has a `title`, the four behaviour hints and an
  `outputSchema`; `jev_models` returns typed `structuredContent`.
  `jev_ask` results link to `jev://history/<call_id>` for clients on
  2025-06-18 or later, and carry `bridge.attempts` and `bridge.request_id`.
- The official SDKs' environment names: `TYPESAFE_BASE_URL` and
  `TYPESAFE_DEFAULT_MODEL`. New knobs `TYPESAFE_MAX_RETRIES` and
  `TYPESAFE_BACKOFF_INITIAL_MS`.
- `evidence/`: real Claude Code sessions recorded through a wire tap, repeated
  trials, a check of every message against the official MCP JSON Schema, and
  a generated report.

- A call history, for judging afterwards whether calls were efficient and
  right. Every `jev_ask` is kept: its state and questions, answers, latency,
  retries, tokens, cost, and whether it came from the cache, failed, or never
  reached the API. `TYPESAFE_HISTORY` chooses `full` (the default), `meta`
  (answers and timings, no state or question text) or `off`. Unreviewed calls
  are pruned after 30 days or past 10,000; reviewed calls are kept.
- `jev_history` — stats for a period (p50/p95 latency, hit rate, retries,
  re-sent states that should have been batched, accuracy) and the calls a
  filter picks, including the least certain first; or one call in full.
- `jev_review` — mark a call correct, partial or incorrect, with the answers it
  should have given and a note.
- `bridge.call_id` on every `jev_ask` result, naming the call in the history.
- `--ui`: a local dashboard to browse calls, read each answer as bars, and
  record reviews. It listens on 127.0.0.1 only, needs a per-run token, checks
  the `Host` header, and loads nothing from the network.
- `--history [days] [filter]` and `--clear-history`.
- `docs/analytics.md`: querying the database safely, with SQL for latency,
  failures, retries, batching, calibration, per-question accuracy and exports.
- `examples/eval-set.mjs` and `examples/replay.mjs`: turn reviewed calls into an
  evaluation set, and score any model against it before switching to it.
- README: how to update an installation, and why to keep it apart from a
  working copy.
- README: a Quick start at the top.
- `evidence/install.mjs`: follows the README's install guide and Quick start
  in a sandbox with an empty HOME, reading each command out of the README, and
  writes `evidence/install.md` with every output.
- `evidence/examples.mjs`: sends every documented `jev_ask` request live and
  checks each against the decision its text describes; writes
  `evidence/examples.md` and the raw `evidence/examples.json`.
- CI runs on Node 18, the oldest version `engines` allows, as well as 20, 22
  and 24. Dependabot keeps the workflow's actions current.

### Changed

- Retries follow the TypeSafe SDKs' `RetryPolicy`: 408, 429 and every 5xx,
  plus timeouts and dropped connections; at most 2 retries; backoff from 500 ms
  doubling to 5 s with 25 % jitter; `Retry-After` (seconds or a date) and
  `retry-after-ms` honoured up to 60 s. Before, only 429 and 529 were retried,
  three times.
- The per-attempt timeout is 10 s, the SDKs' default (was 60 s for the whole
  request).
- Questions are checked more closely against the API reference before being
  sent: unknown fields, a noul's criteria keys, choice descriptions and score
  levels must be text, an object or an array. Unknown `jev_ask` arguments are
  rejected by name.
- An unknown tool is now a JSON-RPC error (`-32602`), as the spec asks, rather
  than a tool result.
- `initialize` answers an unsupported protocol version with 2025-11-25
  instead of echoing it back.
- The server instructions and tool descriptions were rewritten for tool
  search: they say which tasks call for Jev, stay under Claude Code's 2 KB
  cut-off, never quote raw API endpoints, and tell the agent the bridge holds
  the key. `jev_history` rows name the client that made each call.
- The protocol, the catalogue and the TypeSafe client moved out of
  `server.mjs` into `mcp.mjs`, `catalog.mjs` and `typesafe.mjs`.

- The usage log and the history are written after each answer has gone back,
  once the bridge is idle, instead of on the answer's path. Measured end to
  end, median and p95 latency are unchanged or slightly better.
- A call that never reached the API — a timeout, a refused connection — is now
  recorded, as status `0`. Before, it was missing from the usage log.
- The server writes out pending records when stopped by SIGINT, SIGTERM or
  SIGHUP.
- `docs/recipes.md`: the rerank recipe shows its full request, one question
  per passage, instead of one question and a note to repeat it.

### Security

- A key file holding a bare key and a second line (a comment, say) produced a
  key with a line break in it. `fetch` rejects such a header by quoting it, and
  that error reached the tool result, the progress message and the stored
  history. A key must now be one run of printable characters; anything else is
  refused with an error that names the file and does not quote the key.
- A key file with an empty `TYPESAFE_API_KEY=` line, or no such line, could
  have the next variable in it, or the whole file, sent as the key. The file
  is now read line by line: the `TYPESAFE_API_KEY=` value (quoted, or with a
  trailing `# comment`), or a bare key alone on its line, and nothing else.
- The key is sent only over HTTPS, or plain HTTP to this machine, and redirects
  are no longer followed. A `3xx` is reported with the remedy.
- The database and its journal files are created `0600`; they were `0644`,
  which mattered when `TYPESAFE_DB` pointed outside `~/.jev-bridge`. Existing
  files keep their mode: `chmod 600 ~/.jev-bridge/jev.db*` to tighten them.
- Deleted and pruned calls are overwritten with zeros (`secure_delete`), and
  `--clear-history` also empties the write-ahead log. Before, cleared states
  stayed readable in the file's free pages.
- Every dashboard response carries a Content-Security-Policy, not only the page.
- `evidence/run.mjs` leaves out `rate_limit_event` records, which describe the
  recording account, and replaces the output of the recording machine's own
  hooks with a note. The committed recordings were re-sanitised; no check
  changed.

### Fixed

- Cached answers were filed under the question's canonical JSON, which put the
  question text on disk despite the documentation saying otherwise. They are
  now filed under its hash. Existing cache entries miss once and are replaced.
- Several processes opening a brand-new database at the same moment could fail
  with "database is locked" (about one open in fifteen), because SQLite does
  not consult `busy_timeout` when switching a file to WAL. The switch is now
  retried.

## [0.1.0] - 2026-09-20

### Added

- `jev_ask` — evaluate a `state` against typed `noul`, `choice` and `score`
  questions. Declares an `outputSchema` and returns `structuredContent`.
- `jev_usage` — calls, cache hits, tokens and cost over the last N days.
- `jev_models` — the models and aliases the account may use.
- An answer cache in SQLite through the built-in `node:sqlite`, so the package
  still has no dependencies. Seven-day TTL, least-recently-used eviction.
- Cache keys ignore question ids. TypeSafe never sends ids to the model, and an
  agent invents a fresh one each run, so keying on them made the cache miss.
- Cached answers are invalidated when a model alias starts resolving to a new
  version.
- A usage log recording tokens, cost, latency and outcome for every call.
- An in-memory fallback when `node:sqlite` is unavailable (Node < 22.5).
- Retries with backoff on 429 and 529, honouring `retry-after`.
- Local validation of every question before any network call.
- CLI: `--selftest`, `--stats`, `--clear-cache`, `--version`, `--help`.

[Unreleased]: https://github.com/lhviet/jev-bridge/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/lhviet/jev-bridge/releases/tag/v0.1.0
