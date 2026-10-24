/**
 * Related deals + "Lessons from related deals" (utils/dealLinks).
 *
 * Pure rules (matching, prompt budget, citation check) are tested directly.
 * The permission tests run the real service functions against a tiny
 * in-memory deal table patched onto the stubbed Prisma client, evaluating the
 * exact where-clauses the service builds — so a missing scope filter fails here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normaliseValue, dealsMatch, matchKeys, combineCandidates, relatedOutcomeCounts, parseStoredRule,
  LinkRule, MatchableDeal,
} from '../../src/utils/dealLinks/match';
import {
  buildLessonsPrompt, checkLessons, cleanNote, quoteAppearsIn, selectLessonDeals, LessonsReplySchema,
  replyProblems, LessonDeal, MAX_LESSON_DEALS, LESSONS_MAX_TOKENS,
} from '../../src/utils/dealLinks/lessons';
import { prisma } from '../../src/utils/prisma';
import type { PermCtx, Scope } from '../../src/utils/permissions';

const FLAT = 'cf_flat';
const TOWER = 'cf_tower';
const flatRule: LinkRule = { fields: [{ kind: 'custom', fieldId: FLAT }], mode: 'ALL' };

const deal = (id: string, custom: Record<string, string> = {}, extra: Partial<MatchableDeal> = {}): MatchableDeal =>
  ({ id, accountId: null, contactId: null, pipelineId: null, custom, ...extra });

// ─── Match rule ──────────────────────────────────────────────────────────────

test('normalisation: case and whitespace never decide a match', () => {
  assert.equal(normaliseValue('  Tower B  -   502 '), 'tower b - 502');
  assert.equal(normaliseValue('TOWER B\t- 502'), 'tower b - 502');
  assert.equal(normaliseValue('   '), null);
  assert.equal(normaliseValue(null), null);
  assert.ok(dealsMatch(flatRule, deal('a', { [FLAT]: 'Tower B - 502' }), deal('b', { [FLAT]: ' tower b  -  502' })));
  assert.ok(!dealsMatch(flatRule, deal('a', { [FLAT]: 'Tower B - 502' }), deal('c', { [FLAT]: 'Tower B - 503' })));
  // Never related to itself.
  assert.ok(!dealsMatch(flatRule, deal('a', { [FLAT]: 'x' }), deal('a', { [FLAT]: 'x' })));
});

test('AND needs every field; ANY needs one', () => {
  const and: LinkRule = { fields: [{ kind: 'custom', fieldId: FLAT }, { kind: 'custom', fieldId: TOWER }], mode: 'ALL' };
  const any: LinkRule = { ...and, mode: 'ANY' };
  const base = deal('a', { [FLAT]: '502', [TOWER]: 'B' });
  const sameFlatOtherTower = deal('b', { [FLAT]: '502', [TOWER]: 'C' });
  const both = deal('c', { [FLAT]: '502', [TOWER]: 'b' });
  assert.ok(!dealsMatch(and, base, sameFlatOtherTower));
  assert.ok(dealsMatch(and, base, both));
  assert.ok(dealsMatch(any, base, sameFlatOtherTower));
  // ALL with a blank field on the base deal can't match anything (it doesn't "share" a blank).
  const blankTower = deal('d', { [FLAT]: '502' });
  assert.equal(matchKeys(and, blankTower).usable, false);
  assert.deepEqual(matchKeys(and, blankTower).missing, [{ kind: 'custom', fieldId: TOWER }]);
  assert.equal(matchKeys(any, blankTower).usable, true);
  // Blank values on the other deal never equal anything.
  assert.ok(!dealsMatch(any, blankTower, deal('e', {})));
});

test('custom field vs account: built-in fields match on the stored id', () => {
  const byAccount: LinkRule = { fields: [{ kind: 'account' }], mode: 'ALL' };
  const a = deal('a', { [FLAT]: '502' }, { accountId: 'acc1' });
  assert.ok(dealsMatch(byAccount, a, deal('b', { [FLAT]: '999' }, { accountId: 'acc1' })));
  assert.ok(!dealsMatch(byAccount, a, deal('c', { [FLAT]: '502' }, { accountId: 'acc2' })));
  assert.ok(!dealsMatch(byAccount, a, deal('d', { [FLAT]: '502' }, { accountId: 'ACC1' })), 'ids are not case-folded');
  const flatAndAccount: LinkRule = { fields: [{ kind: 'custom', fieldId: FLAT }, { kind: 'account' }], mode: 'ALL' };
  assert.ok(dealsMatch(flatAndAccount, a, deal('e', { [FLAT]: '502 ' }, { accountId: 'acc1' })));
  assert.ok(!dealsMatch(flatAndAccount, a, deal('f', { [FLAT]: '502' }, { accountId: 'acc9' })));
});

test('combineCandidates and outcome counts agree with dealsMatch', () => {
  assert.deepEqual([...combineCandidates('ALL', [new Set(['1', '2', '3']), new Set(['2', '3', '4'])], '3')], ['2']);
  assert.deepEqual([...combineCandidates('ANY', [new Set(['1']), new Set(['2'])])].sort(), ['1', '2']);
  assert.equal(combineCandidates('ALL', []).size, 0);
  const pool = [
    { ...deal('L1', { [FLAT]: 'Tower B - 502' }), status: 'LOST' },
    { ...deal('L2', { [FLAT]: 'tower b - 502' }), status: 'LOST' },
    { ...deal('W1', { [FLAT]: 'Tower A - 101' }), status: 'WON' },
    { ...deal('O3', { [FLAT]: 'Tower B - 502' }), status: 'OPEN' },
  ];
  const counts = relatedOutcomeCounts(flatRule, [pool[3], deal('none', { [FLAT]: 'Villa 9' })], pool);
  assert.deepEqual(counts.get('O3'), { lost: 2, won: 0, open: 0 });
  assert.equal(counts.has('none'), false);
});

test('stored rule: malformed or empty reads as "not set up", duplicates removed', () => {
  assert.equal(parseStoredRule(null), null);
  assert.equal(parseStoredRule({ fields: 'nope', mode: 'ALL' }), null);
  assert.equal(parseStoredRule({ fields: [], mode: 'ALL' }), null);
  assert.equal(parseStoredRule({ fields: [{ kind: 'title' }], mode: 'ALL' }), null);
  const r = parseStoredRule({ fields: [{ kind: 'account' }, { kind: 'account' }, { kind: 'custom', fieldId: FLAT }], mode: 'ANY' });
  assert.deepEqual(r, { fields: [{ kind: 'account' }, { kind: 'custom', fieldId: FLAT }], mode: 'ANY' });
});

// ─── Prompt builder ──────────────────────────────────────────────────────────

const d0 = new Date('2026-01-01T00:00:00Z');
const daysAfter = (n: number) => new Date(d0.getTime() + n * 86400000);
function lessonDeal(id: string, status: LessonDeal['status'], notes: Array<[number, string]>, extra: Partial<LessonDeal> = {}): LessonDeal {
  return {
    id, title: `Deal ${id}`, status, value: 7500000, createdAt: d0, updatedAt: daysAfter(30), closeDate: daysAfter(30),
    stagePath: ['Prospecting', 'Proposal'], quote: null,
    notes: notes.map(([day, text]) => ({ kind: 'comment' as const, date: daysAfter(day), text })), ...extra,
  };
}
const current = { title: 'Tower B - 502 booking', status: 'OPEN', stage: 'Proposal', value: 7600000, sharedOn: ['Flat / Unit = "Tower B - 502"'] };

test('notes: HTML stripped, signatures dropped', () => {
  assert.equal(cleanNote('<p>Customer wanted <b>8%</b> discount&nbsp;&amp; parking</p><p>--</p><p>Ravi<br>Sales</p>'), 'Customer wanted 8% discount & parking');
  assert.equal(cleanNote('Loan not sanctioned\nRegards,\nPriya\n+91 99999'), 'Loan not sanctioned');
  assert.equal(cleanNote('Regards, the customer said no'), 'Regards, the customer said no', 'only a signature line cuts');
});

test('prompt builder: worst case stays inside the Groq per-request budget', () => {
  const long = 'The buyer called again about the price and the floor rise charges and asked for a waiver on the club house fee. '.repeat(12);
  const many = Array.from({ length: 12 }, (_, i) =>
    lessonDeal(`L${i}`, i % 3 ? 'LOST' : 'WON', Array.from({ length: 15 }, (_, j) => [j, `${j} ${long}`] as [number, string])));
  const chosen = selectLessonDeals(many);
  assert.equal(chosen.length, MAX_LESSON_DEALS);
  assert.ok(chosen.slice(0, 8).every((d, i, a) => i === 0 || !(a[i - 1].status === 'WON' && d.status === 'LOST')), 'lost before won');
  const p = buildLessonsPrompt(current, chosen, 'INR');
  assert.ok(p.estRequestTokens <= 4000, `estimated ${p.estRequestTokens} tokens`);
  assert.ok(p.estPromptTokens + LESSONS_MAX_TOKENS === p.estRequestTokens);
  // Newest note first within a deal.
  const d1 = p.refs.get('D1')!;
  assert.ok(d1.notes[0].date >= d1.notes[d1.notes.length - 1].date);
  assert.match(p.user, /\(D1\.N1 2026-01-15 comment\)/);
});

test('prompt builder: small scenario carries status, quote discount and notes', () => {
  const p = buildLessonsPrompt(current, [
    lessonDeal('a', 'LOST', [[10, 'customer wanted 8% discount, we could only give 3%']], { quote: { title: 'Q-1', total: 7200000, maxDiscountPct: 3, status: 'SENT' } }),
    lessonDeal('b', 'LOST', [[20, '<p>Home loan not sanctioned before booking deadline</p>']]),
  ], 'INR');
  assert.match(p.user, /\[D1\] LOST/);
  assert.match(p.user, /max line discount 3%/);
  assert.match(p.user, /Home loan not sanctioned before booking deadline/);
  assert.doesNotMatch(p.user, /<p>/);
  assert.ok(p.estRequestTokens < 2000, `estimated ${p.estRequestTokens}`);
  // Same inputs → same cache key; a changed note → a new key.
  const again = buildLessonsPrompt(current, [lessonDeal('a', 'LOST', [[10, 'customer wanted 8% discount, we could only give 3%']], { quote: { title: 'Q-1', total: 7200000, maxDiscountPct: 3, status: 'SENT' } }), lessonDeal('b', 'LOST', [[20, '<p>Home loan not sanctioned before booking deadline</p>']])], 'INR');
  assert.equal(again.cacheKey, p.cacheKey);
  const changed = buildLessonsPrompt(current, [lessonDeal('a', 'LOST', [[10, 'customer wanted 9% discount']])], 'INR');
  assert.notEqual(changed.cacheKey, p.cacheKey);
});

// ─── Citation check ──────────────────────────────────────────────────────────

test('quote matching: exact after normalising, tolerant of one changed word, never one-word', () => {
  const src = 'Customer wanted 8% discount, we could only give 3%. He went with the builder next door.';
  assert.ok(quoteAppearsIn('customer wanted 8% discount, we could only give 3%', src));
  assert.ok(quoteAppearsIn('"Customer wanted 8% discount — we could only give 3%"', src));
  assert.ok(quoteAppearsIn('we could only offer 3%. He went with the builder next door', src), 'one word changed in a long quote');
  assert.ok(!quoteAppearsIn('discount', src));
  assert.ok(!quoteAppearsIn('customer unhappy with the view from the balcony', src));
  assert.ok(!quoteAppearsIn('customer wanted 10% discount', src), 'a changed number in a short quote fails');
});

test('citation validator: invented reasons dropped, real ones kept with their real note', () => {
  const p = buildLessonsPrompt(current, [
    lessonDeal('a', 'LOST', [[10, 'customer wanted 8% discount, we could only give 3%'], [12, 'site visit done, liked the flat']]),
    lessonDeal('b', 'LOST', [[20, 'Home loan not sanctioned before booking deadline']]),
    lessonDeal('c', 'LOST', [[25, 'called, no answer']]),
    lessonDeal('w', 'WON', [[5, 'offered free car parking, buyer booked same day']]),
  ], 'INR');
  const reply = LessonsReplySchema.parse({
    lossReasons: [
      { reason: 'Discount gap', deals: ['D1'], quote: 'customer wanted 8% discount, we could only give 3%', note: 'D1.N2' },
      { reason: 'Loan delay', deals: 'D2', quote: 'Home loan not sanctioned before booking deadline' },
      { reason: 'Vastu concerns', deals: ['D3'], quote: 'buyer worried about vastu of the main door' }, // invented
      { reason: 'Parking', deals: ['D4'], quote: 'offered free car parking, buyer booked same day' },  // a WON deal as a loss
    ],
    whatWorked: [{ reason: 'Free parking closed it', deals: ['D4'], quote: 'offered free car parking', note: 'D4.N1' }],
    checklist: [
      { item: 'Agree the discount ceiling up front', deals: ['D1'] },
      { item: 'Confirm loan sanction before blocking the flat', deals: ['D2'] },
      { item: 'Do a vastu check', deals: ['D3'] },
    ],
    unexplained: [],
    confidence: 'HIGH',
    caveats: [],
  });
  const r = checkLessons(reply, p.refs);
  assert.deepEqual(r.lossReasons.map(x => x.reason), ['Discount gap', 'Loan delay']);
  // The model said note N2; the quote is really in N1 (day 10) — the real one is reported.
  assert.equal(r.lossReasons[0].source.noteDate, '2026-01-11');
  assert.equal(r.lossReasons[0].source.dealId, 'a');
  assert.deepEqual(r.whatWorked.map(x => x.source.dealId), ['w']);
  assert.deepEqual(r.checklist.map(c => c.item), ['Agree the discount ceiling up front', 'Confirm loan sanction before blocking the flat']);
  assert.deepEqual(r.unexplained.map(d => d.id), ['c'], 'the lost deal whose notes say nothing is unexplained');
  assert.equal(r.droppedUnsupported, 3);
  assert.equal(r.confidence, 'medium', 'dropped points cap confidence');
  assert.match(r.caveats.join(' '), /3 points were removed/);
});

test('citation validator: a quote from one deal does not explain another by association', () => {
  const p = buildLessonsPrompt(current, [
    lessonDeal('a', 'LOST', [[10, 'customer wanted 8% discount, we could only give 3%']]),
    lessonDeal('b', 'LOST', [[20, 'no update']]),
  ], 'INR');
  const r = checkLessons(LessonsReplySchema.parse({
    lossReasons: [{ reason: 'Discount', deals: ['D1', 'D2'], quote: 'customer wanted 8% discount' }],
    checklist: [{ item: 'x', deals: ['D2'] }],
    confidence: 'high',
  }), p.refs);
  assert.deepEqual(r.lossReasons[0].deals.map(d => d.id), ['a']);
  assert.deepEqual(r.unexplained.map(d => d.id), ['b']);
  assert.equal(r.checklist.length, 0);
});

test('reply problems: non-object and quote-less replies trigger the one repair call', () => {
  assert.ok(replyProblems(null).length);
  assert.ok(replyProblems({ lossReasons: [{ reason: 'x', deals: ['D1'], quote: 'no' }] }).length);
  assert.deepEqual(replyProblems({ lossReasons: [{ reason: 'x', deals: ['D1'], quote: 'two words' }] }), []);
  assert.deepEqual(replyProblems({}), [], 'an empty but valid reply is fine (all unexplained)');
});

// ─── Permissions (service against an in-memory table) ───────────────────────

type Row = Record<string, any>;
function matches(row: Row, where: any): boolean {
  if (!where || typeof where !== 'object') return true;
  return Object.entries(where).every(([k, v]: [string, any]) => {
    if (k === 'AND') return (v as any[]).every(w => matches(row, w));
    if (k === 'OR') return (v as any[]).some(w => matches(row, w));
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('in' in v) return v.in.includes(row[k]);
      if ('not' in v) return row[k] !== v.not;
      return true;
    }
    return row[k] === v;
  });
}

function ctxFor(userId: string, dealScope: Scope, extra: Array<[string, Scope]> = []): PermCtx {
  return {
    userId, orgId: 'org1', role: 'SALES_REP', roleKey: 'custom', roleId: 'r1', employeeId: null, departmentId: null,
    reportEmployeeIds: [], reportUserIds: [], teamEmployeeIds: [],
    grants: new Map<string, Scope>([['crm.deal.read', dealScope], ...extra]),
    fieldRules: new Map(),
  };
}

const DEALS: Row[] = [
  { id: 'cur', orgId: 'org1', title: 'Third', status: 'OPEN', stage: 'Proposal', value: 1, assignedTo: 'rep', accountId: null, contactId: null, pipelineId: 'p', createdAt: daysAfter(60), updatedAt: daysAfter(60), closeDate: null },
  { id: 'lost1', orgId: 'org1', title: 'First', status: 'LOST', stage: 'Proposal', value: 2, assignedTo: 'rep', accountId: null, contactId: null, pipelineId: 'p', createdAt: daysAfter(1), updatedAt: daysAfter(20), closeDate: daysAfter(20) },
  { id: 'lost2', orgId: 'org1', title: 'Second', status: 'LOST', stage: 'Negotiation', value: 3, assignedTo: 'other', accountId: null, contactId: null, pipelineId: 'p', createdAt: daysAfter(25), updatedAt: daysAfter(40), closeDate: daysAfter(40) },
  { id: 'elsewhere', orgId: 'org1', title: 'Other flat', status: 'LOST', stage: 'Proposal', value: 4, assignedTo: 'rep', accountId: null, contactId: null, pipelineId: 'p', createdAt: daysAfter(2), updatedAt: daysAfter(3), closeDate: daysAfter(3) },
  { id: 'otherorg', orgId: 'org2', title: 'Foreign', status: 'LOST', stage: 'Proposal', value: 5, assignedTo: 'rep', accountId: null, contactId: null, pipelineId: 'p', createdAt: daysAfter(2), updatedAt: daysAfter(3), closeDate: daysAfter(3) },
];
const CF: Row[] = [
  { customFieldId: FLAT, entityId: 'cur', value: 'Tower B - 502' },
  { customFieldId: FLAT, entityId: 'lost1', value: 'tower b - 502' },
  { customFieldId: FLAT, entityId: 'lost2', value: 'Tower B  - 502' },
  { customFieldId: FLAT, entityId: 'elsewhere', value: 'Tower A - 101' },
  { customFieldId: FLAT, entityId: 'otherorg', value: 'Tower B - 502' },
];
const COMMENTS: Row[] = [
  { entityType: 'DEAL', entityId: 'lost1', body: 'customer wanted 8% discount, we could only give 3%', createdAt: daysAfter(19) },
  { entityType: 'DEAL', entityId: 'lost2', body: 'Home loan not sanctioned before booking deadline', createdAt: daysAfter(39) },
];
const fed: string[] = [];

function installFakeDb() {
  const p = prisma as any;
  const pickSelect = (r: Row, select?: any) => (select ? Object.fromEntries(Object.keys(select).map(k => [k, k === 'assignee' ? { id: r.assignedTo, name: r.assignedTo } : r[k]])) : r);
  p.deal.findMany = async ({ where, take, select }: any) => DEALS.filter(r => matches(r, where)).slice(0, take ?? 1e9).map(r => pickSelect(r, select));
  p.deal.groupBy = async ({ where }: any) => {
    const rows = DEALS.filter(r => matches(r, where));
    return [...new Set(rows.map(r => r.status))].map(s => ({ status: s, _count: { _all: rows.filter(r => r.status === s).length } }));
  };
  p.customFieldValue.findMany = async ({ where }: any) => CF.filter(r => matches(r, where));
  p.$queryRawUnsafe = async (_sql: string, fieldId: string, vals: string[]) =>
    CF.filter(r => r.customFieldId === fieldId && vals.includes(normaliseValue(r.value)!)).map(r => ({ entity_id: r.entityId }));
  p.comment.findMany = async ({ where }: any) => {
    const rows = COMMENTS.filter(r => matches(r, where));
    fed.push(...rows.map(r => r.entityId));
    return rows;
  };
  p.activity.findMany = async () => [];
  p.dealHistory.findMany = async () => [];
  p.lead.findMany = async () => [];
  p.quote.findMany = async () => [];
}

test('permissions: related deals and AI input only include deals the viewer may see', async () => {
  installFakeDb();
  const licensing = require('../../src/utils/licensing');
  licensing.isModuleBlocked = async () => false;
  const { findRelatedDeals, gatherLessonDeals, matchableDeal } = await import('../../src/utils/dealLinks/service');
  const base = await matchableDeal(flatRule, DEALS[0] as any);

  // ALL scope: both lost deals on the unit, not the other flat, not the other org.
  const all = await findRelatedDeals(ctxFor('rep', 'ALL'), flatRule, base);
  assert.deepEqual(all!.deals.map(d => d.id).sort(), ['lost1', 'lost2']);
  assert.deepEqual(all!.counts, { lost: 2, won: 0, open: 0, total: 2 });

  // OWN scope: lost2 belongs to someone else — hidden, not even counted.
  const own = await findRelatedDeals(ctxFor('rep', 'OWN'), flatRule, base);
  assert.deepEqual(own!.deals.map(d => d.id), ['lost1']);
  assert.equal(own!.counts.total, 1);

  fed.length = 0;
  const g = await gatherLessonDeals(ctxFor('rep', 'OWN'), flatRule, base);
  assert.deepEqual(g!.deals.map(d => d.id), ['lost1']);
  assert.ok(!fed.includes('lost2'), 'notes of a deal the viewer cannot open are never read for the AI');
  assert.match(g!.deals[0].notes[0].text, /8% discount/);

  // No deal read permission at all: nothing.
  const none = await findRelatedDeals(ctxFor('rep', 'NONE'), flatRule, base);
  assert.equal(none!.deals.length, 0);
});

test('no related closed deals: gather returns an empty list (the handler then skips the model)', async () => {
  installFakeDb();
  const { gatherLessonDeals } = await import('../../src/utils/dealLinks/service');
  const lonely = deal('cur', { [FLAT]: 'Villa 77' });
  const g = await gatherLessonDeals(ctxFor('rep', 'ALL'), flatRule, lonely);
  assert.deepEqual(g!.deals, []);
  // Base deal without the field → not usable (null), so the panel can say "fill in Flat / Unit".
  assert.equal(await gatherLessonDeals(ctxFor('rep', 'ALL'), flatRule, deal('cur', {})), null);
});

test('lessons handler: no history answers without any model call or usage', async () => {
  installFakeDb();
  const p = prisma as any;
  p.dealLinkRule.findUnique = async () => ({ fields: [{ kind: 'custom', fieldId: FLAT }], mode: 'ALL' });
  p.customField.findMany = async () => [{ id: FLAT, label: 'Flat / Unit', fieldType: 'TEXT', fieldKey: 'flat_unit' }];
  p.deal.findFirst = async ({ where }: any) => ({ ...DEALS[0], id: where.id });
  CF.push({ customFieldId: FLAT, entityId: 'solo', value: 'Villa 77' });
  require('../../src/utils/licensing').isModuleBlocked = async () => false;
  require('../../src/utils/permissions').getPermCtx = async () => ctxFor('rep', 'ALL');
  let usage = 0;
  require('../../src/utils/usageTracking').recordUsage = () => { usage++; };
  const { pastLessons } = await import('../../src/modules/crm/deals/dealLinks.controller');
  let body: any; let status = 200;
  const res: any = { json: (b: any) => { body = b; return res; }, status: (s: number) => { status = s; return res; } };
  await pastLessons({ params: { id: 'solo' }, body: {}, user: { id: 'rep', orgId: 'org1', role: 'SALES_REP' } } as any, res, (e: any) => { throw e; });
  assert.equal(status, 200);
  assert.deepEqual(body, { status: 'no_history' });
  assert.equal(usage, 0);
});

test('reply schema: over-long lists are cut rather than rejected', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ reason: `r${i}`, deals: ['D1'], quote: 'some real words' }));
  const p = LessonsReplySchema.parse({ lossReasons: many, checklist: many.map(m => ({ item: m.reason, deals: m.deals })), caveats: Array(9).fill('c') });
  assert.equal(p.lossReasons.length, 12);
  assert.equal(p.checklist.length, 10);
  assert.equal(p.caveats.length, 5);
  assert.deepEqual(replyProblems({ lossReasons: many }), []);
});
