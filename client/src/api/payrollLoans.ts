import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

// Employee loans & salary advances (server: modules/hr/payroll/loans.controller.ts).

export type LoanStatus = 'ACTIVE' | 'CLOSED' | 'CANCELLED';
export type LedgerType = 'RECOVERY' | 'REPAYMENT' | 'WAIVER' | 'SKIP';
export interface LedgerRow {
  id: string; type: LedgerType; amount: number; month: number; year: number; entryDate: string; note: string | null;
  payslipId: string | null; payslipNumber: string | null; payslipStatus: string | null; balance: number;
}
export interface Loan {
  id: string; userId: string; name: string; type: 'LOAN' | 'ADVANCE'; status: LoanStatus;
  principal: number; interestRate: number | null; interestAmount: number; totalRepayable: number; emiAmount: number; instalments: number;
  disbursedOn: string; startMonth: number; startYear: number; notes: string | null; closeReason: string | null; closedAt: string | null; createdAt: string;
  recovered: number; pending: number; waived: number; outstanding: number; emisRecovered: number;
  skippedMonths: { id: string; year: number; month: number; note: string | null }[];
  user?: { id: string; name: string; email: string; department?: string | null };
  ledger?: LedgerRow[];
  schedule?: { year: number; month: number; amount: number; balanceAfter: number }[];
  notice?: string;
}
export interface LoanSummaryRow { loanId: string; name: string; type: string; principal: number; totalRepayable: number; recoveredThisPeriod: number; totalRecovered: number; outstanding: number; emiLabel: string | null }

export const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const ymLabel = (year: number, month: number) => `${MONTHS_SHORT[month - 1]} ${year}`;

export function useLoans(status?: string) {
  return useQuery<Loan[]>({ queryKey: ['payroll-loans', status ?? 'all'], queryFn: () => api.get('/hr/payroll/loans', { params: status ? { status } : {} }).then(r => r.data) });
}
export function useMyLoans() {
  return useQuery<Loan[]>({ queryKey: ['payroll-loans', 'mine'], queryFn: () => api.get('/hr/payroll/loans/mine').then(r => r.data) });
}
export function useLoan(id: string | null) {
  return useQuery<Loan>({ queryKey: ['payroll-loan', id], enabled: !!id, queryFn: () => api.get(`/hr/payroll/loans/${id}`).then(r => r.data) });
}

function useLoanMutation<V>(fn: (v: V) => Promise<Loan>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (loan: Loan) => {
      qc.invalidateQueries({ queryKey: ['payroll-loans'] });
      qc.setQueryData(['payroll-loan', loan.id], loan);
    },
  });
}

export interface NewLoan {
  userId: string; name: string; type: 'LOAN' | 'ADVANCE'; principal: number; interestRate?: number | null;
  instalments?: number | null; emiAmount?: number | null; disbursedOn: string; startMonth: number; startYear: number; notes?: string | null;
}
export const useCreateLoan = () => useLoanMutation((v: NewLoan) => api.post('/hr/payroll/loans', v).then(r => r.data));
export const useUpdateLoan = (id: string) => useLoanMutation((v: { name?: string; notes?: string | null; emiAmount?: number; startMonth?: number; startYear?: number }) => api.patch(`/hr/payroll/loans/${id}`, v).then(r => r.data));
export const useSkipMonth = (id: string) => useLoanMutation((v: { month: number; year: number; note?: string }) => api.post(`/hr/payroll/loans/${id}/skip`, v).then(r => r.data));
export const useUnskipMonth = (id: string) => useLoanMutation((entryId: string) => api.delete(`/hr/payroll/loans/${id}/skip/${entryId}`).then(r => r.data));
export const useRepayment = (id: string) => useLoanMutation((v: { amount: number; date: string; note?: string }) => api.post(`/hr/payroll/loans/${id}/repayment`, v).then(r => r.data));
export const useCloseLoan = (id: string) => useLoanMutation((v: { reason: string; waiveRemaining: boolean }) => api.post(`/hr/payroll/loans/${id}/close`, v).then(r => r.data));
export const useCancelLoan = (id: string) => useLoanMutation((v: { reason: string }) => api.post(`/hr/payroll/loans/${id}/cancel`, v).then(r => r.data));

/** Same rule as the server (utils/payrollLoans.ts planLoan) — for the live preview in the form. */
export function previewPlan(principal: number, rate: number, mode: 'instalments' | 'emi', value: number) {
  if (!(principal > 0) || !(value > 0)) return null;
  const flat = (m: number) => Math.round(principal * rate / 100 * m / 12 * 100) / 100;
  if (mode === 'instalments') {
    const n = Math.floor(value), interest = flat(n), total = Math.round((principal + interest) * 100) / 100;
    return { instalments: n, emi: Math.ceil(total / n * 100) / 100, interest, total };
  }
  const n0 = Math.ceil(principal / value), interest = flat(n0), total = Math.round((principal + interest) * 100) / 100;
  return { instalments: Math.ceil(Math.round(total / value * 100) / 100), emi: value, interest, total };
}
