import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

/**
 * CRM follow-ups (server: utils/followups, /crm/followups, /ai/*follow-up, /ai/crm/next-step).
 * Status rides on every lead/deal list row as `followUp`; see FollowUpStatusIcon.
 */

export type FollowUpStatus = 'OVERDUE' | 'TODAY' | 'UPCOMING' | 'UNDATED' | 'NONE';
export interface FollowUpRef {
  id: string; source: 'ACTIVITY' | 'TASK'; type: string; title: string;
  dueAt: string | null; dateOnly: boolean; days: number | null;
}
export interface FollowUpSummary {
  status: FollowUpStatus; overdue: number; today: number; upcoming: number; undated: number;
  focus: FollowUpRef | null; next: FollowUpRef | null; label: string;
}
export interface MyFollowUp extends FollowUpRef {
  dueAt: string; status: 'OVERDUE' | 'TODAY'; days: number; label: string;
  record: { kind: 'LEAD' | 'DEAL' | 'CONTACT'; id: string; name: string };
}

export const useMyFollowUps = (enabled = true) =>
  useQuery({
    queryKey: ['followups', 'mine'],
    queryFn: () => api.get('/crm/followups/mine').then(r => r.data as { items: MyFollowUp[]; overdue: number; today: number; timezone: string }),
    enabled,
    refetchInterval: 5 * 60_000,
  });

/** Everything that shows follow-up state: lists, board, My Work, a lead's own list. */
export function invalidateFollowUps(qc: ReturnType<typeof useQueryClient>) {
  for (const key of ['followups', 'leads', 'deals', 'pipeline', 'activities', 'tasks', 'my-work']) qc.invalidateQueries({ queryKey: [key] });
}

export const useSnoozeFollowUp = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { source: 'ACTIVITY' | 'TASK'; id: string; preset: '1h' | '3h' | 'tomorrow' | 'custom'; until?: string }) =>
      api.post('/crm/followups/snooze', b).then(r => r.data as { dueAt: string }),
    onSuccess: () => invalidateFollowUps(qc),
  });
};

/** Done goes through the record's normal API, so workflows/recurrence behave as anywhere else. */
export const useCompleteFollowUp = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (f: { source: 'ACTIVITY' | 'TASK'; id: string }) =>
      f.source === 'ACTIVITY'
        ? api.patch(`/crm/activities/${f.id}`, { done: true }).then(r => r.data)
        : api.patch(`/tasks/${f.id}`, { status: 'DONE' }).then(r => r.data),
    onSuccess: () => invalidateFollowUps(qc),
  });
};

export interface FollowUpPrefs { whatsapp: boolean; digest: boolean; whatsappAvailable: boolean; whatsappHint: string | null; whatsappActive: boolean }
export const useFollowUpPrefs = (enabled = true) =>
  useQuery({ queryKey: ['followups', 'prefs'], queryFn: () => api.get('/crm/followups/prefs').then(r => r.data as FollowUpPrefs), enabled });
export const useSaveFollowUpPrefs = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { whatsapp?: boolean; digest?: boolean }) => api.put('/crm/followups/prefs', b).then(r => r.data as FollowUpPrefs),
    onSuccess: d => qc.setQueryData(['followups', 'prefs'], d),
  });
};

// ─── Email ──────────────────────────────────────────────────────────────────

export type RecordKind = 'LEAD' | 'DEAL';
export interface FactFlag { kind: string; text: string; message: string }
export interface EmailDraft {
  subject: string; body: string; flags: FactFlag[];
  basedOn: { notes: number; notesAvailable: number; planned: number; quote: boolean; lessons: number };
  estTokens: number; cached: boolean; generatedAt: string;
}
export interface DraftOptions { purpose: string; tone: string; language: string; refresh?: boolean }

export const useDraftFollowUpEmail = (kind: RecordKind) =>
  useMutation({
    mutationFn: ({ id, ...opts }: DraftOptions & { id: string }) =>
      api.post(`/ai/${kind === 'LEAD' ? 'lead' : 'deal'}/${id}/follow-up`, opts).then(r => r.data as EmailDraft),
  });

export const useEmailChannel = (kind: RecordKind, id: string, enabled = true) =>
  useQuery({
    queryKey: ['followups', 'email-channel', kind, id],
    queryFn: () => api.get('/crm/followups/email-channel', { params: { entityType: kind, entityId: id } })
      .then(r => r.data as { to: string | null; toName: string; canSend: boolean; via: 'ORG_MAILBOX' | 'PLATFORM'; mailbox: string | null; replyTracking: boolean }),
    enabled: enabled && !!id,
  });

export const useCheckEmail = () =>
  useMutation({
    mutationFn: (b: { entityType: RecordKind; entityId: string; subject: string; body: string }) =>
      api.post('/crm/followups/check', b).then(r => r.data as { flags: FactFlag[] }),
  });

export const useSendFollowUpEmail = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { entityType: RecordKind; entityId: string; subject: string; body: string; aiDraft?: boolean; unverified?: string[] }) =>
      api.post('/crm/followups/send', { ...b, confirm: true }).then(r => r.data as { sent: boolean; via: string; message: string; replyTracking: boolean }),
    onSuccess: (_d, v) => {
      invalidateFollowUps(qc);
      qc.invalidateQueries({ queryKey: [v.entityType === 'LEAD' ? 'leads' : 'deals', v.entityId] });
    },
  });
};

// ─── Next step ──────────────────────────────────────────────────────────────

export interface NextStepSuggestion { type: 'CALL' | 'EMAIL' | 'MEETING' | 'TASK'; title: string; dueAt: string; dueLabel: string; defaulted: boolean; reason: string }
export const useNextStep = () =>
  useMutation({
    mutationFn: (b: { entityType: RecordKind; entityId: string; auto?: boolean }) =>
      api.post('/ai/crm/next-step', b).then(r => r.data as { suggestion: NextStepSuggestion | null; cached: boolean; stale?: boolean; retryInSeconds?: number }),
  });
