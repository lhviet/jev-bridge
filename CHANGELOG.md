# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

### Changed

- The usage log and the history are written after each answer has gone back,
  once the bridge is idle, instead of on the answer's path. Measured end to
  end, median and p95 latency are unchanged or slightly better.
- A call that never reached the API — a timeout, a refused connection — is now
  recorded, as status `0`. Before, it was missing from the usage log.
- The server writes out pending records when stopped by SIGINT, SIGTERM or
  SIGHUP.

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
