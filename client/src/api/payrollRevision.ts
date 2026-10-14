// Rerun / reopen / revise payroll runs — see server payrollRevision.controller.ts.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

export interface Delta { old: number | null; new: number | null; delta: number }
export interface LineChange { code: string; name: string; category: string; old: number | null; new: number | null; delta: number }
export interface SlipDiff { gross: Delta; deductions: Delta; net: Delta; paidDays: Delta | null; lopDays: Delta | null; lines: LineChange[]; changed: boolean }
export interface ChangeEntry { userId: string; name: string; payslipId: string | null; kind: 'UPDATED' | 'ADDED' | 'REMOVED'; diff: SlipDiff; adjustmentsKept?: number; adjustmentsDropped?: string[] }
export interface RerunOptions { userIds?: string[]; keepAdjustments: boolean; includeNewEmployees: boolean; removeWithoutSalary: boolean }
export interface RerunSummary {
  options: RerunOptions & { refreshAttendance: true; userIds: string[] | null };
  entries: ChangeEntry[];
  added: { userId: string; name: string }[];
  removed: { userId: string; name: string; reason: string }[];
  skipped: { userId: string; name: string; reason: string }[];
  changedCount: number; unchangedCount: number;
  totals: { gross: number; deductions: number; net: number };
}

export interface SettlementRow {
  userId: string; name: string; payslipId: string | null; paidNet: number | null; newNet: number | null; difference: number;
  kind: 'ARREARS' | 'RECOVERY' | 'NONE' | 'NOT_PAID_BEFORE' | 'REMOVED'; settled: boolean; settledAt: string | null;
}
export interface Settlement {
  applicable: boolean; rows: SettlementRow[];
  totals: { arrears: number; recovery: number; net: number; pendingArrears: number; pendingRecovery: number; pendingCount: number };
}
export interface VersionEntry {
  version: number; issuedAt: string | null; issuedBy: string | null; issuedByName: string | null;
  reopenedAt: string | null; reopenedBy: string | null; reopenedByName: string | null; reason: string | null;
  payslipCount: number; current: boolean; status: string | null;
}
export interface LaterRun { id: string; month: number; year: number; status: string; periodStart: string | null; cycleName: string | null }
export interface RunHistory {
  versions: VersionEntry[]; reopened: boolean; locked: boolean; settlement: Settlement;
  laterFinalisedRuns: LaterRun[]; revisedEmailedBefore: number; revisionCounts: Record<string, number>;
}
export interface SlipFigures {
  gross: number; deductions: number; net: number; reimbursements: number; employer: number;
  workingDays: number | null; paidDays: number | null; lopDays: number | null;
  lines: { code: string; name: string; category: string; amount: number }[];
}
export interface CompareResult {
  payslip: { id: string; userId: string; name: string; payslipNumber: string; version: number; status: string; revisedAt: string | null; paidDifference: number | null };
  current: SlipFigures;
  versions: { version: number; runVersion: number; issuedAt: string | null; status: string; paidAt: string | null; paidNet: number | null; reason: string; reopenedAt: string; figures: SlipFigures; diffToNext: SlipDiff; diffToCurrent: SlipDiff }[];
}

const invalidate = (qc: ReturnType<typeof useQueryClient>, runId: string) => {
  qc.invalidateQueries({ queryKey: ['payroll-runs'] });
  qc.invalidateQueries({ queryKey: ['payroll-run', runId] });
  qc.invalidateQueries({ queryKey: ['payroll-run-history', runId] });
};

export const useRunHistory = (runId: string) =>
  useQuery<RunHistory>({ queryKey: ['payroll-run-history', runId], queryFn: () => api.get(`/hr/payroll/runs/${runId}/history`).then(r => r.data) });

export function useRerun(runId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (o: RerunOptions) => api.post(`/hr/payroll/runs/${runId}/rerun`, o).then(r => r.data as { summary: RerunSummary }),
    onSuccess: () => invalidate(qc, runId),
  });
}

export function useReopen(runId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { reason: string; acknowledgePaid?: boolean }) => api.post(`/hr/payroll/runs/${runId}/reopen`, b).then(r => r.data as { reopened: { fromStatus: string; laterFinalisedRuns: LaterRun[] } }),
    onSuccess: () => invalidate(qc, runId),
  });
}

export function useFinalize(runId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { repinTemplate?: boolean }) => api.post(`/hr/payroll/runs/${runId}/finalize`, b).then(r => r.data as { refinalize?: { revised: number; unchanged: number; first: number; revisedEmailedBefore: number; settlement: Settlement | null } }),
    onSuccess: () => invalidate(qc, runId),
  });
}

export const useComparePayslip = (runId: string, payslipId: string | null) =>
  useQuery<CompareResult>({ queryKey: ['payslip-compare', runId, payslipId], enabled: !!payslipId, queryFn: () => api.get(`/hr/payroll/runs/${runId}/payslips/${payslipId}/compare`).then(r => r.data) });

export function useEmailRevised(runId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post(`/hr/payroll/runs/${runId}/email`, { onlyRevised: true }).then(r => r.data as { sent: number; skipped: number; failed: { id: string; reason?: string }[] }),
    onSuccess: () => invalidate(qc, runId),
  });
}
