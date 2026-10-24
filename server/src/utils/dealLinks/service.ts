/**
 * "Related deals" — database side. Pure rules live in match.ts, the AI prompt
 * and its checking in lessons.ts.
 *
 * Permission model (same as the analytics query layer):
 *  - Every deal listed or sent to the model passes scopedWhere(ctx, 'deal',
 *    'crm.deal.read') AND { orgId }. Deals the viewer can't open are simply
 *    absent — not counted, not summarised, not fed to the AI.
 *  - Notes follow their own grants: activities need crm.activity.read, lead
 *    notes crm.lead.read on that lead, quotes crm.quote.read on that quote and
 *    the Quotes & invoices module switched on.
 *  - Deal value goes through redact(ctx, 'deal', …) like any other egress.
 */
import { prisma } from '../prisma';
import { PermCtx, scopedWhere, can, canAccessRecord, redact } from '../permissions';
import { isModuleBlocked } from '../licensing';
import {
  LinkRule, LinkField, MatchableDeal, parseStoredRule, matchKeys, normaliseValue, linkFieldKey,
  relatedOutcomeCounts,
} from './match';
import { cleanNote, LessonDeal, NoteSource, NoteKind, selectLessonDeals, MAX_LESSON_DEALS } from './lessons';

export const RELATED_PAGE_MAX = 50;

// ─── Rule ────────────────────────────────────────────────────────────────────

export interface RuleField { kind: LinkField['kind']; fieldId?: string; label: string }
export interface DescribedRule { fields: RuleField[]; mode: LinkRule['mode'] }

export async function dealCustomFields(orgId: string) {
  return prisma.customField.findMany({
    where: { orgId, entityType: 'DEAL' },
    select: { id: true, label: true, fieldType: true, fieldKey: true },
    orderBy: { position: 'asc' },
  });
}

const BUILTIN_LABEL: Record<string, string> = { account: 'Account', contact: 'Contact', pipeline: 'Pipeline' };

/**
 * The org's rule with labels, minus fields that no longer exist (a custom
 * field deleted after the rule was saved). null = not set up.
 */
export async function loadRule(orgId: string): Promise<{ rule: LinkRule; described: DescribedRule } | null> {
  const row = await prisma.dealLinkRule.findUnique({ where: { orgId } });
  const parsed = parseStoredRule(row);
  if (!parsed) return null;
  const defs = await dealCustomFields(orgId);
  const byId = new Map(defs.map(d => [d.id, d]));
  const fields = parsed.fields.filter(f => f.kind !== 'custom' || byId.has(f.fieldId));
  if (!fields.length) return null;
  const rule: LinkRule = { fields, mode: parsed.mode };
  return {
    rule,
    described: {
      mode: rule.mode,
      fields: fields.map(f => f.kind === 'custom'
        ? { kind: f.kind, fieldId: f.fieldId, label: byId.get(f.fieldId)!.label }
        : { kind: f.kind, label: BUILTIN_LABEL[f.kind] }),
    },
  };
}

// ─── Loading a deal's match values ───────────────────────────────────────────

async function customValuesFor(rule: LinkRule, dealIds: string[]): Promise<Map<string, Record<string, string>>> {
  const fieldIds = rule.fields.flatMap(f => (f.kind === 'custom' ? [f.fieldId] : []));
  const out = new Map<string, Record<string, string>>();
  if (!fieldIds.length || !dealIds.length) return out;
  const rows = await prisma.customFieldValue.findMany({
    where: { customFieldId: { in: fieldIds }, entityId: { in: dealIds } },
    select: { customFieldId: true, entityId: true, value: true },
  });
  for (const r of rows) {
    if (r.value == null) continue;
    const m = out.get(r.entityId) ?? {};
    m[r.customFieldId] = r.value;
    out.set(r.entityId, m);
  }
  return out;
}

export async function matchableDeal(rule: LinkRule, deal: { id: string; accountId: string | null; contactId: string | null; pipelineId: string | null }): Promise<MatchableDeal> {
  const custom = (await customValuesFor(rule, [deal.id])).get(deal.id) ?? {};
  return { id: deal.id, accountId: deal.accountId, contactId: deal.contactId, pipelineId: deal.pipelineId, custom };
}

/** "Flat / Unit = "Tower B - 502"" style lines for what this deal is matched on. */
export async function sharedOnLabels(orgId: string, described: DescribedRule, d: MatchableDeal): Promise<string[]> {
  const out: string[] = [];
  for (const f of described.fields) {
    if (f.kind === 'custom') {
      const v = d.custom?.[f.fieldId!];
      if (v && v.trim()) out.push(`${f.label} = "${v.trim()}"`);
    } else {
      const id = f.kind === 'account' ? d.accountId : f.kind === 'contact' ? d.contactId : d.pipelineId;
      if (!id) continue;
      const name = f.kind === 'account'
        ? (await prisma.account.findFirst({ where: { id, orgId }, select: { name: true } }))?.name
        : f.kind === 'contact'
          ? (await prisma.contact.findFirst({ where: { id, orgId }, select: { name: true } }))?.name
          : (await prisma.pipeline.findFirst({ where: { id, orgId }, select: { name: true } }))?.name;
      if (name) out.push(`${f.label} = "${name}"`);
    }
  }
  return out;
}

// ─── Finding related deals ───────────────────────────────────────────────────

/**
 * Deal ids whose custom field `fieldId` has the same normalised value. The
 * SQL expression mirrors match.ts normaliseValue(): collapse whitespace runs,
 * trim, lower-case. Identifiers are fixed; both values are bound parameters.
 */
async function idsWithCustomValue(fieldId: string, normalised: string[]): Promise<Set<string>> {
  if (!normalised.length) return new Set();
  const rows = await prisma.$queryRawUnsafe<Array<{ entity_id: string }>>(
    `SELECT entity_id FROM custom_field_values
      WHERE custom_field_id = $1
        AND lower(btrim(regexp_replace(value, '\\s+', ' ', 'g'))) = ANY($2::text[])
      LIMIT 5000`,
    fieldId, normalised,
  );
  return new Set(rows.map(r => r.entity_id));
}

/**
 * Prisma where-clause for "related to `base` under `rule`", or null when the
 * base deal lacks the values needed (ALL with a blank field, ANY with all blank).
 * Never includes the base deal itself. Tenancy and scope are added by callers.
 */
export async function relatedWhere(rule: LinkRule, base: MatchableDeal): Promise<Record<string, unknown> | null> {
  const k = matchKeys(rule, base);
  if (!k.usable) return null;
  const parts: Array<Record<string, unknown>> = [];
  for (const { field, value } of k.present) {
    if (field.kind === 'custom') parts.push({ id: { in: [...await idsWithCustomValue(field.fieldId, [value])] } });
    else if (field.kind === 'account') parts.push({ accountId: value });
    else if (field.kind === 'contact') parts.push({ contactId: value });
    else parts.push({ pipelineId: value });
  }
  const combined = rule.mode === 'ALL' ? { AND: parts } : { OR: parts };
  return { AND: [combined, { id: { not: base.id } }] };
}

export interface RelatedDealRow {
  id: string;
  title: string;
  status: string;
  stage: string;
  value: number | null;
  createdAt: Date;
  closeDate: Date | null;
  owner: { id: string; name: string } | null;
  latestNote: { text: string; date: Date; kind: NoteKind } | null;
}

export interface RelatedResult {
  deals: RelatedDealRow[];
  counts: { lost: number; won: number; open: number; total: number };
  hasMore: boolean;
}

/** Visible related deals, newest first, plus outcome counts over all visible matches. */
export async function findRelatedDeals(ctx: PermCtx, rule: LinkRule, base: MatchableDeal, limit = 20): Promise<RelatedResult | null> {
  const rel = await relatedWhere(rule, base);
  if (!rel) return null;
  const where = { AND: [{ orgId: ctx.orgId }, scopedWhere(ctx, 'deal', 'crm.deal.read'), rel] };
  const take = Math.min(Math.max(1, limit), RELATED_PAGE_MAX);
  const [rows, grouped] = await Promise.all([
    prisma.deal.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: take + 1,
      select: {
        id: true, title: true, status: true, stage: true, value: true, createdAt: true, closeDate: true,
        assignee: { select: { id: true, name: true } },
      },
    }),
    prisma.deal.groupBy({ by: ['status'], where, _count: { _all: true } }),
  ]);
  const counts = { lost: 0, won: 0, open: 0, total: 0 };
  for (const g of grouped as Array<{ status: string; _count: { _all: number } }>) {
    const n = g._count._all;
    counts.total += n;
    if (g.status === 'LOST') counts.lost = n; else if (g.status === 'WON') counts.won = n; else counts.open = n;
  }
  const page = rows.slice(0, take);
  const latest = await latestNotes(ctx, page.map(r => r.id));
  const deals = page.map(r => {
    const red = redact(ctx, 'deal', { value: Number(r.value) }) as { value?: unknown };
    return {
      id: r.id, title: r.title, status: r.status, stage: r.stage,
      value: typeof red.value === 'number' ? red.value : null,
      createdAt: r.createdAt, closeDate: r.closeDate,
      owner: r.assignee, latestNote: latest.get(r.id) ?? null,
    };
  });
  return { deals, counts, hasMore: rows.length > take };
}

const ACTIVITY_KIND: Record<string, NoteKind> = { CALL: 'call', EMAIL: 'email', MEETING: 'meeting', TASK: 'task' };

/** Comments + activity notes for these deals, newest first per deal, capped per deal. */
async function dealNotes(ctx: PermCtx, dealIds: string[], perDeal: number): Promise<Map<string, NoteSource[]>> {
  const out = new Map<string, NoteSource[]>();
  if (!dealIds.length) return out;
  const [comments, activities] = await Promise.all([
    prisma.comment.findMany({
      where: { entityType: 'DEAL', entityId: { in: dealIds } },
      select: { entityId: true, body: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: dealIds.length * perDeal,
    }),
    can(ctx, 'crm.activity.read')
      ? prisma.activity.findMany({
        where: { orgId: ctx.orgId, dealId: { in: dealIds } },
        select: { dealId: true, type: true, title: true, body: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: dealIds.length * perDeal,
      })
      : Promise.resolve([] as Array<{ dealId: string | null; type: string; title: string; body: string | null; createdAt: Date }>),
  ]);
  const push = (id: string, n: NoteSource) => {
    const list = out.get(id) ?? [];
    if (list.length < perDeal * 2) list.push(n);
    out.set(id, list);
  };
  for (const c of comments) push(c.entityId, { kind: 'comment', date: c.createdAt, text: c.body });
  for (const a of activities) {
    if (!a.dealId) continue;
    // The title is often the whole note ("Call: customer wants 8% off").
    const text = [a.title, a.body].filter(Boolean).join(' — ');
    push(a.dealId, { kind: ACTIVITY_KIND[a.type] ?? 'task', date: a.createdAt, text });
  }
  for (const [id, list] of out) out.set(id, list.sort((a, b) => b.date.getTime() - a.date.getTime()).slice(0, perDeal));
  return out;
}

async function latestNotes(ctx: PermCtx, dealIds: string[]): Promise<Map<string, { text: string; date: Date; kind: NoteKind }>> {
  const notes = await dealNotes(ctx, dealIds, 3);
  const out = new Map<string, { text: string; date: Date; kind: NoteKind }>();
  for (const [id, list] of notes) {
    const n = list.map(x => ({ ...x, text: cleanNote(x.text) })).find(x => x.text);
    if (n) out.set(id, { text: n.text.length > 160 ? `${n.text.slice(0, 160)}…` : n.text, date: n.date, kind: n.kind });
  }
  return out;
}

// ─── Lessons input ───────────────────────────────────────────────────────────

/**
 * The closed related deals the viewer can see (lost first, then won, newest
 * first, at most MAX_LESSON_DEALS) with everything people recorded on them.
 */
export async function gatherLessonDeals(ctx: PermCtx, rule: LinkRule, base: MatchableDeal): Promise<{ deals: LessonDeal[]; counts: { lost: number; won: number } } | null> {
  const rel = await relatedWhere(rule, base);
  if (!rel) return null;
  const scope = scopedWhere(ctx, 'deal', 'crm.deal.read');
  const pick = (status: 'LOST' | 'WON') => prisma.deal.findMany({
    where: { AND: [{ orgId: ctx.orgId, status }, scope, rel] },
    orderBy: [{ closeDate: { sort: 'desc', nulls: 'last' } }, { updatedAt: 'desc' }],
    take: MAX_LESSON_DEALS,
    select: { id: true, title: true, status: true, value: true, createdAt: true, updatedAt: true, closeDate: true },
  });
  const [lost, won] = await Promise.all([pick('LOST'), pick('WON')]);
  const base8 = selectLessonDeals([...lost, ...won].map(d => ({
    id: d.id, title: d.title, status: d.status as LessonDeal['status'],
    value: Number(d.value), createdAt: d.createdAt, updatedAt: d.updatedAt, closeDate: d.closeDate,
    stagePath: [], notes: [], quote: null,
  })));
  const ids = base8.map(d => d.id);
  if (!ids.length) return { deals: [], counts: { lost: lost.length, won: won.length } };

  const quotesOn = can(ctx, 'crm.quote.read') && !(await isModuleBlocked(ctx.orgId, 'sales_docs'));
  const [notes, history, leads, quotes] = await Promise.all([
    dealNotes(ctx, ids, 12),
    prisma.dealHistory.findMany({ where: { dealId: { in: ids } }, orderBy: { changedAt: 'asc' }, select: { dealId: true, fromStage: true, toStage: true } }),
    can(ctx, 'crm.lead.read')
      ? prisma.lead.findMany({ where: { orgId: ctx.orgId, dealId: { in: ids } }, select: { dealId: true, assignedTo: true, notes: true, createdAt: true } })
      : Promise.resolve([] as Array<{ dealId: string | null; assignedTo: string | null; notes: string | null; createdAt: Date }>),
    quotesOn
      ? prisma.quote.findMany({
        where: { orgId: ctx.orgId, dealId: { in: ids } },
        orderBy: { createdAt: 'desc' },
        select: { dealId: true, title: true, status: true, notes: true, createdBy: true, createdAt: true, lines: { select: { quantity: true, unitPrice: true, discount: true } } },
      })
      : Promise.resolve([] as any[]),
  ]);

  for (const d of base8) {
    d.notes = [...(notes.get(d.id) ?? [])];
    const path: string[] = [];
    for (const h of history.filter(x => x.dealId === d.id)) {
      if (!path.length && h.fromStage) path.push(h.fromStage);
      if (path[path.length - 1] !== h.toStage) path.push(h.toStage);
    }
    d.stagePath = path;
    for (const l of leads) {
      if (l.dealId === d.id && l.notes && canAccessRecord(ctx, 'lead', 'crm.lead.read', l)) {
        d.notes.push({ kind: 'lead note', date: l.createdAt, text: l.notes });
      }
    }
    const qs = (quotes as any[]).filter(q => q.dealId === d.id && canAccessRecord(ctx, 'quote', 'crm.quote.read', q));
    if (qs.length) {
      const q = qs[0];
      const total = q.lines.reduce((s: number, l: any) => s + Number(l.quantity) * Number(l.unitPrice) * (1 - Number(l.discount) / 100), 0);
      const maxDiscountPct = q.lines.reduce((m: number, l: any) => Math.max(m, Number(l.discount)), 0);
      d.quote = { title: q.title, total, maxDiscountPct, status: q.status };
      if (q.notes) d.notes.push({ kind: 'quote note', date: q.createdAt, text: q.notes });
    }
    // Value can be field-masked for this role: send 0 rather than the real figure.
    const red = redact(ctx, 'deal', { value: d.value }) as { value?: unknown };
    if (typeof red.value !== 'number') d.value = 0;
  }
  return { deals: base8, counts: { lost: lost.length, won: won.length } };
}

// ─── Hints (board cards, create form) ────────────────────────────────────────

/**
 * Lost/won/open counts of visible related deals for each target. One pool
 * query per rule field, then exact AND/ANY combination in memory
 * (match.ts relatedOutcomeCounts).
 */
export async function outcomeCountsFor(ctx: PermCtx, rule: LinkRule, targets: MatchableDeal[]): Promise<Map<string, { lost: number; won: number; open: number }>> {
  const ors: Array<Record<string, unknown>> = [];
  for (const f of rule.fields) {
    const vals = [...new Set(targets.map(t => {
      if (f.kind === 'custom') return normaliseValue(t.custom?.[f.fieldId]);
      return (f.kind === 'account' ? t.accountId : f.kind === 'contact' ? t.contactId : t.pipelineId) || null;
    }).filter((v): v is string => !!v))];
    if (!vals.length) continue;
    if (f.kind === 'custom') ors.push({ id: { in: [...await idsWithCustomValue(f.fieldId, vals)] } });
    else if (f.kind === 'account') ors.push({ accountId: { in: vals } });
    else if (f.kind === 'contact') ors.push({ contactId: { in: vals } });
    else ors.push({ pipelineId: { in: vals } });
  }
  if (!ors.length) return new Map();
  const pool = await prisma.deal.findMany({
    where: { AND: [{ orgId: ctx.orgId }, scopedWhere(ctx, 'deal', 'crm.deal.read'), { OR: ors }] },
    select: { id: true, status: true, accountId: true, contactId: true, pipelineId: true },
    take: 5000,
  });
  const cvs = await customValuesFor(rule, pool.map(p => p.id));
  const matchablePool = pool.map(p => ({ ...p, custom: cvs.get(p.id) ?? {} }));
  return relatedOutcomeCounts(rule, targets, matchablePool);
}

export { linkFieldKey };
