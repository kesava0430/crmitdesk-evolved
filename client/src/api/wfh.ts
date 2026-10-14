import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

/** Work from home — requests are leave requests of a WFH type; see server modules/hr/leave/wfh.controller.ts. */

export interface WfhSettings {
  enabled: boolean;
  approvalMode: 'MANAGER' | 'AUTO';
  maxPerMonth: number | null;
  maxPerWeek: number | null;
  minNoticeDays: number;
  allowSameDay: boolean;
  allowHalfDay: boolean;
  requireCheckIn: boolean;
}
export interface WfhDayInfo { source: 'REQUEST' | 'SCHEDULE'; requestId: string | null; name: string; halfDay: boolean }
export interface WfhSchedule {
  id: string; userId: string | null; policyGroupId: string | null; weekdays: number[]; startDate: string; endDate: string | null; note: string | null;
  /** "Every Fri" */
  label: string;
  user?: { id: string; name: string } | null; policyGroup?: { id: string; name: string } | null;
  scope?: 'PERSON' | 'GROUP';
  exceptions: { id: string; userId: string | null; date: string; reason: string | null }[];
}
export interface WfhRequest {
  id: string; startDate: string; endDate: string; days: number | string; halfDay: boolean; halfDayPeriod: 'AM' | 'PM' | null; reason: string | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED'; rejectionReason: string | null; cancelReason: string | null; createdAt: string; decidedAt: string | null;
  leaveType: { id: string; name: string; color: string; isWfh: boolean }; decider: { id: string; name: string } | null;
}
export interface WfhSummary {
  userId: string;
  enabled: boolean;
  groupName: string;
  settings: WfhSettings;
  today: string;
  types: { id: string; name: string; color: string }[];
  defaultTypeId: string | null;
  usage: { refDay: string; month: { used: number; limit: number | null }; week: { used: number; limit: number | null } };
  todayWfh: WfhDayInfo | null;
  schedules: WfhSchedule[];
  requests: WfhRequest[];
}

export const useWfhSummary = (userId?: string, enabled = true) => useQuery<WfhSummary>({
  queryKey: ['wfh-summary', userId ?? 'me'],
  queryFn: () => api.get('/hr/leave/wfh/me', { params: { userId } }).then(r => r.data),
  enabled,
});

/** Everything a WFH change can affect on screen. */
function invalidateWfh(qc: ReturnType<typeof useQueryClient>) {
  for (const key of ['wfh-summary', 'wfh-schedules', 'leave-requests', 'attendance-register', 'attendance-me', 'attendance-today', 'attendance-audit']) qc.invalidateQueries({ queryKey: [key] });
}

export interface WfhRequestInput { startDate: string; endDate?: string; halfDay?: boolean; halfDayPeriod?: 'AM' | 'PM'; reason?: string; leaveTypeId?: string }
export function useRequestWfh() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (d: WfhRequestInput) => api.post<WfhRequest>('/hr/leave/wfh/requests', d).then(r => r.data), onSuccess: () => invalidateWfh(qc) });
}
/** The employee withdraws their own request (pending, or approved WFH that hasn't started). */
export function useCancelOwnRequest() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => api.post(`/hr/leave/requests/${id}/cancel`).then(r => r.data), onSuccess: () => invalidateWfh(qc) });
}

export const useWfhSchedules = (filter: { userId?: string; policyGroupId?: string }) => useQuery<WfhSchedule[]>({
  queryKey: ['wfh-schedules', filter.userId ?? '', filter.policyGroupId ?? ''],
  queryFn: () => api.get('/hr/leave/wfh/schedules', { params: filter }).then(r => r.data),
  enabled: !!(filter.userId || filter.policyGroupId),
});
export interface ScheduleInput { userId?: string; policyGroupId?: string; weekdays: number[]; startDate: string; endDate?: string | null; note?: string }
export function useSaveWfhSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...d }: ScheduleInput & { id?: string }) => (id ? api.patch(`/hr/leave/wfh/schedules/${id}`, d) : api.post('/hr/leave/wfh/schedules', d)).then(r => r.data),
    onSuccess: () => invalidateWfh(qc),
  });
}
export function useEndWfhSchedule() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => api.delete<{ ended: boolean }>(`/hr/leave/wfh/schedules/${id}`).then(r => r.data), onSuccess: () => invalidateWfh(qc) });
}
export function useSkipWfhDate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ scheduleId, ...d }: { scheduleId: string; date: string; userId?: string | null; reason?: string }) => api.post(`/hr/leave/wfh/schedules/${scheduleId}/exceptions`, d).then(r => r.data),
    onSuccess: () => invalidateWfh(qc),
  });
}
export function useUnskipWfhDate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ scheduleId, exceptionId }: { scheduleId: string; exceptionId: string }) => api.delete(`/hr/leave/wfh/schedules/${scheduleId}/exceptions/${exceptionId}`).then(r => r.data),
    onSuccess: () => invalidateWfh(qc),
  });
}

const fmt1 = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
/** "2 of 4 WFH days used this month (1 this week)" */
export function usageLine(u: WfhSummary['usage']): string {
  const month = u.month.limit != null ? `${fmt1(u.month.used)} of ${u.month.limit} WFH days used this month` : `${fmt1(u.month.used)} WFH day${u.month.used === 1 ? '' : 's'} this month (no monthly limit)`;
  const week = u.week.limit != null ? `${fmt1(u.week.used)} of ${u.week.limit} this week` : `${fmt1(u.week.used)} this week`;
  const reached = u.month.limit != null && u.month.used >= u.month.limit ? ' — monthly limit reached' : '';
  return `${month} (${week})${reached}`;
}

export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** Monday-first order for weekday pickers */
export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
