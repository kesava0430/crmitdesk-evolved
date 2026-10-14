/**
 * Bulk attendance corrections — the pure parts (utils/attendanceBulk.ts):
 * expanding a selection into cells, the size caps, and the per-cell skip rules
 * that decide what POST /hr/attendance/days/bulk touches.
 *
 *     npm run test:unit
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  expandCells, classifyCell, groupByUser, chunk, isValidDateKey, SKIP_REASON,
  BULK_MAX_CELLS, BULK_MAX_SPAN_DAYS, type BulkOptions, type CellFacts,
} from '../../src/utils/attendanceBulk';

// 2026-10-12 is a Monday; 17/18 are Saturday/Sunday.
const MON = '2026-10-12', SAT = '2026-10-17', SUN = '2026-10-18';

const status400 = (fn: () => unknown, re: RegExp) =>
  assert.throws(fn, (e: any) => e.statusCode === 400 && re.test(e.message));

// ─── Expansion ───────────────────────────────────────────────────────────────

test('a range × people expands to every day for every person, sorted and de-duplicated', () => {
  const cells = expandCells({ userIds: ['u2', 'u1', 'u2'], range: { from: MON, to: '2026-10-14' } });
  assert.deepEqual(cells, [
    { userId: 'u1', date: '2026-10-12' }, { userId: 'u1', date: '2026-10-13' }, { userId: 'u1', date: '2026-10-14' },
    { userId: 'u2', date: '2026-10-12' }, { userId: 'u2', date: '2026-10-13' }, { userId: 'u2', date: '2026-10-14' },
  ]);
});

test('a range can span months and years', () => {
  const cells = expandCells({ userIds: ['u1'], range: { from: '2026-12-30', to: '2027-01-02' } });
  assert.deepEqual(cells.map(c => c.date), ['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
});

test('explicit dates and explicit cells are de-duplicated', () => {
  assert.equal(expandCells({ userIds: ['u1'], dates: [MON, MON, SAT] }).length, 2);
  const cells = expandCells({ cells: [{ userId: 'b', date: SAT }, { userId: 'a', date: MON }, { userId: 'b', date: SAT }] });
  assert.deepEqual(cells, [{ userId: 'a', date: MON }, { userId: 'b', date: SAT }]);
});

test('exactly one way of selecting must be used', () => {
  status400(() => expandCells({}), /either cells/);
  status400(() => expandCells({ cells: [{ userId: 'a', date: MON }], userIds: ['a'], dates: [MON] }), /either cells/);
  status400(() => expandCells({ userIds: ['a'] }), /dates or a range/);
  status400(() => expandCells({ userIds: ['a'], dates: [MON], range: { from: MON, to: MON } }), /dates or a range/);
});

test('invalid and impossible dates are rejected', () => {
  assert.equal(isValidDateKey('2026-02-28'), true);
  assert.equal(isValidDateKey('2026-02-30'), false);
  assert.equal(isValidDateKey('2026-13-01'), false);
  assert.equal(isValidDateKey('12/10/2026'), false);
  status400(() => expandCells({ userIds: ['a'], dates: ['2026-02-30'] }), /Invalid date/);
  status400(() => expandCells({ cells: [{ userId: 'a', date: 'nope' }] }), /Invalid date/);
  status400(() => expandCells({ userIds: ['a'], range: { from: '2026-10-14', to: MON } }), /ends before/);
});

test('the cell cap is enforced with a clear message, before building the list', () => {
  const users = Array.from({ length: 100 }, (_, i) => `u${i}`);
  // 100 people × 31 days = 3,100 > 3,000
  status400(() => expandCells({ userIds: users, range: { from: '2026-10-01', to: '2026-10-31' } }), /3,100 days; the limit is 3,000/);
  // 100 × 30 = 3,000 is allowed
  assert.equal(expandCells({ userIds: users, range: { from: '2026-10-01', to: '2026-10-30' } }).length, BULK_MAX_CELLS);
  const tooMany = Array.from({ length: BULK_MAX_CELLS + 1 }, (_, i) => ({ userId: `u${i}`, date: MON }));
  status400(() => expandCells({ cells: tooMany }), /limit is 3,000/);
});

test('the date span is capped', () => {
  status400(() => expandCells({ userIds: ['a'], range: { from: '2026-01-01', to: '2027-01-02' } }), new RegExp(`limit is ${BULK_MAX_SPAN_DAYS}`));
  status400(() => expandCells({ cells: [{ userId: 'a', date: '2025-01-01' }, { userId: 'a', date: '2026-06-01' }] }), /span more than/);
});

test('groupByUser and chunk', () => {
  const g = groupByUser([{ userId: 'a', date: MON }, { userId: 'b', date: MON }, { userId: 'a', date: SAT }]);
  assert.deepEqual([...g.entries()], [['a', [MON, SAT]], ['b', [MON]]]);
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 2), []);
});

// ─── Skip rules ──────────────────────────────────────────────────────────────

const mark = (o: Partial<BulkOptions> = {}): BulkOptions => ({ action: 'mark', status: 'PRESENT', skipWeeklyOffs: true, skipHolidays: true, overwriteManual: false, ...o });
const facts = (date: string, f: Partial<CellFacts> = {}): CellFacts => ({ date, frozen: false, notEmployed: false, weeklyOffs: [0, 6], holiday: false, existing: null, ...f });
const verdict = (o: BulkOptions, f: CellFacts) => { const v = classifyCell(o, f); return v.apply ? 'apply' : v.code; };

test('an ordinary working day is marked', () => {
  assert.equal(verdict(mark(), facts(MON)), 'apply');
  assert.equal(verdict(mark(), facts(MON, { existing: { source: 'COMPUTED', status: 'ABSENT' } })), 'apply');
  // Marking a computed PRESENT day still pins it as MANUAL
  assert.equal(verdict(mark(), facts(MON, { existing: { source: 'COMPUTED', status: 'PRESENT' } })), 'apply');
});

test('frozen days are always skipped as locked, for mark and reset alike', () => {
  const frozenManual = facts(MON, { frozen: true, existing: { source: 'MANUAL', status: 'ABSENT' } });
  assert.equal(verdict(mark({ overwriteManual: true }), frozenManual), 'FROZEN');
  assert.equal(verdict(mark({ action: 'reset', status: undefined }), frozenManual), 'FROZEN');
  assert.equal(SKIP_REASON.FROZEN, 'locked — payroll finalised');
});

test('weekly offs follow the user\'s policy and the skip flag', () => {
  assert.equal(verdict(mark(), facts(SAT)), 'WEEK_OFF');
  assert.equal(verdict(mark(), facts(SUN)), 'WEEK_OFF');
  assert.equal(verdict(mark({ skipWeeklyOffs: false }), facts(SAT)), 'apply');
  // A Friday/Saturday weekend policy: Sunday is a working day
  assert.equal(verdict(mark(), facts(SUN, { weeklyOffs: [5, 6] })), 'apply');
  assert.equal(verdict(mark(), facts('2026-10-16', { weeklyOffs: [5, 6] })), 'WEEK_OFF');
});

test('holidays follow the skip flag', () => {
  assert.equal(verdict(mark(), facts(MON, { holiday: true })), 'HOLIDAY');
  assert.equal(verdict(mark({ skipHolidays: false }), facts(MON, { holiday: true })), 'apply');
});

test('days outside employment are skipped', () => {
  assert.equal(verdict(mark(), facts(MON, { notEmployed: true, existing: { source: 'COMPUTED', status: 'NOT_EMPLOYED' } })), 'NOT_EMPLOYED');
});

test('existing manual corrections are kept unless overwriting; identical ones are "already"', () => {
  const manualAbsent = facts(MON, { existing: { source: 'MANUAL', status: 'ABSENT', notes: null } });
  assert.equal(verdict(mark(), manualAbsent), 'MANUAL_KEPT');
  assert.equal(verdict(mark({ overwriteManual: true }), manualAbsent), 'apply');
  const manualPresent = facts(MON, { existing: { source: 'MANUAL', status: 'PRESENT', notes: 'Client visit' } });
  // Re-running the same batch: nothing new, even with overwrite on
  assert.equal(verdict(mark({ overwriteManual: true }), manualPresent), 'ALREADY');
  assert.equal(verdict(mark({ overwriteManual: true, notes: 'Client visit' }), manualPresent), 'ALREADY');
  // …but different notes are a change
  assert.equal(verdict(mark({ overwriteManual: true, notes: 'Offsite' }), manualPresent), 'apply');
});

test('reset only touches manual days and ignores the weekly-off / holiday filters', () => {
  const reset = mark({ action: 'reset', status: undefined });
  assert.equal(verdict(reset, facts(MON, { existing: { source: 'COMPUTED', status: 'ABSENT' } })), 'NOT_MANUAL');
  assert.equal(verdict(reset, facts(MON)), 'NOT_MANUAL');
  assert.equal(verdict(reset, facts(SAT, { holiday: true, existing: { source: 'MANUAL', status: 'PRESENT' } })), 'apply');
});
