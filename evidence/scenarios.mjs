/**
 * The recorded Claude Code sessions: what each asks, and what it must show.
 *
 * Prompts say what a user wants and never name a tool, so choosing and
 * calling the tools is the agent's job. `expect` lists checks that
 * evidence/report.mjs runs against the recorded wire log; a check that fails
 * is reported as failed, not hidden.
 */

/** Claude Code speaks 2025-11-25 to a stdio server unless told to negotiate; these make it try 2026-07-28 first. */
export const MODERN_ENV = { MCP_SDK_GENERATION: 'v2', MCP_PROTOCOL_NEGOTIATION: 'auto' };

const asked = (w) => w.calls.filter((c) => c.name === 'jev_ask');
const questionCount = (c) => Object.keys(c.args?.questions ?? {}).length;

const legacyHandshake = { label: 'Claude Code opened with initialize (2025-11-25)', test: (w) => w.handshake === 'initialize' && w.negotiated === '2025-11-25' };
const modernHandshake = {
  label: 'server/discover answered; no initialize; every request carried _meta protocolVersion 2026-07-28',
  test: (w) => w.handshake === 'server/discover' && !w.methods.includes('initialize') && w.allModern,
};
const noErrors = { label: 'no tool call ended in isError, and no JSON-RPC error', test: (w) => w.calls.every((c) => !c.isError) && w.errors.length === 0 };

export const SCENARIOS = [
  {
    name: 'legacy-multilabel',
    title: 'Several labels at once, instructions only',
    about: 'Default Claude Code (2025-11-25 handshake) with every skill disabled, so only the server\'s instructions, descriptions and guide steer the agent. Four labels that can all be true, plus urgency.',
    env: {},
    args: ['--disable-slash-commands'],
    prompt: 'A customer wrote: "Third time this week the export button does nothing. I\'m on the Pro plan paying $40/mo and I want a refund if this isn\'t fixed today." '
      + 'Which of these apply: bug report, billing question, refund request, churn risk? And how urgent is it? I want calibrated probabilities, not your impression.',
    expect: [
      legacyHandshake,
      { label: 'one jev_ask call holding all 5 judgments (batched)', test: (w) => asked(w).length === 1 && questionCount(asked(w)[0]) >= 5 },
      { label: 'the labels were asked as separate nouls, since several can be true', test: (w) => Object.values(asked(w)[0]?.args.questions ?? {}).filter((q) => q.type === 'noul').length >= 4 },
      noErrors,
    ],
  },
  {
    name: 'modern-rerank',
    title: 'Reranking search results over 2026-07-28',
    about: 'Claude Code negotiating MCP 2026-07-28: server/discover, per-request _meta, no initialize. Rerank four passages against a query.',
    env: MODERN_ENV,
    args: [],
    prompt: 'My search for "how do I rotate the API key without downtime?" returned these passages. Rank them by how well they actually answer the question, with a calibrated score for each.\n'
      + 'a) "API keys are created in the console under Settings > Keys."\n'
      + 'b) "To rotate without downtime, create a second key, deploy it everywhere, then revoke the old one; both keys work during the overlap."\n'
      + 'c) "Keys should be rotated every 90 days as a security best practice."\n'
      + 'd) "Our uptime SLA is 99.95% for paid plans."',
    expect: [
      modernHandshake,
      { label: 'one jev_ask call scoring every passage (batched)', test: (w) => asked(w).length === 1 && questionCount(asked(w)[0]) >= 4 },
      noErrors,
    ],
  },
  {
    name: 'modern-review-workflow',
    title: 'Judge, record the truth, audit',
    about: 'MCP 2026-07-28, four tools in sequence: route a ticket, record the known truth against that exact call, then report cost and uncertain calls.',
    env: MODERN_ENV,
    args: [],
    prompt: 'Route this support ticket to billing, technical or sales: "The API returns a 500 error every time I upload an invoice PDF." '
      + 'Then, whatever it picked: I already know the right team is technical, so record that as the truth for this exact call in the review log. '
      + 'Finally tell me what these judgments have cost so far and list any past calls it was unsure about.',
    expect: [
      modernHandshake,
      { label: 'jev_ask routed the ticket with a choice', test: (w) => Object.values(asked(w)[0]?.args.questions ?? {}).some((q) => q.type === 'choice') },
      {
        label: 'jev_review named the call_id jev_ask returned, with expected = technical',
        test: (w) => {
          const review = w.calls.find((c) => c.name === 'jev_review');
          return !!review && review.args.id === asked(w)[0]?.result?.bridge?.call_id && Object.values(review.args.expected ?? {}).includes('technical');
        },
      },
      { label: 'jev_usage and jev_history were both used for the audit', test: (w) => ['jev_usage', 'jev_history'].every((n) => w.calls.some((c) => c.name === n)) },
      noErrors,
    ],
  },
  {
    name: 'prompt-cost-report',
    title: 'An MCP prompt as a slash command',
    about: '/mcp__jev__cost_report 1 — Claude Code fetches the prompt with prompts/get, and the rendered prompt drives the usage and history tools.',
    env: {},
    args: [],
    prompt: '/mcp__jev__cost_report 1',
    expect: [
      legacyHandshake,
      { label: 'prompts/get cost_report with days = "1"', test: (w) => w.prompts.some((p) => p.name === 'cost_report' && p.arguments?.days === '1') },
      { label: 'the prompt\'s steps ran: jev_usage and jev_history with days 1', test: (w) => ['jev_usage', 'jev_history'].every((n) => w.calls.some((c) => c.name === n && c.args.days === 1)) },
      noErrors,
    ],
  },
  {
    name: 'resource-guide',
    title: 'A resource read, then applied',
    about: 'The jev://guide resource read (resources/read), then its "select, don\'t generate" rule applied through jev_ask.',
    env: {},
    args: [],
    prompt: 'Read @jev:jev://guide, then have Jev find the delivery date in: "Ordered 3 Jan, dispatched 5 Jan, and it should reach you by 11 Jan. Returns close 25 Jan." '
      + 'Tell me which rule from the guide you followed.',
    expect: [
      { label: 'resources/read jev://guide', test: (w) => w.reads.includes('jev://guide') },
      { label: 'jev_ask with a choice over the candidate dates', test: (w) => asked(w).some((c) => Object.values(c.args.questions ?? {}).some((q) => q.type === 'choice')) },
      noErrors,
    ],
  },
  {
    name: 'resource-guide-haiku',
    title: 'The same, on Haiku, asked loosely',
    about: 'Claude Haiku 4.5 with a looser prompt that never asks for Jev by name: does a small model still route the judgment through jev_ask?',
    env: {},
    args: [],
    model: 'haiku',
    prompt: 'Read @jev:jev://guide, then use it to find the delivery date in: "Ordered 3 Jan, dispatched 5 Jan, and it should reach you by 11 Jan. Returns close 25 Jan." '
      + 'Tell me which rule from the guide you followed.',
    expect: [
      { label: 'resources/read jev://guide', test: (w) => w.reads.includes('jev://guide') },
      { label: 'jev_ask was called to make the judgment', test: (w) => asked(w).length > 0 },
    ],
  },
  {
    name: 'modern-models',
    title: 'Checking the key, on Haiku',
    about: 'MCP 2026-07-28 on Claude Haiku 4.5: the models endpoint as a tool, to check the key and list model names.',
    env: MODERN_ENV,
    args: [],
    model: 'haiku',
    prompt: 'Is my TypeSafe API key working, and which Jev model names can I use?',
    expect: [
      modernHandshake,
      { label: 'jev_models answered with the model list', test: (w) => w.calls.some((c) => c.name === 'jev_models' && Array.isArray(c.result?.models)) },
      noErrors,
    ],
  },
];
