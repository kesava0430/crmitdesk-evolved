import OpenAI from 'openai';

// ─── Client Factory ───────────────────────────────────────────────────────────

function getClient(): OpenAI | null {
  if (process.env.GROQ_API_KEY) {
    return new OpenAI({
      apiKey: process.env.GROQ_API_KEY,
      baseURL: 'https://api.groq.com/openai/v1',
    });
  }
  if (process.env.OPENAI_API_KEY) {
    return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return null;
}

// ─── Model Routing ────────────────────────────────────────────────────────────

const AI_MODEL_FAST = process.env.GROQ_API_KEY ? 'llama-3.1-8b-instant' : 'gpt-4o-mini';
const AI_MODEL_SMART = process.env.GROQ_API_KEY ? 'llama-3.3-70b-versatile' : 'gpt-4o';
const AI_MODEL = AI_MODEL_FAST;

// ─── In-Memory Response Cache (5-min TTL) ────────────────────────────────────

const cache = new Map<string, { value: string; expires: number }>();

function getCached(key: string): string | null {
  const entry = cache.get(key);
  if (!entry || Date.now() > entry.expires) { cache.delete(key); return null; }
  return entry.value;
}

function setCached(key: string, value: string, ttlMs = 5 * 60 * 1000) {
  cache.set(key, { value, expires: Date.now() + ttlMs });
  // Prune if cache grows large
  if (cache.size > 500) {
    const now = Date.now();
    for (const [k, v] of cache) { if (now > v.expires) cache.delete(k); }
  }
}

function cacheKey(...parts: any[]): string {
  return parts.map(p => (typeof p === 'object' ? JSON.stringify(p) : String(p))).join('|').slice(0, 500);
}

// ─── Chat with Retry + Caching ────────────────────────────────────────────────

async function chat(
  client: OpenAI,
  system: string,
  user: string,
  opts: { maxTokens?: number; temperature?: number; model?: string } = {}
): Promise<string> {
  const model = opts.model ?? AI_MODEL;
  const maxTokens = opts.maxTokens ?? 800;
  const temperature = opts.temperature ?? 0.3;

  const key = cacheKey(model, system, user);
  const cached = getCached(key);
  if (cached) return cached;

  let lastErr: any;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
    try {
      const res = await client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature,
        max_tokens: maxTokens,
      });
      const text = res.choices[0]?.message?.content?.trim() || '';
      setCached(key, text);
      return text;
    } catch (err: any) {
      lastErr = err;
      if (err?.status === 401 || err?.status === 402) throw err; // don't retry auth errors
      if (err?.status !== 429 && err?.status !== 503) throw err; // only retry rate limits
    }
  }
  throw lastErr;
}

// ─── Lead Scoring ──────────────────────────────────────────────────────────────

export async function scoreLead(lead: {
  status: string;
  source?: string | null;
  notes?: string | null;
  contact?: { name: string; email?: string | null; jobTitle?: string | null } | null;
  createdAt: Date;
}): Promise<{ score: number; reason: string }> {
  const client = getClient();
  if (!client) return { score: 50, reason: 'AI not configured — add GROQ_API_KEY to .env (free at console.groq.com)' };

  const payload = {
    status: lead.status,
    source: lead.source,
    notes: lead.notes,
    contact: lead.contact,
    daysSinceCreated: Math.floor((Date.now() - new Date(lead.createdAt).getTime()) / 86400000),
  };

  const reply = await chat(
    client,
    'You are a CRM lead scoring AI. Score leads from 0–100. Higher = more likely to convert. Respond ONLY with valid JSON: {"score": number, "reason": "1 sentence max 120 chars"}',
    `Score this lead: ${JSON.stringify(payload)}`,
    { maxTokens: 300 }
  );

  try {
    const parsed = JSON.parse(reply);
    return {
      score: Math.min(100, Math.max(0, Math.round(Number(parsed.score)))),
      reason: String(parsed.reason || '').slice(0, 150),
    };
  } catch {
    return { score: 50, reason: 'Could not parse AI response' };
  }
}

// ─── Follow-up Email Generator ────────────────────────────────────────────────

export async function generateFollowUp(context: {
  type: 'lead' | 'deal';
  title: string;
  stage?: string;
  contactName?: string;
  contactEmail?: string;
  notes?: string;
  value?: number;
}): Promise<{ subject: string; body: string }> {
  const client = getClient();
  if (!client) {
    return {
      subject: `Follow-up: ${context.title}`,
      body: 'AI follow-up generation not configured — add OPENAI_API_KEY to .env',
    };
  }

  const reply = await chat(
    client,
    'You are a professional sales email writer. Write concise, warm, personalized follow-up emails (3–5 short paragraphs). Respond ONLY with valid JSON: {"subject": "...", "body": "..."}',
    `Write a follow-up email for this ${context.type}: ${JSON.stringify(context)}`,
    { maxTokens: 1000 }
  );

  try {
    return JSON.parse(reply);
  } catch {
    return { subject: `Follow-up: ${context.title}`, body: reply };
  }
}

// ─── Ticket Sentiment Analysis ────────────────────────────────────────────────

export type Sentiment = 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE' | 'FRUSTRATED';
const VALID_SENTIMENTS: Sentiment[] = ['POSITIVE', 'NEUTRAL', 'NEGATIVE', 'FRUSTRATED'];

export async function analyzeTicketSentiment(ticket: {
  title: string;
  body: string;
  priority: string;
}): Promise<Sentiment> {
  const client = getClient();
  if (!client) return 'NEUTRAL';

  const reply = await chat(
    client,
    'You are a customer support AI. Classify the sentiment of this support ticket. Respond ONLY with one word: POSITIVE, NEUTRAL, NEGATIVE, or FRUSTRATED.',
    `Ticket: "${ticket.title}"\n\n${ticket.body}`,
    { maxTokens: 300 }
  );

  const sentiment = reply.toUpperCase().trim() as Sentiment;
  return VALID_SENTIMENTS.includes(sentiment) ? sentiment : 'NEUTRAL';
}

// ─── AI Reply Suggestion ──────────────────────────────────────────────────────

export async function suggestTicketReply(
  ticket: { title: string; body: string; priority: string; category?: string | null },
  articles: Array<{ title: string; body: string }>
): Promise<string> {
  const client = getClient();
  if (!client) return 'AI reply suggestions not configured — add OPENAI_API_KEY to .env';

  const kb = articles.length > 0
    ? `\n\nRelevant knowledge base articles:\n${articles.map(a => `**${a.title}**: ${a.body.slice(0, 300)}`).join('\n---\n')}`
    : '';

  return chat(
    client,
    'You are a helpful, professional IT support agent. Write a clear, empathetic, solution-focused reply to the support ticket below. Keep it concise (3–5 sentences). Do not include subject lines or greetings like "Dear" — just the body.',
    `Ticket title: "${ticket.title}"\nPriority: ${ticket.priority}\nCategory: ${ticket.category || 'General'}\n\n${ticket.body}${kb}\n\nWrite a reply:`,
    { maxTokens: 800 }
  );
}

// ─── AI Auto-Routing ──────────────────────────────────────────────────────────

export async function autoRouteTicket(ticket: {
  title: string;
  body: string;
  priority: string;
}, categories: Array<{ id: string; name: string }>, agents: Array<{ id: string; name: string; role: string }>): Promise<{
  categoryId: string | null;
  categoryName: string | null;
  agentId: string | null;
  agentName: string | null;
  reason: string;
}> {
  const client = getClient();
  if (!client) return { categoryId: null, categoryName: null, agentId: null, agentName: null, reason: 'AI not configured' };

  const reply = await chat(
    client,
    `You are an IT help desk triage AI. Given a support ticket, pick the most appropriate category and agent.
Respond ONLY with valid JSON: {"categoryId": "...", "agentId": "...", "reason": "1 sentence"}
Use null if no clear match. Pick from the provided lists only.`,
    `Ticket: "${ticket.title}"\nPriority: ${ticket.priority}\n\n${ticket.body}\n\nCategories: ${JSON.stringify(categories)}\n\nAgents: ${JSON.stringify(agents)}`,
    { maxTokens: 300 }
  );

  try {
    const parsed = JSON.parse(reply);
    const cat = categories.find(c => c.id === parsed.categoryId) ?? null;
    const agent = agents.find(a => a.id === parsed.agentId) ?? null;
    return {
      categoryId: cat?.id ?? null,
      categoryName: cat?.name ?? null,
      agentId: agent?.id ?? null,
      agentName: agent?.name ?? null,
      reason: String(parsed.reason || '').slice(0, 200),
    };
  } catch {
    return { categoryId: null, categoryName: null, agentId: null, agentName: null, reason: 'Could not parse AI response' };
  }
}

// ─── Natural Language Dashboard Query ────────────────────────────────────────

export async function naturalLanguageQuery(
  question: string,
  context: {
    totalDeals: number;
    openDeals: number;
    wonDeals: number;
    lostDeals: number;
    totalContacts: number;
    totalTickets: number;
    openTickets: number;
    resolvedTickets: number;
    totalLeads: number;
    activeLeads: number;
    forecastRevenue: number;
  }
): Promise<string> {
  const client = getClient();
  if (!client) return 'AI queries not configured — add OPENAI_API_KEY to .env';

  return chat(
    client,
    'You are a CRM analytics assistant. Answer questions about the user\'s business data concisely (2–3 sentences max). Be specific and actionable. If the data doesn\'t support the question, say so briefly.',
    `CRM snapshot: ${JSON.stringify(context)}\n\nUser question: ${question}`,
    { maxTokens: 300 }
  );
}

// ─── KB Article Generator ─────────────────────────────────────────────────────

export async function generateKbArticle(ticket: {
  title: string; body: string; priority: string; category?: string | null;
}, comments: Array<{ body: string; author?: string }>): Promise<{ title: string; body: string }> {
  const client = getClient();
  if (!client) return { title: ticket.title, body: 'AI not configured.' };
  const thread = comments.map(c => `- ${c.author ?? 'Agent'}: ${c.body}`).join('\n');
  const reply = await chat(client,
    'You are a technical writer. Given a resolved support ticket and its resolution thread, write a clear knowledge base article. Respond ONLY with valid JSON: {"title": "...", "body": "markdown content"}',
    `Ticket: "${ticket.title}"\nCategory: ${ticket.category ?? 'General'}\n\nDescription:\n${ticket.body}\n\nResolution thread:\n${thread}`,
    { model: AI_MODEL_SMART, maxTokens: 1500 }
  );
  try { return JSON.parse(reply); } catch { return { title: ticket.title, body: reply }; }
}

// ─── Duplicate Ticket Detector ────────────────────────────────────────────────

export async function detectDuplicates(newTicket: {
  title: string; body: string;
}, existing: Array<{ id: string; title: string; body: string; status: string }>): Promise<{
  duplicates: Array<{ id: string; title: string; confidence: number; reason: string }>;
}> {
  const client = getClient();
  if (!client || existing.length === 0) return { duplicates: [] };
  const sample = existing.slice(0, 20); // limit context
  const reply = await chat(client,
    'You are a duplicate detection AI. Given a new support ticket, identify semantically similar existing tickets. Respond ONLY with valid JSON: {"duplicates": [{"id": "...", "confidence": 0-100, "reason": "1 sentence"}]}. Only include tickets with confidence > 60.',
    `New ticket: "${newTicket.title}"\n${newTicket.body}\n\nExisting tickets:\n${JSON.stringify(sample.map(t => ({ id: t.id, title: t.title, status: t.status })))}`,
    { maxTokens: 300 }
  );
  try {
    const parsed = JSON.parse(reply);
    return {
      duplicates: (parsed.duplicates ?? []).map((d: any) => ({
        ...d,
        title: existing.find(e => e.id === d.id)?.title ?? d.id,
      })),
    };
  } catch { return { duplicates: [] }; }
}

// ─── Ticket Thread Summarizer ─────────────────────────────────────────────────

export async function summarizeThread(ticket: {
  title: string; body: string;
}, comments: Array<{ body: string; author?: string; createdAt?: Date }>): Promise<string> {
  const client = getClient();
  if (!client) return 'AI not configured.';
  if (comments.length < 3) return 'Not enough comments to summarize.';
  const thread = comments.map(c => `${c.author ?? 'User'}: ${c.body}`).join('\n---\n');
  return chat(client,
    'You are a support ticket summarizer. Summarize the thread in 3–4 sentences covering: the issue, what was tried, current status, and next steps.',
    `Ticket: "${ticket.title}"\n\n${ticket.body}\n\nThread:\n${thread}`,
    { maxTokens: 600 }
  );
}

// ─── Resolution Time Estimator ────────────────────────────────────────────────

export async function estimateResolutionTime(ticket: {
  title: string; body: string; priority: string; category?: string | null;
}): Promise<{ hours: number; label: string; reason: string }> {
  const client = getClient();
  if (!client) return { hours: 24, label: '~1 day', reason: 'AI not configured' };
  const reply = await chat(client,
    'You are an IT helpdesk AI. Estimate resolution time for this ticket. Respond ONLY with valid JSON: {"hours": number, "label": "e.g. 2–4 hours", "reason": "1 sentence"}',
    `Title: "${ticket.title}"\nPriority: ${ticket.priority}\nCategory: ${ticket.category ?? 'General'}\n\n${ticket.body}`,
    { maxTokens: 300 }
  );
  try { return JSON.parse(reply); } catch { return { hours: 8, label: '~1 day', reason: 'Could not estimate' }; }
}

// ─── SLA Breach Predictor ─────────────────────────────────────────────────────

export async function predictSlaBreach(ticket: {
  title: string; body: string; priority: string; createdAt: Date; slaDeadline?: Date | null;
  responseCount: number;
}): Promise<{ risk: 'LOW' | 'MEDIUM' | 'HIGH'; score: number; reason: string }> {
  const client = getClient();
  if (!client) return { risk: 'LOW', score: 20, reason: 'AI not configured' };
  const ageHours = (Date.now() - new Date(ticket.createdAt).getTime()) / 3600000;
  const hoursLeft = ticket.slaDeadline
    ? (new Date(ticket.slaDeadline).getTime() - Date.now()) / 3600000
    : null;
  const reply = await chat(client,
    'You are an SLA risk assessment AI. Predict breach risk. Respond ONLY with valid JSON: {"risk": "LOW"|"MEDIUM"|"HIGH", "score": 0-100, "reason": "1 sentence"}',
    `Priority: ${ticket.priority}\nAge: ${ageHours.toFixed(1)}h\nHours until SLA: ${hoursLeft?.toFixed(1) ?? 'unknown'}\nResponses: ${ticket.responseCount}\nTitle: "${ticket.title}"`,
    { maxTokens: 300 }
  );
  try {
    const p = JSON.parse(reply);
    return { risk: ['LOW','MEDIUM','HIGH'].includes(p.risk) ? p.risk : 'MEDIUM', score: Number(p.score) || 50, reason: String(p.reason || '') };
  } catch { return { risk: 'MEDIUM', score: 50, reason: 'Could not assess' }; }
}

// ─── Deal Win Probability ─────────────────────────────────────────────────────

export async function calculateWinProbability(deal: {
  title: string; value: number; stage: string; probability: number;
  daysOpen: number; contactName?: string; notes?: string | null;
}, orgWinRate: number): Promise<{ probability: number; factors: string[]; recommendation: string }> {
  const client = getClient();
  if (!client) return { probability: deal.probability, factors: [], recommendation: 'AI not configured' };
  const reply = await chat(client,
    'You are a sales AI. Predict deal win probability. Respond ONLY with valid JSON: {"probability": 0-100, "factors": ["up to 3 key factors"], "recommendation": "1 actionable sentence"}',
    `Deal: "${deal.title}"\nValue: $${deal.value}\nStage: ${deal.stage}\nManual prob: ${deal.probability}%\nDays open: ${deal.daysOpen}\nOrg win rate: ${orgWinRate}%\nContact: ${deal.contactName ?? 'unknown'}\nNotes: ${deal.notes ?? 'none'}`,
    { maxTokens: 300 }
  );
  try {
    const p = JSON.parse(reply);
    return {
      probability: Math.min(100, Math.max(0, Number(p.probability))),
      factors: Array.isArray(p.factors) ? p.factors.slice(0, 3) : [],
      recommendation: String(p.recommendation || ''),
    };
  } catch { return { probability: deal.probability, factors: [], recommendation: 'Could not assess' }; }
}

// ─── Pipeline Health Report ───────────────────────────────────────────────────

export async function generatePipelineHealth(data: {
  totalDeals: number; openDeals: number; wonDeals: number; lostDeals: number;
  totalValue: number; avgDaysOpen: number; staleDealCount: number;
  stageBreakdown: Array<{ stage: string; count: number; value: number }>;
}): Promise<{ summary: string; risks: string[]; opportunities: string[] }> {
  const client = getClient();
  if (!client) return { summary: 'AI not configured.', risks: [], opportunities: [] };
  const reply = await chat(client,
    'You are a sales analytics AI. Analyze the pipeline and respond ONLY with valid JSON: {"summary": "2-3 sentence overview", "risks": ["up to 3 risks"], "opportunities": ["up to 3 opportunities"]}',
    `Pipeline snapshot: ${JSON.stringify(data)}`,
    { model: AI_MODEL_SMART, maxTokens: 800 }
  );
  try { return JSON.parse(reply); } catch { return { summary: reply, risks: [], opportunities: [] }; }
}

// ─── Churn Risk Detector ──────────────────────────────────────────────────────

export async function detectChurnRisk(contact: {
  name: string; createdAt: Date; lastActivityAt?: Date | null;
}, recentTickets: Array<{ sentiment?: string | null; status: string; createdAt: Date }>): Promise<{
  risk: 'LOW' | 'MEDIUM' | 'HIGH'; score: number; reason: string;
}> {
  const client = getClient();
  if (!client) return { risk: 'LOW', score: 20, reason: 'AI not configured' };
  const daysSinceActivity = contact.lastActivityAt
    ? (Date.now() - new Date(contact.lastActivityAt).getTime()) / 86400000
    : (Date.now() - new Date(contact.createdAt).getTime()) / 86400000;
  const negativeCount = recentTickets.filter(t => ['NEGATIVE','FRUSTRATED'].includes(t.sentiment ?? '')).length;
  const reply = await chat(client,
    'You are a churn risk AI. Respond ONLY with valid JSON: {"risk": "LOW"|"MEDIUM"|"HIGH", "score": 0-100, "reason": "1 sentence"}',
    `Contact: ${contact.name}\nDays since last activity: ${daysSinceActivity.toFixed(0)}\nRecent tickets: ${recentTickets.length}\nNegative/frustrated tickets: ${negativeCount}\nTicket details: ${JSON.stringify(recentTickets.slice(0,5).map(t => ({ sentiment: t.sentiment, status: t.status })))}`,
    { maxTokens: 300 }
  );
  try {
    const p = JSON.parse(reply);
    return { risk: ['LOW','MEDIUM','HIGH'].includes(p.risk) ? p.risk : 'LOW', score: Number(p.score)||20, reason: String(p.reason||'') };
  } catch { return { risk: 'LOW', score: 20, reason: 'Could not assess' }; }
}

// ─── Lead Nurture Sequence ────────────────────────────────────────────────────

export async function generateNurtureSequence(lead: {
  status: string; source?: string | null; notes?: string | null;
  contactName?: string; contactEmail?: string;
}): Promise<Array<{ day: number; subject: string; body: string }>> {
  const client = getClient();
  if (!client) return [];
  const reply = await chat(client,
    'You are a sales email strategist. Generate a 3-step lead nurture email sequence. Respond ONLY with valid JSON array: [{"day": number, "subject": "...", "body": "3-4 sentence email body"}]. Days should be 1, 4, and 10.',
    `Lead info: contact=${lead.contactName ?? 'Unknown'}, source=${lead.source ?? 'unknown'}, status=${lead.status}, notes=${lead.notes ?? 'none'}`,
    { model: AI_MODEL_SMART, maxTokens: 1200 }
  );
  try {
    const arr = JSON.parse(reply);
    return Array.isArray(arr) ? arr.slice(0, 3) : [];
  } catch { return []; }
}

// ─── Meeting Notes Parser ─────────────────────────────────────────────────────

export async function parseMeetingNotes(notes: string): Promise<{
  contacts: Array<{ name: string; email?: string; company?: string; jobTitle?: string }>;
  leads: Array<{ name: string; notes: string; source: string }>;
  deals: Array<{ title: string; value?: number; stage?: string; notes: string }>;
  nextSteps: string[];
  summary: string;
}> {
  const client = getClient();
  if (!client) return { contacts: [], leads: [], deals: [], nextSteps: [], summary: 'AI not configured.' };
  const reply = await chat(client,
    'You are a CRM data extraction AI. Extract structured CRM data from meeting notes. Respond ONLY with valid JSON: {"contacts": [...], "leads": [...], "deals": [...], "nextSteps": ["..."], "summary": "2-sentence overview"}',
    `Meeting notes:\n${notes}`,
    { model: AI_MODEL_SMART, maxTokens: 1500 }
  );
  try { return JSON.parse(reply); } catch { return { contacts: [], leads: [], deals: [], nextSteps: [], summary: notes.slice(0, 200) }; }
}

// ─── Proactive AI Insights ────────────────────────────────────────────────────

export async function generateInsights(data: {
  staleDealCount: number; staleDealValue: number;
  openTickets: number; avgTicketAgeHours: number;
  slaBreachedCount: number; weeklyTicketGrowth: number;
  weeklyLeadsGrowth: number; unfollowedLeads: number;
  topNegativeTickets: number;
}): Promise<Array<{ type: 'warning' | 'info' | 'success'; title: string; description: string; action?: string }>> {
  const client = getClient();
  if (!client) return [];
  const reply = await chat(client,
    'You are a proactive business insights AI. Generate 3-5 actionable observations from the data. Respond ONLY with valid JSON array: [{"type": "warning"|"info"|"success", "title": "short title", "description": "1-2 sentences", "action": "optional CTA text"}]',
    `Business snapshot: ${JSON.stringify(data)}`,
    { maxTokens: 600 }
  );
  try {
    const arr = JSON.parse(reply);
    return Array.isArray(arr) ? arr.slice(0, 5) : [];
  } catch { return []; }
}

// ─── Email Tone Checker ───────────────────────────────────────────────────────

export async function checkEmailTone(email: {
  subject: string; body: string; context?: string;
}): Promise<{ tone: string; score: number; issues: string[]; suggestions: string[]; approved: boolean }> {
  const client = getClient();
  if (!client) return { tone: 'neutral', score: 80, issues: [], suggestions: [], approved: true };
  const reply = await chat(client,
    'You are a professional communication coach. Analyze this business email tone. Respond ONLY with valid JSON: {"tone": "professional|friendly|aggressive|passive-aggressive|too-casual|empathetic", "score": 0-100, "issues": ["up to 3 issues"], "suggestions": ["up to 3 improvements"], "approved": boolean}',
    `Subject: ${email.subject}\nContext: ${email.context ?? 'customer support reply'}\n\nBody:\n${email.body}`,
    { maxTokens: 300 }
  );
  try { return JSON.parse(reply); } catch { return { tone: 'neutral', score: 80, issues: [], suggestions: [], approved: true }; }
}

// ─── Natural Language Command Parser (AI CRUD) ────────────────────────────────

export async function parseNaturalLanguageCommand(
  command: string,
  context: {
    users?: Array<{ id: string; name: string }>;
    categories?: Array<{ id: string; name: string }>;
    contacts?: Array<{ id: string; name: string }>;
  }
): Promise<{
  intent: 'create' | 'update' | 'unknown';
  entity: 'ticket' | 'contact' | 'lead' | 'deal' | 'article' | 'unknown';
  fields: Record<string, any>;
  confidence: number;
  explanation: string;
}> {
  const client = getClient();
  if (!client) return { intent: 'unknown', entity: 'unknown', fields: {}, confidence: 0, explanation: 'AI not configured' };
  const reply = await chat(client,
    `You are a CRM command parser. Parse natural language commands into structured actions.
For tickets: fields can be title, body, priority (LOW/MEDIUM/HIGH/CRITICAL), categoryId, assignedTo (user id)
For contacts: fields can be name, email, phone, jobTitle, company
For leads: fields can be name, email, source, status, notes
For deals: fields can be title, value (number), stage, probability (0-100), contactId, notes
For articles: fields can be title, body, status (DRAFT/PUBLISHED)
Respond ONLY with valid JSON: {"intent": "create"|"update", "entity": "ticket"|"contact"|"lead"|"deal"|"article", "fields": {...}, "confidence": 0-100, "explanation": "1 sentence"}
Match user/category names to IDs from the context when provided.`,
    `Command: "${command}"\n\nContext:\nUsers: ${JSON.stringify(context.users ?? [])}\nCategories: ${JSON.stringify(context.categories ?? [])}\nContacts: ${JSON.stringify(context.contacts ?? [])}`,
    { maxTokens: 300 }
  );
  try { return JSON.parse(reply); } catch { return { intent: 'unknown', entity: 'unknown', fields: {}, confidence: 0, explanation: 'Could not parse command' }; }
}

// ─── AI Action Planner (whitelisted action execution) ─────────────────────────
// Distinct from parseNaturalLanguageCommand above: that one only ever proposes
// a create/update of one of 5 entity types, which the UI then hands off to the
// existing form. This one picks from an arbitrary caller-supplied menu of
// registered actions (server/src/utils/ai-actions.ts) — state changes,
// reminders, notes, scoring, toggles — anything with no dedicated "create"
// form. The model can only ever name an action from the menu it's given; it
// never invents one, and every id it returns still gets re-validated against
// the org by the action's own handler before anything runs.

export async function planAiAction(
  command: string,
  context: {
    actions: Array<{ name: string; description: string; params: string }>;
    deals?: Array<{ id: string; title: string; stage: string }>;
    tickets?: Array<{ id: string; title: string; status: string }>;
    leads?: Array<{ id: string; name: string }>;
    rules?: Array<{ id: string; name: string; isActive: boolean }>;
    contacts?: Array<{ id: string; name: string }>;
  }
): Promise<{
  action: string | null;
  params: Record<string, any>;
  confidence: number;
  explanation: string;
}> {
  const client = getClient();
  if (!client) return { action: null, params: {}, confidence: 0, explanation: 'AI not configured' };

  const menu = context.actions
    .map(a => `- ${a.name}: ${a.description}\n  params: ${a.params}`)
    .join('\n');

  const reply = await chat(client,
    `You are a CRM automation planner. Given a natural language request, pick the SINGLE best-matching action from this whitelist, or return null if nothing matches well enough:\n${menu}\n\nMatch any deal/ticket/lead/rule/contact mentioned by name to its id using the context lists provided — never invent an id that isn't in the context. If you can't find a confident id match for something the action requires, lower the confidence instead of guessing.\nRespond ONLY with valid JSON: {"action": "<one of the names above>"|null, "params": {...matching that action's params shape}, "confidence": 0-100, "explanation": "1 short sentence describing what will happen, for the user to confirm"}`,
    `Command: "${command}"\n\nContext:\nDeals: ${JSON.stringify(context.deals ?? [])}\nTickets: ${JSON.stringify(context.tickets ?? [])}\nLeads: ${JSON.stringify(context.leads ?? [])}\nWorkflow rules: ${JSON.stringify(context.rules ?? [])}\nContacts: ${JSON.stringify(context.contacts ?? [])}`,
    { maxTokens: 400, model: AI_MODEL_SMART }
  );
  try {
    const parsed = JSON.parse(reply);
    return {
      action: parsed.action ?? null,
      params: parsed.params ?? {},
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
      explanation: parsed.explanation ?? '',
    };
  } catch {
    return { action: null, params: {}, confidence: 0, explanation: 'Could not parse command' };
  }
}

// ─── Auto-Tag Ticket ──────────────────────────────────────────────────────────

export async function autoTagTicket(ticket: {
  title: string; body: string; category?: string | null;
}): Promise<string[]> {
  const client = getClient();
  if (!client) return [];
  const cached = getCached(cacheKey('autoTag', ticket.title, ticket.body.slice(0, 200)));
  if (cached) return JSON.parse(cached);

  const reply = await chat(client,
    'You are an IT help desk AI. Extract 3-6 short, lowercase keyword tags from this support ticket that would help categorize and find it later. Respond ONLY with a valid JSON array of strings: ["tag1", "tag2", ...]',
    `Title: "${ticket.title}"\nCategory: ${ticket.category ?? 'General'}\n\n${ticket.body.slice(0, 600)}`,
    { maxTokens: 150 }
  );
  try {
    const tags = JSON.parse(reply);
    return Array.isArray(tags) ? tags.slice(0, 6).map((t: any) => String(t).toLowerCase().trim()) : [];
  } catch { return []; }
}

// ─── Score Contact Health ─────────────────────────────────────────────────────

export async function scoreContactHealth(contact: {
  name: string; createdAt: Date; lastActivityAt?: Date | null;
  dealCount: number; openDealValue: number;
  ticketCount: number; negativeTickets: number;
  responseRate?: number;
}): Promise<{ score: number; grade: 'A' | 'B' | 'C' | 'D' | 'F'; summary: string; recommendations: string[] }> {
  const client = getClient();
  if (!client) return { score: 70, grade: 'B', summary: 'AI not configured', recommendations: [] };

  const daysSinceActivity = contact.lastActivityAt
    ? Math.floor((Date.now() - new Date(contact.lastActivityAt).getTime()) / 86400000)
    : Math.floor((Date.now() - new Date(contact.createdAt).getTime()) / 86400000);

  const reply = await chat(client,
    'You are a customer health scoring AI. Rate the overall health of a customer relationship. Respond ONLY with valid JSON: {"score": 0-100, "grade": "A"|"B"|"C"|"D"|"F", "summary": "2-sentence assessment", "recommendations": ["up to 3 actionable recommendations"]}',
    `Contact: ${contact.name}\nDays since last activity: ${daysSinceActivity}\nOpen deals: ${contact.dealCount} (value: $${contact.openDealValue})\nTotal tickets: ${contact.ticketCount}\nNegative/frustrated tickets: ${contact.negativeTickets}`,
    { maxTokens: 300 }
  );
  try {
    const p = JSON.parse(reply);
    const grades = ['A','B','C','D','F'];
    return {
      score: Math.min(100, Math.max(0, Number(p.score))),
      grade: grades.includes(p.grade) ? p.grade : 'C',
      summary: String(p.summary || ''),
      recommendations: Array.isArray(p.recommendations) ? p.recommendations.slice(0, 3) : [],
    };
  } catch { return { score: 70, grade: 'B', summary: 'Could not assess', recommendations: [] }; }
}

// ─── Predict Deal Close Date ──────────────────────────────────────────────────

export async function predictDealCloseDate(deal: {
  title: string; stage: string; value: number; probability: number;
  daysOpen: number; expectedCloseDate?: Date | null; notes?: string | null;
}, historicalAvgDays: number): Promise<{
  predictedDays: number; predictedDate: string; confidence: 'LOW' | 'MEDIUM' | 'HIGH';
  reasoning: string;
}> {
  const client = getClient();
  if (!client) return { predictedDays: historicalAvgDays, predictedDate: '', confidence: 'LOW', reasoning: 'AI not configured' };

  const reply = await chat(client,
    'You are a sales forecasting AI. Predict when this deal will close. Respond ONLY with valid JSON: {"predictedDays": number (days from today), "confidence": "LOW"|"MEDIUM"|"HIGH", "reasoning": "1-2 sentences"}',
    `Deal: "${deal.title}"\nStage: ${deal.stage}\nValue: $${deal.value}\nProbability: ${deal.probability}%\nDays already open: ${deal.daysOpen}\nHistorical avg close: ${historicalAvgDays} days\nExpected close: ${deal.expectedCloseDate ?? 'not set'}\nNotes: ${deal.notes ?? 'none'}`,
    { maxTokens: 200 }
  );
  try {
    const p = JSON.parse(reply);
    const days = Math.max(1, Number(p.predictedDays) || historicalAvgDays);
    const date = new Date();
    date.setDate(date.getDate() + days);
    return {
      predictedDays: days,
      predictedDate: date.toISOString().split('T')[0],
      confidence: ['LOW','MEDIUM','HIGH'].includes(p.confidence) ? p.confidence : 'MEDIUM',
      reasoning: String(p.reasoning || ''),
    };
  } catch { return { predictedDays: historicalAvgDays, predictedDate: '', confidence: 'LOW', reasoning: 'Could not predict' }; }
}

// ─── Detect Competitor Mentions ───────────────────────────────────────────────

export async function detectCompetitorMentions(text: string, knownCompetitors?: string[]): Promise<{
  mentions: Array<{ competitor: string; context: string; sentiment: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' }>;
  hasCompetitorActivity: boolean;
}> {
  const client = getClient();
  if (!client) return { mentions: [], hasCompetitorActivity: false };

  const competitorHint = knownCompetitors?.length
    ? `Known competitors to watch for: ${knownCompetitors.join(', ')}\n`
    : '';

  const reply = await chat(client,
    `You are a competitive intelligence AI. Detect competitor mentions in business text. ${competitorHint}Respond ONLY with valid JSON: {"mentions": [{"competitor": "name", "context": "brief quote or context", "sentiment": "POSITIVE"|"NEGATIVE"|"NEUTRAL"}], "hasCompetitorActivity": boolean}`,
    `Text to analyze:\n${text.slice(0, 1000)}`,
    { maxTokens: 400 }
  );
  try {
    const p = JSON.parse(reply);
    return {
      mentions: Array.isArray(p.mentions) ? p.mentions.slice(0, 5) : [],
      hasCompetitorActivity: Boolean(p.hasCompetitorActivity),
    };
  } catch { return { mentions: [], hasCompetitorActivity: false }; }
}

// ─── Bulk Score Leads ─────────────────────────────────────────────────────────

export async function bulkScoreLeads(leads: Array<{
  id: string; status: string; source?: string | null; notes?: string | null;
  contactName?: string; daysOld: number;
}>): Promise<Array<{ id: string; score: number; reason: string }>> {
  const client = getClient();
  if (!client) return leads.map(l => ({ id: l.id, score: 50, reason: 'AI not configured' }));

  const BATCH = 10;
  const results: Array<{ id: string; score: number; reason: string }> = [];

  for (let i = 0; i < leads.length; i += BATCH) {
    const batch = leads.slice(i, i + BATCH);
    const reply = await chat(client,
      'You are a CRM lead scoring AI. Score each lead 0-100. Respond ONLY with a valid JSON array: [{"id": "...", "score": number, "reason": "max 80 chars"}]',
      `Score these leads:\n${JSON.stringify(batch)}`,
      { maxTokens: 600 }
    );
    try {
      const arr = JSON.parse(reply);
      if (Array.isArray(arr)) results.push(...arr);
    } catch {
      results.push(...batch.map(l => ({ id: l.id, score: 50, reason: 'Batch scoring error' })));
    }
    if (i + BATCH < leads.length) await new Promise(r => setTimeout(r, 500)); // rate limit spacing
  }
  return results;
}
