/**
 * Attendance engine and helpers (audit 2026-10-13, ATT-25).
 *
 * attendanceEngine.ts is pure, so these run real IST scenarios end to end:
 * timezone day bucketing (ATT-4), provisional today/future days (ATT-5),
 * employment window (ATT-8), working-day leave length (ATT-9), AM half-day
 * lateness (ATT-12), night shifts (ATT-13), the office-network rule (ATT-15),
 * the client-IP helper (ATT-3) and the close-out plan (ATT-17).
 *
 *     npm run test:unit
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateDay, summarise, countWorkingDays, shiftDayKey, localDateKey, zonedDayStart, minutesIntoDay, dayPhase,
  safeTimeZone, isValidTimeZone, isScoped, pickGroup, lateConversion, keyToDate, shiftEndInstant,
  DEFAULT_POLICY, type Policy, type DayContext,
} from '../../src/utils/attendanceEngine';
import { verifyAgainstOffices, extractClientIp, requestIp } from '../../src/utils/attendanceVerification';
import { closeOutPlan } from '../../src/utils/attendanceAutoCheckout';

const IST = 'Asia/Kolkata';
const ist = (local: string) => new Date(`${local}:00+05:30`);
const policy = (p: Partial<Policy> = {}): Policy => ({ ...DEFAULT_POLICY, timezone: IST, ...p });
const night = (p: Partial<Policy> = {}) => policy({ shiftStart: '22:00', shiftEnd: '06:00', ...p });
const day = (key: string, extra: Partial<DayContext> = {}): DayContext => ({ date: keyToDate(key), sessions: [], ...extra });
const MON = '2026-10-12', TUE = '2026-10-13', WED = '2026-10-14', SAT = '2026-10-17', SUN = '2026-10-18';

test('fixture dates fall on the weekdays the tests assume', () => {
  assert.equal(keyToDate(MON).getUTCDay(), 1);
  assert.equal(keyToDate(SAT).getUTCDay(), 6);
  assert.equal(keyToDate(SUN).getUTCDay(), 0);
});

// ─── Timezone helpers (ATT-4, ATT-14) ────────────────────────────────────────

test('local date in IST differs from the UTC date between 00:00 and 05:30', () => {
  const at = new Date('2026-10-12T20:00:00Z'); // 01:30 IST on the 13th
  assert.equal(at.toISOString().slice(0, 10), MON);
  assert.equal(localDateKey(at, IST), TUE);
});

test('zonedDayStart gives local midnight, including across a DST change', () => {
  assert.equal(zonedDayStart(MON, IST).toISOString(), '2026-10-11T18:30:00.000Z');
  assert.equal(zonedDayStart('2026-03-08', 'America/New_York').toISOString(), '2026-03-08T05:00:00.000Z');
  assert.equal(zonedDayStart('2026-03-09', 'America/New_York').toISOString(), '2026-03-09T04:00:00.000Z');
  assert.equal(minutesIntoDay(ist(`${TUE}T06:00`), IST, MON), 30 * 60);
});

test('a day shift keeps the local date; a night shift attributes early-morning punches to the previous evening', () => {
  assert.equal(shiftDayKey(ist(`${TUE}T00:30`), policy()), TUE);
  assert.equal(shiftDayKey(ist(`${TUE}T00:30`), night()), MON);
  assert.equal(shiftDayKey(ist(`${MON}T22:05`), night()), MON);
  assert.equal(shiftDayKey(ist(`${TUE}T11:00`), night()), TUE);
});

test('invalid time zones are rejected and fall back safely', () => {
  assert.equal(isValidTimeZone('Asia/Kolkata'), true);
  assert.equal(isValidTimeZone('Mars/Olympus'), false);
  assert.equal(isValidTimeZone(''), false);
  assert.equal(safeTimeZone('Mars/Olympus', null, 'Asia/Kolkata'), 'Asia/Kolkata');
  assert.equal(safeTimeZone('bogus', undefined, 'also bogus'), 'UTC');
  // The engine must not throw on a bad stored zone (used to 500 the register)
  assert.doesNotThrow(() => evaluateDay(policy({ timezone: safeTimeZone('bogus', 'UTC') }), day(MON), ist(`${WED}T12:00`)));
});

// ─── Provisional days (ATT-5) ────────────────────────────────────────────────

test('today with an open session is provisional PRESENT, not ABSENT', () => {
  const r = evaluateDay(policy(), day(MON, { sessions: [{ checkInAt: ist(`${MON}T09:00`), checkOutAt: null }] }), ist(`${MON}T11:00`));
  assert.equal(r.status, 'PRESENT');
  assert.equal(r.phase, 'today');
  assert.equal(r.provisional, true);
  assert.equal(r.workedMinutes, 120);
});

test('today with a late open session follows the arrival band', () => {
  const r = evaluateDay(policy(), day(MON, { sessions: [{ checkInAt: ist(`${MON}T09:40`), checkOutAt: null }] }), ist(`${MON}T11:00`));
  assert.equal(r.status, 'LATE');
  assert.equal(r.lateMinutes, 40);
});

test('future days and today without punches are PENDING; week-offs still show', () => {
  const now = ist(`${MON}T10:00`);
  assert.equal(evaluateDay(policy(), day(WED), now).status, 'PENDING');
  assert.equal(evaluateDay(policy(), day(WED), now).phase, 'future');
  assert.equal(evaluateDay(policy(), day(MON), now).status, 'PENDING');
  assert.equal(evaluateDay(policy(), day(SUN), now).status, 'WEEK_OFF');
  assert.equal(evaluateDay(policy(), day(SUN), now).provisional, true);
  assert.equal(dayPhase(policy(), MON, ist(`${TUE}T00:01`)), 'past');
});

test('a past day with no punches is ABSENT; a past open session without assume-shift-end is ABSENT', () => {
  const now = ist(`${WED}T12:00`);
  assert.equal(evaluateDay(policy(), day(MON), now).status, 'ABSENT');
  const open = evaluateDay(policy(), day(MON, { sessions: [{ checkInAt: ist(`${MON}T09:00`), checkOutAt: null }] }), now);
  assert.equal(open.status, 'ABSENT');
  const assumed = evaluateDay(policy({ assumeShiftEndOnMissingCheckout: true }), day(MON, { sessions: [{ checkInAt: ist(`${MON}T09:00`), checkOutAt: null }] }), now);
  assert.equal(assumed.status, 'PRESENT');
  assert.equal(assumed.workedMinutes, 540);
});

test('a session closed by the close-out job counts as a missing check-out', () => {
  const now = ist(`${WED}T12:00`);
  const s = [{ checkInAt: ist(`${MON}T09:00`), checkOutAt: ist(`${MON}T18:00`), checkOutSource: 'AUTO_CLOSE' }];
  assert.equal(evaluateDay(policy(), day(MON, { sessions: s }), now).status, 'ABSENT');
  assert.equal(evaluateDay(policy({ assumeShiftEndOnMissingCheckout: true }), day(MON, { sessions: s }), now).status, 'PRESENT');
});

test('the register summary leaves future days out; PENDING never counts', () => {
  const p = policy();
  const now = ist(`${TUE}T10:00`);
  const days = [MON, TUE, WED].map(k => evaluateDay(p, day(k, k === MON ? { sessions: [{ checkInAt: ist(`${MON}T09:00`), checkOutAt: ist(`${MON}T18:00`) }] } : {}), now));
  const s = summarise(p, days, { toDate: true });
  assert.equal(s.workingDays, 1);
  assert.equal(s.presentDays, 1);
  assert.equal(s.absentDays, 0);
  assert.equal(s.pendingDays, 2);
});

// ─── Full day evaluation ─────────────────────────────────────────────────────

test('a normal IST day: on time, full hours, overtime off', () => {
  const r = evaluateDay(policy(), day(MON, { sessions: [{ checkInAt: ist(`${MON}T09:10`), checkOutAt: ist(`${MON}T18:05`) }] }), ist(`${WED}T09:00`));
  assert.equal(r.status, 'PRESENT');
  assert.equal(r.lateMinutes, 0);
  assert.equal(r.workedMinutes, 535);
  assert.equal(r.paidFraction, 1);
});

test('multiple sessions add up; short day is HALF_DAY', () => {
  const r = evaluateDay(policy(), day(MON, { sessions: [
    { checkInAt: ist(`${MON}T09:00`), checkOutAt: ist(`${MON}T11:00`) },
    { checkInAt: ist(`${MON}T12:00`), checkOutAt: ist(`${MON}T15:00`) },
  ] }), ist(`${WED}T09:00`));
  assert.equal(r.workedMinutes, 300);
  assert.equal(r.status, 'HALF_DAY');
  assert.equal(r.paidFraction, 0.5);
});

test('ATT-12: AM half-day leave expects arrival at mid-shift', () => {
  const leave = { days: 0.5, halfDay: true, halfDayPeriod: 'AM', isPaid: true, leaveTypeName: 'Casual', requestId: 'lr1' };
  const r = evaluateDay(policy(), day(MON, { leave, sessions: [{ checkInAt: ist(`${MON}T13:30`), checkOutAt: ist(`${MON}T18:00`) }] }), ist(`${WED}T09:00`));
  assert.notEqual(r.status, 'ABSENT');
  assert.equal(r.status, 'PRESENT');
  assert.equal(r.lateMinutes, 0);
  assert.equal(r.paidFraction, 1);
  // PM leave still expects the normal start
  const pm = evaluateDay(policy(), day(MON, { leave: { ...leave, halfDayPeriod: 'PM' }, sessions: [{ checkInAt: ist(`${MON}T09:00`), checkOutAt: ist(`${MON}T13:30`) }] }), ist(`${WED}T09:00`));
  assert.equal(pm.status, 'PRESENT');
  assert.equal(pm.earlyMinutes, 0);
});

test('ATT-13: a 22:00–06:00 shift worked in full is PRESENT on the evening it started', () => {
  const p = night();
  const sessions = [{ checkInAt: ist(`${MON}T22:00`), checkOutAt: ist(`${TUE}T06:00`) }];
  assert.equal(shiftDayKey(sessions[0].checkInAt, p), MON);
  const r = evaluateDay(p, day(MON, { sessions }), ist(`${WED}T12:00`));
  assert.equal(r.status, 'PRESENT');
  assert.equal(r.workedMinutes, 480);
  assert.equal(r.earlyMinutes, 0);
});

test('ATT-13: arriving 00:30 on a 22:00 shift is 150 minutes late', () => {
  const r = evaluateDay(night(), day(MON, { sessions: [{ checkInAt: ist(`${TUE}T00:30`), checkOutAt: ist(`${TUE}T06:00`) }] }), ist(`${WED}T12:00`));
  assert.equal(r.lateMinutes, 150);
  assert.equal(r.status, 'HALF_DAY');
});

test('ATT-13: night-shift early departure, overtime and assume-shift-end use the next-morning end', () => {
  const p = night({ overtimeAfterMinutes: 30, overtimeMinMinutes: 30, earlyDepartureGraceMinutes: 15 });
  const early = evaluateDay(p, day(MON, { sessions: [{ checkInAt: ist(`${MON}T22:00`), checkOutAt: ist(`${TUE}T05:00`) }] }), ist(`${WED}T12:00`));
  assert.equal(early.earlyMinutes, 60);
  const ot = evaluateDay(p, day(MON, { sessions: [{ checkInAt: ist(`${MON}T22:00`), checkOutAt: ist(`${TUE}T07:30`) }] }), ist(`${WED}T12:00`));
  assert.equal(ot.overtimeMinutes, 60);
  const assumed = evaluateDay(night({ assumeShiftEndOnMissingCheckout: true }), day(MON, { sessions: [{ checkInAt: ist(`${MON}T22:00`), checkOutAt: null }] }), ist(`${WED}T12:00`));
  assert.equal(assumed.workedMinutes, 480);
});

test('ATT-4: a night shift in progress after midnight is still "today" for its start day', () => {
  const p = night();
  const r = evaluateDay(p, day(MON, { sessions: [{ checkInAt: ist(`${MON}T22:00`), checkOutAt: null }] }), ist(`${TUE}T02:00`));
  assert.equal(r.phase, 'today');
  assert.equal(r.status, 'PRESENT');
  assert.equal(r.workedMinutes, 240);
});

test('holidays: optional ones only count when opted in', () => {
  const now = ist(`${WED}T12:00`);
  assert.equal(evaluateDay(policy(), day(MON, { holiday: { name: 'Diwali', isOptional: false } }), now).status, 'HOLIDAY');
  assert.equal(evaluateDay(policy(), day(MON, { holiday: { name: 'Onam', isOptional: true } }), now).status, 'ABSENT');
  assert.equal(evaluateDay(policy(), day(MON, { holiday: { name: 'Onam', isOptional: true, optedIn: true } }), now).status, 'HOLIDAY');
});

test('ATT-27: an approved WFH request makes the day WFH and paid', () => {
  const r = evaluateDay(policy(), day(MON, { wfhApproved: { requestId: 'w1', name: 'Work from home' } }), ist(`${WED}T12:00`));
  assert.equal(r.status, 'WFH');
  assert.equal(r.paidFraction, 1);
});

// ─── Employment window (ATT-8) ───────────────────────────────────────────────

test('ATT-8: days before joining are NOT_EMPLOYED, not ABSENT', () => {
  const employment = { joiningDate: keyToDate(TUE), lastWorkingDate: null };
  const now = ist('2026-10-20T12:00');
  const mon = evaluateDay(policy(), day(MON, { employment }), now);
  assert.equal(mon.status, 'NOT_EMPLOYED');
  assert.equal(mon.wouldWork, true);
  const sun = evaluateDay(policy(), day('2026-10-11', { employment }), now);
  assert.equal(sun.status, 'NOT_EMPLOYED');
  assert.equal(sun.wouldWork, false);
  const after = evaluateDay(policy(), day(WED, { employment: { joiningDate: null, lastWorkingDate: keyToDate(TUE) } }), now);
  assert.equal(after.status, 'NOT_EMPLOYED');
});

test('ATT-8: register summary excludes NOT_EMPLOYED; payroll counts them as unpaid working days', () => {
  const p = policy();
  const rows = [
    { status: 'NOT_EMPLOYED' as const, paidFraction: 0, overtimeMinutes: 0, phase: 'past' as const, wouldWork: true },
    { status: 'NOT_EMPLOYED' as const, paidFraction: 0, overtimeMinutes: 0, phase: 'past' as const, wouldWork: false },
    { status: 'PRESENT' as const, paidFraction: 1, overtimeMinutes: 0, phase: 'past' as const },
    { status: 'WEEK_OFF' as const, paidFraction: 1, overtimeMinutes: 0, phase: 'past' as const },
  ];
  const reg = summarise(p, rows, { toDate: true });
  assert.equal(reg.workingDays, 1);
  assert.equal(reg.lopDays, 0);
  assert.equal(reg.notEmployedDays, 2);
  const pay = summarise(p, rows, { notEmployedAsLop: true });
  assert.equal(pay.workingDays, 2);
  assert.equal(pay.paidDays, 1);
  assert.equal(pay.lopDays, 1);
});

// ─── Leave length (ATT-9) ────────────────────────────────────────────────────

test('ATT-9: leave counts working days only', () => {
  const offs = [0, 6];
  assert.equal(countWorkingDays('2026-10-16', '2026-10-19', offs, new Set()), 2); // Fri..Mon
  assert.equal(countWorkingDays('2026-10-16', '2026-10-19', offs, new Set(['2026-10-19'])), 1);
  assert.equal(countWorkingDays(SAT, SUN, offs, new Set()), 0);
  assert.equal(countWorkingDays(MON, MON, offs, new Set(), true), 0.5);
  assert.equal(countWorkingDays(SUN, SUN, offs, new Set(), true), 0);
  assert.equal(countWorkingDays(MON, SUN, [0], new Set()), 6); // six-day week
});

// ─── Late conversion / applicability ─────────────────────────────────────────

test('late conversion beyond the allowance', () => {
  const p = policy({ lateAllowedPerMonth: 3, lateConversionEvery: 3, lateConversionUnit: 'HALF_DAY' });
  assert.equal(lateConversion(p, 3).extraLopDays, 0);
  assert.equal(lateConversion(p, 6).extraLopDays, 0.5);
  assert.equal(lateConversion({ ...p, lateConversionUnit: 'LOP' }, 9).extraLopDays, 2);
});

test('pickGroup: user > location > department > type > unscoped default', () => {
  const groups = [
    { id: 'def', isDefault: true, isActive: true, applicability: null },
    { id: 'loc', isDefault: false, isActive: true, applicability: { locationIds: ['hyd'] } },
    { id: 'usr', isDefault: false, isActive: true, applicability: { userIds: ['u1'] } },
  ];
  assert.equal(pickGroup(groups, { userId: 'u1', locationId: 'hyd' })!.id, 'usr');
  assert.equal(pickGroup(groups, { userId: 'u2', locationId: 'hyd' })!.id, 'loc');
  assert.equal(pickGroup(groups, { userId: 'u2' })!.id, 'def');
  assert.equal(isScoped({ userIds: [] }), false);
  assert.equal(isScoped({ departmentIds: ['d'] }), true);
});

// ─── Office network rule (ATT-15) ────────────────────────────────────────────

test('ATT-15: the network matches against ANY office allowlist, not only the nearest office', () => {
  const near = { name: 'Near (no allowlist)', latitude: 17.45, longitude: 78.38, radiusMeters: 200, allowedIps: null };
  const far = { name: 'Far', latitude: 12.97, longitude: 77.59, radiusMeters: 200, allowedIps: '203.0.113.0/24' };
  // Standing at the near office on some other network: must NOT pass vacuously
  const spoof = verifyAgainstOffices([near, far], 17.45, 78.38, '198.51.100.7');
  assert.equal(spoof.locationOk, true);
  assert.equal(spoof.networkStatus, 'not_matched');
  assert.equal(spoof.networkOk, false);
  // On the far office's network: matched regardless of which office is nearest
  assert.equal(verifyAgainstOffices([near, far], 17.45, 78.38, '203.0.113.9').networkStatus, 'matched');
  // No office has an allowlist: the signal doesn't exist
  assert.equal(verifyAgainstOffices([near], 17.45, 78.38, '198.51.100.7').networkStatus, 'not_configured');
});

// ─── Client IP (ATT-3) ───────────────────────────────────────────────────────

test('ATT-3: a client-supplied X-Forwarded-For entry is never trusted', () => {
  const headers = { 'x-forwarded-for': '203.0.113.5, 198.51.100.7' }; // spoofed office IP, then the real peer nginx appended
  assert.equal(extractClientIp(headers, '10.0.0.1'), '198.51.100.7');
  assert.equal(requestIp({ ip: '::ffff:198.51.100.7', headers }), '198.51.100.7');
  assert.equal(requestIp({ ip: '', headers: {}, socket: { remoteAddress: '10.0.0.2' } }), '10.0.0.2');
});

// ─── Close-out (ATT-17) ──────────────────────────────────────────────────────

test('ATT-17: forgotten sessions close at shift end, after the grace hours', () => {
  const p = policy();
  const end = shiftEndInstant(p, MON);
  assert.equal(end.toISOString(), ist(`${MON}T18:00`).toISOString());
  const plan = closeOutPlan(ist(`${MON}T09:00`), end, 4);
  assert.equal(plan.closeAt.toISOString(), ist(`${MON}T18:00`).toISOString());
  assert.equal(plan.dueAt.toISOString(), ist(`${MON}T22:00`).toISOString());
  // Started after the shift had ended: closed at its own start, never before it
  const late = closeOutPlan(ist(`${MON}T19:00`), end, 4);
  assert.equal(late.closeAt.toISOString(), ist(`${MON}T19:00`).toISOString());
  // Night shift ends the next morning
  assert.equal(shiftEndInstant(night(), MON).toISOString(), ist(`${TUE}T06:00`).toISOString());
});
