/**
 * Follow-ups (utils/followups): due/overdue/today classification across
 * timezones and date-only vs date-time, reminder selection (exactly once,
 * no replay after downtime), digest once per day, list status aggregation,
 * AI context trimming, the email fact checker, next-step parsing, and
 * permission filtering of My Work.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../../src/utils/prisma';
import type { PermCtx, Scope } from '../../src/utils/permissions';
import {
  isDateOnly, classifyDue, remindAt, shouldRemind, candidateDueWindow, digestWindowOpen, summarise,
  compareSummaries, parseDueInput, dueDayKey, matchesFilter, EMPTY_SUMMARY, OpenItem,
} from '../../src/utils/followups/time';
import { checkDraft, contextFacts, amountMentions, dateMentions } from '../../src/utils/followups/factcheck';
import { renderContext, FollowUpContext, EMAIL_CONTEXT_CHARS, NOTE_CAP_EMAIL, NEXT_STEP_CONTEXT_CHARS, NOTE_CAP_NEXT, contextNumbers } from '../../src/utils/followups/context';
import { buildEmailPrompt, parseEmailReply, factCheck, textToHtml, stripQuoted, referencedIds, EMAIL_MAX_TOKENS } from '../../src/utils/followups/email';
import { parseNextStep, buildNextStepPrompt, cooldownLeft, NEXT_STEP_MAX_TOKENS } from '../../src/utils/followups/nextStep';
import { selectDue, DueCandidate, digestText } from '../../src/utils/followups/reminders';

const IST = 'Asia/Kolkata';
const NY = 'America/New_York';
const at = (iso: string) => new Date(iso);
const dateOnly = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);

// ─── Classification ─────────────────────────────────────────────────────────

test('date-only is exactly UTC midnight; any other instant is a real time', () => {
  assert.equal(isDateOnly(dateOnly('2026-10-25')), true);
  assert.equal(isDateOnly(at('2026-10-25T00:00:01.000Z')), false);
  assert.equal(isDateOnly(at('2026-10-25T05:30:00.000Z')), false);
  // API input: a date stays date-only; a time landing on UTC midnight is nudged a minute.
  assert.equal(parseDueInput('2026-10-25')!.toISOString(), '2026-10-25T00:00:00.000Z');
  assert.equal(parseDueInput('2026-10-25T05:30:00+05:30')!.toISOString(), '2026-10-25T00:01:00.000Z');
  assert.equal(parseDueInput('2026-10-25T11:00:00+05:30')!.toISOString(), '2026-10-25T05:30:00.000Z');
  assert.equal(parseDueInput('nonsense'), null);
  assert.equal(parseDueInput(''), null);
});

test('IST near midnight: "today" is the org\'s local day, not UTC', () => {
  // 23:50 IST on 24 Oct = 18:20 UTC on 24 Oct; 00:10 IST on 25 Oct = 18:40 UTC on 24 Oct.
  const lateNight = at('2026-10-24T18:20:00Z');
  const justAfterMidnight = at('2026-10-24T18:40:00Z');
  const due25 = dateOnly('2026-10-25');
  assert.equal(classifyDue(due25, lateNight, IST), 'UPCOMING');
  assert.equal(classifyDue(due25, justAfterMidnight, IST), 'TODAY', 'date-only 25 Oct is due today from 00:00 IST, though UTC is still the 24th');
  assert.equal(classifyDue(dateOnly('2026-10-24'), justAfterMidnight, IST), 'OVERDUE');
  // A timed item at 23:55 IST on the 24th: today at 23:50, overdue at 00:10.
  const t = at('2026-10-24T18:25:00Z');
  assert.equal(classifyDue(t, lateNight, IST), 'TODAY');
  assert.equal(classifyDue(t, justAfterMidnight, IST), 'OVERDUE');
  // A timed item at 00:30 IST on the 25th, seen at 23:50 IST on the 24th: tomorrow.
  assert.equal(classifyDue(at('2026-10-24T19:00:00Z'), lateNight, IST), 'UPCOMING');
  assert.equal(dueDayKey(at('2026-10-24T19:00:00Z'), IST), '2026-10-25');
});

test('date-only dates are read in UTC, never shifted a day west of Greenwich', () => {
  const due = dateOnly('2026-10-25');
  assert.equal(dueDayKey(due, NY), '2026-10-25');
  // 20:00 in New York on the 24th (00:00Z on the 25th): still upcoming there.
  assert.equal(classifyDue(due, at('2026-10-25T00:00:00Z'), NY), 'UPCOMING');
  assert.equal(classifyDue(due, at('2026-10-25T13:00:00Z'), NY), 'TODAY');
  // A timed item earlier today that has passed is overdue (date-time compares instants).
  assert.equal(classifyDue(at('2026-10-25T13:00:00Z'), at('2026-10-25T13:01:00Z'), NY), 'OVERDUE');
});

test('reminder time: date-only at the org working-day start; timed at its time', () => {
  assert.equal(remindAt(dateOnly('2026-10-25'), IST, { h: 9, min: 0 }).toISOString(), '2026-10-25T03:30:00.000Z');
  assert.equal(remindAt(dateOnly('2026-10-25'), NY, { h: 9, min: 0 }).toISOString(), '2026-10-25T13:00:00.000Z');
  const timed = at('2026-10-25T08:45:00Z');
  assert.equal(remindAt(timed, IST).getTime(), timed.getTime());
});

test('reminders fire within the grace window only — no replay after downtime', () => {
  const grace = 6 * 3_600_000;
  const due = at('2026-10-25T08:00:00Z');
  assert.equal(shouldRemind(due, at('2026-10-25T07:59:00Z'), IST, grace), false, 'not before it is due');
  assert.equal(shouldRemind(due, at('2026-10-25T08:00:00Z'), IST, grace), true);
  assert.equal(shouldRemind(due, at('2026-10-25T13:59:00Z'), IST, grace), true, 'after 6h downtime it still goes out once');
  assert.equal(shouldRemind(due, at('2026-10-25T14:01:00Z'), IST, grace), false, 'older than the grace window: left to the digest');
  // The DB pre-filter window always contains anything shouldRemind accepts (incl. date-only in far zones).
  for (const tz of [IST, NY, 'Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
    const d = dateOnly('2026-10-25');
    const fire = remindAt(d, tz);
    const w = candidateDueWindow(new Date(fire.getTime() + 60_000), grace);
    assert.ok(d >= w.from && d <= w.to, `window covers date-only reminder in ${tz}`);
  }
});

function cand(id: string, dueAt: Date, orgId = 'org1'): DueCandidate {
  return { id, source: 'ACTIVITY', orgId, type: 'CALL', title: `Call ${id}`, dueAt, userId: 'rep', rec: { kind: 'LEAD', id: 'L1' } };
}

test('reminder selection is idempotent across restarts: the conditional claim lets each row through once', async () => {
  // In-memory activities table honouring the claim's WHERE (reminded_at IS NULL AND due_at = seen).
  const rows = [
    { id: 'a1', dueAt: at('2026-10-25T08:00:00Z'), remindedAt: null as Date | null, done: false },
    { id: 'a2', dueAt: at('2026-10-25T08:05:00Z'), remindedAt: null as Date | null, done: false },
    { id: 'old', dueAt: at('2026-10-20T08:00:00Z'), remindedAt: null as Date | null, done: false },
  ];
  const p = prisma as any;
  p.activity.updateMany = async ({ where, data }: any) => {
    const r = rows.find(x => x.id === where.id && x.remindedAt === null && x.dueAt.getTime() === where.dueAt.getTime() && x.done === false);
    if (!r) return { count: 0 };
    Object.assign(r, data);
    return { count: 1 };
  };
  const { claim } = await import('../../src/utils/followups/reminders') as any;
  const tz = new Map([['org1', IST]]);
  const now = at('2026-10-25T08:10:00Z');
  const tick = async () => {
    const open = rows.filter(r => !r.remindedAt && !r.done).map(r => cand(r.id, r.dueAt));
    const due = selectDue(open, tz, new Set(), now);
    const sent: string[] = [];
    for (const c of due) if (await claim(c, now)) sent.push(c.id);
    return sent;
  };
  assert.deepEqual(await tick(), ['a1', 'a2'], 'first tick sends both; the week-old one never fires');
  assert.deepEqual(await tick(), [], 'a restart/second tick sends nothing again');
  // Two overlapping workers racing on the same candidate: only one claim wins.
  rows[0].remindedAt = null;
  const c = cand('a1', rows[0].dueAt);
  const results = await Promise.all([claim(c, now), claim(c, now)]);
  assert.deepEqual(results.sort(), [false, true]);
  // Rescheduled after the poller read it (dueAt changed): claim refuses the stale copy.
  rows[1].remindedAt = null; rows[1].dueAt = at('2026-10-26T08:05:00Z');
  assert.equal(await claim(cand('a2', at('2026-10-25T08:05:00Z')), now), false);
});

test('orgs with CRM switched off are skipped by reminder selection', () => {
  const now = at('2026-10-25T08:10:00Z');
  const cs = [cand('x', at('2026-10-25T08:00:00Z'), 'on'), cand('y', at('2026-10-25T08:00:00Z'), 'off')];
  const due = selectDue(cs, new Map([['on', IST], ['off', IST]]), new Set(['off']), now);
  assert.deepEqual(due.map(d => d.id), ['x']);
});

test('morning digest: window opens at the org day start; claim is once per user per day', async () => {
  assert.equal(digestWindowOpen(at('2026-10-25T03:29:00Z'), IST), false);
  assert.equal(digestWindowOpen(at('2026-10-25T03:30:00Z'), IST), true);
  assert.equal(digestWindowOpen(at('2026-10-25T06:29:00Z'), IST), true);
  assert.equal(digestWindowOpen(at('2026-10-25T06:31:00Z'), IST), false);
  assert.equal(digestText({ today: 3, overdue: 2 }), 'You have 3 follow-ups today, 2 overdue');
  assert.equal(digestText({ today: 1, overdue: 0 }), 'You have 1 follow-up today');
  assert.equal(digestText({ today: 0, overdue: 4 }), 'You have 4 overdue');

  const prefs = new Map<string, { userId: string; orgId: string; digest: boolean; lastDigestOn: string | null }>();
  const p = prisma as any;
  p.followUpPrefs.upsert = async ({ where, create }: any) => { if (!prefs.has(where.userId)) prefs.set(where.userId, { digest: true, lastDigestOn: null, ...create }); return prefs.get(where.userId); };
  p.followUpPrefs.updateMany = async ({ where, data }: any) => {
    const r = prefs.get(where.userId);
    const today = where.OR[1].lastDigestOn.not;
    if (!r || r.digest !== where.digest) return { count: 0 };
    if (!(r.lastDigestOn === null || r.lastDigestOn !== today)) return { count: 0 };
    Object.assign(r, data); return { count: 1 };
  };
  const { claimDigest } = await import('../../src/utils/followups/reminders') as any;
  assert.equal(await claimDigest('u1', 'org1', '2026-10-25'), true);
  assert.equal(await claimDigest('u1', 'org1', '2026-10-25'), false, 'second tick the same day: no digest');
  assert.equal(await claimDigest('u1', 'org1', '2026-10-26'), true, 'next day: one more');
  prefs.get('u1')!.digest = false;
  assert.equal(await claimDigest('u1', 'org1', '2026-10-27'), false, 'turned off: none');
});

// ─── List status aggregation ────────────────────────────────────────────────

test('record summary: overdue wins, oldest overdue is named, counts per bucket', () => {
  const now = at('2026-10-25T06:00:00Z'); // 11:30 IST
  const items: OpenItem[] = [
    { id: '1', source: 'ACTIVITY', type: 'CALL', title: 'Call Mr. Iyer', dueAt: dateOnly('2026-10-23') },
    { id: '2', source: 'TASK', type: 'TASK', title: 'Send brochure', dueAt: dateOnly('2026-10-24') },
    { id: '3', source: 'ACTIVITY', type: 'MEETING', title: 'Site visit', dueAt: at('2026-10-25T10:30:00Z') },
    { id: '4', source: 'ACTIVITY', type: 'EMAIL', title: 'Quote', dueAt: dateOnly('2026-10-28') },
    { id: '5', source: 'ACTIVITY', type: 'TASK', title: 'Someday', dueAt: null },
  ];
  const s = summarise(items, now, IST);
  assert.equal(s.status, 'OVERDUE');
  assert.deepEqual([s.overdue, s.today, s.upcoming, s.undated], [2, 1, 1, 1]);
  assert.equal(s.focus!.id, '1');
  assert.equal(s.focus!.days, 2);
  assert.match(s.label, /^Call Mr\. Iyer — overdue 2 days \(\+4 more\)$/);
  assert.equal(s.next!.id, '3');

  const todayOnly = summarise([items[2]], now, IST);
  assert.equal(todayOnly.status, 'TODAY');
  assert.match(todayOnly.label, /Site visit — due today 16:00/);
  const upcoming = summarise([items[3]], now, IST);
  assert.equal(upcoming.status, 'UPCOMING');
  assert.match(upcoming.label, /Quote — 28 Oct/);
  assert.equal(summarise([items[4]], now, IST).status, 'UNDATED');
  assert.equal(summarise([], now, IST), EMPTY_SUMMARY);

  // Sort: overdue (oldest first) < today < upcoming < undated < none; filters.
  const list = [EMPTY_SUMMARY, upcoming, todayOnly, s, summarise([items[1]], now, IST)];
  const sorted = [...list].sort(compareSummaries);
  assert.deepEqual(sorted.map(x => x.status), ['OVERDUE', 'OVERDUE', 'TODAY', 'UPCOMING', 'NONE']);
  assert.equal(sorted[0], s, 'older overdue first');
  assert.equal(matchesFilter(s, 'overdue'), true);
  assert.equal(matchesFilter(s, 'today'), true, 'a record with an overdue AND a today item shows under both filters');
  assert.equal(matchesFilter(upcoming, 'none'), false);
  assert.equal(matchesFilter(EMPTY_SUMMARY, 'none'), true);
});

// ─── AI context, prompts, fact check ────────────────────────────────────────

function ctxFixture(overrides: Partial<FollowUpContext> = {}): FollowUpContext {
  const notes = Array.from({ length: 30 }, (_, i) => ({
    kind: i % 2 ? 'comment' : 'call', date: new Date(Date.UTC(2026, 9, 24 - i)), author: 'Ravi',
    text: `${i === 0 ? 'Mr. Iyer asked for parking near the lift and a 3% discount. ' : ''}Note ${i}: ` + 'lorem ipsum dolor sit amet '.repeat(40),
  }));
  return {
    kind: 'DEAL', id: 'D1', title: 'Tower B 502 – Iyer', status: 'OPEN', stage: 'Negotiation', daysInStage: 12,
    value: 8500000, closeDate: dateOnly('2026-11-15'), currency: 'INR', source: null,
    contact: { name: 'Mr. Iyer', email: 'iyer@example.com', company: 'Acme Pvt Ltd', jobTitle: 'Director' },
    sender: { name: 'Ravi Kumar', company: 'Zenith Realty' },
    notes,
    planned: [{ type: 'CALL', title: 'Discuss loan sanction', dueAt: dateOnly('2026-10-23'), status: 'OVERDUE', days: 2 }],
    quote: { title: 'Q-12', status: 'SENT', total: 8245000, maxDiscountPct: 3, validUntil: dateOnly('2026-10-31'), lines: [{ description: '3BHK unit', quantity: 1, unitPrice: 8500000, discount: 3 }] },
    lessons: ['Check the buyer’s home-loan sanction status before blocking the unit.'],
    today: '2026-10-25', weekday: 'Sunday', timeZone: IST,
    ...overrides,
  };
}

test('context builder: newest notes first, capped per note and within the token budget', () => {
  const c = ctxFixture();
  const r = renderContext(c, { budget: EMAIL_CONTEXT_CHARS, noteCap: NOTE_CAP_EMAIL });
  assert.ok(r.text.length <= EMAIL_CONTEXT_CHARS, `rendered ${r.text.length} chars`);
  assert.ok(r.text.indexOf('Note 0:') < r.text.indexOf('Note 1:'), 'newest first');
  assert.ok(!r.text.includes('Note 20:'), 'only the newest MAX_NOTES are considered');
  const tight = renderContext(c, { budget: 3000, noteCap: NOTE_CAP_EMAIL });
  assert.ok(tight.text.length <= 3000 && tight.notesShown < tight.notesTotal, 'a smaller budget drops the oldest notes');
  assert.ok(tight.text.includes('Note 0:'));
  assert.match(r.text, /value INR 85,00,000/);
  assert.match(r.text, /LATEST QUOTE: "Q-12" · SENT · total INR 82,45,000 · discount up to 3% · valid until 2026-10-31/);
  assert.match(r.text, /\[overdue 2 days\] call: Discuss loan sanction \(due 2026-10-23\)/);
  assert.match(r.text, /LESSONS FROM SIMILAR PAST DEALS/);
  for (const line of r.text.split('\n').filter(l => l.includes('Note '))) assert.ok(line.length < NOTE_CAP_EMAIL + 60);

  const p = buildEmailPrompt(c, { purpose: 'send_quote', tone: 'formal', language: 'en', refresh: false });
  assert.ok(p.estRequestTokens < 4000, `email request ≈ ${p.estRequestTokens} tokens incl. max_tokens ${EMAIL_MAX_TOKENS}`);
  const n = buildNextStepPrompt(c);
  assert.ok(n.estRequestTokens < 1500, `next-step request ≈ ${n.estRequestTokens} tokens incl. max_tokens ${NEXT_STEP_MAX_TOKENS}`);
  assert.ok(renderContext(c, { budget: NEXT_STEP_CONTEXT_CHARS, noteCap: NOTE_CAP_NEXT, includeLessons: false }).text.length <= NEXT_STEP_CONTEXT_CHARS);
  // Same input → same cache key; a new note → new key.
  assert.equal(buildEmailPrompt(c, { purpose: 'send_quote', tone: 'formal', language: 'en', refresh: true }).cacheKey, p.cacheKey);
  const c2 = ctxFixture({ notes: [{ kind: 'comment', date: new Date(), text: 'new' }, ...c.notes] });
  assert.notEqual(buildEmailPrompt(c2, { purpose: 'send_quote', tone: 'formal', language: 'en', refresh: false }).cacheKey, p.cacheKey);
});

test('fact checker: amounts in any Indian/Western format verify against the context; invented ones are flagged', () => {
  const c = ctxFixture();
  const r = renderContext(c, { budget: EMAIL_CONTEXT_CHARS, noteCap: NOTE_CAP_EMAIL });
  const facts = contextFacts(r.text, contextNumbers(c));
  const ok = 'Dear Mr. Iyer, as quoted, the total is ₹82,45,000 (Rs. 82.45 lakh) with a 3% discount, valid until 31 October 2026. The unit price is INR 85,00,000.';
  assert.deepEqual(checkDraft(ok, facts, 'deal'), []);
  const bad = 'We can offer it at ₹80,00,000 with a 5% discount if you confirm by 28 Oct. Shall we meet on Friday at 4 pm?';
  const flags = checkDraft(bad, facts, 'deal');
  assert.deepEqual(flags.map(f => f.kind).sort(), ['amount', 'date', 'percent', 'time', 'weekday']);
  assert.equal(flags.find(f => f.kind === 'amount')!.message, 'check: ₹80,00,000 not found in the deal');
  // Upcoming context dates make their weekday plausible (31 Oct 2026, the quote's validity, is a Saturday);
  // a past note date doesn't (23 Oct, the overdue call, was a Friday — "Friday" above was flagged).
  assert.deepEqual(checkDraft('The quote is valid until 31 October (Saturday).', facts, 'deal'), []);
  assert.deepEqual(checkDraft('About the call planned for 23 October.', facts, 'deal'), []);
  // Plain counts are not money.
  assert.deepEqual(checkDraft('The 3 BHK has 2 balconies.', facts, 'deal'), []);
  assert.deepEqual(amountMentions('₹85 lakh or 1.2 crore or $12,500').map(m => m.value), [8500000, 12000000, 12500]);
  assert.deepEqual(dateMentions('on 2026-10-31, 31/10/2026 and Oct 31st').map(d => d.md), ['10-31', '10-31', '10-31']);
  // Through the email helper too (subject included).
  assert.equal(factCheck(c, r.text, 'Offer: ₹79 lakh', 'Hello').length, 1);
});

test('email reply parsing: JSON only, markdown stripped, bad shapes give repair problems', () => {
  const ok = parseEmailReply(JSON.stringify({ subject: 'Following up\n on Tower B', body: '**Dear Mr. Iyer**,\n\n# Hi\nThanks for visiting the site yesterday, as noted.' }));
  assert.ok(ok.ok);
  if (ok.ok) { assert.equal(ok.subject, 'Following up on Tower B'); assert.doesNotMatch(ok.body, /\*\*|^#/m); }
  const bad = parseEmailReply('Sure! Here is your email');
  assert.equal(bad.ok, false);
  const shape = parseEmailReply(JSON.stringify({ subject: '', body: 'x' }));
  assert.equal(shape.ok, false);
  if (!shape.ok) assert.ok(shape.problems.length >= 2);
  // HTML is fully escaped; replies are trimmed of the quoted original.
  assert.equal(textToHtml('<b>hi</b>\nthere'), '<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;color:#111"><p style="margin:0 0 12px">&lt;b&gt;hi&lt;/b&gt;<br>there</p></div>');
  assert.equal(stripQuoted('Yes, Friday works.\n\nOn Sat, 24 Oct 2026, Ravi wrote:\n> Dear Mr. Iyer'), 'Yes, Friday works.');
  assert.deepEqual(referencedIds('<a@x>', ['<root@x> <a@x>']), ['<a@x>', '<root@x>']);
});

test('next-step parsing: dates resolved in the org timezone; past/unparseable fall back; bad JSON → problems', () => {
  const now = at('2026-10-25T06:00:00Z'); // Sun 11:30 IST
  const r = parseNextStep(JSON.stringify({ type: 'call', title: 'Call Mr. Iyer about the loan sanction', when: 'tomorrow 11am', reason: 'Loan call is overdue.' }), now, IST);
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.suggestion.type, 'CALL');
    assert.equal(r.suggestion.dueAt, '2026-10-26T05:30:00.000Z');
    assert.equal(r.suggestion.defaulted, false);
    assert.match(r.suggestion.dueLabel, /Mon.*26 Oct 2026.*11:00/);
  }
  const days = parseNextStep(JSON.stringify({ type: 'EMAIL', title: 'Send the revised quote', when: 'in 3 days' }), now, IST);
  assert.ok(days.ok && days.suggestion.dueAt === '2026-10-28T03:30:00.000Z', 'date words without a time get 09:00 org time');
  const past = parseNextStep(JSON.stringify({ type: 'TASK', title: 'Check documents', when: 'yesterday' }), now, IST);
  assert.ok(past.ok && past.suggestion.defaulted && past.suggestion.dueAt === '2026-10-26T03:30:00.000Z');
  const nonsense = parseNextStep(JSON.stringify({ type: 'MEETING', title: 'Meet', when: 'whenever suits' }), now, IST);
  assert.ok(nonsense.ok && nonsense.suggestion.defaulted);
  assert.equal(parseNextStep(JSON.stringify({ type: 'FAX', title: 'x', when: 'tomorrow' }), now, IST).ok, false);
  assert.equal(parseNextStep('not json', now, IST).ok, false);
  // Midnight-UTC results are nudged so they aren't read as date-only (Tokyo 09:00 = 00:00Z).
  const tokyo = parseNextStep(JSON.stringify({ type: 'CALL', title: 'Call back', when: 'tomorrow 9am' }), now, 'Asia/Tokyo');
  assert.ok(tokyo.ok && !isDateOnly(new Date(tokyo.suggestion.dueAt)));
  assert.equal(cooldownLeft(null, 1000), 0);
  assert.equal(cooldownLeft(0 + 1, 1 + 5 * 60_000, 10), 5 * 60_000);
});

// ─── Permission filtering (My Work) ─────────────────────────────────────────

function ctxFor(userId: string, scope: Scope, extra: Array<[string, Scope]> = []): PermCtx {
  return {
    userId, orgId: 'org1', role: 'SALES_REP', roleKey: 'custom', roleId: 'r1', employeeId: null, departmentId: null,
    reportEmployeeIds: [], reportUserIds: [], teamEmployeeIds: [],
    grants: new Map<string, Scope>([['crm.lead.read', scope], ['crm.deal.read', scope], ['crm.contact.read', scope], ['crm.activity.read', 'ALL'], ...extra]),
    fieldRules: new Map(),
  };
}

type Row = Record<string, any>;
function matches(row: Row, where: any): boolean {
  if (!where || typeof where !== 'object') return true;
  return Object.entries(where).every(([k, v]: [string, any]) => {
    if (k === 'AND') return (v as any[]).every(w => matches(row, w));
    if (k === 'OR') return (v as any[]).some(w => matches(row, w));
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('in' in v && !v.in.includes(row[k])) return false;
      if ('notIn' in v && v.notIn.includes(row[k])) return false;
      if ('not' in v && (v.not === null ? row[k] == null : row[k] === v.not)) return false;
      if ('lt' in v && !(row[k] != null && row[k] < v.lt)) return false;
      return true;
    }
    return row[k] === v;
  });
}

test('My Work: only my follow-ups, only on records my scope allows, overdue first', async () => {
  const LEADS: Row[] = [
    { id: 'L-mine', orgId: 'org1', assignedTo: 'rep', contact: { name: 'Mr. Iyer' } },
    { id: 'L-other', orgId: 'org1', assignedTo: 'boss', contact: { name: 'Ms. Rao' } },
  ];
  const ACTS: Row[] = [
    { id: 'a-today', orgId: 'org1', done: false, type: 'CALL', title: 'Call Iyer', dueAt: dateOnly('2026-10-25'), assignedTo: null, createdBy: 'rep', leadId: 'L-mine', dealId: null, contactId: null },
    { id: 'a-over', orgId: 'org1', done: false, type: 'EMAIL', title: 'Email Iyer', dueAt: dateOnly('2026-10-22'), assignedTo: 'rep', createdBy: 'boss', leadId: 'L-mine', dealId: null, contactId: null },
    { id: 'a-hidden', orgId: 'org1', done: false, type: 'CALL', title: 'Call Rao', dueAt: dateOnly('2026-10-22'), assignedTo: 'rep', createdBy: 'rep', leadId: 'L-other', dealId: null, contactId: null },
    { id: 'a-notmine', orgId: 'org1', done: false, type: 'CALL', title: 'Boss call', dueAt: dateOnly('2026-10-22'), assignedTo: 'boss', createdBy: 'rep', leadId: 'L-mine', dealId: null, contactId: null },
    { id: 'a-future', orgId: 'org1', done: false, type: 'CALL', title: 'Later', dueAt: dateOnly('2026-10-26'), assignedTo: null, createdBy: 'rep', leadId: 'L-mine', dealId: null, contactId: null },
  ];
  const p = prisma as any;
  p.organization.findUnique = async () => ({ timezone: IST });
  p.activity.findMany = async ({ where }: any) => ACTS.filter(r => matches(r, where));
  p.task.findMany = async () => [];
  p.lead.findMany = async ({ where }: any) => LEADS.filter(r => matches(r, where));
  p.deal.findMany = async () => [];
  p.contact.findMany = async () => [];
  const { myFollowUps } = await import('../../src/utils/followups/collect');
  const now = at('2026-10-25T06:00:00Z');

  const own = await myFollowUps(ctxFor('rep', 'OWN'), now);
  assert.deepEqual(own.items.map(i => i.id), ['a-over', 'a-today'], 'assigned-to-me + created-by-me-unassigned; the other rep\'s lead is hidden under OWN scope');
  assert.deepEqual([own.overdue, own.today], [1, 1]);
  assert.equal(own.items[0].record.name, 'Mr. Iyer');
  assert.equal(own.items[0].label, 'Email Iyer — overdue 3 days');

  const all = await myFollowUps(ctxFor('rep', 'ALL'), now);
  assert.deepEqual(all.items.map(i => i.id).sort(), ['a-hidden', 'a-over', 'a-today']);

  const none = await myFollowUps(ctxFor('rep', 'NONE'), now);
  assert.equal(none.items.length, 0, 'no CRM read grant: nothing');
});
