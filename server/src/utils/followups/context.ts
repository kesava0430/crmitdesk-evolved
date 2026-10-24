/**
 * The facts an AI follow-up (email draft, next-step suggestion) may use.
 *
 * gatherContext() reads the record and its history with the *requesting
 * user's* permissions (record scope, crm.activity.read for activity notes,
 * crm.quote.read on the quote), and renderContext() turns it into a compact,
 * labelled text block trimmed to a character budget — newest notes first,
 * each note capped — so a request stays well under Groq's free-tier
 * 8k tokens/minute even with max_tokens included (see EMAIL_* below).
 *
 * The rendered text is ALSO what the fact checker compares the draft against,
 * so "found in the deal" means "was in what the model was shown".
 */
import { prisma } from '../prisma';
import { PermCtx, can, scopedWhere, canAccessRecord } from '../permissions';
import { AppError } from '../../middleware/errorHandler';
import { cleanNote, estimateTokens } from '../dealLinks/lessons';
import { loadOpenItems, orgTimeZone } from './collect';
import { classifyDue, dueDayKey, daysBetween, isDateOnly } from './time';
import { localDateKey } from '../attendanceEngine';

export type CtxKind = 'LEAD' | 'DEAL';

export interface CtxNote { kind: string; date: Date; author?: string | null; text: string }
export interface CtxPlanned { type: string; title: string; dueAt: Date | null; status: string; days: number | null }
export interface CtxQuote {
  title: string; status: string; total: number; maxDiscountPct: number; validUntil: Date | null;
  lines: Array<{ description: string; quantity: number; unitPrice: number; discount: number }>;
}
export interface FollowUpContext {
  kind: CtxKind;
  id: string;
  title: string;
  status: string;
  stage?: string | null;
  daysInStage?: number | null;
  value?: number | null;
  closeDate?: Date | null;
  source?: string | null;
  currency: string;
  contact: { name?: string | null; email?: string | null; company?: string | null; jobTitle?: string | null };
  sender: { name: string; company: string; email?: string | null };
  notes: CtxNote[];
  planned: CtxPlanned[];
  quote: CtxQuote | null;
  lessons: string[];
  today: string;
  weekday: string;
  timeZone: string;
}

/** Budgets (characters of rendered context). ≈3.5 chars/token → EMAIL ≈ 2.3k tokens, NEXT_STEP ≈ 0.7k. */
export const EMAIL_CONTEXT_CHARS = 8000;
export const NEXT_STEP_CONTEXT_CHARS = 2400;
export const NOTE_CAP_EMAIL = 420;
export const NOTE_CAP_NEXT = 220;
export const MAX_NOTES = 14;

const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : '—');

export function money(n: number, currency: string): string {
  // Indian grouping for INR (what the user and the customer write), Western otherwise.
  const locale = currency === 'INR' ? 'en-IN' : 'en-US';
  return `${currency} ${Math.round(n).toLocaleString(locale)}`;
}

function quoteTotals(lines: Array<{ quantity: any; unitPrice: any; discount: any }>) {
  const total = lines.reduce((s, l) => s + Number(l.quantity) * Number(l.unitPrice) * (1 - Number(l.discount) / 100), 0);
  const maxDiscountPct = lines.reduce((m, l) => Math.max(m, Number(l.discount)), 0);
  return { total, maxDiscountPct };
}

/** Loads the facts, with the viewer's permissions. 404 when the record isn't visible. */
export async function gatherContext(ctx: PermCtx, kind: CtxKind, id: string, opts: { lessons?: string[] } = {}): Promise<FollowUpContext> {
  const orgId = ctx.orgId;
  const tz = await orgTimeZone(orgId);
  const now = new Date();
  const [org, branding, me] = await Promise.all([
    prisma.organization.findUnique({ where: { id: orgId }, select: { name: true, currency: true } }),
    prisma.orgBranding.findUnique({ where: { orgId }, select: { companyName: true } }),
    prisma.user.findUnique({ where: { id: ctx.userId }, select: { name: true, email: true } }),
  ]);
  const currency = org?.currency || 'USD';
  const base = {
    kind, id, currency, lessons: opts.lessons ?? [],
    sender: { name: me?.name ?? 'Your account manager', company: branding?.companyName || org?.name || '', email: me?.email },
    today: localDateKey(now, tz), weekday: WEEKDAY[new Date(`${localDateKey(now, tz)}T00:00:00Z`).getUTCDay()], timeZone: tz,
  };
  const canActs = can(ctx, 'crm.activity.read');
  const notes: CtxNote[] = [];
  let partial: Omit<FollowUpContext, keyof typeof base | 'notes' | 'planned'>;
  let leadIdsForNotes: string[] = [];

  if (kind === 'LEAD') {
    const lead = await prisma.lead.findFirst({
      where: { AND: [{ id, orgId }, scopedWhere(ctx, 'lead', 'crm.lead.read')] },
      include: { contact: { select: { name: true, email: true, jobTitle: true, account: { select: { name: true } } } } },
    });
    if (!lead || !can(ctx, 'crm.lead.read')) throw new AppError(404, 'Lead not found');
    if (lead.notes) notes.push({ kind: 'lead note', date: lead.updatedAt, text: lead.notes });
    partial = {
      title: lead.contact?.name || 'Lead', status: lead.status, source: lead.source, quote: null,
      contact: { name: lead.contact?.name, email: lead.contact?.email, jobTitle: lead.contact?.jobTitle, company: lead.contact?.account?.name },
    };
  } else {
    const deal = await prisma.deal.findFirst({
      where: { AND: [{ id, orgId }, scopedWhere(ctx, 'deal', 'crm.deal.read')] },
      include: {
        contact: { select: { name: true, email: true, jobTitle: true } },
        account: { select: { name: true } },
        history: { orderBy: { changedAt: 'desc' }, take: 1 },
      },
    });
    if (!deal || !can(ctx, 'crm.deal.read')) throw new AppError(404, 'Deal not found');
    const enteredStage = deal.history[0]?.toStage === deal.stage ? deal.history[0].changedAt : deal.createdAt;
    let quote: CtxQuote | null = null;
    if (can(ctx, 'crm.quote.read')) {
      const quotes = await prisma.quote.findMany({ where: { orgId, dealId: id }, include: { lines: true }, orderBy: { createdAt: 'desc' }, take: 5 });
      const q = quotes.find(x => canAccessRecord(ctx, 'quote', 'crm.quote.read', x));
      if (q) {
        const t = quoteTotals(q.lines);
        quote = {
          title: q.title, status: q.status, total: t.total, maxDiscountPct: t.maxDiscountPct, validUntil: q.validUntil,
          lines: q.lines.slice(0, 5).map(l => ({ description: l.description, quantity: Number(l.quantity), unitPrice: Number(l.unitPrice), discount: Number(l.discount) })),
        };
        if (q.notes) notes.push({ kind: 'quote note', date: q.updatedAt, text: q.notes });
      }
    }
    const fromLeads = await prisma.lead.findMany({ where: { orgId, dealId: id }, select: { id: true, notes: true, updatedAt: true, assignedTo: true } });
    for (const l of fromLeads) if (l.notes && canAccessRecord(ctx, 'lead', 'crm.lead.read', l)) notes.push({ kind: 'lead note', date: l.updatedAt, text: l.notes });
    leadIdsForNotes = fromLeads.filter(l => canAccessRecord(ctx, 'lead', 'crm.lead.read', l)).map(l => l.id);
    partial = {
      title: deal.title, status: deal.status, stage: deal.stage, value: Number(deal.value), closeDate: deal.closeDate,
      daysInStage: Math.max(0, Math.floor((now.getTime() - enteredStage.getTime()) / 86_400_000)), quote,
      contact: { name: deal.contact?.name, email: deal.contact?.email, jobTitle: deal.contact?.jobTitle, company: deal.account?.name },
    };
  }

  const fk = kind === 'LEAD' ? 'leadId' : 'dealId';
  const [comments, acts, open] = await Promise.all([
    prisma.comment.findMany({ where: { entityType: kind as any, entityId: id }, include: { author: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, take: MAX_NOTES }),
    canActs
      ? prisma.activity.findMany({
          where: { orgId, done: true, OR: [{ [fk]: id }, ...(leadIdsForNotes.length ? [{ leadId: { in: leadIdsForNotes } }] : [])] },
          include: { createdByUser: { select: { name: true } } }, orderBy: { updatedAt: 'desc' }, take: MAX_NOTES,
        })
      : Promise.resolve([] as any[]),
    loadOpenItems(orgId, kind, [id]),
  ]);
  for (const c of comments) notes.push({ kind: 'comment', date: c.createdAt, author: c.author?.name, text: c.body });
  for (const a of acts) {
    const direction = (a.emailMeta as any)?.direction;
    const dir = direction === 'INBOUND' ? 'email received' : a.type === 'EMAIL' ? 'email sent' : a.type.toLowerCase();
    // An email sent from the app contributes only its subject: its body may
    // carry a figure someone sent despite a fact-check flag, and feeding it
    // back would turn that figure into a "fact found in the deal".
    const text = direction === 'OUTBOUND' ? `${a.title} (sent from the app)` : [a.title, a.body].filter(Boolean).join(': ');
    notes.push({ kind: dir, date: a.dueAt && a.dueAt < a.updatedAt ? a.dueAt : a.updatedAt, author: a.createdByUser?.name, text });
  }
  const planned: CtxPlanned[] = (open.get(id) ?? []).map(it => ({
    type: it.type, title: it.title, dueAt: it.dueAt,
    status: it.dueAt ? classifyDue(it.dueAt, now, tz) : 'UNDATED',
    days: it.dueAt ? daysBetween(dueDayKey(it.dueAt, tz), base.today) : null,
  })).sort((a, b) => (a.dueAt?.getTime() ?? Infinity) - (b.dueAt?.getTime() ?? Infinity)).slice(0, 6);

  return { ...base, ...partial!, notes, planned };
}

// ─── Rendering (pure) ───────────────────────────────────────────────────────

export interface RenderOptions { budget: number; noteCap: number; includeQuote?: boolean; includeLessons?: boolean }

export interface RenderedContext { text: string; notesShown: number; notesTotal: number; estTokens: number }

function plannedLine(p: CtxPlanned, tz: string): string {
  let due = 'no date';
  if (p.dueAt) {
    due = dueDayKey(p.dueAt, tz);
    if (!isDateOnly(p.dueAt)) due += ` ${new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(p.dueAt)}`;
  }
  const tag = p.status === 'OVERDUE' ? `overdue ${p.days ?? 0} day${p.days === 1 ? '' : 's'}` : p.status === 'TODAY' ? 'due today' : p.status === 'UPCOMING' ? 'upcoming' : 'no date';
  return `- [${tag}] ${p.type.toLowerCase()}: ${p.title} (due ${due})`;
}

/** Compact labelled text, trimmed to the budget (newest notes first, each capped). Pure. */
export function renderContext(c: FollowUpContext, o: RenderOptions): RenderedContext {
  const head: string[] = [];
  head.push(`TODAY: ${c.today} (${c.weekday}), time zone ${c.timeZone}`);
  if (c.kind === 'DEAL') {
    const bits = [`Deal "${c.title}"`, `status ${c.status}`];
    if (c.stage) bits.push(`stage ${c.stage}${c.daysInStage != null ? ` (${c.daysInStage} days in stage)` : ''}`);
    if (c.value) bits.push(`value ${money(c.value, c.currency)}`);
    if (c.closeDate) bits.push(`expected close ${day(c.closeDate)}`);
    head.push(`RECORD: ${bits.join(' · ')}`);
  } else {
    head.push(`RECORD: Lead "${c.title}" · status ${c.status}${c.source ? ` · source ${c.source}` : ''}`);
  }
  const contact = [c.contact.name, c.contact.jobTitle, c.contact.company && `at ${c.contact.company}`].filter(Boolean).join(', ');
  head.push(`CONTACT: ${contact || 'unknown name'}`);
  head.push(`SENDER: ${c.sender.name}${c.sender.company ? `, ${c.sender.company}` : ''}`);
  if (o.includeQuote !== false && c.quote) {
    const q = c.quote;
    const lines = q.lines.map(l => `${l.description.slice(0, 60)} ×${l.quantity} @ ${money(l.unitPrice, c.currency)}${l.discount ? ` (${l.discount}% off)` : ''}`).join('; ');
    head.push(`LATEST QUOTE: "${q.title}" · ${q.status} · total ${money(q.total, c.currency)}${q.maxDiscountPct ? ` · discount up to ${q.maxDiscountPct}%` : ''}${q.validUntil ? ` · valid until ${day(q.validUntil)}` : ''}${lines ? ` · lines: ${lines}` : ''}`);
  }
  if (c.planned.length) {
    head.push('PLANNED FOLLOW-UPS:');
    for (const p of c.planned) head.push(plannedLine(p, c.timeZone));
  } else {
    head.push('PLANNED FOLLOW-UPS: none');
  }
  const lessonLines: string[] = [];
  if (o.includeLessons !== false && c.lessons.length) {
    lessonLines.push('LESSONS FROM SIMILAR PAST DEALS (checklist):');
    for (const l of c.lessons.slice(0, 4)) lessonLines.push(`- ${l.slice(0, 200)}`);
  }
  let text = head.join('\n');
  const tail = lessonLines.join('\n');
  let left = o.budget - text.length - tail.length - 40;

  const sorted = c.notes
    .map(n => ({ ...n, text: cleanNote(n.text) }))
    .filter(n => n.text)
    .sort((a, b) => b.date.getTime() - a.date.getTime())
    .slice(0, MAX_NOTES);
  const noteLines: string[] = [];
  for (const n of sorted) {
    if (left < 80) break;
    const prefix = `- ${day(n.date)} ${n.kind}${n.author ? ` (${n.author})` : ''}: `;
    let body = n.text.length > o.noteCap ? `${n.text.slice(0, o.noteCap)}…` : n.text;
    if (prefix.length + body.length > left) body = `${body.slice(0, Math.max(0, left - prefix.length))}…`;
    noteLines.push(prefix + body);
    left -= prefix.length + body.length + 1;
  }
  text += `\nRECENT NOTES (newest first):\n${noteLines.length ? noteLines.join('\n') : '(none recorded)'}`;
  if (tail) text += `\n${tail}`;
  return { text, notesShown: noteLines.length, notesTotal: sorted.length, estTokens: estimateTokens(text.length) };
}

/** Numbers/percentages the context carries in raw form too (so "8500000" and "85,00,000" both verify). */
export function contextNumbers(c: FollowUpContext): { numbers: number[]; percents: number[]; today: string } {
  const numbers: number[] = [];
  const percents: number[] = [];
  if (c.value) numbers.push(c.value);
  if (c.quote) {
    numbers.push(Math.round(c.quote.total));
    percents.push(c.quote.maxDiscountPct);
    for (const l of c.quote.lines) {
      numbers.push(l.unitPrice, l.quantity, Math.round(l.quantity * l.unitPrice), Math.round(l.quantity * l.unitPrice * (1 - l.discount / 100)));
      percents.push(l.discount);
    }
  }
  return { numbers, percents, today: c.today };
}
