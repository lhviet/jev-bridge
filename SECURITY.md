# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Report it privately through this repository's **Security** tab →
**Report a vulnerability**. That opens a private advisory visible only to the
maintainers. You should receive an acknowledgement within a few days.

Include what you found, how to reproduce it, and the impact you expect. If you
have a fix in mind, describe it — but please wait for a reply before publishing
anything.

## Supported versions

Only the latest release receives security fixes while the project is pre-1.0.

## How jev-bridge handles your API key

This is the part most worth scrutinising, so here is exactly what the code does:

- The key is read from `TYPESAFE_API_KEY`, then `TYPESAFE_API_KEY_FILE`, then
  `~/.jev-bridge/.env`, then a `.env` at the package root — in that order. A
  file is read for its `TYPESAFE_API_KEY=` line, or for a bare key alone on a
  line; no other variable in it is ever taken for the key.
- A key must be one run of printable characters. One with a space or a line
  break — a malformed key file — is refused with an error that names the file
  and does not quote the key.
- It is sent **only** to the TypeSafe API, as an `Authorization: Bearer`
  header. The bridge refuses to send it over plain HTTP, except to this machine
  (`localhost`, `127.0.0.1`, `[::1]`), and does not follow redirects, so a
  misconfigured `TYPESAFE_BASE_URL` cannot pass it on. It is never logged,
  never written to the database, and never included in a tool result.
- `~/.jev-bridge` is created with mode `0700`, and everything the bridge
  creates — the database and its journal files — is `0600`. Keep the key file
  at `0600`.
- The `--selftest` output prints the key's length and first eight characters so
  you can tell which key is loaded. Nothing more.

## What the database contains

`~/.jev-bridge/jev.db` holds three things. It is never uploaded anywhere; what
reaches your MCP client is covered under
[Text you judged comes back later](#text-you-judged-comes-back-later).

- **The answer cache** — answers keyed by SHA-256 hashes of the request. It
  holds no `state` and no question text. Answers do repeat your `choice` option
  names and `score` level labels, which Jev returns as part of each answer.
- **The usage log** — token counts, costs, latencies and HTTP status codes.
- **The call history**, controlled by `TYPESAFE_HISTORY`:
  - `full` (the default) keeps the `state` and questions of every call, so a
    reviewer can judge whether the answer was right;
  - `meta` keeps answers, timings, costs and hashes, but **not** the state or
    the question text — a test checks the database file's bytes to hold it to
    that. Answers still repeat your `choice` option names and `score` level
    labels. The hashes are plain SHA-256, so someone who can read the file and
    guess a short state exactly can confirm the guess;
  - `off` keeps nothing.

  Calls are pruned after 30 days (`TYPESAFE_HISTORY_DAYS`), except those you
  have reviewed. `jev-bridge --clear-history` deletes all of it. Deleted rows
  are overwritten with zeros (`secure_delete`) and the write-ahead log is
  emptied, so the text does not linger in free pages; a test reads the file's
  bytes to check. Changing the mode does not rewrite calls already recorded.

## Text you judged comes back later

With `TYPESAFE_HISTORY=full`, `jev_history` and the `jev://history` resources
return stored states to your MCP client, and so to the model: the first 160
characters in every list, and the whole state for one call. Two consequences:

- **Stored text is untrusted input.** A state copied from an email or a web page
  may contain instructions aimed at an agent, and it can come back days later
  when the agent reviews past calls. Treat what those tools return as data,
  and review verdicts before you rely on them in an evaluation set.
- **One database serves every project.** A session in one project can list
  the calls made from another. Point `JEV_BRIDGE_HOME` or `TYPESAFE_DB`
  somewhere else per project to keep them apart, or use `meta` or `off`.

Anything you export from the history carries what it kept — an evaluation set
from `examples/eval-set.mjs` holds every reviewed state in full. The repository
ignores `*.jsonl` and the export file names used in
[docs/analytics.md](docs/analytics.md), but a copy saved elsewhere is yours to
keep private.

## The history dashboard

`jev-bridge --ui` starts a web server so you can review calls in a browser. It
shows whatever the history kept, so it is locked down like a local notebook
server:

- It listens on **127.0.0.1 only**, and rejects any request whose `Host`
  header names anything other than `127.0.0.1`, `localhost` or `[::1]` on its
  port — which stops a web page from reaching it through DNS rebinding.
- Every request needs a **random token**, generated per run and printed with
  the address. The API takes it only in a header, and compares it in constant
  time.
- The page loads **nothing from the network**, renders every stored value as
  text rather than markup, and its Content-Security-Policy allows only its own
  script and style. It sends no referrer and cannot be framed.
- It runs in its own process: the MCP server never opens a port.

## Out of scope

The security of the TypeSafe API itself, and of your MCP client, belongs to
their respective maintainers.
