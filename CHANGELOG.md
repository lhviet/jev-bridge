# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
