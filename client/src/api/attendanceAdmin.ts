import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

/** PENDING (not happened yet / in progress without punches) and NOT_EMPLOYED (before joining / after exit) are computed, never stored. */
export type DayStatus = 'PRESENT' | 'LATE' | 'HALF_DAY' | 'ABSENT' | 'LEAVE' | 'UNPAID_LEAVE' | 'WFH' | 'HOLIDAY' | 'WEEK_OFF' | 'LOP' | 'PENDING' | 'NOT_EMPLOYED';
export type ManualStatus = Exclude<DayStatus, 'PENDING' | 'NOT_EMPLOYED'>;
export interface LateBand { untilMinutes: number | null; status: 'PRESENT' | 'LATE' | 'HALF_DAY' | 'ABSENT' }
export interface PolicyGroup {
  id: string; name: string; isDefault: boolean; isActive: boolean; shiftStart: string; shiftEnd: string; timezone: string | null;
  graceMinutes: number; lateBands: LateBand[] | null; minFullDayMinutes: number; minHalfDayMinutes: number;
  earlyDepartureGraceMinutes: number; earlyDepartureStatus: 'NONE' | 'HALF_DAY'; overtimeAfterMinutes: number; overtimeMinMinutes: number;
  lateAllowedPerMonth: number; lateConversionEvery: number; lateConversionUnit: 'HALF_DAY' | 'LOP' | 'NONE'; weeklyOffs: number[];
  assumeShiftEndOnMissingCheckout: boolean; optionalHolidaysAllowed?: number; applicability: { departmentIds?: string[]; locationIds?: string[]; employmentTypes?: string[]; userIds?: string[] } | null;
}
export interface Holiday { id: string; date: string; name: string; locationIds: string[]; isOptional: boolean }
export interface RegisterDay {
  date: string; status: DayStatus; source: 'COMPUTED' | 'MANUAL'; paidFraction: number; workedMinutes: number; lateMinutes: number; earlyMinutes: number; overtimeMinutes: number;
  firstInAt: string | null; lastOutAt: string | null; reason: string | null; notes: string | null; leaveRequestId: string | null;
  /** past = final; today = in progress; future = not started. Non-past days are provisional. */
  phase?: 'past' | 'today' | 'future'; provisional?: boolean;
  /** Covered by a finalised payroll run — read-only */
  frozen?: boolean;
}
export interface Summary { daysInPeriod: number; workingDays: number; presentDays: number; halfDays: number; leaveDays: number; unpaidLeaveDays: number; absentDays: number; lopDays: number; paidDays: number; lateCount: number; lateConversion: { note: string; extraLopDays: number }; overtimeHours: number; pendingDays?: number; notEmployedDays?: number; byStatus: Record<string, number>; policyGroupName?: string }
export interface RegisterRow { user: { id: string; name: string; avatarUrl?: string | null; department?: string | null; isActive?: boolean }; policyGroup: string; timezone?: string; days: RegisterDay[]; summary: Summary }
export interface DaySession {
  id: string; checkInAt: string | null; checkOutAt: string | null; source: string; checkOutSource: string | null; notes: string | null;
  checkInPassed: boolean | null; checkInFaceOk: boolean | null; checkOutFaceOk: boolean | null; hasCheckInSelfie: boolean; hasCheckOutSelfie: boolean;
}
export interface DayDetail { timezone: string; day: RegisterDay | null; sessions: DaySession[] }
export interface OptionalHolidayList { year: number; allowed: number; used: number; today: string; holidays: (Holiday & { optedIn: boolean })[] }
export interface AuditRow { id: string; date: string | null; entityType: string; action: string; before: any; after: any; reason: string | null; changedAt: string; batchId?: string | null; changer: { id: string; name: string }; user: { id: string; name: string } }

export const STATUS_LABEL: Record<DayStatus, string> = { PRESENT: 'Present', LATE: 'Late', HALF_DAY: 'Half day', ABSENT: 'Absent', LEAVE: 'Leave', UNPAID_LEAVE: 'Unpaid leave', WFH: 'WFH', HOLIDAY: 'Holiday', WEEK_OFF: 'Week off', LOP: 'LOP', PENDING: 'Not yet', NOT_EMPLOYED: 'Not employed' };
export const STATUS_SHORT: Record<DayStatus, string> = { PRESENT: 'P', LATE: 'L', HALF_DAY: '½', ABSENT: 'A', LEAVE: 'LV', UNPAID_LEAVE: 'UL', WFH: 'W', HOLIDAY: 'H', WEEK_OFF: 'O', LOP: 'X', PENDING: '', NOT_EMPLOYED: '–' };
export const STATUS_CLASS: Record<DayStatus, string> = {
  PRESENT: 'bg-success/15 text-success', LATE: 'bg-warning/20 text-warning', HALF_DAY: 'bg-warning/10 text-warning', ABSENT: 'bg-danger/15 text-danger',
  LEAVE: 'bg-info/15 text-info', UNPAID_LEAVE: 'bg-danger/10 text-danger', WFH: 'bg-accent-soft text-accent', HOLIDAY: 'bg-surface-sunken text-fg-subtle', WEEK_OFF: 'bg-surface-sunken text-fg-subtle', LOP: 'bg-danger/20 text-danger',
  PENDING: 'bg-transparent border border-dashed border-line-subtle text-fg-subtle', NOT_EMPLOYED: 'bg-transparent text-fg-subtle',
};

export const usePolicyGroups = () => useQuery<{ groups: PolicyGroup[]; defaultLateBands: LateBand[] }>({ queryKey: ['attendance-policy-groups'], queryFn: () => api.get('/hr/attendance/policy-groups').then(r => r.data) });
export const useMyPolicy = (enabled = true) => useQuery<any>({ queryKey: ['attendance-my-policy'], queryFn: () => api.get('/hr/attendance/my-policy').then(r => r.data), enabled, staleTime: 5 * 60_000 });
export const useHolidays = (year: number) => useQuery<Holiday[]>({ queryKey: ['holidays', year], queryFn: () => api.get('/hr/attendance/holidays', { params: { year } }).then(r => r.data) });
export const useRegister = (month: string, userId?: string, includeEmployees?: boolean) => useQuery<{ from: string; to: string; rows: RegisterRow[] }>({
  queryKey: ['attendance-register', month, userId ?? '', !!includeEmployees],
  queryFn: () => api.get('/hr/attendance/register', { params: { month, userId, includeEmployees: includeEmployees ? '1' : undefined } }).then(r => r.data),
});
export const useAttendanceAudit = (userId?: string) => useQuery<AuditRow[]>({ queryKey: ['attendance-audit', userId ?? ''], queryFn: () => api.get('/hr/attendance/audit', { params: { userId } }).then(r => r.data) });

const inv = (qc: ReturnType<typeof useQueryClient>) => { qc.invalidateQueries({ queryKey: ['attendance-register'] }); qc.invalidateQueries({ queryKey: ['attendance-audit'] }); qc.invalidateQueries({ queryKey: ['attendance-me'] }); };

export function useSavePolicyGroup() { const qc = useQueryClient(); return useMutation({ mutationFn: ({ id, ...d }: Partial<PolicyGroup> & { id?: string }) => (id ? api.put(`/hr/attendance/policy-groups/${id}`, d) : api.post('/hr/attendance/policy-groups', d)).then(r => r.data), onSuccess: () => { qc.invalidateQueries({ queryKey: ['attendance-policy-groups'] }); qc.invalidateQueries({ queryKey: ['attendance-register'] }); } }); }
export function useDeletePolicyGroup() { const qc = useQueryClient(); return useMutation({ mutationFn: (id: string) => api.delete(`/hr/attendance/policy-groups/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['attendance-policy-groups'] }) }); }
export function useSaveHoliday() { const qc = useQueryClient(); return useMutation({ mutationFn: ({ id, ...d }: Partial<Holiday> & { id?: string }) => (id ? api.put(`/hr/attendance/holidays/${id}`, d) : api.post('/hr/attendance/holidays', d)).then(r => r.data), onSuccess: () => { qc.invalidateQueries({ queryKey: ['holidays'] }); qc.invalidateQueries({ queryKey: ['attendance-register'] }); } }); }
export function useDeleteHoliday() { const qc = useQueryClient(); return useMutation({ mutationFn: (id: string) => api.delete(`/hr/attendance/holidays/${id}`), onSuccess: () => { qc.invalidateQueries({ queryKey: ['holidays'] }); qc.invalidateQueries({ queryKey: ['attendance-register'] }); } }); }
export interface MarkDayInput {
  userId: string; date: string;
  /** Omit to fix punches only and let the engine decide the status */
  status?: ManualStatus;
  /** Only the fields that were actually changed */
  sessions?: { recordId: string; checkInAt?: string; checkOutAt?: string | null }[];
  addSession?: { checkInAt: string; checkOutAt?: string | null };
  notes?: string; reason: string;
}
export function useMarkDay() { const qc = useQueryClient(); return useMutation({ mutationFn: (d: MarkDayInput) => api.post('/hr/attendance/days', d).then(r => r.data), onSuccess: () => { inv(qc); qc.invalidateQueries({ queryKey: ['attendance-day'] }); } }); }
export const useDayDetail = (userId: string, date: string) => useQuery<DayDetail>({ queryKey: ['attendance-day', userId, date], queryFn: () => api.get('/hr/attendance/day', { params: { userId, date } }).then(r => r.data) });
export const fetchSelfie = (recordId: string, which: 'in' | 'out') => api.get<{ selfie: string }>(`/hr/attendance/records/${recordId}/selfie`, { params: { which } }).then(r => r.data.selfie);
export function useBulkHolidays() { const qc = useQueryClient(); return useMutation({ mutationFn: (rows: { date: string; name: string; isOptional?: boolean }[]) => api.post<{ ok: boolean; count: number; skipped: number }>('/hr/attendance/holidays/bulk', rows).then(r => r.data), onSuccess: () => { qc.invalidateQueries({ queryKey: ['holidays'] }); qc.invalidateQueries({ queryKey: ['attendance-register'] }); } }); }
export const useOptionalHolidays = (year: number) => useQuery<OptionalHolidayList>({ queryKey: ['optional-holidays', year], queryFn: () => api.get('/hr/attendance/optional-holidays', { params: { year } }).then(r => r.data) });
export function useSetOptionalHoliday() { const qc = useQueryClient(); return useMutation({ mutationFn: ({ id, optIn }: { id: string; optIn: boolean }) => (optIn ? api.post(`/hr/attendance/optional-holidays/${id}`) : api.delete(`/hr/attendance/optional-holidays/${id}`)).then(r => r.data), onSuccess: () => { qc.invalidateQueries({ queryKey: ['optional-holidays'] }); inv(qc); } }); }

/** Register month as CSV (one row per person, one column per day + totals) — built client-side from what's on screen. */
export function registerToCsv(rows: RegisterRow[]): string {
  const days = rows[0]?.days.map(d => d.date) ?? [];
  const esc = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const header = ['Employee', 'Department', 'Policy', ...days, 'Working days', 'Paid days', 'LOP days', 'Present', 'Half days', 'Leave', 'Absent', 'Late', 'OT hours'];
  const lines = rows.map(r => [
    r.user.name, r.user.department ?? '', r.policyGroup,
    ...r.days.map(d => (d.status === 'PENDING' ? '' : STATUS_LABEL[d.status]) + (d.source === 'MANUAL' ? ' (manual)' : '')),
    r.summary.workingDays, r.summary.paidDays, r.summary.lopDays, r.summary.presentDays, r.summary.halfDays, r.summary.leaveDays, r.summary.absentDays, r.summary.lateCount, r.summary.overtimeHours,
  ]);
  return [header, ...lines].map(l => l.map(esc).join(',')).join('\r\n');
}
export function useResetDay() { const qc = useQueryClient(); return useMutation({ mutationFn: ({ userId, date, reason }: { userId: string; date: string; reason?: string }) => api.delete(`/hr/attendance/days/${userId}/${date}`, { data: { reason } }).then(r => r.data), onSuccess: () => inv(qc) }); }
export function useConvertToLeave() { const qc = useQueryClient(); return useMutation({ mutationFn: (d: { userId: string; date: string; leaveTypeId: string; halfDay?: boolean; halfDayPeriod?: 'AM' | 'PM'; reason: string }) => api.post('/hr/leave/convert', d).then(r => r.data), onSuccess: () => { inv(qc); qc.invalidateQueries({ queryKey: ['leave-requests'] }); } }); }

// ─── Bulk edit (POST /hr/attendance/days/bulk) ───────────────────────────────

/** Same caps as the server (utils/attendanceBulk.ts) — checked client-side to explain before sending. */
export const BULK_MAX_CELLS = 3000;
export interface BulkCell { userId: string; date: string }
export interface BulkInput {
  /** Explicit cells (selection mode) — or userIds with dates / range */
  cells?: BulkCell[];
  userIds?: string[];
  dates?: string[];
  range?: { from: string; to: string };
  skipWeeklyOffs: boolean;
  skipHolidays: boolean;
  action: 'mark' | 'reset';
  status?: ManualStatus;
  reason: string;
  notes?: string;
  overwriteManual: boolean;
  /** Classify only, write nothing */
  dryRun?: boolean;
}
export interface BulkSkip { userId: string; date: string; code: string; reason: string }
export interface BulkResult { batchId: string | null; dryRun: boolean; total: number; changed: number; skipped: BulkSkip[] }
export function useBulkDays() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (d: BulkInput) => api.post<BulkResult>('/hr/attendance/days/bulk', d).then(r => r.data),
    onSuccess: (r) => { if (!r.dryRun) { inv(qc); qc.invalidateQueries({ queryKey: ['attendance-day'] }); } },
  });
}
