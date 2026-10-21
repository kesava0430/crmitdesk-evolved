/**
 * Work from home — the pure rules (utils/wfhRules.ts) and how the engine
 * evaluates a WFH day (utils/attendanceEngine.ts): limit counting, notice,
 * AUTO vs MANAGER approval, recurring schedules + exceptions, the check-in
 * exemption, wfhRequireCheckIn, and the removed "notes say WFH" heuristic.
 *
 *     npm run test:unit
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkLimits, checkNotice, requestDays, scheduleDays, scheduleCovers, scheduleFor, mergeDays, usageFor, usageWindow,
  weekStartOf, approvalOutcome, exemptRule, wfhSettingsOf, describeWeekdays, DEFAULT_WFH, type ScheduleLike, limitEntries,
} from '../../src/utils/wfhRules';
import { evaluateDay, summarise, keyToDate, DEFAULT_POLICY, type Policy, type DayContext } from '../../src/utils/attendanceEngine';
import { evaluateRule, DEFAULT_CHECK_IN_RULE } from '../../src/utils/attendanceRules';

const IST = 'Asia/Kolkata';
const ist = (local: string) => new Date(`${local}:00+05:30`);
const policy = (p: Partial<Policy> = {}): Policy => ({ ...DEFAULT_POLICY, timezone: IST, ...p });
const day = (key: string, extra: Partial<DayContext> = {}): DayContext => ({ date: keyToDate(key), sessions: [], ...extra });
const OFFS = [0, 6];
const NONE = new Set<string>();
// October 2026: Mon 12, Fri 16, Sat 17, Sun 18; Fri 30, Sat 31 → Sun 1 Nov, Mon 2 Nov.
const MON = '2026-10-12', TUE = '2026-10-13', WED = '2026-10-14', THU = '2026-10-15', FRI = '2026-10-16', SAT = '2026-10-17';
const WFH = { requestId: 'w1', name: 'Work from home' };

// ─── Settings ────────────────────────────────────────────────────────────────

test('settings default to the owner decisions (manager approval, 4 a month, check-in required)', () => {
  assert.deepEqual(wfhSettingsOf(null), DEFAULT_WFH);
  const s = wfhSettingsOf({ wfhEnabled: false, wfhApprovalMode: 'AUTO', wfhMaxPerMonth: null, wfhMaxPerWeek: 2, wfhMinNoticeDays: 1, wfhAllowSameDay: false, wfhAllowHalfDay: false, wfhRequireCheckIn: false });
  assert.deepEqual(s, { enabled: false, approvalMode: 'AUTO', maxPerMonth: null, maxPerWeek: 2, minNoticeDays: 1, allowSameDay: false, allowHalfDay: false, requireCheckIn: false });
  assert.equal(wfhSettingsOf({ wfhApprovalMode: 'nonsense' }).approvalMode, 'MANAGER');
});

// ─── Counting ────────────────────────────────────────────────────────────────

test('a request counts working days only; a half day is 0.5', () => {
  assert.deepEqual(requestDays(FRI, '2026-10-19', false, OFFS, NONE).map(d => d.day), [FRI, '2026-10-19']); // weekend skipped
  assert.deepEqual(requestDays(MON, WED, false, OFFS, new Set([TUE])).map(d => d.day), [MON, WED]);        // holiday skipped
  assert.deepEqual(requestDays(MON, MON, true, OFFS, NONE), [{ day: MON, weight: 0.5 }]);
  assert.deepEqual(requestDays(SAT, SAT, false, OFFS, NONE), []);
});

test('usage is per calendar month and ISO week (Mon–Sun) of the reference day', () => {
  assert.equal(weekStartOf('2026-10-18'), MON);                      // Sunday belongs to the week starting Monday
  assert.equal(weekStartOf('2026-11-01'), '2026-10-26');
  const entries = [{ day: '2026-10-05', weight: 1 }, { day: MON, weight: 1 }, { day: WED, weight: 0.5 }, { day: '2026-11-02', weight: 1 }];
  assert.deepEqual(usageFor(entries, THU), { month: 2.5, week: 1.5 });
  assert.deepEqual(usageWindow([WED]), { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(usageWindow(['2026-10-30']), { from: '2026-10-01', to: '2026-11-01' }); // widened to that day's whole ISO week
});

test('limits count approved + pending requests already in the month', () => {
  const existing = [{ day: '2026-10-02', weight: 1 }, { day: '2026-10-05', weight: 1 }, { day: MON, weight: 1 }];
  assert.equal(checkLimits({ maxPerMonth: 4, maxPerWeek: null }, existing, [{ day: FRI, weight: 1 }]), null);       // 4th day fits
  const msg = checkLimits({ maxPerMonth: 4, maxPerWeek: null }, existing, requestDays(THU, FRI, false, OFFS, NONE));
  assert.match(msg!, /5 days of work from home in October 2026 — the limit is 4 days a month \(3 days already used or requested\)/);
});

test('half days let a request fit exactly at the limit', () => {
  const existing = [{ day: '2026-10-02', weight: 1 }, { day: '2026-10-05', weight: 1 }, { day: MON, weight: 1 }, { day: TUE, weight: 0.5 }];
  assert.equal(checkLimits({ maxPerMonth: 4, maxPerWeek: null }, existing, [{ day: FRI, weight: 0.5 }]), null);
  assert.ok(checkLimits({ maxPerMonth: 4, maxPerWeek: null }, existing, [{ day: FRI, weight: 1 }]));
});

test('the weekly limit is checked per ISO week; a request spanning months is checked per month', () => {
  const existing = [{ day: MON, weight: 1 }];
  assert.match(checkLimits({ maxPerMonth: null, maxPerWeek: 1 }, existing, [{ day: WED, weight: 1 }])!, /week of 12 Oct — the limit is 1 day a week/);
  assert.equal(checkLimits({ maxPerMonth: null, maxPerWeek: 1 }, existing, [{ day: '2026-10-19', weight: 1 }]), null);
  // 30 Oct (Fri) + 2 Nov (Mon): one day in each month
  const req = requestDays('2026-10-30', '2026-11-02', false, OFFS, NONE);
  assert.deepEqual(req.map(r => r.day), ['2026-10-30', '2026-11-02']);
  const full = Array.from({ length: 4 }, (_, i) => ({ day: `2026-10-0${i + 5}`, weight: 1 }));
  assert.match(checkLimits({ maxPerMonth: 4, maxPerWeek: null }, full, req)!, /October 2026/);
  assert.equal(checkLimits({ maxPerMonth: 4, maxPerWeek: null }, [], req), null);
  assert.equal(checkLimits({ maxPerMonth: null, maxPerWeek: null }, full, req), null); // unlimited
});

test('a modified request does not count against itself (existing excludes it; overlapping days never double)', () => {
  // The caller excludes the request being modified; days it re-requests are taken out of "existing" too.
  assert.equal(checkLimits({ maxPerMonth: 1, maxPerWeek: null }, [{ day: MON, weight: 1 }], [{ day: MON, weight: 1 }]), null);
  assert.deepEqual(mergeDays([{ day: MON, weight: 0.5 }], [{ day: MON, weight: 1 }, { day: TUE, weight: 1 }]), [{ day: MON, weight: 1 }, { day: TUE, weight: 1 }]);
});

// ─── Notice ──────────────────────────────────────────────────────────────────

test('notice: no past dates, same-day only when allowed, minimum notice days', () => {
  const s = { minNoticeDays: 0, allowSameDay: true };
  assert.equal(checkNotice(s, WED, WED), null);
  assert.match(checkNotice(s, TUE, WED)!, /past date/);
  assert.match(checkNotice({ minNoticeDays: 0, allowSameDay: false }, WED, WED)!, /Same-day/);
  assert.equal(checkNotice({ minNoticeDays: 0, allowSameDay: false }, THU, WED), null);
  assert.match(checkNotice({ minNoticeDays: 2, allowSameDay: true }, THU, WED)!, /2 days notice — the earliest date you can request now is 16 Oct/);
  assert.equal(checkNotice({ minNoticeDays: 2, allowSameDay: true }, FRI, WED), null);
});

// ─── Approval mode ───────────────────────────────────────────────────────────

test('AUTO approves the employee\'s own request; MANAGER and manager/overridden requests take the normal path', () => {
  assert.equal(approvalOutcome({ approvalMode: 'AUTO' }, 'self', false), 'AUTO_APPROVED');
  assert.equal(approvalOutcome({ approvalMode: 'MANAGER' }, 'self', false), 'NORMAL');
  assert.equal(approvalOutcome({ approvalMode: 'AUTO' }, 'manager', false), 'NORMAL');
  assert.equal(approvalOutcome({ approvalMode: 'AUTO' }, 'self', true), 'NORMAL');
});

// ─── Recurring schedules ─────────────────────────────────────────────────────

const everyFriday: ScheduleLike = { id: 's1', userId: null, policyGroupId: 'g1', weekdays: [5], startDate: '2026-10-01', endDate: null };

test('a recurring schedule covers its weekdays from the start date, until the end date', () => {
  assert.equal(scheduleCovers(everyFriday, 'u1', FRI), true);
  assert.equal(scheduleCovers(everyFriday, 'u1', THU), false);
  assert.equal(scheduleCovers({ ...everyFriday, startDate: '2026-10-20' }, 'u1', FRI), false);
  assert.equal(scheduleCovers({ ...everyFriday, endDate: '2026-10-15' }, 'u1', FRI), false);
  assert.equal(scheduleCovers({ ...everyFriday, startDate: keyToDate('2026-10-01'), endDate: keyToDate(FRI) }, 'u1', FRI), true); // Date objects too
  assert.equal(describeWeekdays([5, 1]), 'Every Mon, Fri');
  assert.equal(describeWeekdays([0, 6]), 'Every Sat, Sun');
});

test('exceptions skip a date for one person or for everyone on the schedule', () => {
  const s = { ...everyFriday, exceptions: [{ userId: 'u2', date: FRI }, { userId: null, date: '2026-10-23' }] };
  assert.equal(scheduleCovers(s, 'u1', FRI), true);
  assert.equal(scheduleCovers(s, 'u2', FRI), false);
  assert.equal(scheduleCovers(s, 'u1', '2026-10-23'), false);
  assert.equal(scheduleFor([s], 'u2', FRI), null);
});

test('recurring expansion gives working days only (a weekly off or holiday on the weekday is skipped)', () => {
  const both: ScheduleLike = { ...everyFriday, weekdays: [5, 6] };
  assert.deepEqual(scheduleDays([both], 'u1', '2026-10-01', '2026-10-31', OFFS, new Set(['2026-10-23'])).map(d => d.day), ['2026-10-02', '2026-10-09', FRI, '2026-10-30']);
  // Recurring days count towards the limits alongside requests
  const used = mergeDays(scheduleDays([everyFriday], 'u1', '2026-10-01', '2026-10-31', OFFS, NONE), [{ day: MON, weight: 1 }]);
  assert.deepEqual(usageFor(used, WED), { month: 6, week: 2 });
});

// ─── Check-in exemption ──────────────────────────────────────────────────────

test('on a WFH day check-in skips location and network; face still applies', () => {
  const outside = { location: false, network: false, face: null };
  assert.equal(evaluateRule(DEFAULT_CHECK_IN_RULE, outside).passed, false);              // office day: blocked
  assert.equal(evaluateRule(exemptRule(DEFAULT_CHECK_IN_RULE, true), outside).passed, true); // WFH day: nothing left to check
  const withFace = { ...DEFAULT_CHECK_IN_RULE, face: true };
  const exempt = exemptRule(withFace, true);
  assert.deepEqual({ location: exempt.location, network: exempt.network, face: exempt.face }, { location: false, network: false, face: true });
  assert.equal(evaluateRule(exempt, { location: false, network: false, face: false }).passed, false);
  assert.equal(evaluateRule(exempt, { location: false, network: false, face: true }).passed, true);
  assert.deepEqual(exemptRule(withFace, false), withFace);
});

// ─── Evaluating a WFH day ────────────────────────────────────────────────────

const after = ist(`${WED}T12:00`); // MON is in the past
const worked = (from: string, to: string) => ({ checkInAt: ist(`${MON}T${from}`), checkOutAt: ist(`${MON}T${to}`) });

test('wfhRequireCheckIn off: an approved WFH day is paid whatever was punched (unchanged behaviour)', () => {
  const r = evaluateDay(policy({ wfhRequireCheckIn: false }), day(MON, { wfhApproved: WFH }), after);
  assert.equal(r.status, 'WFH');
  assert.equal(r.paidFraction, 1);
  assert.equal(r.leaveRequestId, 'w1');
});

test('wfhRequireCheckIn on: no punches → ABSENT', () => {
  const r = evaluateDay(policy({ wfhRequireCheckIn: true }), day(MON, { wfhApproved: WFH }), after);
  assert.equal(r.status, 'ABSENT');
  assert.equal(r.paidFraction, 0);
  assert.match(r.reason, /Work from home — no check-in/);
});

test('wfhRequireCheckIn on: enough hours → WFH, paid like present, lateness bands not applied', () => {
  // Starts 11:30 (2h30 after the 09:00 shift — the HALF_DAY band on an office day) but works 8h30
  const r = evaluateDay(policy({ wfhRequireCheckIn: true }), day(MON, { sessions: [worked('11:30', '20:00')], wfhApproved: WFH }), after);
  assert.equal(r.status, 'WFH');
  assert.equal(r.paidFraction, 1);
  assert.equal(r.lateMinutes, 0);
  assert.match(r.reason, /worked 8h 30m/);
  const office = evaluateDay(policy(), day(MON, { sessions: [worked('11:30', '20:00')] }), after);
  assert.equal(office.status, 'HALF_DAY'); // the same punches on an office day
});

test('wfhRequireCheckIn on: short hours → HALF_DAY or ABSENT by the min-hours rules; no early-departure rule', () => {
  const half = evaluateDay(policy({ wfhRequireCheckIn: true }), day(MON, { sessions: [worked('09:00', '14:00')], wfhApproved: WFH }), after);
  assert.equal(half.status, 'HALF_DAY');
  assert.equal(half.paidFraction, 0.5);
  assert.match(half.reason, /^Work from home — worked 5h/);
  const absent = evaluateDay(policy({ wfhRequireCheckIn: true }), day(MON, { sessions: [worked('09:00', '11:00')], wfhApproved: WFH }), after);
  assert.equal(absent.status, 'ABSENT');
  const early = evaluateDay(policy({ wfhRequireCheckIn: true, earlyDepartureStatus: 'HALF_DAY' }), day(MON, { sessions: [worked('07:00', '16:00')], wfhApproved: WFH }), after);
  assert.equal(early.status, 'WFH');
  assert.equal(early.earlyMinutes, 0);
});

test('wfhRequireCheckIn on: today/future stay provisional (PENDING, then WFH while in progress)', () => {
  const future = evaluateDay(policy({ wfhRequireCheckIn: true }), day(FRI, { wfhApproved: WFH }), after);
  assert.equal(future.status, 'PENDING');
  assert.match(future.reason, /Upcoming — Work from home/);
  const todayNoPunch = evaluateDay(policy({ wfhRequireCheckIn: true }), day(WED, { wfhApproved: WFH }), after);
  assert.equal(todayNoPunch.status, 'PENDING');
  assert.match(todayNoPunch.reason, /not checked in yet/);
  const inProgress = evaluateDay(policy({ wfhRequireCheckIn: true }), day(WED, { sessions: [{ checkInAt: ist(`${WED}T10:45`), checkOutAt: null }], wfhApproved: WFH }), after);
  assert.equal(inProgress.status, 'WFH');
  assert.equal(inProgress.provisional, true);
  assert.equal(inProgress.lateMinutes, 0);
});

test('a recurring WFH day (no request id) evaluates the same way; weekly offs and leave still win', () => {
  const rec = { requestId: null, name: 'Recurring work from home' };
  assert.equal(evaluateDay(policy({ wfhRequireCheckIn: true }), day(MON, { sessions: [worked('09:00', '18:00')], wfhApproved: rec }), after).status, 'WFH');
  assert.equal(evaluateDay(policy({ wfhRequireCheckIn: false }), day(MON, { wfhApproved: rec }), after).leaveRequestId, null);
  assert.equal(evaluateDay(policy(), day(SAT, { wfhApproved: rec }), after).status, 'WEEK_OFF');
  const leave = { days: 1, halfDay: false, halfDayPeriod: null, isPaid: true, leaveTypeName: 'Casual', requestId: 'l1' };
  assert.equal(evaluateDay(policy({ wfhRequireCheckIn: true }), day(MON, { leave, wfhApproved: rec }), after).status, 'LEAVE');
});

test('the legacy "notes say WFH" heuristic is gone: an unpunched day without an approved WFH is ABSENT', () => {
  const r = evaluateDay(policy(), { ...day(MON), wfh: true } as any, after);
  assert.equal(r.status, 'ABSENT');
});

test('period summary counts WFH days (present and paid) separately', () => {
  const s = summarise(policy(), [
    { status: 'WFH', paidFraction: 1, overtimeMinutes: 0 }, { status: 'PRESENT', paidFraction: 1, overtimeMinutes: 0 },
    { status: 'WFH', paidFraction: 1, overtimeMinutes: 0 }, { status: 'ABSENT', paidFraction: 0, overtimeMinutes: 0 },
  ]);
  assert.equal(s.wfhDays, 2);
  assert.equal(s.presentDays, 3);
  assert.equal(s.paidDays, 3);
  assert.equal(s.lopDays, 1);
});

test('team-wide recurring WFH days never count towards a person\'s limit (five-Friday month)', () => {
  // January 2027 has five Fridays (1, 8, 15, 22, 29); the whole team works from home every Friday.
  const team = { id: 's1', userId: null, policyGroupId: 'g1', weekdays: [5], startDate: '2026-10-01', endDate: null };
  const recurring = scheduleDays([team], 'u1', '2027-01-01', '2027-01-31', OFFS, NONE);
  assert.equal(recurring.length, 5);
  const settings = { maxPerMonth: 4, maxPerWeek: null };
  // Before: the five Fridays alone exceeded the limit, so no request could ever pass.
  assert.ok(checkLimits(settings, recurring, [{ day: '2027-01-05', weight: 1 }]));
  // Now only requested days count: four requests fit, the fifth is refused.
  const asked = ['2027-01-05', '2027-01-12', '2027-01-19'].map(day => ({ day, weight: 1 }));
  assert.equal(checkLimits(settings, limitEntries(asked, recurring), [{ day: '2027-01-26', weight: 1 }]), null);
  const msg = checkLimits(settings, limitEntries([...asked, { day: '2027-01-26', weight: 1 }], recurring), [{ day: '2027-01-27', weight: 1 }]);
  assert.match(msg!, /limit is 4 days a month \(4 days already used or requested\)/);
});
