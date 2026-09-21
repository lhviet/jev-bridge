# Contributing to jev-bridge

Thanks for your interest. This is a small project with a few firm opinions;
reading this first will save you a round of review.

## The rules that matter

1. **No runtime dependencies.** jev-bridge runs as `node src/server.mjs` with
   nothing installed. That is why it starts instantly and has nothing to rot.
   A change that adds a `dependencies` entry will not be merged. Node built-ins
   — including `node:sqlite` and `node:test` — are fair game.
2. **Nothing but protocol on stdout.** MCP speaks JSON-RPC over stdout. A stray
   `console.log` corrupts the stream, and the symptom is a client reporting the
   server as disconnected with no clue why. Diagnostics go to stderr, through
   `log()`.
3. **Keep policy out of the bridge.** Thresholds and decisions belong to the
   caller. jev-bridge returns judgments; it does not act on them.
4. **Never cache a failure.** Only a 200 is stored.
5. **Recording never slows an answer.** The usage log and the call history go
   through the store's write-behind queue, and are written once the bridge is
   idle. Do not add a database write to the path that produces a reply; the
   test "the answer is returned before anything about it is written" guards it.

## Getting set up

```bash
git clone https://github.com/lhviet/jev-bridge.git
cd jev-bridge
npm test
```

There is no `npm install` step. Node 22.5 or newer runs the full suite; on an
older Node the SQLite tests skip and the memory fallback is tested instead.

## Tests

The suite runs on the built-in `node --test` runner. Only the TypeSafe API is
faked; SQLite, the MCP protocol and multi-process contention run for real.

A new behaviour needs a test that **fails without your change**. Before opening
a pull request, break your own code on purpose and confirm a test notices —
a test that has never been seen to fail proves nothing.

The suite never calls the live API and never reads a real key: it sets
`TYPESAFE_API_KEY`, `TYPESAFE_DB` and `JEV_BRIDGE_HOME` for every server it
starts.

## When you change what a client is told

`src/catalog.mjs` holds the server instructions, the tool descriptions and
schemas, the guide and the prompts: everything an agent reads before it
decides what to do. A change there can change what Claude does, which no unit
test sees. Re-record the sessions and read the report before opening a pull
request:

```bash
npm run evidence   # needs `claude` and a TypeSafe key; costs well under a dollar
```

The report ([evidence/README.md](evidence/README.md)) says which checks passed.
Keep every description and the instructions under 2 KB — Claude Code cuts
them there — and put the rule that matters most first.

## Pull requests

- Keep each pull request to one change.
- Add an entry under `[Unreleased]` in `CHANGELOG.md`.
- Describe what you changed and **how you verified it**. If it touches the
  cache or the protocol, say what you ran against a real MCP client.

## Reporting bugs

Open an issue with the output of `node src/server.mjs --version`, your Node
version, your MCP client, and what you expected. Redact your API key from
anything you paste.

Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## Code of conduct

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
