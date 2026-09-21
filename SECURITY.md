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
  `~/.jev-bridge/.env`, then a `.env` at the package root — in that order.
- It is sent **only** to the TypeSafe API, as an `Authorization: Bearer`
  header over HTTPS. It is never logged, never written to the database, and
  never included in a tool result.
- `~/.jev-bridge` is created with mode `0700`. Keep the key file at `0600`.
- The `--selftest` output prints the key's length and first eight characters so
  you can tell which key is loaded. Nothing more.

## What the database contains

`~/.jev-bridge/jev.db` stores **answers** — keyed by a SHA-256 hash of the
request — plus token counts, costs, latencies and HTTP status codes. It does
**not** store the `state` you sent or the text of your questions. A hash cannot
be reversed into the content that produced it.

## Out of scope

The security of the TypeSafe API itself, and of your MCP client, belongs to
their respective maintainers.
