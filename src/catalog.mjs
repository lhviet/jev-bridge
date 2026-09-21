/**
 * Everything an MCP client is told about jev-bridge: the server instructions,
 * the five tools, the resources, the prompts. Data, not behaviour — the
 * handlers live in server.mjs.
 *
 * Written for how Claude Code reads it. With tool search on (the default), a
 * session starts with only tool NAMES and the server instructions, so the
 * instructions say when to go looking; each description and the instructions
 * are cut at 2 KB, so the part that matters comes first; and a tool is dropped
 * if its input schema is not valid JSON Schema 2020-12 or a top-level property
 * name falls outside [A-Za-z0-9_.-]{1,64}. test/protocol.test.mjs holds every
 * one of those limits.
 */
import { FILTER_NAMES, VERDICTS } from './history.mjs';

export const INSTRUCTIONS =
  'jev-bridge connects TypeSafe\'s Jev, a fast calibrated judgment model (not a chat model). Search for its tools ' +
  'whenever a task needs a probability or a pick over text or JSON rather than prose: classify or route a message, ' +
  'yes/no checks (urgent? contains PII? does the source support the claim?), pick one of N labels, grade against a ' +
  'rubric, rerank search results, choose the right candidate value, or gate an action on confidence.\n\n' +
  'Workflow: (1) jev_ask with EVERY independent question about the same state in ONE call. (2) Act on the numbers ' +
  'with explicit thresholds, and say how sure Jev was. (3) When the user or later evidence shows an answer right or ' +
  'wrong, record it with jev_review and the call_id. jev_history audits past calls (filter "uncertain" or "slow"); ' +
  'jev_usage reports spend and cache hits; jev_models lists model names and checks the API key.\n\n' +
  'The bridge holds the TypeSafe API key: never call api.typesafe.ai yourself or ask the user for the key. When the ' +
  'user wants Jev\'s judgment, report numbers that came back from jev_ask, not your own estimate. Before designing ' +
  'non-trivial questions, read the resource jev://guide. Prompts: review_uncertain, cost_report, question_design.';

/* ── shared schema pieces ────────────────────────────────────────────────── */

// The API takes text, or text given structure: `string | object | array`.
const TEXTISH = { type: ['string', 'object', 'array'] };
const INSTRUCTIONS_FIELD = {
  ...TEXTISH,
  description: 'The judgment to make, stated in full (ids are never sent to the model). A string, or an object with ' +
    'the question in one field and the data it cites in others, referenced by name in backticks.',
};
const PROBABILITIES = { type: 'object', additionalProperties: { type: 'number', minimum: 0, maximum: 1 } };
const CONFIDENCE = { type: 'number', minimum: 0, maximum: 1 };

const QUESTION = {
  description: 'One question. `type` picks the shape of `criteria`.',
  oneOf: [
    {
      title: 'noul: yes/no',
      type: 'object',
      properties: {
        type: { const: 'noul' },
        instructions: INSTRUCTIONS_FIELD,
        criteria: {
          type: 'object',
          description: 'Optional. What a yes and a no mean.',
          properties: { true: TEXTISH, false: TEXTISH },
          additionalProperties: false,
        },
      },
      required: ['type', 'instructions'],
      additionalProperties: false,
    },
    {
      title: 'choice: one of a set',
      type: 'object',
      properties: {
        type: { const: 'choice' },
        instructions: INSTRUCTIONS_FIELD,
        criteria: {
          type: 'object',
          description: 'option -> description (null when the name says it all). 2-255 options; include a "none" option when nothing may fit.',
          minProperties: 2,
          maxProperties: 255,
          additionalProperties: { type: ['string', 'object', 'array', 'null'] },
        },
      },
      required: ['type', 'instructions', 'criteria'],
      additionalProperties: false,
    },
    {
      title: 'score: a level on a rubric',
      type: 'object',
      properties: {
        type: { const: 'score' },
        instructions: INSTRUCTIONS_FIELD,
        criteria: {
          type: 'array',
          description: 'Ordered level descriptions, LOWEST FIRST, 2-10 of them, each a concrete situation.',
          minItems: 2,
          maxItems: 10,
          items: TEXTISH,
        },
      },
      required: ['type', 'instructions', 'criteria'],
      additionalProperties: false,
    },
  ],
};

const ANSWER = {
  oneOf: [
    {
      type: 'object',
      properties: { type: { const: 'noul' }, noul: { type: 'number', minimum: 0, maximum: 1, description: 'P(yes).' } },
      required: ['type', 'noul'],
    },
    {
      type: 'object',
      properties: { type: { const: 'choice' }, choice: { type: 'string' }, probabilities: PROBABILITIES, confidence: CONFIDENCE },
      required: ['type', 'choice', 'probabilities', 'confidence'],
    },
    {
      type: 'object',
      properties: {
        type: { const: 'score' },
        score: { type: 'number', description: 'Probability-weighted level index; can fall between levels.' },
        legend: { type: 'object', description: 'Level index -> its description.' },
        probabilities: PROBABILITIES,
        confidence: CONFIDENCE,
      },
      required: ['type', 'score', 'legend', 'probabilities', 'confidence'],
    },
  ],
};

const USAGE = {
  type: 'object',
  properties: {
    window_days: { type: 'integer' },
    calls: { type: 'integer' },
    live_calls: { type: 'integer' },
    cache_hits: { type: 'integer' },
    hit_rate: { type: 'number' },
    errors: { type: 'integer' },
    input_tokens: { type: 'integer' },
    output_tokens: { type: 'integer' },
    cost_usd: { type: 'number' },
    saved_input_tokens: { type: 'integer' },
    saved_usd: { type: 'number' },
    avg_live_latency_ms: { type: ['number', 'null'] },
    by_day: { type: 'array', items: { type: 'object' } },
    models: { type: 'array', items: { type: 'object' } },
    cache: { type: 'object' },
    store: { type: 'string' },
  },
  required: ['window_days', 'calls', 'live_calls', 'cache_hits', 'cost_usd'],
};

const HISTORY_REPORT = {
  type: 'object',
  properties: {
    window_days: { type: 'number' },
    filter: { type: 'string' },
    history: { type: 'string', description: 'full, meta or off: how much the bridge keeps.' },
    stats: { type: 'object', description: 'performance, efficiency (hit rate, re-sent states, retries) and quality (reviews, accuracy).' },
    total: { type: 'integer', description: 'Calls the filter matched; `calls` holds the first `limit`.' },
    calls: { type: 'array', items: { type: 'object' } },
  },
  required: ['window_days', 'filter', 'stats', 'total', 'calls'],
};

const HISTORY_CALL = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    ts: { type: 'number' },
    client: { type: ['string', 'null'] },
    state: { description: 'As sent; null when history is "meta".' },
    questions: { description: 'As sent; null when history is "meta".' },
    answers: { type: ['object', 'null'] },
    verdict: { type: ['string', 'null'] },
    expected: { type: ['object', 'null'] },
  },
  required: ['id', 'ts'],
};

/* ── tools ───────────────────────────────────────────────────────────────── */

/**
 * Annotations are hints a client may show or act on (MCP spec, ToolAnnotations).
 * jev_ask is read-only in the sense that matters — it changes nothing the user
 * owns — but open-world: it reaches TypeSafe and is billed per input token.
 */
export const TOOLS = [
  {
    name: 'jev_ask',
    title: 'Ask Jev for calibrated judgments',
    description:
      'Ask TypeSafe\'s Jev for calibrated, typed judgments about a `state` (text or JSON): probabilities and picks to ' +
      'threshold, never prose. For classifying or routing, yes/no checks, picking one of N, grading on a rubric, ' +
      'reranking passages, checking a claim against a source, choosing the right candidate value.\n\n' +
      '`questions` maps your own id -> a question of one of three types:\n' +
      '- noul: yes/no. Returns `noul` = P(yes), 0..1. Use one noul per label when several can be true. 0.5 means ' +
      'torn, not "medium".\n' +
      '- choice: one of a set. `criteria` = {option: description or null}, 2-255 options; add a "none" option when ' +
      'nothing may fit. Returns `choice`, `probabilities`, `confidence`.\n' +
      '- score: a level on a rubric. `criteria` = array of 2-10 concrete levels, LOWEST FIRST. Returns `score` ' +
      '(can fall between levels), `legend`, `probabilities`, `confidence`.\n\n' +
      'Rules: put EVERY independent question about one state in ONE call; they run in parallel on one read of the ' +
      'state, far cheaper than separate calls. Ids are never sent to the model: write the whole question in ' +
      '`instructions`, and point at nested state with backticked paths like `ticket.body`. Keep arithmetic, counting ' +
      'and date comparison in code. To rank candidates, give each its own score against the query in the same call. ' +
      'Limits: state + longest question <= 32k tokens; whole request <= 64k.\n\n' +
      'A repeated request is answered from a local cache at no cost (`bridge.cached`). Keep `bridge.call_id`: pass it ' +
      'to jev_review once you learn whether an answer was right. Full guide: resource jev://guide.',
    inputSchema: {
      type: 'object',
      properties: {
        state: {
          type: ['string', 'object', 'array'],
          description: 'What to judge: a string, or a JSON object/array (named fields beat one blob). Text only. ' +
            'Send only what the questions need; irrelevant detail lowers accuracy.',
        },
        questions: {
          type: 'object',
          description: 'Your question id -> question. Answers come back under the same ids.',
          minProperties: 1,
          additionalProperties: QUESTION,
        },
        model: {
          type: 'string',
          description: 'Default "jev-latest". "jev-preview" for the newest build; a versioned id such as "jev-1.13.0" to ' +
            'pin one you tuned thresholds against. jev_models lists the names.',
          examples: ['jev-latest', 'jev-preview', 'jev-1.13.0'],
        },
        cache: {
          type: 'boolean',
          description: 'Default true. false forces a live call (for measuring, not deciding) and refreshes the stored answer.',
        },
      },
      required: ['state', 'questions'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'The versioned model that answered, e.g. jev-1.13.0.' },
        answers: { type: 'object', additionalProperties: ANSWER },
        usage: {
          type: 'object',
          properties: { input_tokens: { type: 'integer' }, output_tokens: { type: 'integer' } },
          description: 'From TypeSafe. On a cache hit, the original call\'s usage.',
        },
        bridge: {
          type: 'object',
          properties: {
            cached: { type: 'boolean' },
            latency_ms: { type: 'number' },
            cost_usd: { type: 'number', description: 'What THIS call cost: 0 on a cache hit.' },
            call_id: { type: 'string', description: 'This call in jev_history; pass to jev_review. Absent when history is off.' },
            attempts: { type: 'integer', description: 'HTTP attempts; more than 1 after a retry.' },
            request_id: { type: 'string', description: 'TypeSafe\'s x-typesafe-request-id, for support.' },
          },
          required: ['cached', 'latency_ms', 'cost_usd'],
        },
      },
      required: ['model', 'answers', 'bridge'],
    },
    annotations: { title: 'Ask Jev', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'jev_usage',
    title: 'Jev spend and cache hits',
    description:
      'What Jev has cost over the last N days, from the bridge\'s local log: calls, live calls, cache hits and hit ' +
      'rate, errors, input tokens, USD spent, USD the cache saved, average live latency, per day and per model. Use ' +
      'it before scaling a workflow up, or to check the cache is earning its place.',
    inputSchema: {
      type: 'object',
      properties: { days: { type: 'integer', minimum: 1, maximum: 365, default: 7, description: 'Window in days.' } },
      additionalProperties: false,
    },
    outputSchema: USAGE,
    annotations: { title: 'Jev usage', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'jev_history',
    title: 'Audit past Jev calls',
    description:
      'Look back at earlier jev_ask calls. Without `id`: stats for the window (p50/p95 latency, cache hits, retries, ' +
      'live calls that re-sent a state and should have been batched, reviewed accuracy) plus the matching calls, each ' +
      'with its client, the start of its state and its answers on one line. With `id` (a bridge.call_id): that call in ' +
      'full: state, questions, answers, timing, cost, review. filter "uncertain" lists the calls Jev was least sure of ' +
      'first; "slow" the slowest; "unreviewed" the ones still to judge.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'A bridge.call_id. Returns that one call in full; the other fields are ignored.' },
        days: { type: 'integer', minimum: 1, maximum: 3650, default: 7, description: 'Window in days.' },
        filter: { type: 'string', enum: FILTER_NAMES, default: 'all', description: 'Which calls to list. "all" is newest first.' },
        below: { type: 'number', minimum: 0, maximum: 1, default: 0.6, description: 'Certainty cut-off for "uncertain".' },
        q: { type: 'string', description: 'Only calls whose state or answers contain this text.' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 20, description: 'Most calls to list.' },
      },
      additionalProperties: false,
    },
    outputSchema: { type: 'object', anyOf: [HISTORY_REPORT, HISTORY_CALL] },
    annotations: { title: 'Jev history', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    // A 200-call report runs to ~80k characters; let Claude Code keep it inline.
    _meta: { 'anthropic/maxResultSizeChars': 150_000 },
  },
  {
    name: 'jev_review',
    title: 'Record whether a Jev answer was right',
    description:
      'Record the truth about a past jev_ask call once it is known: the user corrected it, or the evidence says ' +
      'otherwise. `verdict` is correct, partial or incorrect; `expected` maps question id -> the answer it should ' +
      'have been (e.g. {"department": "technical"}); `note` says why. verdict null withdraws a review. Reviewed ' +
      'calls are never pruned and give jev_history its accuracy.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The bridge.call_id of the call being judged.' },
        verdict: { type: ['string', 'null'], enum: [...VERDICTS, null] },
        note: { type: 'string', description: 'Why, in a sentence.' },
        expected: { type: 'object', description: 'Question id -> the answer it should have been.' },
      },
      required: ['id', 'verdict'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        verdict: { type: ['string', 'null'] },
        note: { type: ['string', 'null'] },
        expected: { type: ['object', 'null'] },
        reviewed_at: { type: ['number', 'null'] },
      },
      required: ['id', 'verdict'],
    },
    annotations: { title: 'Review a Jev call', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'jev_models',
    title: 'List TypeSafe models',
    description:
      'Check that the TypeSafe API key works, and list the model names it may send in jev_ask\'s `model` field, with ' +
      'a description and release date. No arguments; the bridge holds the key. Lists aliases; versioned ids such as ' +
      'jev-1.13.0 are accepted whether listed or not.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: {
      type: 'object',
      properties: {
        models: {
          type: 'array',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, description: { type: 'string' }, release_date: { type: 'string' } },
            required: ['name'],
          },
        },
      },
      required: ['models'],
    },
    annotations: { title: 'Jev models', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
];

/* ── resources ───────────────────────────────────────────────────────────── */

export const GUIDE_URI = 'jev://guide';

/** Condensed from docs.typesafe.ai; the links go to the source of each rule. */
export const GUIDE = `# Designing Jev questions

This guide is for writing a **jev_ask** request. Design the questions here, then
send them with jev_ask: the judgment comes back from Jev, not from your own reading.

Jev is a System One model: it makes fast, calibrated judgments about a *state* and
returns typed answers. It does not generate text or reason step by step. Give it
one snap judgment per question, and keep the workflow, arithmetic and policy in code.

## The request

\`\`\`json
{
  "state": {"message": "Help! My payouts have been failing for 3 days.", "plan": "Pro"},
  "questions": {
    "urgent":   {"type": "noul",   "instructions": "Does \`message\` convey urgency?"},
    "team":     {"type": "choice", "instructions": "Which team should handle \`message\`?",
                 "criteria": {"billing": "Payments, invoicing, refunds",
                              "technical": "Bugs, outages, integrations",
                              "sales": "Pricing, upgrades", "none": null}},
    "severity": {"type": "score",  "instructions": "How severe is the problem in \`message\`?",
                 "criteria": ["Cosmetic, no impact", "Degraded, has a workaround",
                              "Blocked, no workaround", "Money or data being lost"]}
  }
}
\`\`\`

## Pick the type by the answer you need

| Type | Use when | Returns |
| --- | --- | --- |
| noul | a condition holds or not | \`noul\` = P(yes), 0..1. No confidence field. |
| choice | exactly one option from a set, no order | \`choice\`, \`probabilities\` over every option, \`confidence\` |
| score | a position on levels you describe | \`score\` (can land between levels), \`legend\`, \`probabilities\`, \`confidence\` |

- Several labels can be true at once: one **noul per label**, not a choice.
- A noul near 0.5 means yes and no are about equally likely, not "medium".
  To measure a degree, use a score with defined levels.
- Give a choice a **none / other** option when the list may not cover the input,
  or Jev is forced into a confident wrong pick.
- Score levels are **ordered, lowest first**, 2 to 10 of them, each a concrete
  situation that stands on its own. Do not interpolate numbers between levels.
- **Ranking** (search results, candidates): one score per candidate against the
  same query, all in one call, then sort in code. Don't filter with nouls first and
  score the survivors in a second call.

## Write questions Jev reads literally

- **Question ids are never sent to the model.** Put the whole question in \`instructions\`.
- Point at parts of a structured state with backticked paths: \`ticket.messages[0].text\`.
- State the exact condition; put boundary cases in \`criteria\`. Jev answers what
  you wrote, not what you meant. Align criteria with the instruction (a noul whose
  \`true\` means "no" does worse).
- \`instructions\` and \`criteria\` may be objects or arrays when definitions,
  contrasts or examples make them clearer.
- Keep **counting, maths and date comparison in code**. Extract the parts
  (for a date: day, month and year as choices, each with "not stated") and compute.
- **Select, don't generate.** Find the candidate values first (every date or
  amount in the text), then ask Jev a choice over them, with a "none" option, and
  copy the chosen value verbatim.
- Send only the state the questions need. Irrelevant detail lowers accuracy.

## Batch, then decide in code

- Put **every independent question about the same state in one call**, including
  speculative ones only some inputs need. They run in parallel on one read of the
  state: TypeSafe measured 13 questions in one call at 12x cheaper and 10x faster
  than 13 calls, with the same answers.
- Make a second call only when an answer is needed to fetch new evidence, build a
  new state, or choose the next options.
- Split a broad judgment ("rate this pitch") into narrow scores and weight them in
  code. Changing a weight or threshold then costs no new call.
- Choice and score \`confidence\` says how peaked the distribution is. Use it to
  decide when to act and when to escalate to a person. Tune thresholds on your data.
- Typed output guarantees the interface, not the truth. Record what you learn with
  jev_review so jev_history can report accuracy.

## Limits (jev-1.13)

- Text only: a string, a JSON object, or an array. Convert images, audio and binaries first.
- 64k tokens per request; 32k for the state plus the longest single question.
- choice: at most 255 options. score: 2 to 10 levels.
- English is where accuracy is best. Test other languages before relying on them.
- Aliases: \`jev-latest\` (stable), \`jev-preview\` (newest). Pin a versioned id
  such as \`jev-1.13.0\` once thresholds are tuned against it.

## Sources

- API reference: https://docs.typesafe.ai/api
- Primitives: https://docs.typesafe.ai/primitives (choice, score, noul pages)
- Confidence: https://docs.typesafe.ai/confidence
- Speculative fan-out: https://docs.typesafe.ai/patterns/fan-out
- Models and limits: https://docs.typesafe.ai/models
- Known weaknesses: https://docs.typesafe.ai/model-jaggedness/jev-1.13
`;

/**
 * Fixed resources. `ttlMs` and `cacheScope` are the 2026-07-28 caching hints:
 * the guide is the same for everyone and changes only with a release; the rest
 * is this user's data and changes with every call.
 */
export const RESOURCES = [
  {
    uri: GUIDE_URI,
    name: 'guide',
    title: 'Designing Jev questions',
    description: 'How to choose noul, choice or score, write criteria Jev reads literally, batch questions, and read confidence. Read before designing non-trivial questions.',
    mimeType: 'text/markdown',
    annotations: { audience: ['assistant', 'user'], priority: 0.9 },
    cache: { ttlMs: 86_400_000, cacheScope: 'public' },
  },
  {
    uri: 'jev://models',
    name: 'models',
    title: 'TypeSafe models',
    description: 'The model names and aliases this API key may use, fetched live from TypeSafe.',
    mimeType: 'application/json',
    annotations: { audience: ['assistant', 'user'], priority: 0.4 },
    cache: { ttlMs: 3_600_000, cacheScope: 'private' },
  },
  {
    uri: 'jev://usage',
    name: 'usage',
    title: 'Jev usage, last 7 days',
    description: 'Calls, cache hits, tokens and spend over the last 7 days, as jev_usage returns them.',
    mimeType: 'application/json',
    annotations: { audience: ['user', 'assistant'], priority: 0.5 },
    cache: { ttlMs: 0, cacheScope: 'private' },
  },
  {
    uri: 'jev://history',
    name: 'history',
    title: 'Recent Jev calls',
    description: 'The last 20 calls of the past 7 days with stats, as jev_history returns them.',
    mimeType: 'application/json',
    annotations: { audience: ['user', 'assistant'], priority: 0.5 },
    cache: { ttlMs: 0, cacheScope: 'private' },
  },
];

export const TEMPLATES = [
  {
    uriTemplate: 'jev://history/{id}',
    name: 'call',
    title: 'One Jev call in full',
    description: 'A past jev_ask call by its bridge.call_id: state, questions, answers, timing, cost and review.',
    mimeType: 'application/json',
  },
];

/* ── prompts ─────────────────────────────────────────────────────────────── */

// Claude Code runs a prompt as /mcp__<server>__<prompt> and splits its
// arguments on whitespace, so every argument here is a single token.
export const PROMPTS = [
  {
    name: 'review_uncertain',
    title: 'Review the calls Jev was least sure of',
    description: 'Walk the least certain recent jev_ask calls, judge each against the evidence, and record verdicts with jev_review.',
    arguments: [
      { name: 'days', description: 'How far back to look. Default 7.', required: false },
      { name: 'below', description: 'Certainty cut-off, 0..1. Default 0.6.', required: false },
    ],
  },
  {
    name: 'cost_report',
    title: 'Report what Jev cost, and how to spend less',
    description: 'Summarise spend, cache hits, latency and batching misses from jev_usage and jev_history, with concrete savings.',
    arguments: [{ name: 'days', description: 'Window in days. Default 7.', required: false }],
  },
  {
    name: 'question_design',
    title: 'Design Jev questions for the task at hand',
    description: 'Load the question-design guide, then draft the jev_ask request for the task in this conversation.',
    arguments: [],
  },
];
