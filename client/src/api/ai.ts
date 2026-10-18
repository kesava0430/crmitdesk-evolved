import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { AskAnswer } from './analytics';

export const useScoreLead = () =>
  useMutation({
    mutationFn: (id: string) => api.post(`/ai/lead/${id}/score`).then(r => r.data as { score: number; reason: string }),
  });

export const useLeadFollowUp = () =>
  useMutation({
    mutationFn: (id: string) => api.post(`/ai/lead/${id}/follow-up`).then(r => r.data as { subject: string; body: string }),
  });

export const useDealFollowUp = () =>
  useMutation({
    mutationFn: (id: string) => api.post(`/ai/deal/${id}/follow-up`).then(r => r.data as { subject: string; body: string }),
  });

export const useTicketSentiment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/ai/ticket/${id}/sentiment`).then(r => r.data as { sentiment: string }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tickets'] }),
  });
};

export const useTicketReply = () =>
  useMutation({
    mutationFn: (id: string) => api.post(`/ai/ticket/${id}/reply`).then(r => r.data as { reply: string }),
  });

export const useNLQuery = () =>
  useMutation({
    mutationFn: (question: string) => api.post('/ai/query', { question }).then(r => r.data as AskAnswer),
  });

export const useKbArticle = () =>
  useMutation({ mutationFn: (id: string) => api.post(`/ai/ticket/${id}/kb-article`).then(r => r.data as { title: string; body: string }) });

export const useInvoiceReminder = () =>
  useMutation({ mutationFn: (id: string) => api.post(`/ai/invoice/${id}/reminder`).then(r => r.data as { subject: string; body: string }) });

export const useDetectDuplicates = () =>
  useMutation({ mutationFn: (data: { title: string; body?: string }) => api.post('/ai/ticket/check-duplicate', data).then(r => r.data as { duplicates: Array<{ id: string; title: string; confidence: number; reason: string }> }) });

export const useSummarizeThread = () =>
  useMutation({ mutationFn: (id: string) => api.post(`/ai/ticket/${id}/summarize`).then(r => r.data as { summary: string }) });

export const useEstimateResolution = () =>
  useMutation({ mutationFn: (id: string) => api.post(`/ai/ticket/${id}/estimate`).then(r => r.data as { hours: number; label: string; reason: string }) });

export const useSlaRisk = () =>
  useMutation({ mutationFn: (id: string) => api.post(`/ai/ticket/${id}/sla-risk`).then(r => r.data as { risk: string; score: number; reason: string }) });

export const useWinProbability = () =>
  useMutation({ mutationFn: (id: string) => api.post(`/ai/deal/${id}/win-probability`).then(r => r.data as { probability: number; factors: string[]; recommendation: string }) });

export const usePipelineHealth = () =>
  useMutation({ mutationFn: () => api.post('/ai/pipeline/health').then(r => r.data as { summary: string; risks: string[]; opportunities: string[] }) });

export const useChurnRisk = () =>
  useMutation({ mutationFn: (id: string) => api.post(`/ai/contact/${id}/churn-risk`).then(r => r.data as { risk: string; score: number; reason: string }) });

export const useNurtureSequence = () =>
  useMutation({ mutationFn: (id: string) => api.post(`/ai/lead/${id}/nurture-sequence`).then(r => r.data as { sequence: Array<{ day: number; subject: string; body: string }> }) });

export const useMeetingNotes = () =>
  useMutation({ mutationFn: (notes: string) => api.post('/ai/meeting-notes', { notes }).then(r => r.data) });

export const useAiInsights = () =>
  useMutation({ mutationFn: () => api.post('/ai/insights').then(r => r.data as { insights: Array<{ type: string; title: string; description: string; action?: string }> }) });

export const useToneCheck = () =>
  useMutation({ mutationFn: (data: { subject: string; body: string; context?: string }) => api.post('/ai/tone-check', data).then(r => r.data) });

export const useNlCommand = () =>
  useMutation({ mutationFn: (command: string) => api.post('/ai/command', { command }).then(r => r.data as { intent: string; entity: string; fields: Record<string, any>; confidence: number; explanation: string }) });

// ─── AI Actions (whitelisted "do it for me" commands) ─────────────────────────
// A command becomes an ordered plan (one or more steps) that the user confirms
// on one card; the server re-validates everything on execute. Shapes mirror
// server/src/utils/aiActions/planner.ts and executor.ts.

export type AiRisk = 'low' | 'medium' | 'high';

export interface AiPlanCandidate { id: string; label: string; hint?: string }
export interface AiPlanAmbiguity { param: string; query: string; entity: string; noun: string; candidates: AiPlanCandidate[] }
export interface AiPlanChange { field: string; before?: string | null; after: string | null }
export interface AiPlanStep {
  index: number;
  action: string;
  label: string;
  category: string;
  params: Record<string, any>;
  risk: AiRisk;
  allowed: boolean;
  blockedReason?: string;
  errors: string[];
  needs: AiPlanAmbiguity[];
  warnings: string[];
  preview: { title: string; changes: AiPlanChange[]; notes?: string[]; target?: { type: string; id: string; label: string; link?: string } };
  dependsOn: number[];
}

export interface AiActionPlan {
  planId?: string;
  interactionLogId?: string | null;
  steps?: AiPlanStep[];
  risk?: AiRisk;
  requiresSecondConfirmation?: boolean;
  ready?: boolean;
  repaired?: boolean;
  // First step, as older single-action responses had it.
  action: string | null;
  label?: string;
  params: Record<string, any>;
  confidence: number;
  explanation: string;
  allowed: boolean;
  requiresConfirmation: boolean;
}

export interface AiStepReport {
  index: number;
  action: string;
  label: string;
  status: 'done' | 'failed' | 'skipped';
  summary?: string;
  error?: string;
  output?: { id?: string; type?: string; label?: string; link?: string };
}
export interface AiExecutionReport {
  ok: boolean;
  planId: string;
  summary: string;
  completed: number;
  failedAt: number | null;
  steps: AiStepReport[];
}

// "What can I say" help panel data — no LLM call, safe to cache for the
// whole session (staleTime: Infinity). Filtered server-side by role,
// permissions and the org's areas, so it only lists what this user can run.
export interface AiActionMenuItem {
  name: string;
  label: string;
  description: string;
  example: string;
  category?: string;
  risk?: AiRisk | 'varies';
}
export interface AiActionMenu {
  actions: AiActionMenuItem[];
  legacy: Array<{ entity: string; label: string; example: string }>;
}
export const useAiActionsMenu = (enabled = true) =>
  useQuery({ queryKey: ['ai-actions-menu'], queryFn: () => api.get('/ai/actions').then(r => r.data as AiActionMenu), staleTime: Infinity, enabled });

export const usePlanAiAction = () =>
  useMutation({
    mutationFn: (command: string) => api.post('/ai/actions/plan', { command }).then(r => r.data as AiActionPlan),
  });

/** Re-validates a plan after the user picked a candidate (no AI call). */
export const useReviewAiPlan = () =>
  useMutation({
    mutationFn: (data: { steps: Array<{ action: string; params: Record<string, any> }>; planId?: string; interactionLogId?: string | null; explanation?: string; confidence?: number }) =>
      api.post('/ai/actions/review', data).then(r => r.data as AiActionPlan),
  });

/** Runs a confirmed plan; answers with a per-step report (also when a step fails). */
export const useExecuteAiPlan = () =>
  useMutation({
    mutationFn: (data: { steps: Array<{ action: string; params: Record<string, any> }>; planId?: string; interactionLogId?: string | null; confirmHighRisk?: boolean; idempotencyKey: string; command?: string }) =>
      api.post('/ai/actions/execute', data).then(r => r.data as AiExecutionReport),
  });

// AI Feature Builder hooks
/** GET /ai/rules is MANAGERS-only — callers pass `can.readAiConfig(role)`. */
export function useAIRules(enabled = true) {
  return useQuery({ queryKey: ['ai-rules'], queryFn: () => api.get('/ai/rules').then(r => r.data), enabled });
}

export function useCreateAIRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: any) => api.post('/ai/rules', data).then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ai-rules'] }),
  });
}

export function useUpdateAIRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: any) => api.patch(`/ai/rules/${id}`, data).then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ai-rules'] }),
  });
}

export function useDeleteAIRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/ai/rules/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ai-rules'] }),
  });
}

export function useRunAIRule() {
  return useMutation({
    mutationFn: ({ id, ...data }: any) => api.post(`/ai/rules/${id}/run`, data).then(r => r.data),
  });
}

export function useBulkScoreLeads() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post('/ai/leads/bulk-score').then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['leads'] }),
  });
}
