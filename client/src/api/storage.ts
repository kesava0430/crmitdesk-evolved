import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

export interface StorageStatus {
  configured: boolean;
  connected: boolean;
  provider: string | null;
  connectedEmail: string | null;
  connectedAt: string | null;
}

export function useStorageStatus() {
  return useQuery<StorageStatus>({
    queryKey: ['storage-status'],
    queryFn: () => api.get('/storage/status').then(r => r.data),
  });
}

export function useConnectGoogleDrive() {
  return useMutation({
    mutationFn: () => api.get('/storage/google/connect').then(r => r.data),
    onSuccess: (data: { url: string }) => { window.location.href = data.url; },
  });
}

export function useDisconnectStorage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete('/storage').then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['storage-status'] }),
  });
}
