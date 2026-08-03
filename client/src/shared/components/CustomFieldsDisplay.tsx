import { useCustomFieldDefs, useCustomFieldValues, fromValueRecords } from '../../api/customFields';
import { useContacts } from '../../api/crm';

interface Props {
  entityType: string;
  entityId: string;
  /** Wrap in the standard bordered white card used by sibling detail-page sections. */
  card?: boolean;
}

function displayValue(fieldType: string, raw: string | undefined, contactNameById?: Map<string, string>) {
  if (raw === undefined || raw === '') return '--';
  if (fieldType === 'BOOLEAN') return raw === 'true' ? 'Yes' : raw === 'false' ? 'No' : '--';
  // REFERENCE stores the linked Contact's id — resolve it to a name rather
  // than showing the raw id (see customfields.controller.ts's FIELD_TYPES
  // comment on why REFERENCE always points at Contact today).
  if (fieldType === 'REFERENCE') return contactNameById?.get(raw) || '--';
  return raw;
}

/** Read-only custom field values for an entity detail view (e.g. Contact detail page). */
export function CustomFieldsDisplay({ entityType, entityId, card }: Props) {
  const { data: defs } = useCustomFieldDefs(entityType);
  const { data: records } = useCustomFieldValues(entityId);
  const hasReferenceField = !!defs?.some(d => d.fieldType === 'REFERENCE');
  const { data: contacts } = useContacts(undefined, hasReferenceField);
  const contactNameById = new Map((contacts ?? []).map((c: any) => [c.id, c.name]));
  const valueMap = fromValueRecords(records);

  if (!defs || defs.length === 0) return null;

  const grid = (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
      {defs.map(def => (
        <div key={def.id} className="bg-gray-50 rounded-xl p-3">
          <p className="text-gray-400 text-xs mb-1">{def.label}</p>
          <p className="font-medium">{displayValue(def.fieldType, valueMap[def.fieldKey], contactNameById)}</p>
        </div>
      ))}
    </div>
  );

  if (!card) return grid;

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 shadow-sm p-5">
      <p className="text-sm font-medium text-gray-700 mb-3">Custom Fields</p>
      {grid}
    </div>
  );
}
