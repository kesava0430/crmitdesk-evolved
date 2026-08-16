import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

export interface StorageStatus {
  configured: boolean;
  connected: boolean;
  provider: string | null;
  connectedEmail: string | null;
  connectedAt: string | null;
  hosted: {
    available: boolean;
    quotaBytes: number;
    usedBytes: number;
  };
}

export function useStorageStatus() {
  return useQuery<StorageStatus>({
    queryKey: ['storage-status'],
    queryFn: () => api.get('/storage/status').then(r => r.data),
    // A 403 here is a permission answer, not a transient failure — retrying it
    // three times just delays the message the user needs to see.
    retry: (count, err: any) => (err?.response?.status === 403 ? false : count < 2),
  });
}

export function useConnectGoogleDrive() {
  return useMutation({
    mutationFn: () => api.get('/storage/google/connect').then(r => r.data),
    onSuccess: (data: { url: string }) => { window.location.href = data.url; },
  });
}

export function useConnectHostedStorage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post('/storage/hosted/connect').then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['storage-status'] }),
  });
}

export function useDisconnectStorage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete('/storage').then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['storage-status'] }),
  });
}
