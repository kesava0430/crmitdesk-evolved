/**
 * The AI feature catalogue.
 *
 * Every AI capability in the product is described here once, and the UI reads
 * from this file rather than repeating (or omitting) the explanation next to
 * each button. An audit found 20 of 32 AI touchpoints had no user-facing
 * explanation at all, and only three places anywhere in the client told the
 * user what record data actually gets sent to the model.
 *
 * Four fields matter most and are required for every entry:
 *
 *   `does`   — what the user gets, in plain language.
 *   `sends`  — what leaves your server and goes to the AI provider. This is the
 *              question a customer's security reviewer asks first, and it was
 *              previously unanswerable from the UI.
 *   `effect` — 'advisory' (you see a suggestion and decide) or 'writes' (the
 *              product changes a record for you). Four features write without
 *              asking; users deserve to know which.
 *   `tier`   — 'free' or 'paid'. Paid features are blocked on the Free plan by
 *              `requireFeature('ai')`, so the label prevents a confusing 402.
 *
 * KEEP IN SYNC with the server: `server/src/utils/ai.ts`,
 * `server/src/modules/ai/ai.routes.ts` (which routes are `requireFeature`-gated),
 * and `server/src/utils/rag.ts`. If you change a prompt's inputs, update `sends`.
 */

export type AiEffect = 'advisory' | 'writes';
export type AiTier = 'free' | 'paid';

export interface AiFeature {
  /** Stable key used by <AiInfo id="…" />. Namespaced by area. */
  id: string;
  /** Short title, matching the button or panel it sits beside. */
  name: string;
  does: string;
  sends: string;
  effect: AiEffect;
  tier: AiTier;
  /** What you get when no AI provider is configured, or the call fails. */
  fallback?: string;
  /** Anything a user should know before clicking. Rendered as a caution. */
  caveat?: string;
}

/* Written as an array so the AI Governance page can list every feature in one
   table; `AI_FEATURE` below gives O(1) lookup by id. */
export const AI_FEATURES: AiFeature[] = [
  // ── Command bar & search ──────────────────────────────────────────────
  {
    id: 'command.bar',
    name: 'AI Command',
    does: 'Turns a plain-English instruction into either a prefilled create form or a single, named action you confirm before it runs.',
    sends: 'Your typed command, plus lists of names and IDs from your workspace (deals, tickets, contacts, users, categories, and pending leave requests) so the AI can match a name you typed to the right record.',
    effect: 'advisory',
    tier: 'paid',
    fallback: 'Says it could not understand the command; nothing runs.',
    caveat: 'Actions are checked against your role on the server before running — the AI cannot grant itself permissions.',
  },
  {
    id: 'search.interpret',
    name: 'Smart search',
    does: 'Reads your search box text and works out the filters you meant — for example "urgent open tickets" becomes a priority and status filter rather than a text match.',
    sends: 'Only the text you typed into the search box. No record data.',
    effect: 'advisory',
    tier: 'free',
    fallback: 'Falls back to an ordinary keyword search, so search always works.',
  },

  // ── Dashboard ─────────────────────────────────────────────────────────
  {
    id: 'dashboard.query',
    name: 'Ask AI about your data',
    does: 'Answers questions about your pipeline and help desk in two or three sentences.',
    sends: 'Only summary totals — counts of open deals, tickets, leads and forecast revenue. No names, emails or individual records.',
    effect: 'advisory',
    tier: 'paid',
    fallback: 'Tells you AI is not configured.',
  },
  {
    id: 'dashboard.insights',
    name: 'AI Insights',
    does: 'Looks across your CRM and help desk numbers and flags three to five things worth attention.',
    sends: 'Only summary totals. No names, emails or individual records.',
    effect: 'advisory',
    tier: 'paid',
    fallback: 'Shows no insights rather than an error.',
  },
  {
    id: 'meeting.notes',
    name: 'Parse meeting notes',
    does: 'Reads pasted notes and pulls out the contacts, leads, deals and next steps it can find.',
    sends: 'The full text you paste. If your notes name people outside your company, those names are sent to the AI provider.',
    effect: 'advisory',
    tier: 'paid',
    fallback: 'Returns nothing found.',
    caveat: 'Nothing is created automatically — you review the results and create records yourself.',
  },

  // ── Leads ─────────────────────────────────────────────────────────────
  {
    id: 'lead.score',
    name: 'Lead score',
    does: 'Rates how likely a lead is to convert, 0–100, with a one-line reason.',
    sends: "The lead's name, company, job title, source, status and notes.",
    effect: 'writes',
    tier: 'free',
    fallback: 'Leaves the lead unscored rather than storing a placeholder.',
    caveat: 'Saves the score onto the lead straight away. It is guidance, not a decision — re-score any time.',
  },
  {
    id: 'lead.bulkScore',
    name: 'Score all leads',
    does: 'Scores every unscored lead in one go, up to 50 at a time.',
    sends: "Each lead's name, company, job title, source and status.",
    effect: 'writes',
    tier: 'paid',
    fallback: 'Leaves leads unscored.',
    caveat: 'Writes a score onto many leads at once with no per-lead confirmation.',
  },
  {
    id: 'lead.followUp',
    name: 'AI follow-up email',
    does: "Drafts a personalised follow-up email based on the lead's details and notes.",
    sends: "The lead's name, company, job title, source and notes.",
    effect: 'advisory',
    tier: 'paid',
    fallback: 'Gives you a plain subject line to write from.',
    caveat: 'Nothing is sent. The draft is yours to copy, edit and send.',
  },
  {
    id: 'lead.nurture',
    name: 'AI nurture sequence',
    does: 'Drafts a three-step email sequence, spaced over days 1, 4 and 10.',
    sends: "The lead's name, company, job title and status.",
    effect: 'advisory',
    tier: 'paid',
    fallback: 'Returns no sequence.',
    caveat: 'Nothing is scheduled or sent — these are drafts.',
  },

  // ── Deals ─────────────────────────────────────────────────────────────
  {
    id: 'deal.winProbability',
    name: 'Win probability',
    does: 'Estimates the chance of winning the deal and names the factors behind it.',
    sends: "The deal's title, value, stage, age and your own manual probability.",
    effect: 'advisory',
    tier: 'paid',
    fallback: "Falls back to the probability you set manually.",
  },
  {
    id: 'deal.followUp',
    name: 'Follow-up email',
    does: 'Drafts a follow-up email for this deal.',
    sends: "The deal's title, value, stage and contact name.",
    effect: 'advisory',
    tier: 'paid',
    caveat: 'Nothing is sent — copy and edit before using it.',
  },
  {
    id: 'deal.toneCheck',
    name: 'Tone check',
    does: 'Reads a draft email and reports how it will land, with suggested improvements.',
    sends: 'The email text you paste in.',
    effect: 'advisory',
    tier: 'paid',
    fallback: 'Reports no issues — so treat a silent pass as "not checked", not as approval.',
  },
  {
    id: 'deal.pipelineHealth',
    name: 'Pipeline health',
    does: 'Summarises the pipeline and lists its main risks and opportunities.',
    sends: 'Deal titles, values and stages across your pipeline.',
    effect: 'advisory',
    tier: 'paid',
  },

  // ── Contacts ──────────────────────────────────────────────────────────
  {
    id: 'contact.churnRisk',
    name: 'Churn risk',
    does: 'Estimates how likely this customer is to leave, and why.',
    sends: "The contact's name, company, recent activity count and their recent support tickets.",
    effect: 'advisory',
    tier: 'paid',
    fallback: 'Reports low risk — treat that as "not assessed" rather than good news.',
  },
  {
    id: 'contact.health',
    name: 'Contact health',
    does: 'Grades the overall relationship A–F with recommendations.',
    sends: "The contact's name, company, deal history and support ticket counts.",
    effect: 'advisory',
    tier: 'paid',
  },
  {
    id: 'deal.closeDate',
    name: 'Predicted close date',
    does: 'Predicts when this deal will close, based on its stage and how long similar deals took.',
    sends: "The deal's title, value, stage, age and your historical average close time.",
    effect: 'advisory',
    tier: 'paid',
  },
  {
    id: 'competitors.detect',
    name: 'Competitor mentions',
    does: 'Spots competitors named in a piece of text and how they were talked about.',
    sends: 'The text you provide, plus any competitor names you list.',
    effect: 'advisory',
    tier: 'paid',
  },

  // ── Tickets ───────────────────────────────────────────────────────────
  {
    id: 'ticket.duplicate',
    name: 'Duplicate check',
    does: 'While you type a ticket title, checks whether a similar ticket already exists.',
    sends: 'The title you are typing, plus the titles of up to 20 recent open tickets.',
    effect: 'advisory',
    tier: 'paid',
    caveat: 'Runs automatically as you type, once the title reaches 10 characters.',
  },
  {
    id: 'ticket.sentiment',
    name: 'Detect sentiment',
    does: 'Classifies the ticket as positive, neutral, negative or frustrated.',
    sends: "The ticket's subject and description.",
    effect: 'writes',
    tier: 'free',
    fallback: 'Records neutral.',
    caveat: 'Saves the result onto the ticket immediately.',
  },
  {
    id: 'ticket.reply',
    name: 'AI reply suggestion',
    does: 'Drafts a reply to the customer.',
    sends: "The ticket's subject, description and extracts from published knowledge base articles.",
    effect: 'advisory',
    tier: 'paid',
    caveat: 'Nothing is sent to the customer — review and edit before replying.',
  },
  {
    id: 'ticket.autoRoute',
    name: 'AI auto-routing',
    does: 'Picks the best category and agent for this ticket.',
    sends: "The ticket's subject and description, plus your category names and agent names.",
    effect: 'writes',
    tier: 'free',
    fallback: 'Changes nothing.',
    caveat: 'Reassigns the ticket as soon as you click — there is no confirmation step. The category and agent are checked against your real lists, so it can only pick one that exists.',
  },
  {
    id: 'ticket.summarize',
    name: 'Thread summary',
    does: 'Summarises a long ticket thread: the issue, what was tried, where it stands and what is next.',
    sends: 'The full comment thread, including the names of everyone who commented.',
    effect: 'advisory',
    tier: 'paid',
  },
  {
    id: 'ticket.estimate',
    name: 'Resolution estimate',
    does: 'Estimates how long this ticket will take to resolve.',
    sends: "The ticket's subject, description, priority and category.",
    effect: 'advisory',
    tier: 'paid',
  },
  {
    id: 'ticket.slaRisk',
    name: 'SLA risk',
    does: 'Predicts whether this ticket is heading for an SLA breach.',
    sends: "The ticket's priority, age, status and SLA target.",
    effect: 'advisory',
    tier: 'paid',
  },
  {
    id: 'ticket.kbArticle',
    name: 'Generate KB article',
    does: 'Turns a resolved ticket and its thread into a draft knowledge base article.',
    sends: 'The full comment thread, including commenter names.',
    effect: 'advisory',
    tier: 'paid',
    caveat: 'No article is created — you copy the draft and publish it yourself.',
  },
  {
    id: 'ticket.autoTag',
    name: 'Auto-tag',
    does: 'Suggests three to six keyword tags for the ticket.',
    sends: "The ticket's subject and description.",
    effect: 'advisory',
    tier: 'free',
  },

  // ── Knowledge base (RAG) ──────────────────────────────────────────────
  {
    id: 'knowledge.ask',
    name: 'Ask the knowledge base',
    does: 'Answers from your own indexed documents, and cites the passages it used.',
    sends: 'Your question, plus the passages retrieved from your knowledge base.',
    effect: 'advisory',
    tier: 'paid',
    fallback: 'Says it could not find the answer rather than guessing.',
    caveat: 'Retrieval filters by your permissions before ranking, so you never see a passage from a document you are not allowed to read.',
  },
  {
    id: 'knowledge.index',
    name: 'Knowledge indexing',
    does: 'Splits documents into passages and builds the search index that answers are drawn from.',
    sends: 'The document text, to build embeddings.',
    effect: 'writes',
    tier: 'paid',
    caveat: 'Re-indexing skips documents whose content has not changed, so it costs nothing to run again.',
  },

  // ── Studio & builder ──────────────────────────────────────────────────
  {
    id: 'studio.context',
    name: 'Business context',
    does: 'Teaches every AI feature your industry, your wording and your tone.',
    sends: 'Nothing on its own. What you save here is added to the instructions for every other AI feature.',
    effect: 'writes',
    tier: 'paid',
  },
  {
    id: 'studio.generateSetup',
    name: 'Generate setup',
    does: 'Proposes renamed terminology and a few draft automation rules that fit your industry.',
    sends: 'Your industry and company description.',
    effect: 'advisory',
    tier: 'paid',
    caveat: 'Nothing changes until you review each item and click Apply.',
  },
  {
    id: 'studio.function',
    name: 'Custom AI function',
    does: 'Runs an AI function your team wrote, against the inputs you give it.',
    sends: 'Your function\'s instructions plus the input values you enter.',
    effect: 'advisory',
    tier: 'paid',
  },
  {
    id: 'builder.rule',
    name: 'Custom AI rule',
    does: 'Runs your own AI instruction against a record and returns the result.',
    sends: 'Your instruction plus the text or record you point it at.',
    effect: 'advisory',
    tier: 'paid',
  },
];

/** Lookup by id. Prefer this over scanning the array. */
export const AI_FEATURE: Record<string, AiFeature> = Object.fromEntries(
  AI_FEATURES.map(f => [f.id, f]),
);

export const EFFECT_LABEL: Record<AiEffect, string> = {
  advisory: 'Suggestion only',
  writes: 'Changes a record',
};
