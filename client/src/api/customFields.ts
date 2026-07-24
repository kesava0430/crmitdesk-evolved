import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

export interface CustomFieldDef {
  id: string;
  fieldKey: string;
  label: string;
  fieldType: 'TEXT' | 'NUMBER' | 'DATE' | 'SELECT' | 'BOOLEAN' | 'TEXTAREA';
  entityType: 'TICKET' | 'CONTACT' | 'DEAL' | 'LEAD';
  required: boolean;
  position: number;
  options: string[] | null;
}

export interface CustomFieldValueRecord {
  id: string;
  customFieldId: string;
  entityId: string;
  value: string | null;
  field: CustomFieldDef;
}

const unwrap = (r: any) => (Array.isArray(r.data) ? r.data : (r.data?.data ?? r.data));

/** Admin-defined field definitions for one entity type (TICKET/CONTACT/DEAL/LEAD). */
export const useCustomFieldDefs = (entityType: string) =>
  useQuery<CustomFieldDef[]>({
    queryKey: ['custom-fields', entityType],
    queryFn: () => api.get('/custom-fields', { params: { entityType } }).then(unwrap),
    enabled: !!entityType,
  });

/** Saved values for one specific entity record (a ticket, contact, deal or lead). */
export const useCustomFieldValues = (entityId?: string) =>
  useQuery<CustomFieldValueRecord[]>({
    queryKey: ['custom-field-values', entityId],
    queryFn: () => api.get(`/custom-fields/values/${entityId}`).then(unwrap),
    enabled: !!entityId,
  });

export const useSaveCustomFieldValues = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ entityId, values }: { entityId: string; values: { customFieldId: string; value: string | null }[] }) =>
      api.post(`/custom-fields/values/${entityId}`, { values }).then(r => r.data),
    onSuccess: (_data, { entityId }) => {
      qc.invalidateQueries({ queryKey: ['custom-field-values', entityId] });
    },
  });
};

/**
 * Converts a { [fieldKey]: rawValue } map (as edited in a form) into the
 * { customFieldId, value }[] payload the /values endpoint expects, using the
 * field definitions to look up each key's id and to stringify non-string
 * values (BOOLEAN/NUMBER) consistently.
 */
export function toValuesPayload(defs: CustomFieldDef[], formValues: Record<string, any>) {
  return defs
    .filter(d => formValues[d.fieldKey] !== undefined)
    .map(d => {
      const raw = formValues[d.fieldKey];
      const value = raw === '' || raw === null || raw === undefined ? null : String(raw);
      return { customFieldId: d.id, value };
    });
}

/** Builds the { [fieldKey]: value } map used as form state from saved value records. */
export function fromValueRecords(records: CustomFieldValueRecord[] | undefined) {
  const out: Record<string, string> = {};
  (records ?? []).forEach(r => {
    if (r.field?.fieldKey) out[r.field.fieldKey] = r.value ?? '';
  });
  return out;
}
