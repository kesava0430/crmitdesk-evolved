import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

export interface Condition {
  field: string;
  operator: 'eq' | 'neq' | 'gt' | 'lt' | 'contains' | 'in';
  value: string | number | string[];
}

export interface Action {
  type: 'ASSIGN_TO' | 'SET_PRIORITY' | 'SET_STATUS' | 'SEND_EMAIL' | 'SEND_WHATSAPP' | 'ADD_NOTE' | 'SEND_WEBHOOK' | 'SCORE_LEAD';
  params: Record<string, string | number>;
}

export interface WorkflowRule {
  id: string;
  name: string;
  description?: string;
  trigger: string;
  conditions: Condition[];
  actions: Action[];
  isActive: boolean;
  runCount: number;
  createdAt: string;
  _count?: { logs: number };
}

export interface WorkflowLog {
  id: string;
  ruleId: string;
  entityType: string;
  entityId: string;
  result: 'SUCCESS' | 'SKIPPED' | 'ERROR';
  detail?: string;
  createdAt: string;
}

export function useWorkflows() {
  return useQuery<WorkflowRule[]>({ queryKey: ['workflows'], queryFn: () => api.get('/workflows').then(r => r.data) });
}

export function useWorkflowLogs(ruleId: string | null) {
  return useQuery<WorkflowLog[]>({
    queryKey: ['workflow-logs', ruleId],
    queryFn: () => api.get(`/workflows/${ruleId}/logs`).then(r => r.data),
    enabled: !!ruleId,
  });
}

export function useCreateWorkflow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Omit<WorkflowRule, 'id' | 'createdAt' | 'runCount' | '_count'>) =>
      api.post('/workflows', data).then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workflows'] }),
  });
}

export function useUpdateWorkflow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: Partial<WorkflowRule> & { id: string }) =>
      api.put(`/workflows/${id}`, data).then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workflows'] }),
  });
}

export function useDeleteWorkflow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/workflows/${id}`).then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workflows'] }),
  });
}

export function useToggleWorkflow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.patch(`/workflows/${id}/toggle`).then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workflows'] }),
  });
}
