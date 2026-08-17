import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

const unwrap = (r: any) => (Array.isArray(r.data) ? r.data : (r.data?.data ?? r.data));

// ─── Modules ─────────────────────────────────────────────────────────────────
/**
 * `enabled` exists because the app shell calls this on every page, to build the
 * sidebar's per-module links. GET /custom-modules is ALL_STAFF, so for an
 * EMPLOYEE it returned 403 on every single navigation. Callers in the shell
 * pass `can.readStaffRecords(role)` rather than firing a request whose answer
 * is already known — an EMPLOYEE cannot read module records either, so there
 * is no link to draw for them in the first place.
 */
export const useCustomModules = (enabled = true) =>
  useQuery({
    queryKey: ['custom-modules'],
    queryFn: () => api.get('/custom-modules').then(r => r.data),
    enabled,
  });

export const useCustomModule = (id?: string, enabled = true) =>
  useQuery({ queryKey: ['custom-modules', id], queryFn: () => api.get(`/custom-modules/${id}`).then(r => r.data), enabled: enabled && !!id });

/** Templates are CRM_MANAGERS on the server, unlike the module list itself
 *  (ALL_STAFF) — callers pass `can.readCrmReports(role)`. */
export const useModuleTemplates = (enabled = true) =>
  useQuery({ queryKey: ['custom-module-templates'], queryFn: () => api.get('/custom-modules/templates').then(r => r.data), staleTime: Infinity, enabled });

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
// Field add/remove change a module's field COUNT, which the sidebar's nav
// injection (AppLayout.tsx) reads off the *list* query (['custom-modules'])
// to decide whether a module is visible yet — invalidating only the single-
// module detail query (['custom-modules', moduleId]) left that list stale,
// so a module could sit with 1+ fields and still never appear in the sidebar
// until something else happened to refetch the list. Update doesn't change
// the count, so it only needs the detail invalidation.
export const useAddModuleField = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: ({ moduleId, ...data }: any) => api.post(`/custom-modules/${moduleId}/fields`, data).then(r => r.data),
    onSuccess: (_d, vars: any) => { qc.invalidateQueries({ queryKey: ['custom-modules', vars.moduleId] }); qc.invalidateQueries({ queryKey: ['custom-modules'], exact: true }); } });
};
export const useUpdateModuleField = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: ({ moduleId, fieldId, ...data }: any) => api.patch(`/custom-modules/${moduleId}/fields/${fieldId}`, data).then(r => r.data),
    onSuccess: (_d, vars: any) => qc.invalidateQueries({ queryKey: ['custom-modules', vars.moduleId] }) });
};
export const useRemoveModuleField = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: ({ moduleId, fieldId }: any) => api.delete(`/custom-modules/${moduleId}/fields/${fieldId}`).then(r => r.data),
    onSuccess: (_d, vars: any) => { qc.invalidateQueries({ queryKey: ['custom-modules', vars.moduleId] }); qc.invalidateQueries({ queryKey: ['custom-modules'], exact: true }); } });
};

// ─── Records ─────────────────────────────────────────────────────────────────
// ALL_STAFF-only on the server — callers pass `can.readStaffRecords(role)`.
export const useModuleRecords = (moduleId?: string, enabled = true) =>
  useQuery({ queryKey: ['custom-module-records', moduleId], queryFn: () => api.get(`/custom-modules/${moduleId}/records`, { params: { limit: 100 } }).then(unwrap), enabled: !!moduleId && enabled });

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
/** GET /custom-modules/:id/sync is CRM_MANAGERS — callers pass `can.readCrmReports(role)`. */
export const useSyncConfig = (moduleId?: string, enabled = true) =>
  useQuery({ queryKey: ['custom-module-sync', moduleId], queryFn: () => api.get(`/custom-modules/${moduleId}/sync`).then(r => r.data), enabled: enabled && !!moduleId });

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
