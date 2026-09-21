# Evaluation and analytics

The dashboard (`--ui`) and the `jev_history` tool answer the everyday
questions: was it fast, what did it cost, was it right. For anything else — a
report of your own, a spreadsheet, a notebook, an evaluation of a new model
against your own calls — query the database directly. It is an ordinary SQLite
file, and every query on this page was run against a real one.

- [Where the data is](#where-the-data-is)
- [Opening it safely](#opening-it-safely)
- [What each table is for](#what-each-table-is-for)
- [The history, column by column](#the-history-column-by-column)
- [Performance](#performance)
- [Quality](#quality)
- [Evaluating a model on your own calls](#evaluating-a-model-on-your-own-calls)
- [Exporting](#exporting)
- [From code](#from-code)
- [Things to keep in mind](#things-to-keep-in-mind)

## Where the data is

One file, shared by every session and by the dashboard:

```text
~/.jev-bridge/jev.db      or $TYPESAFE_DB, or $JEV_BRIDGE_HOME/jev.db
```

Timestamps (`ts`, `reviewed_at`) are **milliseconds** since the Unix epoch. In
SQLite, `datetime(ts / 1000, 'unixepoch', 'localtime')` reads one, and
`ts >= strftime('%s', 'now', '-7 days') * 1000` keeps the last seven days.

## Opening it safely

```bash
sqlite3 -cmd "PRAGMA query_only = ON" -column -header ~/.jev-bridge/jev.db
```

`query_only` makes the connection refuse every write, so a slip cannot damage
the history. Reading while Claude Code sessions are writing is safe: the
database is in WAL mode, and readers see a consistent snapshot.

**Why not `sqlite3 -readonly`?** It works while a jev-bridge process has the
file open, and fails with `unable to open database file` when none does. In WAL
mode a reader needs the `-shm` file beside the database; SQLite deletes it when
the last connection closes, and a read-only connection is not allowed to
create it again. `query_only` has no such trouble.

**For heavy work, take a snapshot** and point your tools at the copy. It is a
consistent point-in-time copy even while sessions are writing, and it is not in
WAL mode, so any tool can open it read-only:

```bash
sqlite3 ~/.jev-bridge/jev.db "VACUUM INTO '/tmp/jev-snapshot.db'"
```

(Run that one without `query_only`. `VACUUM INTO` never changes the source,
but under `query_only` it fails — and still leaves a partial file behind.)

## What each table is for

| Table | Holds | Kept | Use it for |
| --- | --- | --- | --- |
| `history` | One row per `jev_ask`: timing, cost, answers, review | 30 days and 10,000 unreviewed rows; reviewed rows forever | Anything about a particular call, and all quality questions |
| `payloads` | Each state and question set, stored once | While a kept call refers to it | Reading what was asked |
| `calls` | One row per `jev_ask`, numbers only | Forever | Cost and volume over months |
| `cache` | Answers, keyed by hashes | 7 days, 20,000 entries | Not analysis; it is the cache |
| `aliases` | What each alias last resolved to | — | Which version `jev-latest` meant |

`history` and `calls` record the same calls. `history` has the detail, but
prunes; `calls` is lean and permanent. For a trend longer than a month, use
`calls`.

## The history, column by column

| Column | Meaning |
| --- | --- |
| `id` | The `bridge.call_id` the call returned: the process's session, then a counter |
| `ts` | When the call was made, in ms |
| `session` | One per server process — roughly, one Claude Code session |
| `client` | The MCP client's name, from its handshake, such as `claude-code` |
| `requested_model` | What the caller asked for, such as `jev-latest` |
| `resolved_model` | What answered, such as `jev-1.13.0` |
| `cached` | `1` if answered from the cache |
| `forced` | `1` if the caller passed `cache: false` |
| `status` | The HTTP status; `200` for success, `0` if no reply ever came |
| `error` | Why it failed, if it did |
| `latency_ms` | Time inside the bridge, from receiving the call to having the answer |
| `attempts` | Tries it took; more than one means it was retried after a 408, 429 or 5xx, a timeout or a dropped connection |
| `input_tokens`, `output_tokens` | Tokens billed; `0` for a cache hit |
| `cost_usd` | What this call cost; `0` for a hit |
| `question_count` | Questions in the call |
| `certainty` | How sure Jev was, 0–1, from its least sure answer. A `choice` or `score` uses Jev's `confidence`; a `noul` uses `abs(2p − 1)`, so 0.5 is 0 and 0.95 is 0.9 |
| `state_hash`, `questions_hash` | Keys into `payloads` |
| `kept` | `1` if the state and questions were kept (history on `full`) |
| `preview` | The first 160 characters of the state |
| `digest` | The answers on one line, `id=value, …` |
| `answers` | The answers as JSON, exactly as Jev returned them |
| `verdict` | `correct`, `partial` or `incorrect`, once reviewed |
| `note` | The reviewer's note |
| `expected` | JSON: question id → what the answer should have been |
| `reviewed_at` | When the review was made, in ms |

`answers` is keyed by the caller's question ids:

```json
{
  "is_urgent":   { "type": "noul",   "noul": 0.95 },
  "department":  { "type": "choice", "choice": "billing", "confidence": 0.8,
                   "probabilities": { "billing": 0.87, "technical": 0.13, "sales": 0 } },
  "frustration": { "type": "score",  "score": 1.05, "confidence": 0.92,
                   "legend": { "0": "Calm", "1": "Frustrated", "2": "Very angry" },
                   "probabilities": { "0": 0, "1": 0.95, "2": 0.05 } }
}
```

so `json_extract(answers, '$.department.choice')` reads one of them. `expected`
holds what a reviewer marked, in the same terms: `true` or `false` for a
`noul`, an option name for a `choice`, a level number for a `score`.

## Performance

**Day by day, from the permanent log:**

```sql
SELECT date(ts / 1000, 'unixepoch', 'localtime')                          AS day,
       COUNT(*)                                                           AS calls,
       SUM(cached)                                                        AS cache_hits,
       SUM(cached = 0 AND status <> 200)                                  AS errors,
       SUM(input_tokens)                                                  AS tokens,
       ROUND(SUM(cost_usd), 6)                                            AS usd,
       ROUND(AVG(CASE WHEN cached = 0 AND status = 200 THEN latency_ms END)) AS avg_live_ms
FROM calls
GROUP BY day
ORDER BY day;
```

**Latency percentiles of live calls, by model.** Nearest-rank, as the
dashboard computes them, so every figure is a latency that happened:

```sql
WITH live AS (
  SELECT resolved_model, latency_ms,
         ROW_NUMBER() OVER (PARTITION BY resolved_model ORDER BY latency_ms) AS n,
         COUNT(*)     OVER (PARTITION BY resolved_model)                     AS total
  FROM history
  WHERE cached = 0 AND status = 200
    AND ts >= strftime('%s', 'now', '-7 days') * 1000
)
SELECT resolved_model,
       MAX(total)                                  AS calls,
       MIN(CASE WHEN n >= 0.50 * total THEN latency_ms END) AS p50_ms,
       MIN(CASE WHEN n >= 0.95 * total THEN latency_ms END) AS p95_ms,
       MAX(latency_ms)                             AS max_ms
FROM live
GROUP BY resolved_model;
```

**The slowest calls**, with how many tries each took:

```sql
SELECT id, datetime(ts / 1000, 'unixepoch', 'localtime') AS at,
       ROUND(latency_ms) AS ms, attempts, input_tokens, preview
FROM history
WHERE cached = 0 AND status = 200
ORDER BY latency_ms DESC
LIMIT 10;
```

**Failures, by kind:**

```sql
SELECT status,
       COUNT(*) AS calls,
       substr(error, 1, instr(error || char(10), char(10)) - 1) AS first_line_of_one
FROM history
WHERE status <> 200
GROUP BY status;
```

**Time lost to rate limits** — calls that had to retry:

```sql
SELECT COUNT(*) AS retried_calls, ROUND(AVG(latency_ms)) AS avg_ms, MAX(attempts) AS most_tries
FROM history
WHERE attempts > 1;
```

**States sent live more than once.** Every send after the first paid to
ingest the same state again, and its questions could have ridden in one call.
`forced` counts sends made with `cache: false`, which were deliberate; the
dashboard's *re-sent states* leaves those out.

```sql
SELECT COUNT(*)          AS live_calls,
       SUM(forced)       AS forced,
       SUM(input_tokens) AS tokens,
       MIN(preview)      AS state
FROM history
WHERE cached = 0 AND status = 200 AND state_hash IS NOT NULL
GROUP BY state_hash
HAVING COUNT(*) > 1
ORDER BY live_calls DESC;
```

**Where the calls come from:**

```sql
SELECT client,
       COUNT(DISTINCT session) AS sessions,
       COUNT(*)                AS calls,
       SUM(cached)             AS cache_hits,
       ROUND(SUM(cost_usd), 6) AS usd
FROM history
GROUP BY client;
```

## Quality

Quality numbers exist only for calls someone reviewed — in the dashboard, or by
Claude through `jev_review`. Review a few dozen, starting with the least
certain, before reading much into them.

**Accuracy, by model:**

```sql
SELECT resolved_model,
       COUNT(*)                                          AS reviewed,
       SUM(verdict = 'correct')                          AS correct,
       SUM(verdict = 'partial')                          AS partial,
       SUM(verdict = 'incorrect')                        AS incorrect,
       ROUND(1.0 * SUM(verdict = 'correct') / COUNT(*), 2) AS accuracy
FROM history
WHERE verdict IS NOT NULL
GROUP BY resolved_model;
```

**Does certainty predict correctness?** If Jev is well calibrated, accuracy
rises from band to band. A band where it does not is where to set your own code
to double-check:

```sql
SELECT printf('%.1f to %.1f', band / 5.0, (band + 1) / 5.0) AS certainty,
       COUNT(*)                                             AS reviewed,
       ROUND(1.0 * SUM(verdict = 'correct') / COUNT(*), 2)  AS accuracy
FROM (SELECT MIN(CAST(certainty * 5 AS INTEGER), 4) AS band, verdict
      FROM history
      WHERE verdict IS NOT NULL AND certainty IS NOT NULL)
GROUP BY band
ORDER BY band;
```

**What to review next** — the least certain calls nobody has looked at:

```sql
SELECT id, ROUND(certainty, 2) AS certainty, preview, digest
FROM history
WHERE verdict IS NULL AND status = 200 AND certainty < 0.6
ORDER BY certainty
LIMIT 20;
```

**Accuracy per question.** Agents invent their own question ids, so this
groups by the question's text instead. It counts only answers a reviewer
marked with an expected value:

```sql
SELECT json_extract(qs.body, '$."' || e.key || '".instructions')      AS question,
       COUNT(*)                                                       AS marked,
       SUM(CASE json_extract(h.answers, '$."' || e.key || '".type')
             WHEN 'choice' THEN json_extract(h.answers, '$."' || e.key || '".choice') = e.value
             WHEN 'noul'   THEN (json_extract(h.answers, '$."' || e.key || '".noul') >= 0.5) = (e.value = 1)
             WHEN 'score'  THEN ROUND(json_extract(h.answers, '$."' || e.key || '".score')) = e.value
           END)                                                       AS jev_was_right
FROM history h
JOIN json_each(h.expected) e
LEFT JOIN payloads qs ON qs.hash = h.questions_hash AND h.kept = 1
GROUP BY question
ORDER BY marked DESC;
```

**Where one `choice` question goes wrong** — what Jev said against what it
should have said. Change `department` to your question's id:

```sql
SELECT json_extract(h.answers, '$.department.choice') AS jev_said,
       e.value                                         AS should_be,
       COUNT(*)                                        AS calls
FROM history h
JOIN json_each(h.expected) e ON e.key = 'department'
GROUP BY jev_said, should_be
ORDER BY calls DESC;
```

**One call in full**, with what was asked. As written it shows the latest
call; put an id from the dashboard or from `bridge.call_id` in its place:

```sql
SELECT h.id, datetime(h.ts / 1000, 'unixepoch', 'localtime') AS at,
       s.body AS state, qs.body AS questions, h.answers, h.verdict, h.note, h.expected
FROM history h
LEFT JOIN payloads s  ON s.hash  = h.state_hash     AND h.kept = 1
LEFT JOIN payloads qs ON qs.hash = h.questions_hash AND h.kept = 1
WHERE h.id = (SELECT id FROM history ORDER BY ts DESC LIMIT 1);  -- or: WHERE h.id = '29f8023b-15'
```

## Evaluating a model on your own calls

Every call you review becomes a labelled example. Two scripts in `examples/`
turn those into an evaluation you can re-run whenever TypeSafe releases a
model:

```bash
node examples/eval-set.mjs > eval.jsonl               # every reviewed call, one per line
node examples/replay.mjs eval.jsonl                   # score jev-latest against it
node examples/replay.mjs eval.jsonl jev-preview       # and the next model, before switching
```

```text
call        question    should be    was          now
3ef38033-1  is_urgent   true         true         true         right
3ef38033-1  department  "billing"    "billing"    "billing"    right
3ef38033-2  is_urgent   false        false        false        right
3ef38033-2  department  "technical"  "technical"  "technical"  right
3ef38033-3  is_urgent   false        false        false        right
3ef38033-3  department  "sales"      "sales"      "sales"      right
3ef38033-4  is_urgent   true         true         true         right
3ef38033-4  department  "technical"  "technical"  "technical"  right

8 of 8 answers right with jev-preview, against 8 of 8 when reviewed. 0 changed; 0 of 4 calls failed; 1442 input tokens.
```

That is a real run: four support tickets, reviewed by hand, replayed against
`jev-preview` — which agreed with `jev-latest` on every answer. When a model
does differ, the last column says how: `wrong`, `right, fixed` (wrong when
reviewed, right now) or `wrong, broke` (right when reviewed, wrong now). A
`broke` is the line to read before switching models.

- **What counts as the truth.** For each question, the answer the reviewer
  marked it should have been. On a call marked *correct*, a question the
  reviewer did not mark counts Jev's original answer as right. Anything else is
  not scored.
- **What is compared.** Decisions — yes or no, the option chosen, the nearest
  score level — not probabilities, which vary by about ±0.02 between identical
  calls.
- **What it costs.** One live call per line of the set, about $0.00002 each for
  a 400-token state. The replay goes straight to the API: it skips the cache,
  and adds nothing to the history.
- **`eval.jsonl` is yours to edit.** Add cases by hand, delete ones that no
  longer matter, keep one file per product area. `eval-set.mjs incorrect
  partial` exports only the calls that went wrong. Each line holds a state, so
  keep the file private; the repository ignores `*.jsonl`.

## Exporting

**A spreadsheet of calls** (no state text):

```bash
sqlite3 -cmd "PRAGMA query_only = ON" -csv -header ~/.jev-bridge/jev.db \
  "SELECT id, datetime(ts / 1000, 'unixepoch', 'localtime') AS at, resolved_model, cached, status,
          latency_ms, attempts, input_tokens, cost_usd, certainty, verdict, note, preview, digest
   FROM history ORDER BY ts" > jev-calls.csv
```

**The same, as JSON**, straight from the bridge, with its stats computed:

```bash
node src/server.mjs --history 30 > /dev/null 2> jev-history.json
```

(The command line writes its reports to stderr, because stdout is reserved for
the MCP protocol.)

**From Python**, with only the standard library:

```python
import json, os, sqlite3

db = sqlite3.connect(os.path.expanduser("~/.jev-bridge/jev.db"))
db.execute("PRAGMA query_only = ON")
db.row_factory = sqlite3.Row
for row in db.execute("SELECT id, latency_ms, certainty, verdict, answers FROM history WHERE cached = 0"):
    answers = json.loads(row["answers"] or "{}")
    print(row["id"], row["latency_ms"], row["certainty"], row["verdict"], sorted(answers))
```

`pandas.read_sql_query(sql, db)` accepts the same connection, and DuckDB can
attach the file with its SQLite extension. Point either at a snapshot rather
than the live file.

## From code

The bridge's own modules read the history the way the dashboard does, filters
and statistics included:

```js
import * as sqlite from 'node:sqlite';
import { openStore } from '/path/to/jev-bridge/src/store.mjs';
import { historyReport } from '/path/to/jev-bridge/src/history.mjs';

const store = openStore(`${process.env.HOME}/.jev-bridge/jev.db`, { sqlite });
const { stats, calls } = historyReport(store, { days: 30, filter: 'incorrect' });
console.log(stats.quality, calls.map((c) => c.id));

const one = store.getHistory(calls[0]?.id); // state, questions, answers, review
store.close();
```

`filter` takes `all`, `live`, `cached`, `errors`, `uncertain`, `slow`,
`unreviewed`, `reviewed`, `correct`, `partial` or `incorrect`. To record a
review from code, use `reviewCall(store, id, { verdict, note, expected })` from
the same module; it checks the verdict before anything is written.

## Things to keep in mind

- **The history prunes; `calls` does not.** A monthly trend from `history`
  silently loses its early weeks. Reviewed calls are the exception: they are
  never pruned.
- **Leave cache hits out of API performance.** A hit costs nothing and its
  latency is a local lookup. Filter on `cached = 0`.
- **Calls recorded on `meta` have no content.** `kept` is `0`, `preview` is
  empty, and `payloads` has nothing for them. Switching modes does not rewrite
  old rows.
- **Question ids belong to the caller.** Code that sends fixed questions keeps
  them stable; an agent often renames them. Group by the question's text when
  in doubt, as the per-question query above does.
- **Write reviews through the bridge.** `jev_review`, the dashboard and
  `reviewCall` validate what they store. An `UPDATE` by hand can put a verdict
  the tools do not understand into the table. To empty the history, use
  `--clear-history`, which removes the stored states with it.
