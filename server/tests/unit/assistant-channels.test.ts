/**
 * Staff assistant over WhatsApp / Slack — the pure pieces:
 *  - phone normalisation and profile ↔ sender matching,
 *  - Twilio and Slack signature checks (valid / invalid / replay),
 *  - sender → user mapping (match, no match, ambiguous, inactive, other org,
 *    changed phone, unverified; Slack link / email match),
 *  - the conversation state machine (plan → yes → run; no; expiry; high-risk
 *    double confirmation; numbered disambiguation),
 *  - the WhatsApp keyword rule, chat formatting, limits.
 *
 *     npm run test:unit
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { toE164, phoneMatches, maskPhone } from '../../src/utils/assistantChannels/phone';
import { twilioSignature, verifyTwilioSignature, slackSignature, verifySlackRequest } from '../../src/utils/assistantChannels/signatures';
import { pickWhatsAppSender, pickSlackSender, parseLinkCommand, hashCode, newLinkCode } from '../../src/utils/assistantChannels/identity';
import {
  decide, classifyReply, matchesPhrase, setParam, highRiskPhrase, parseAddressed, type PendingConfirm, type PendingChoose,
} from '../../src/utils/assistantChannels/state';
import { formatAnswer, formatChoices, formatPlanPrompt, formatReport, formatBlocked, clip } from '../../src/utils/assistantChannels/format';
import { SlidingWindowLimiter, SeenIds } from '../../src/utils/assistantChannels/limits';
import { present } from '../../src/utils/assistantChannels/core';
import { isSlackResponseUrl } from '../../src/utils/assistantChannels/transport';
import type { ActionPlan, PlanStep } from '../../src/utils/aiActions/planner';

// ─── Phones ──────────────────────────────────────────────────────────────────

test('toE164 normalises Twilio senders and international input, refuses national numbers', () => {
  assert.equal(toE164('whatsapp:+919876543210'), '+919876543210');
  assert.equal(toE164('+1 (415) 555-1234'), '+14155551234');
  assert.equal(toE164('0044 7700 900123'), '+447700900123');
  assert.equal(toE164('9876543210'), null);
  assert.equal(toE164('+123'), null);
  assert.equal(toE164(''), null);
  assert.equal(toE164(null), null);
});

test('phoneMatches: exact international, lenient national, never short or different', () => {
  const s = 'whatsapp:+919876543210';
  assert.ok(phoneMatches('+91 98765 43210', s));
  assert.ok(phoneMatches('098765 43210', s));
  assert.ok(phoneMatches('9876543210', s));
  assert.ok(!phoneMatches('+91 98765 43211', s));
  assert.ok(!phoneMatches('+1 9876543210', s), 'a different country code is a different number');
  assert.ok(!phoneMatches('43210', s), 'too short to identify anyone');
  assert.ok(!phoneMatches(null, s));
  assert.ok(!phoneMatches('9876543210', 'not a number'));
});

test('maskPhone hides the middle digits', () => {
  assert.equal(maskPhone('+919876543210'), '+91 •••••43210');
});

// ─── Signatures ──────────────────────────────────────────────────────────────

test('Twilio signature: valid, wrong token, tampered body, missing', () => {
  const url = 'https://app.zenkara.in/zenkara/api/inbox/whatsapp/webhook';
  const params = { From: 'whatsapp:+919876543210', To: 'whatsapp:+14155238886', Body: 'zen hi', MessageSid: 'SM1' };
  const sig = twilioSignature(url, params, 'token-a');
  assert.ok(verifyTwilioSignature(sig, url, params, 'token-a'));
  assert.ok(!verifyTwilioSignature(sig, url, params, 'token-b'));
  assert.ok(!verifyTwilioSignature(sig, url, { ...params, Body: 'zen give me salaries' }, 'token-a'));
  assert.ok(!verifyTwilioSignature(sig, `${url}?x=1`, params, 'token-a'));
  assert.ok(!verifyTwilioSignature(undefined, url, params, 'token-a'));
  assert.ok(!verifyTwilioSignature('short', url, params, 'token-a'));
});

test('Slack signature: valid, mismatch, replayed (stale) and missing headers', () => {
  const secret = '8f742231b10e8888abcd99yyyzzz85a5';
  const body = 'token=x&team_id=T1&user_id=U1&command=%2Fzen&text=hello';
  const now = Date.UTC(2026, 9, 18, 6, 0, 0);
  const ts = String(Math.floor(now / 1000));
  const sig = slackSignature(secret, ts, body);
  assert.match(sig, /^v0=[a-f0-9]{64}$/);
  assert.deepEqual(verifySlackRequest({ signingSecret: secret, timestamp: ts, signature: sig, rawBody: body, now }), { ok: true });
  assert.deepEqual(verifySlackRequest({ signingSecret: secret, timestamp: ts, signature: sig, rawBody: Buffer.from(body), now }), { ok: true });
  assert.deepEqual(verifySlackRequest({ signingSecret: secret, timestamp: ts, signature: sig, rawBody: body + '&x=1', now }), { ok: false, reason: 'mismatch' });
  assert.deepEqual(verifySlackRequest({ signingSecret: 'other', timestamp: ts, signature: sig, rawBody: body, now }), { ok: false, reason: 'mismatch' });
  // The same, correctly signed request replayed 6 minutes later.
  assert.deepEqual(verifySlackRequest({ signingSecret: secret, timestamp: ts, signature: sig, rawBody: body, now: now + 6 * 60_000 }), { ok: false, reason: 'stale' });
  assert.deepEqual(verifySlackRequest({ signingSecret: secret, timestamp: 'abc', signature: sig, rawBody: body, now }), { ok: false, reason: 'stale' });
  assert.deepEqual(verifySlackRequest({ signingSecret: null, timestamp: ts, signature: sig, rawBody: body, now }), { ok: false, reason: 'missing' });
  assert.deepEqual(verifySlackRequest({ signingSecret: secret, timestamp: ts, signature: undefined, rawBody: body, now }), { ok: false, reason: 'missing' });
});

// ─── Sender → user ───────────────────────────────────────────────────────────

const ORG = 'org1';
const SENDER = '+919876543210';
const u = (id: string, over: Partial<{ orgId: string | null; isActive: boolean; phone: string | null; role: string }> = {}) => ({
  id, orgId: ORG, role: 'IT_AGENT', email: `${id}@x.test`, name: `User ${id}`, isActive: true, phone: '+91 98765 43210', ...over,
});
const link = (user: ReturnType<typeof u>, phoneE164 = SENDER, orgId = ORG) => ({ userId: user.id, orgId, phoneE164, user });

test('WhatsApp sender: exactly one verified, active user with that phone → that user', () => {
  const r = pickWhatsAppSender(ORG, SENDER, [link(u('a'))]);
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual(r.user, { id: 'a', orgId: ORG, role: 'IT_AGENT', email: 'a@x.test', name: 'User a' });
});

test('WhatsApp sender: no link → none; staff phone without verification → unverified', () => {
  assert.deepEqual(pickWhatsAppSender(ORG, SENDER, []), { ok: false, reason: 'none' });
  assert.deepEqual(pickWhatsAppSender(ORG, SENDER, [], [{ isActive: true }]), { ok: false, reason: 'unverified' });
  assert.deepEqual(pickWhatsAppSender(ORG, 'garbage', [link(u('a'))]), { ok: false, reason: 'none' });
});

test('WhatsApp sender: two verified users on one number → ambiguous, no data', () => {
  assert.deepEqual(pickWhatsAppSender(ORG, SENDER, [link(u('a')), link(u('b'))]), { ok: false, reason: 'ambiguous' });
});

test('WhatsApp sender: deactivated user → refused', () => {
  assert.deepEqual(pickWhatsAppSender(ORG, SENDER, [link(u('a', { isActive: false }))]), { ok: false, reason: 'inactive' });
});

test('WhatsApp sender: a link from another org (or a user moved to another org) never matches', () => {
  assert.deepEqual(pickWhatsAppSender(ORG, SENDER, [link(u('a', { orgId: 'org2' }), SENDER, 'org2')]), { ok: false, reason: 'none' });
  assert.deepEqual(pickWhatsAppSender(ORG, SENDER, [link(u('a', { orgId: 'org2' }))]), { ok: false, reason: 'none' });
});

test('WhatsApp sender: profile phone changed after verification voids the link', () => {
  assert.deepEqual(pickWhatsAppSender(ORG, SENDER, [link(u('a', { phone: '+91 90000 00000' }))]), { ok: false, reason: 'phone_changed' });
  assert.deepEqual(pickWhatsAppSender(ORG, SENDER, [link(u('a', { phone: null }))]), { ok: false, reason: 'phone_changed' });
});

test('Slack sender: linked → user; wrong org/team or inactive → refused', () => {
  const user = u('a');
  const l = { orgId: ORG, slackTeamId: 'T1', slackUserId: 'U1', user };
  const ok = pickSlackSender(ORG, 'T1', 'U1', l, null);
  assert.ok(ok.ok && ok.user.id === 'a');
  assert.deepEqual(pickSlackSender(ORG, 'T2', 'U1', l, null), { ok: false, reason: 'none' });
  assert.deepEqual(pickSlackSender('org2', 'T1', 'U1', l, null), { ok: false, reason: 'none' });
  assert.deepEqual(pickSlackSender(ORG, 'T1', 'U1', { ...l, user: u('a', { isActive: false }) }, null), { ok: false, reason: 'inactive' });
});

test('Slack sender: email match only when allowed, exactly one active user', () => {
  assert.deepEqual(pickSlackSender(ORG, 'T1', 'U1', null, null), { ok: false, reason: 'unverified' });
  const one = pickSlackSender(ORG, 'T1', 'U1', null, [u('a'), u('b', { isActive: false })]);
  assert.ok(one.ok && one.user.id === 'a');
  assert.deepEqual(pickSlackSender(ORG, 'T1', 'U1', null, [u('a'), u('b')]), { ok: false, reason: 'ambiguous' });
  assert.deepEqual(pickSlackSender(ORG, 'T1', 'U1', null, [u('a', { orgId: 'org2' })]), { ok: false, reason: 'unverified' });
});

test('link codes: parse, hash ignores case/dashes/spaces, formats', () => {
  assert.equal(parseLinkCommand('link 123456'), '123456');
  assert.equal(parseLinkCommand('LINK abcd-efgh'), 'abcd-efgh');
  assert.equal(parseLinkCommand('link'), null);
  assert.equal(parseLinkCommand('please link 123456'), null);
  assert.equal(hashCode('abcd-efgh'), hashCode('ABCD EFGH'));
  assert.notEqual(hashCode('123456'), hashCode('123457'));
  assert.match(newLinkCode('whatsapp'), /^\d{6}$/);
  assert.match(newLinkCode('slack'), /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
});

// ─── WhatsApp keyword rule ───────────────────────────────────────────────────

test('parseAddressed: only a leading "zen" word addresses the assistant', () => {
  assert.deepEqual(parseAddressed('zen how many tickets are open?'), { addressed: true, rest: 'how many tickets are open?' });
  assert.deepEqual(parseAddressed('Zen: create a ticket'), { addressed: true, rest: 'create a ticket' });
  assert.deepEqual(parseAddressed('/zen help'), { addressed: true, rest: 'help' });
  assert.deepEqual(parseAddressed('  ZEN'), { addressed: true, rest: '' });
  assert.equal(parseAddressed('Zenith order #42 is late').addressed, false);
  assert.equal(parseAddressed('zenkara support please').addressed, false);
  assert.equal(parseAddressed('Hi, is zen mode available?').addressed, false);
});

// ─── State machine ───────────────────────────────────────────────────────────

const NOW = new Date('2026-10-18T06:00:00Z');
const later = (min: number) => new Date(NOW.getTime() + min * 60_000);
const confirmP = (over: Partial<PendingConfirm> = {}): PendingConfirm => ({
  kind: 'confirm', stage: 'first', highRisk: false, phrase: '', planId: 'p1', interactionLogId: null,
  steps: [{ action: 'CREATE_TICKET', params: { title: 'VPN down', body: 'VPN down' } }], command: 'create ticket', explanation: '',
  expiresAt: later(15).toISOString(), ...over,
});
const chooseP = (): PendingChoose => ({
  kind: 'choose', planId: 'p2', interactionLogId: null, steps: [{ action: 'ADD_NOTE', params: { entityType: 'DEAL', entityId: 'Acme', body: 'x' } }],
  command: 'note on acme', explanation: '', expiresAt: later(15).toISOString(), stepIndex: 0, param: 'entityId', noun: 'deal', query: 'Acme',
  candidates: [{ id: 'd1', label: 'Acme renewal' }, { id: 'd2', label: 'Acme ERP' }],
});

test('classifyReply / matchesPhrase', () => {
  assert.deepEqual(classifyReply(' Yes! '), { kind: 'yes' });
  assert.deepEqual(classifyReply('ok.'), { kind: 'yes' });
  assert.deepEqual(classifyReply('Cancel'), { kind: 'no' });
  assert.deepEqual(classifyReply('2'), { kind: 'number', n: 2 });
  assert.deepEqual(classifyReply('yes please create it high'), { kind: 'other' });
  assert.ok(matchesPhrase('confirm   payroll.', 'CONFIRM PAYROLL'));
  assert.ok(!matchesPhrase('confirm', 'CONFIRM PAYROLL'));
  assert.ok(!matchesPhrase('anything', ''));
});

test('plan → yes → execute; "1" also confirms; no / "2" cancels', () => {
  const p = confirmP();
  assert.deepEqual(decide(p, 'yes', NOW), { do: 'execute', pending: p, confirmHighRisk: false });
  assert.deepEqual(decide(p, '1', NOW), { do: 'execute', pending: p, confirmHighRisk: false });
  assert.deepEqual(decide(p, 'no', NOW), { do: 'cancel', pending: p });
  assert.deepEqual(decide(p, '2', NOW), { do: 'cancel', pending: p });
  assert.deepEqual(decide(p, '7', NOW), { do: 'reprompt', pending: p, reason: 'out_of_range' });
});

test('expiry: a reply after 15 minutes runs nothing; a new request is just new', () => {
  const p = confirmP();
  assert.deepEqual(decide(p, 'yes', later(15)), { do: 'expired' });
  assert.deepEqual(decide(p, 'CONFIRM PAYROLL', later(20)), { do: 'expired' });
  assert.deepEqual(decide(p, 'how many tickets are open?', later(16)), { do: 'new', text: 'how many tickets are open?' });
  assert.deepEqual(decide({ ...p, expiresAt: 'garbage' }, 'yes', NOW), { do: 'expired' });
});

test('high risk: yes is never enough — the exact phrase runs it', () => {
  const p = confirmP({ highRisk: true, phrase: 'CONFIRM PAYROLL' });
  assert.deepEqual(decide(p, 'yes', NOW), { do: 'second', pending: p });
  const second = { ...p, stage: 'second' as const };
  assert.deepEqual(decide(second, 'yes', NOW), { do: 'reprompt', pending: second, reason: 'need_phrase' });
  assert.deepEqual(decide(second, '1', NOW), { do: 'reprompt', pending: second, reason: 'need_phrase' });
  assert.deepEqual(decide(second, 'confirm', NOW), { do: 'reprompt', pending: second, reason: 'need_phrase' });
  assert.deepEqual(decide(second, 'CONFIRM LOAN', NOW), { do: 'reprompt', pending: second, reason: 'need_phrase' });
  assert.deepEqual(decide(second, 'confirm payroll', NOW), { do: 'execute', pending: second, confirmHighRisk: true });
  assert.deepEqual(decide(second, 'no', NOW), { do: 'cancel', pending: second });
  // The phrase in the FIRST stage doesn't skip the second.
  assert.equal(decide(p, 'CONFIRM PAYROLL', NOW).do, 'new');
});

test('numbered disambiguation: pick, out of range, cancel, or start over', () => {
  const p = chooseP();
  assert.deepEqual(decide(p, '2', NOW), { do: 'pick', pending: p, candidate: { id: 'd2', label: 'Acme ERP' } });
  assert.deepEqual(decide(p, '3', NOW), { do: 'reprompt', pending: p, reason: 'out_of_range' });
  assert.deepEqual(decide(p, 'yes', NOW), { do: 'reprompt', pending: p, reason: 'out_of_range' });
  assert.deepEqual(decide(p, 'cancel', NOW), { do: 'cancel', pending: p });
  assert.deepEqual(decide(p, 'actually, show open tickets', NOW), { do: 'new', text: 'actually, show open tickets', dropped: true });
});

test('nothing pending: a bare yes/number does nothing; text is a new request', () => {
  assert.deepEqual(decide(null, 'yes', NOW), { do: 'nothing_pending' });
  assert.deepEqual(decide(null, '1', NOW), { do: 'nothing_pending' });
  assert.deepEqual(decide(null, 'CONFIRM PAYROLL', NOW), { do: 'nothing_pending' });
  assert.deepEqual(decide(null, 'create a ticket', NOW), { do: 'new', text: 'create a ticket' });
});

test('setParam fills a pick without mutating the stored plan; highRiskPhrase names the risk', () => {
  const steps = [{ action: 'X', params: { a: 'Acme', ids: ['p', 'q'] } }];
  const out = setParam(steps, 0, 'a', 'id1');
  assert.equal(out[0].params.a, 'id1');
  assert.equal(steps[0].params.a, 'Acme');
  assert.deepEqual(setParam(steps, 0, 'ids.1', 'id2')[0].params.ids, ['p', 'id2']);
  assert.equal(highRiskPhrase([{ action: 'CREATE_TICKET', risk: 'low' }, { action: 'START_PAYROLL_RUN', risk: 'high' }]), 'CONFIRM PAYROLL');
  assert.equal(highRiskPhrase([{ action: 'ADD_LOAN', risk: 'high' }]), 'CONFIRM LOAN');
  assert.equal(highRiskPhrase([{ action: 'INVITE_USER', risk: 'high' }]), 'CONFIRM ACCESS');
  assert.equal(highRiskPhrase([{ action: 'SEND_WHATSAPP_NOW', risk: 'high' }]), 'CONFIRM SEND');
  assert.equal(highRiskPhrase([{ action: 'CREATE_TICKET', risk: 'low' }]), '');
});

// ─── present(): planner output → message + waiting state ────────────────────

const step = (over: Partial<PlanStep> = {}): PlanStep => ({
  index: 1, action: 'CREATE_TICKET', label: 'Create a ticket', category: 'IT Desk', params: { title: 'VPN down', body: 'VPN down', priority: 'HIGH' },
  risk: 'low', allowed: true, errors: [], needs: [], warnings: [], preview: { title: 'Create HIGH ticket “VPN down”', changes: [{ field: 'Priority', after: 'HIGH' }] }, dependsOn: [], ...over,
});
const planOf = (steps: PlanStep[], over: Partial<ActionPlan> = {}): ActionPlan => ({
  planId: 'plan-1', interactionLogId: 'log-1', steps, explanation: 'Create the ticket.', confidence: 80,
  risk: steps.some(s => s.risk === 'high') ? 'high' : 'low', requiresSecondConfirmation: steps.some(s => s.risk === 'high'),
  ready: steps.every(s => s.allowed && !s.errors.length && !s.needs.length), repaired: false,
  action: steps[0]?.action ?? null, params: steps[0]?.params ?? {}, allowed: true, requiresConfirmation: true, ...over,
});

test('present: ready plan waits for YES with a 15-minute expiry', () => {
  const r = present(planOf([step()]), 'create a ticket', 'whatsapp', NOW);
  assert.equal(r.next?.kind, 'confirm');
  const p = r.next as PendingConfirm;
  assert.equal(p.stage, 'first');
  assert.equal(p.highRisk, false);
  assert.equal(p.expiresAt, later(15).toISOString());
  assert.deepEqual(p.steps, [{ action: 'CREATE_TICKET', params: { title: 'VPN down', body: 'VPN down', priority: 'HIGH' } }]);
  assert.match(r.reply, /Create HIGH ticket “VPN down”/);
  assert.match(r.reply, /Reply \*YES\* to run it or \*NO\* to cancel \(expires in 15 min\)/);
});

test('present: high-risk plan announces the phrase', () => {
  const r = present(planOf([step({ action: 'START_PAYROLL_RUN', label: 'Start a payroll run (draft)', risk: 'high', preview: { title: 'Draft payroll run for October 2026', changes: [] } })]), 'run payroll', 'slack', NOW);
  const p = r.next as PendingConfirm;
  assert.equal(p.highRisk, true);
  assert.equal(p.phrase, 'CONFIRM PAYROLL');
  assert.match(r.reply, /High-risk/);
  assert.match(r.reply, /CONFIRM PAYROLL/);
});

test('present: ambiguity → numbered choices; blocked → explanation, nothing waits; empty → planner explanation', () => {
  const amb = present(planOf([step({ needs: [{ param: 'entityId', query: 'Acme', entity: 'deal', noun: 'deal', candidates: [{ id: 'd1', label: 'Acme renewal', hint: 'Proposal · ₹40,000' }, { id: 'd2', label: 'Acme ERP' }] }] })]), 'note', 'whatsapp', NOW);
  assert.equal(amb.next?.kind, 'choose');
  assert.match(amb.reply, /Which deal did you mean by “Acme”\?\n1\. Acme renewal — Proposal · ₹40,000\n2\. Acme ERP/);
  const blocked = present(planOf([step({ allowed: false, blockedReason: 'Your role can’t create deals.' })]), 'deal', 'whatsapp', NOW);
  assert.equal(blocked.next, null);
  assert.match(blocked.reply, /Your role can’t create deals/);
  const empty = present(planOf([], { explanation: 'Nothing in the list fits that request.' }), 'x', 'whatsapp', NOW);
  assert.equal(empty.next, null);
  assert.match(empty.reply, /Nothing in the list fits/);
});

// ─── Formatting ──────────────────────────────────────────────────────────────

const askBase = {
  question: 'q', howCalculated: [], widgetSpec: null, available: [], warnings: [], cached: false, modelCalls: 1, forecast: null,
};

test('formatAnswer: breakdown rows formatted with the org currency, extra rows counted, link last', () => {
  const rows = [['Dave Desk', 1250000], ['Ivy IT', 98000.5], ['Sam', 10], ['A', 1], ['B', 1], ['C', 1]].map(([n, v]) => ({ assignee: n, sum_value: v }));
  const text = formatAnswer({
    ...askBase, status: 'answered', answer: 'Dave Desk leads with ₹12,50,000.', title: 'Won value by owner', chart: 'bar',
    results: [{
      columns: [{ key: 'assignee', label: 'Owner', role: 'dimension', format: 'text' }, { key: 'sum_value', label: 'Value', role: 'measure', format: 'money' }],
      rows, meta: { kind: 'aggregate', bucket: null, currency: 'INR', description: 'Sum of deal value by owner — this year' } as any,
    }],
  } as any, { channel: 'whatsapp', link: 'https://app.zenkara.in/zenkara/dashboard?ask=x' });
  assert.match(text, /^\*Won value by owner\*\nDave Desk leads with ₹12,50,000\./);
  assert.match(text, /• Dave Desk — ₹12,50,000/);
  assert.match(text, /• Ivy IT — ₹98,001/);
  assert.match(text, /…and 1 more/);
  assert.match(text, /_Sum of deal value by owner — this year_/);
  assert.match(text, /Full answer and chart: https:\/\/app\.zenkara\.in\/zenkara\/dashboard\?ask=x$/);
});

test('formatAnswer: unanswerable says what can be asked; long text is clipped to the channel limit', () => {
  const text = formatAnswer({
    ...askBase, status: 'unanswerable', answer: 'I can’t answer that from your data.', title: '', chart: null, results: [],
    available: [{ dataset: 'tickets', label: 'Tickets', examples: ['How many tickets are open?'] }, { dataset: 'leads', label: 'Leads', examples: [] }],
  } as any, { channel: 'slack' });
  assert.match(text, /You can ask about: Tickets, Leads\./);
  assert.match(text, /For example: “How many tickets are open\?”/);
  assert.equal(clip('x'.repeat(2000), 1500).length, 1500);
  assert.ok(clip('x'.repeat(2000), 1500).endsWith('…'));
});

test('formatPlanPrompt / formatChoices / formatBlocked / formatReport', () => {
  const plan = planOf([step(), step({ index: 2, action: 'ADD_NOTE', label: 'Add a note', preview: { title: 'Note on the new ticket', changes: [] } })]);
  const prompt = formatPlanPrompt(plan, confirmP(), 'whatsapp', 15);
  assert.match(prompt, /1\. Create HIGH ticket “VPN down”\n {3}• Priority: HIGH\n2\. Note on the new ticket/);
  assert.match(prompt, /run all steps/);
  assert.match(formatChoices(chooseP(), 'slack'), /Reply with the number, or NO to cancel\./);
  assert.match(formatBlocked(planOf([step({ errors: ['No contact called “Zed” was found.'] })]), 'whatsapp'), /No contact called “Zed”/);
  const ok = formatReport({ ok: true, planId: 'p', summary: 'Created HIGH ticket “VPN down”.', completed: 1, failedAt: null, steps: [{ index: 1, action: 'CREATE_TICKET', label: 'Create a ticket', status: 'done', summary: 'Created HIGH ticket “VPN down”.', output: { id: 't1', link: '/itdesk/tickets/t1' } }] }, 'whatsapp', p => `https://app${p}`);
  assert.match(ok, /^Done\. Created HIGH ticket “VPN down”\.\n\n1\. Done: Created HIGH ticket “VPN down”\. https:\/\/app\/itdesk\/tickets\/t1$/);
  const failed = formatReport({ ok: false, planId: 'p', summary: 'Nothing was changed; step 1 (Convert) failed: already converted', completed: 0, failedAt: 1, steps: [{ index: 1, action: 'CONVERT_LEAD', label: 'Convert', status: 'failed', error: 'already converted' }, { index: 2, action: 'CREATE_TASK', label: 'Task', status: 'skipped' }] }, 'slack', p => p);
  assert.match(failed, /1\. Failed: Convert — already converted\n2\. Not started: Task/);
});

// ─── Limits ──────────────────────────────────────────────────────────────────

test('SlidingWindowLimiter and SeenIds', () => {
  let t = 0;
  const lim = new SlidingWindowLimiter(2, 1000, () => t);
  assert.ok(lim.hit('a')); assert.ok(lim.hit('a')); assert.ok(!lim.hit('a'));
  assert.ok(lim.hit('b'), 'keys are independent');
  assert.equal(lim.retryAfter('a'), 1);
  t = 1001;
  assert.ok(lim.hit('a'));
  const seen = new SeenIds(1000, () => t);
  assert.ok(seen.first('Ev1')); assert.ok(!seen.first('Ev1'));
  t = 2500;
  assert.ok(seen.first('Ev1'), 'forgotten after the TTL');
});

test('isSlackResponseUrl only allows https://hooks.slack.com', () => {
  assert.ok(isSlackResponseUrl('https://hooks.slack.com/commands/T1/123/abc'));
  assert.ok(!isSlackResponseUrl('http://hooks.slack.com/commands/T1'));
  assert.ok(!isSlackResponseUrl('https://hooks.slack.com.evil.test/x'));
  assert.ok(!isSlackResponseUrl('https://169.254.169.254/latest'));
  assert.ok(!isSlackResponseUrl('not a url'));
});
