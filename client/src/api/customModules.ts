import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

const unwrap = (r: any) => (Array.isArray(r.data) ? r.data : (r.data?.data ?? r.data));

// ─── Modules ─────────────────────────────────────────────────────────────────
export const useCustomModules = () =>
  useQuery({ queryKey: ['custom-modules'], queryFn: () => api.get('/custom-modules').then(r => r.data) });

export const useCustomModule = (id?: string) =>
  useQuery({ queryKey: ['custom-modules', id], queryFn: () => api.get(`/custom-modules/${id}`).then(r => r.data), enabled: !!id });

export const useCreateCustomModule = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (data: any) => api.post('/custom-modules', data).then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['custom-modules'] }) });
};
export const useUpdateCustomModule = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: ({ id, ...data }: any) => api.patch(`/custom-modules/${id}`, data).then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['custom-modules'] }) });
};
export const useDeleteCustomModule = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => api.delete(`/custom-modules/${id}`).then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['custom-modules'] }) });
};

// ─── Fields ──────────────────────────────────────────────────────────────────
export const useAddModuleField = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: ({ moduleId, ...data }: any) => api.post(`/custom-modules/${moduleId}/fields`, data).then(r => r.data),
    onSuccess: (_d, vars: any) => qc.invalidateQueries({ queryKey: ['custom-modules', vars.moduleId] }) });
};
export const useUpdateModuleField = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: ({ moduleId, fieldId, ...data }: any) => api.patch(`/custom-modules/${moduleId}/fields/${fieldId}`, data).then(r => r.data),
    onSuccess: (_d, vars: any) => qc.invalidateQueries({ queryKey: ['custom-modules', vars.moduleId] }) });
};
export const useRemoveModuleField = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: ({ moduleId, fieldId }: any) => api.delete(`/custom-modules/${moduleId}/fields/${fieldId}`).then(r => r.data),
    onSuccess: (_d, vars: any) => qc.invalidateQueries({ queryKey: ['custom-modules', vars.moduleId] }) });
};

// ─── Records ─────────────────────────────────────────────────────────────────
export const useModuleRecords = (moduleId?: string) =>
  useQuery({ queryKey: ['custom-module-records', moduleId], queryFn: () => api.get(`/custom-modules/${moduleId}/records`, { params: { limit: 100 } }).then(unwrap), enabled: !!moduleId });

export const useCreateModuleRecord = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: ({ moduleId, data }: any) => api.post(`/custom-modules/${moduleId}/records`, { data }).then(r => r.data),
    onSuccess: (_d, vars: any) => { qc.invalidateQueries({ queryKey: ['custom-module-records', vars.moduleId] }); qc.invalidateQueries({ queryKey: ['custom-modules'] }); } });
};
export const useUpdateModuleRecord = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: ({ moduleId, recordId, data }: any) => api.patch(`/custom-modules/${moduleId}/records/${recordId}`, { data }).then(r => r.data),
    onSuccess: (_d, vars: any) => qc.invalidateQueries({ queryKey: ['custom-module-records', vars.moduleId] }) });
};
export const useDeleteModuleRecord = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: ({ moduleId, recordId }: any) => api.delete(`/custom-modules/${moduleId}/records/${recordId}`).then(r => r.data),
    onSuccess: (_d, vars: any) => { qc.invalidateQueries({ queryKey: ['custom-module-records', vars.moduleId] }); qc.invalidateQueries({ queryKey: ['custom-modules'] }); } });
};

// ─── External sync ───────────────────────────────────────────────────────────
export const useSyncConfig = (moduleId?: string) =>
  useQuery({ queryKey: ['custom-module-sync', moduleId], queryFn: () => api.get(`/custom-modules/${moduleId}/sync`).then(r => r.data), enabled: !!moduleId });

export const useSaveSyncConfig = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: ({ moduleId, ...data }: any) => api.put(`/custom-modules/${moduleId}/sync`, data).then(r => r.data),
    onSuccess: (_d, vars: any) => qc.invalidateQueries({ queryKey: ['custom-module-sync', vars.moduleId] }) });
};
export const useDeleteSyncConfig = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (moduleId: string) => api.delete(`/custom-modules/${moduleId}/sync`).then(r => r.data),
    onSuccess: (_d, moduleId: string) => qc.invalidateQueries({ queryKey: ['custom-module-sync', moduleId] }) });
};
export const useTriggerSync = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (moduleId: string) => api.post(`/custom-modules/${moduleId}/sync/run`).then(r => r.data),
    onSuccess: (_d, moduleId: string) => { qc.invalidateQueries({ queryKey: ['custom-module-sync', moduleId] }); qc.invalidateQueries({ queryKey: ['custom-module-records', moduleId] }); } });
};
