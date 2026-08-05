import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

// ─── Types ────────────────────────────────────────────────────────────────────

export type Channel = 'EMAIL' | 'WHATSAPP' | 'CHAT';
export type ConvStatus = 'OPEN' | 'CLOSED' | 'PENDING';

export interface Message {
  id: string;
  conversationId: string;
  direction: 'INBOUND' | 'OUTBOUND';
  fromAddress: string;
  toAddress: string;
  body: string;
  htmlBody?: string | null;
  externalId?: string | null;
  readAt?: string | null;
  sentAt: string;
}

export interface Conversation {
  id: string;
  orgId: string;
  channel: Channel;
  contactName: string;
  contactEmail?: string | null;
  contactPhone?: string | null;
  subject?: string | null;
  status: ConvStatus;
  assignedTo?: string | null;
  lastMessageAt?: string | null;
  unreadCount: number;
  createdAt: string;
  updatedAt: string;
  assignee?: { id: string; name: string; avatarUrl?: string | null } | null;
  messages?: Message[];
}

export interface InboxSettings {
  emailAccount: {
    id: string;
    email: string;
    imapHost: string;
    imapPort: number;
    smtpHost: string;
    smtpPort: number;
    lastSyncAt?: string | null;
  } | null;
  whatsAppConfig: {
    id: string;
    accountSid: string;
    phoneNumber: string;
    notifyNumber?: string | null;
  } | null;
}

// ─── Conversations ────────────────────────────────────────────────────────────

export function useConversations(params?: { channel?: Channel; status?: string }) {
  const query = new URLSearchParams();
  if (params?.channel) query.set('channel', params.channel);
  if (params?.status) query.set('status', params.status);

  return useQuery<{ data: Conversation[]; total: number }>({
    queryKey: ['conversations', params],
    queryFn: () => api.get(`/inbox/conversations?${query}`).then(r => r.data),
    refetchInterval: 30_000, // poll every 30s for new messages
  });
}

export function useConversation(id: string | null) {
  return useQuery<Conversation>({
    queryKey: ['conversation', id],
    queryFn: () => api.get(`/inbox/conversations/${id}`).then(r => r.data),
    enabled: !!id,
  });
}

export function useUpdateConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string; status?: ConvStatus; assignedTo?: string | null }) =>
      api.patch(`/inbox/conversations/${id}`, data).then(r => r.data),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['conversations'] });
      qc.invalidateQueries({ queryKey: ['conversation', vars.id] });
    },
  });
}

// ─── Reply ────────────────────────────────────────────────────────────────────

export function useSendReply() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ conversationId, body }: { conversationId: string; body: string }) =>
      api.post(`/inbox/conversations/${conversationId}/reply`, { body }).then(r => r.data),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['conversation', vars.conversationId] });
      qc.invalidateQueries({ queryKey: ['conversations'] });
    },
  });
}

// ─── Settings ─────────────────────────────────────────────────────────────────

export function useInboxSettings() {
  return useQuery<InboxSettings>({
    queryKey: ['inbox-settings'],
    queryFn: () => api.get('/inbox/settings').then(r => r.data),
  });
}

export function useConnectEmail() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      email: string; password: string;
      imapHost: string; imapPort: number;
      smtpHost: string; smtpPort: number;
    }) => api.post('/inbox/settings/email', data).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['inbox-settings'] });
      qc.invalidateQueries({ queryKey: ['conversations'] });
    },
  });
}

export function useDisconnectEmail() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete('/inbox/settings/email').then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inbox-settings'] }),
  });
}

export function useConnectWhatsApp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { accountSid: string; authToken: string; phoneNumber: string; notifyNumber?: string }) =>
      api.post('/inbox/settings/whatsapp', data).then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inbox-settings'] }),
  });
}

export function useDisconnectWhatsApp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete('/inbox/settings/whatsapp').then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inbox-settings'] }),
  });
}

export function useTriggerSync() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post('/inbox/sync').then(r => r.data),
    onSuccess: () => {
      setTimeout(() => qc.invalidateQueries({ queryKey: ['conversations'] }), 3000);
    },
  });
}
