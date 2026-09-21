# Before

Two recordings from before the changes they motivated, kept for comparison.
Both came through the same wire tap as the sessions in [`../runs`](../runs).

| File | What it shows |
| --- | --- |
| [`v0.1.0-discover-probe.wire.jsonl`](v0.1.0-discover-probe.wire.jsonl) | jev-bridge 0.1.0 under Claude Code 2.1.278 with `MCP_PROTOCOL_NEGOTIATION=auto`. Claude Code probes with `server/discover` for MCP 2026-07-28; the old server answers `-32601 Method not found`, and Claude Code falls back to the 2025-11-25 `initialize` handshake. The server spoke only the older revision. |
| [`rerank-two-calls.wire.jsonl`](rerank-two-calls.wire.jsonl) | An early recording of the `modern-rerank` scenario. The agent asked Jev twice about the same passages: a noul per passage, then a score for the three that lost. Nothing told it to score every candidate in one call. After "To rank candidates, give each its own score against the query in the same call" went into the `jev_ask` description and the guide, the same prompt took one call in every recording (see [How reliably](../README.md#how-reliably)). |
