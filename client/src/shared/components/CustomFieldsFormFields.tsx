import { useCustomFieldDefs, CustomFieldDef } from '../../api/customFields';
import { Spinner } from './Spinner';

interface Props {
  /** TICKET | CONTACT | DEAL | LEAD */
  entityType: string;
  /** { [fieldKey]: stringValue } */
  values: Record<string, string>;
  onChange: (fieldKey: string, value: string) => void;
}

function FieldInput({ def, value, onChange }: { def: CustomFieldDef; value: string; onChange: (v: string) => void }) {
  const common = 'ui-input';
  switch (def.fieldType) {
    case 'TEXTAREA':
      return (
        <textarea
          aria-label={def.label}
          rows={3}
          className={common}
          required={def.required}
          value={value ?? ''}
          onChange={e => onChange(e.target.value)}
        />
      );
    case 'NUMBER':
      return (
        <input
          aria-label={def.label}
          type="number"
          className={common}
          required={def.required}
          value={value ?? ''}
          onChange={e => onChange(e.target.value)}
        />
      );
    case 'DATE':
      return (
        <input
          aria-label={def.label}
          type="date"
          className={common}
          required={def.required}
          value={value ?? ''}
          onChange={e => onChange(e.target.value)}
        />
      );
    case 'BOOLEAN':
      return (
        <select aria-label={def.label} className={common} required={def.required} value={value ?? ''} onChange={e => onChange(e.target.value)}>
          <option value="">— none —</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      );
    case 'SELECT':
      return (
        <select aria-label={def.label} className={common} required={def.required} value={value ?? ''} onChange={e => onChange(e.target.value)}>
          <option value="">— none —</option>
          {(def.options ?? []).map(opt => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
      );
    case 'TEXT':
    default:
      return (
        <input
          aria-label={def.label}
          type="text"
          className={common}
          required={def.required}
          value={value ?? ''}
          onChange={e => onChange(e.target.value)}
        />
      );
  }
}

/**
 * Renders one input per admin-defined custom field for the given entity
 * type, driven entirely by /api/custom-fields definitions. Used inside the
 * Ticket/Contact/Deal/Lead create & edit forms so admin-configured custom
 * fields actually show up where they're supposed to.
 */
export function CustomFieldsFormFields({ entityType, values, onChange }: Props) {
  const { data: defs, isLoading } = useCustomFieldDefs(entityType);

  if (isLoading) return <Spinner />;
  if (!defs || defs.length === 0) return null;

  return (
    <div className="form-section">
      <p className="form-section-title">Custom Fields</p>
      <div className="space-y-4">
        {defs.map(def => (
          <div key={def.id}>
            <label className="form-label">
              {def.label} {def.required && <span className="req">*</span>}
            </label>
            <FieldInput def={def} value={values[def.fieldKey]} onChange={v => onChange(def.fieldKey, v)} />
          </div>
        ))}
      </div>
    </div>
  );
}
