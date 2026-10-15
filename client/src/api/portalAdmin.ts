import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import { publicAppRoot } from '../shared/appUrl';

export interface PortalUser {
  id: string;
  name: string;
  email: string;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  orgId: string;
}

// IT_MANAGERS-only on the server. Callers pass `can.readPortalUsers(role)`.
export function usePortalUsers(enabled = true) {
  return useQuery<PortalUser[]>({ queryKey: ['portal-users'], queryFn: () => api.get('/portal-users').then(r => r.data), enabled });
}

export function useCreatePortalUser() {
  const qc = useQueryClient();
  return useMutation({
    // appBase: this page's public root, so the emailed link matches the one on
    // screen even when the server's FRONTEND_URL lacks the /zenkara base.
    mutationFn: (data: { name: string; email: string; sendInvite?: boolean }) => api.post('/portal-users', { ...data, appBase: publicAppRoot() }).then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['portal-users'] }),
  });
}

export function useTogglePortalUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.patch(`/portal-users/${id}/toggle`).then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['portal-users'] }),
  });
}

export function useDeletePortalUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/portal-users/${id}`).then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['portal-users'] }),
  });
}

export function useResendPortalInvite() {
  return useMutation({
    mutationFn: (id: string) => api.post(`/portal-users/${id}/resend-invite`, { appBase: publicAppRoot() }).then(r => r.data),
  });
}
