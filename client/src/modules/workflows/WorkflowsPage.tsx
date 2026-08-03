import { useState } from 'react';
import {
  Zap, Plus, Trash2, ToggleLeft, ToggleRight,
  Play, Clock, CheckCircle, XCircle,
  Eye, X, Edit2
} from 'lucide-react';
import { SearchableSelect, RowActions } from '../../shared/components';
import {
  useWorkflows, useWorkflowLogs, useCreateWorkflow, useUpdateWorkflow,
  useDeleteWorkflow, useToggleWorkflow, useRunDateRule,
  type WorkflowRule, type Condition, type Action, type DateConfig,
} from '../../api/workflows';
import { useCustomModules, useCustomModule } from '../../api/customModules';
import { useCustomFieldDefs } from '../../api/customFields';
import { Spinner } from '../../shared/components';
import { addToast } from '../../shared/components/toastStore';

// ─── Config maps ──────────────────────────────────────────────────────────────

const TRIGGERS = [
  { value: 'TICKET_CREATED',       label: 'Ticket Created',        entity: 'TICKET' },
  { value: 'TICKET_STATUS_CHANGED',label: 'Ticket Status Changed', entity: 'TICKET' },
  { value: 'TICKET_UPDATED',       label: 'Ticket Updated',        entity: 'TICKET' },
  { value: 'LEAD_CREATED',         label: 'Lead Created',          entity: 'LEAD' },
  { value: 'LEAD_STATUS_CHANGED',  label: 'Lead Status Changed',   entity: 'LEAD' },
  { value: 'LEAD_ACTIVITY_COMPLETED', label: 'Lead Follow-up Completed', entity: 'LEAD' },
  { value: 'DEAL_STAGE_CHANGED',   label: 'Deal Stage Changed',    entity: 'DEAL' },
  { value: 'DEAL_WON',             label: 'Deal Won',              entity: 'DEAL' },
  { value: 'DEAL_LOST',            label: 'Deal Lost',             entity: 'DEAL' },
  { value: 'SLA_BREACH',           label: 'SLA Breach',            entity: 'TICKET' },
  // "entity" here is only the *default* — DATE_FIELD_REACHED's actual
  // entity depends on the rule's own dateConfig.entityType (Contact vs a
  // specific Custom Module), resolved by getEntityForTrigger() below.
  { value: 'DATE_FIELD_REACHED',   label: 'Date Reached (birthday, reminder, renewal…)', entity: 'CONTACT' },
];

const CONDITION_FIELDS: Record<string, { value: string; label: string }[]> = {
  TICKET: [
    { value: 'priority', label: 'Priority' },
    { value: 'status', label: 'Status' },
    { value: 'assignedTo', label: 'Assigned To (User ID)' },
  ],
  LEAD: [
    { value: 'status', label: 'Status' },
    { value: 'source', label: 'Source' },
  ],
  DEAL: [
    { value: 'stage', label: 'Stage' },
    { value: 'status', label: 'Status' },
  ],
  CONTACT: [
    { value: 'source', label: 'Source' },
  ],
  // CUSTOM_MODULE_RECORD's fields are module-specific, so there's no fixed
  // list here — conditions are still supported (rule.conditions just has
  // no "add" picker for it), the field name can be typed in as free text
  // via the condition value input elsewhere in this form.
};

const OPERATORS = [
  { value: 'eq', label: 'equals' },
  { value: 'neq', label: 'not equals' },
  { value: 'gt', label: 'greater than' },
  { value: 'lt', label: 'less than' },
  { value: 'contains', label: 'contains' },
];

const ACTION_TYPES = [
  { value: 'ASSIGN_TO',     label: 'Assign to User' },
  { value: 'SET_PRIORITY',  label: 'Set Priority' },
  { value: 'SET_STATUS',    label: 'Set Status' },
  { value: 'SEND_EMAIL',    label: 'Send Email' },
  { value: 'SEND_WHATSAPP', label: 'Send WhatsApp (not for Leads)' },
  { value: 'ADD_NOTE',      label: 'Add Note' },
  { value: 'SEND_WEBHOOK',  label: 'Send Webhook' },
  { value: 'CREATE_NOTIFICATION', label: 'Create In-App Notification' },
  { value: 'CREATE_TICKET', label: 'Create Follow-up Ticket' },
  { value: 'SCORE_LEAD',    label: 'AI-Score Lead (Lead only)' },
  { value: 'SEND_CSAT_SURVEY', label: 'Send Feedback Survey (Ticket only)' },
];

// Mirrors the RECIPIENT_OPTIONS in ScheduleReminderPanel — same four
// recipient types, same restriction that "Deal's contact" only makes sense
// for DEAL-triggered rules (tickets have no linked CRM Contact).
const WHATSAPP_RECIPIENT_OPTIONS: Record<string, { value: string; label: string }[]> = {
  DEAL: [
    { value: 'CONTACT', label: "Deal's contact" },
    { value: 'ASSIGNEE', label: 'Assigned rep' },
    { value: 'CUSTOM_NUMBER', label: 'Custom number' },
    { value: 'ORG_DEFAULT', label: 'Org default number' },
  ],
  TICKET: [
    // "Linked contact" only resolves if the ticket was filed "on behalf of"
    // a Contact (Ticket.contactId, set from the New Ticket form's "Filing
    // For" picker) — otherwise this fails cleanly at send time, same as any
    // other recipient option with nothing on file. See notification-recipient.ts.
    { value: 'CONTACT', label: 'Linked contact (if filed on behalf of one)' },
    { value: 'ASSIGNEE', label: 'Assigned agent' },
    { value: 'CUSTOM_NUMBER', label: 'Custom number' },
    { value: 'ORG_DEFAULT', label: 'Org default number' },
  ],
  CONTACT: [
    { value: 'CONTACT', label: "Contact's own number" },
    { value: 'ASSIGNEE', label: 'Contact owner' },
    { value: 'CUSTOM_NUMBER', label: 'Custom number' },
    { value: 'ORG_DEFAULT', label: 'Org default number' },
  ],
  // CUSTOM_MODULE_RECORD falls back to the TICKET set below (ASSIGNEE will
  // just fail cleanly at send time — see notification-recipient.ts) — set
  // recipient to "Custom number" with a {{fieldKey}} template pointing at
  // whichever of the module's own fields holds a phone number.
};

// Appended to whichever entity's option list above whenever that entity has
// at least one REFERENCE custom field defined (see customfields.controller.ts's
// FIELD_TYPES) — lets a rule notify whoever a *specific* field points at,
// not just the record's built-in requester/assignee/contact.
const REFERENCE_FIELD_OPTION = { value: 'REFERENCE_FIELD', label: 'A "Reference" custom field…' };

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DEFAULT_DATE_CONFIG: DateConfig = {
  entityType: 'CONTACT',
  dateField: 'dateOfBirth',
  offsetDays: 0,
  recurrence: 'YEARLY',
};

const empty = (): Omit<WorkflowRule, 'id' | 'createdAt' | 'runCount' | '_count'> => ({
  name: '',
  description: '',
  trigger: 'TICKET_CREATED',
  conditions: [],
  actions: [{ type: 'ASSIGN_TO', params: { userId: '' } }],
  isActive: true,
});

// DATE_FIELD_REACHED's real entity depends on the rule's own dateConfig
// (Contact vs a specific Custom Module's records), unlike every other
// trigger which maps 1:1 to a fixed entity.
function getEntityForTrigger(trigger: string, dateConfig?: DateConfig | null): string {
  if (trigger === 'DATE_FIELD_REACHED') {
    if (dateConfig?.entityType === 'CUSTOM_MODULE') return 'CUSTOM_MODULE_RECORD';
    return dateConfig?.entityType || 'CONTACT';
  }
  return TRIGGERS.find(t => t.value === trigger)?.entity || 'TICKET';
}

function ActionParamsEditor({ action, onChange, entity }: { action: Action; onChange: (a: Action) => void; entity: string }) {
  const p = action.params;
  const set = (k: string, v: string) => onChange({ ...action, params: { ...p, [k]: v } });
  // Only standard entities (not CUSTOM_MODULE_RECORD) can carry REFERENCE
  // custom fields today — see customfields.controller.ts's ENTITY_TYPES.
  const isStandardEntity = ['TICKET', 'CONTACT', 'DEAL', 'LEAD'].includes(entity);
  const { data: entityFieldDefs } = useCustomFieldDefs(isStandardEntity ? entity : '');
  const referenceFields = (entityFieldDefs || []).filter(d => d.fieldType === 'REFERENCE');

  switch (action.type) {
    case 'ASSIGN_TO':
      return <input value={String(p.userId || '')} onChange={e => set('userId', e.target.value)}
        placeholder="User ID" className="flex-1 px-2 py-1 text-xs border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-brand-400" />;
    case 'SET_PRIORITY':
      return <select value={String(p.priority || 'MEDIUM')} onChange={e => set('priority', e.target.value)}
        className="flex-1 px-2 py-1 text-xs border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-brand-400">
        {['LOW','MEDIUM','HIGH','CRITICAL'].map(v => <option key={v}>{v}</option>)}
      </select>;
    case 'SET_STATUS':
      return <input value={String(p.status || '')} onChange={e => set('status', e.target.value)}
        placeholder="OPEN / RESOLVED / etc." className="flex-1 px-2 py-1 text-xs border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-brand-400" />;
    case 'SEND_EMAIL':
      return <div className="flex-1 space-y-1">
        <input value={String(p.to || '')} onChange={e => set('to', e.target.value)}
          placeholder="To email (use {{contact.email}})" className="w-full px-2 py-1 text-xs border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-brand-400" />
        <input value={String(p.subject || '')} onChange={e => set('subject', e.target.value)}
          placeholder="Subject" className="w-full px-2 py-1 text-xs border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-brand-400" />
        <textarea value={String(p.body || '')} onChange={e => set('body', e.target.value)}
          placeholder="Body (use {{title}}, {{priority}}, {{status}})" rows={2}
          className="w-full px-2 py-1 text-xs border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-brand-400 resize-none" />
      </div>;
    case 'SEND_WHATSAPP': {
      const baseOptions = WHATSAPP_RECIPIENT_OPTIONS[entity] || WHATSAPP_RECIPIENT_OPTIONS.TICKET;
      const recipientOptions = referenceFields.length ? [...baseOptions, REFERENCE_FIELD_OPTION] : baseOptions;
      const recipientType = String(p.recipientType || 'ASSIGNEE');
      return <div className="flex-1 space-y-1">
        {entity === 'LEAD' && (
          <p className="text-[11px] text-amber-600">SEND_WHATSAPP isn't supported for leads — this action will be skipped when it runs.</p>
        )}
        <select value={recipientType} onChange={e => set('recipientType', e.target.value)}
          className="w-full px-2 py-1 text-xs border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-brand-400">
          {recipientOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        {recipientType === 'CUSTOM_NUMBER' && (
          <input value={String(p.customNumber || '')} onChange={e => set('customNumber', e.target.value)}
            placeholder="+14155551234" className="w-full px-2 py-1 text-xs border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-brand-400" />
        )}
        {recipientType === 'REFERENCE_FIELD' && (
          <select value={String(p.referenceFieldId || '')} onChange={e => set('referenceFieldId', e.target.value)}
            className="w-full px-2 py-1 text-xs border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-brand-400">
            <option value="">— select a reference field —</option>
            {referenceFields.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
        )}
        <textarea value={String(p.message || '')} onChange={e => set('message', e.target.value)}
          placeholder="Message (use {{title}}, {{priority}}, {{status}})" rows={2}
          className="w-full px-2 py-1 text-xs border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-brand-400 resize-none" />
      </div>;
    }
    case 'ADD_NOTE':
      return <textarea value={String(p.body || '')} onChange={e => set('body', e.target.value)}
        placeholder="Note body" rows={2}
        className="flex-1 px-2 py-1 text-xs border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-brand-400 resize-none" />;
    case 'SEND_WEBHOOK':
      return <input value={String(p.url || '')} onChange={e => set('url', e.target.value)}
        placeholder="https://hooks.example.com/crm" className="flex-1 px-2 py-1 text-xs border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-brand-400" />;
    case 'CREATE_NOTIFICATION': {
      const recipientType = String(p.recipientType || 'ASSIGNEE');
      return <div className="flex-1 space-y-1">
        <input value={String(p.title || '')} onChange={e => set('title', e.target.value)}
          placeholder="Notification title" className="w-full px-2 py-1 text-xs border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-brand-400" />
        <textarea value={String(p.body || '')} onChange={e => set('body', e.target.value)}
          placeholder="Body (use {{title}}, {{priority}}, {{status}})" rows={2}
          className="w-full px-2 py-1 text-xs border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-brand-400 resize-none" />
        <select value={recipientType} onChange={e => set('recipientType', e.target.value)}
          className="w-full px-2 py-1 text-xs border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-brand-400">
          <option value="ASSIGNEE">Assignee / owner</option>
          <option value="USER">Specific user</option>
        </select>
        {recipientType === 'USER' && (
          <input value={String(p.userId || '')} onChange={e => set('userId', e.target.value)}
            placeholder="User ID" className="w-full px-2 py-1 text-xs border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-brand-400" />
        )}
      </div>;
    }
    case 'CREATE_TICKET':
      return <div className="flex-1 space-y-1">
        <input value={String(p.title || '')} onChange={e => set('title', e.target.value)}
          placeholder="Ticket title (use {{title}})" className="w-full px-2 py-1 text-xs border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-brand-400" />
        <textarea value={String(p.body || '')} onChange={e => set('body', e.target.value)}
          placeholder="Description" rows={2}
          className="w-full px-2 py-1 text-xs border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-brand-400 resize-none" />
        <select value={String(p.priority || 'MEDIUM')} onChange={e => set('priority', e.target.value)}
          className="w-full px-2 py-1 text-xs border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-brand-400">
          {['LOW','MEDIUM','HIGH','CRITICAL'].map(v => <option key={v}>{v}</option>)}
        </select>
      </div>;
    case 'SCORE_LEAD':
      return <p className="flex-1 text-[11px] text-gray-400 italic px-1 py-1.5">No parameters — uses AI to score the lead and stores the result on the lead record.</p>;
    case 'SEND_CSAT_SURVEY': {
      if (entity !== 'TICKET') {
        return <p className="flex-1 text-[11px] text-amber-600 italic px-1 py-1.5">Only applies to Ticket-triggered rules — this action will be skipped otherwise.</p>;
      }
      const recipientType = String(p.recipientType || 'REQUESTER');
      return <div className="flex-1 space-y-1">
        <select value={recipientType} onChange={e => set('recipientType', e.target.value)}
          className="w-full px-2 py-1 text-xs border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-brand-400">
          <option value="REQUESTER">Whoever filed the ticket</option>
          <option value="CONTACT">Linked contact (if filed on behalf of one)</option>
          {referenceFields.length > 0 && <option value="REFERENCE_FIELD">A "Reference" custom field…</option>}
        </select>
        {recipientType === 'REFERENCE_FIELD' && (
          <select value={String(p.referenceFieldId || '')} onChange={e => set('referenceFieldId', e.target.value)}
            className="w-full px-2 py-1 text-xs border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-brand-400">
            <option value="">— select a reference field —</option>
            {referenceFields.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
        )}
        <p className="text-[11px] text-gray-400 italic">Emails a 1–5 star rating link to whoever is selected above.</p>
      </div>;
    }
    default:
      return null;
  }
}

// ─── Date-config sub-form (only for trigger === 'DATE_FIELD_REACHED') ─────────

// Built-in date columns every "default module" (standard entity) exposes
// without needing a custom field — mirrors server/src/utils/dateAutomation.ts's
// BUILTIN_DATE_FIELDS exactly (see that file's comment for why these two
// lists have to agree). createdAt/updatedAt are universal; dateOfBirth is
// Contact-only.
const BUILTIN_DATE_FIELDS: Record<string, { value: string; label: string }[]> = {
  CONTACT: [
    { value: 'dateOfBirth', label: 'Date of Birth' },
    { value: 'createdAt', label: 'Created' },
    { value: 'updatedAt', label: 'Last Updated' },
  ],
  DEAL: [
    { value: 'createdAt', label: 'Created' },
    { value: 'updatedAt', label: 'Last Updated' },
  ],
  TICKET: [
    { value: 'createdAt', label: 'Created' },
    { value: 'updatedAt', label: 'Last Updated' },
  ],
  LEAD: [
    { value: 'createdAt', label: 'Created' },
    { value: 'updatedAt', label: 'Last Updated' },
  ],
};

const STANDARD_ENTITY_LABELS: Record<string, string> = {
  CONTACT: 'Contacts',
  DEAL: 'Deals',
  TICKET: 'Tickets',
  LEAD: 'Leads',
};

function DateConfigEditor({ config, onChange }: { config: DateConfig; onChange: (c: DateConfig) => void }) {
  const { data: modules = [] } = useCustomModules();
  const { data: selectedModule } = useCustomModule(config.entityType === 'CUSTOM_MODULE' ? config.moduleId : undefined);
  const moduleDateFields = (selectedModule?.fields || []).filter((f: any) => f.fieldType === 'DATE');

  const isStandardEntity = config.entityType !== 'CUSTOM_MODULE';
  // Org-defined custom fields (Settings → Custom Fields) of type DATE for
  // whichever standard entity is selected — the "if there are any custom
  // date fields they also need to be displayed" half of this feature.
  const { data: customFieldDefs = [] } = useCustomFieldDefs(isStandardEntity ? config.entityType : '');
  const customDateFields = customFieldDefs.filter(f => f.fieldType === 'DATE');
  const builtinFields = isStandardEntity ? (BUILTIN_DATE_FIELDS[config.entityType] || []) : [];

  const isBefore = config.offsetDays < 0;
  const dayCount = Math.abs(config.offsetDays);

  return (
    <div className="space-y-3 bg-brand-50/40 border border-brand-100 rounded-xl p-3">
      <div>
        <label className="form-label">Watch this date on…</label>
        <select
          value={config.entityType}
          onChange={e => {
            const entityType = e.target.value as DateConfig['entityType'];
            const defaultField = entityType === 'CONTACT' ? 'dateOfBirth' : entityType === 'CUSTOM_MODULE' ? '' : 'createdAt';
            onChange({ ...config, entityType, dateField: defaultField, moduleId: undefined });
          }}
          className="ui-input text-sm"
        >
          <option value="CONTACT">Contacts</option>
          <option value="DEAL">Deals</option>
          <option value="TICKET">Tickets</option>
          <option value="LEAD">Leads</option>
          <option value="CUSTOM_MODULE">A Custom Module's date field</option>
        </select>
      </div>

      {isStandardEntity && (
        <div>
          <label className="form-label">Date Field</label>
          <select
            value={config.dateField}
            onChange={e => onChange({ ...config, dateField: e.target.value })}
            className="ui-input text-sm"
          >
            <option value="">— select a field —</option>
            {builtinFields.length > 0 && (
              <optgroup label="Built-in">
                {builtinFields.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
              </optgroup>
            )}
            {customDateFields.length > 0 && (
              <optgroup label="Custom fields">
                {customDateFields.map(f => <option key={f.fieldKey} value={f.fieldKey}>{f.label}</option>)}
              </optgroup>
            )}
          </select>
          {customDateFields.length === 0 && (
            <p className="text-xs text-gray-400 mt-1">
              Add a custom Date field to {STANDARD_ENTITY_LABELS[config.entityType]} under Settings → Custom Fields to see more options here.
            </p>
          )}
        </div>
      )}

      {config.entityType === 'CUSTOM_MODULE' && (
        <>
          <div>
            <label className="form-label">Custom Module</label>
            <select
              value={config.moduleId || ''}
              onChange={e => onChange({ ...config, moduleId: e.target.value, dateField: '' })}
              className="ui-input text-sm"
            >
              <option value="">— select a module —</option>
              {modules.map((m: any) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>
          {config.moduleId && (
            <div>
              <label className="form-label">Date Field</label>
              {moduleDateFields.length === 0 ? (
                <p className="text-xs text-amber-600">This module has no Date-type field yet — add one on the module's Fields tab first.</p>
              ) : (
                <select
                  value={config.dateField}
                  onChange={e => onChange({ ...config, dateField: e.target.value })}
                  className="ui-input text-sm"
                >
                  <option value="">— select a field —</option>
                  {moduleDateFields.map((f: any) => <option key={f.fieldKey} value={f.fieldKey}>{f.label}</option>)}
                </select>
              )}
            </div>
          )}
        </>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="form-label">When</label>
          <div className="flex items-center gap-2">
            <select
              value={isBefore ? 'BEFORE' : 'AFTER'}
              onChange={e => onChange({ ...config, offsetDays: e.target.value === 'BEFORE' ? -dayCount : dayCount })}
              className="ui-input text-sm flex-shrink-0 w-24"
            >
              <option value="BEFORE">Before</option>
              <option value="AFTER">After / On</option>
            </select>
            <input
              type="number" min={0}
              value={dayCount}
              onChange={e => { const n = Math.max(0, Number(e.target.value)); onChange({ ...config, offsetDays: isBefore ? -n : n }); }}
              className="ui-input text-sm w-20"
            />
            <span className="text-xs text-gray-500">day(s)</span>
          </div>
        </div>
        <div>
          <label className="form-label">Repeats</label>
          <select
            value={config.recurrence}
            onChange={e => onChange({ ...config, recurrence: e.target.value as DateConfig['recurrence'] })}
            className="ui-input text-sm"
          >
            <option value="YEARLY">Every year (birthdays, anniversaries)</option>
            <option value="ONCE">Once (a specific appointment/visit date)</option>
          </select>
        </div>
      </div>
      <p className="text-xs text-gray-500">
        {dayCount === 0
          ? 'Fires on the date itself.'
          : `Fires ${dayCount} day${dayCount === 1 ? '' : 's'} ${isBefore ? 'before' : 'after'} the date.`}
      </p>
    </div>
  );
}

// ─── Rule Editor Modal ────────────────────────────────────────────────────────

function RuleEditor({
  initial,
  onSave,
  onClose,
  saving,
}: {
  initial: Omit<WorkflowRule, 'id' | 'createdAt' | 'runCount' | '_count'>;
  onSave: (rule: typeof initial) => void;
  onClose: () => void;
  saving: boolean;
}) {
  const [form, setForm] = useState(initial);

  const entity = getEntityForTrigger(form.trigger, form.dateConfig);
  const condFields = CONDITION_FIELDS[entity] || [];

  const dateConfigIncomplete = form.trigger === 'DATE_FIELD_REACHED' && (
    !form.dateConfig?.dateField || (form.dateConfig.entityType === 'CUSTOM_MODULE' && !form.dateConfig.moduleId)
  );

  function addCondition() {
    setForm(f => ({ ...f, conditions: [...f.conditions, { field: condFields[0]?.value || 'priority', operator: 'eq', value: '' }] }));
  }
  function updateCondition(i: number, patch: Partial<Condition>) {
    setForm(f => ({ ...f, conditions: f.conditions.map((c, idx) => idx === i ? { ...c, ...patch } : c) }));
  }
  function removeCondition(i: number) {
    setForm(f => ({ ...f, conditions: f.conditions.filter((_, idx) => idx !== i) }));
  }

  function addAction() {
    setForm(f => ({ ...f, actions: [...f.actions, { type: 'ADD_NOTE', params: { body: '' } }] }));
  }
  function updateAction(i: number, patch: Partial<Action>) {
    setForm(f => ({ ...f, actions: f.actions.map((a, idx) => idx === i ? { ...a, ...patch } as Action : a) }));
  }
  function removeAction(i: number) {
    setForm(f => ({ ...f, actions: f.actions.filter((_, idx) => idx !== i) }));
  }

  return (
    <div role="dialog" aria-modal="true" className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <Zap size={18} className="text-brand-600" />
            <h2 className="font-semibold text-gray-900">{initial.name ? `Edit: ${initial.name}` : 'New Automation Rule'}</h2>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg"><X size={16} /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-6">
          {/* Name + Description */}
          <div className="form-section">
            <p className="form-section-title">Rule Details</p>
            <div className="space-y-4">
              <div>
                <label className="form-label">Rule Name <span className="req">*</span></label>
                <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  aria-label="Rule Name" placeholder="e.g. Auto-assign CRITICAL tickets" className="ui-input" />
              </div>
              <div>
                <label className="form-label">Description</label>
                <input value={form.description || ''} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                  placeholder="What does this automation do?" className="ui-input" />
              </div>
            </div>
          </div>

          {/* Trigger */}
          <div className="form-section">
            <p className="form-section-title">① When this happens (Trigger)</p>
<SearchableSelect ariaLabel="Trigger" value={form.trigger} onChange={val => setForm(f => ({
              ...f,
              trigger: val,
              conditions: [],
              dateConfig: val === 'DATE_FIELD_REACHED' ? (f.dateConfig || DEFAULT_DATE_CONFIG) : f.dateConfig,
            }))} required options={TRIGGERS.map(t => ({ value: t.value, label: t.label }))} />
            {form.trigger === 'DATE_FIELD_REACHED' && (
              <div className="mt-3">
                <DateConfigEditor
                  config={form.dateConfig || DEFAULT_DATE_CONFIG}
                  onChange={dateConfig => setForm(f => ({ ...f, dateConfig }))}
                />
              </div>
            )}
          </div>

          {/* Conditions */}
          <div className="form-section">
            <div className="flex items-center justify-between mb-3">
              <p className="form-section-title" style={{marginBottom: 0}}>② Conditions (optional)</p>
              <button onClick={addCondition} className="text-xs text-brand-600 hover:text-brand-700 font-medium flex items-center gap-1">
                <Plus size={12} /> Add
              </button>
            </div>
            {form.conditions.length === 0 ? (
              <p className="text-xs text-gray-400 italic">No conditions — rule runs for every {form.trigger.toLowerCase()} event</p>
            ) : (
              <div className="space-y-2">
                {form.conditions.map((cond, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <select value={cond.field} onChange={e => updateCondition(i, { field: e.target.value })}
                      className="ui-input text-xs py-1.5 w-36 flex-shrink-0">
                      {condFields.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                    </select>
                    <select value={cond.operator} onChange={e => updateCondition(i, { operator: e.target.value as any })}
                      className="ui-input text-xs py-1.5 w-28 flex-shrink-0">
                      {OPERATORS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                    <input value={String(cond.value)} onChange={e => updateCondition(i, { value: e.target.value })}
                      placeholder="Value" className="ui-input flex-1 text-xs py-1.5" />
                    <button onClick={() => removeCondition(i)} className="text-gray-300 hover:text-red-400"><Trash2 size={13} /></button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="form-section">
            <div className="flex items-center justify-between mb-3">
              <p className="form-section-title" style={{marginBottom: 0}}>③ Actions</p>
              <button onClick={addAction} className="text-xs text-brand-600 hover:text-brand-700 font-medium flex items-center gap-1">
                <Plus size={12} /> Add
              </button>
            </div>
            <div className="space-y-3">
              {form.actions.map((action, i) => (
                <div key={i} className="flex items-start gap-2 bg-white border border-gray-100 rounded-xl p-3">
                  <select value={action.type}
                    onChange={e => updateAction(i, { type: e.target.value as any, params: {} })}
                    className="ui-input text-xs py-1.5 w-40 flex-shrink-0">
                    {ACTION_TYPES.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
                  </select>
                  <ActionParamsEditor action={action} onChange={a => updateAction(i, a)} entity={entity} />
                  <button onClick={() => removeAction(i)} className="text-gray-300 hover:text-red-400 flex-shrink-0 mt-0.5"><Trash2 size={13} /></button>
                </div>
              ))}
              {form.actions.length === 0 && (
                <p className="text-xs text-gray-400 italic">Add at least one action</p>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="p-5 border-t border-gray-100 flex justify-between items-center">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.isActive} onChange={e => setForm(f => ({ ...f, isActive: e.target.checked }))}
              className="w-4 h-4 accent-brand-600" />
            <span className="text-gray-600">Active</span>
          </label>
          <div className="flex gap-3">
            <button onClick={onClose} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 border border-gray-200 rounded-xl">Cancel</button>
            <button onClick={() => onSave(form)} disabled={saving || !form.name || form.actions.length === 0 || dateConfigIncomplete}
              className="px-4 py-2 text-sm bg-brand-600 text-white rounded-xl hover:bg-brand-700 disabled:opacity-40 flex items-center gap-2">
              {saving && <Spinner />}
              Save Rule
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Logs drawer ──────────────────────────────────────────────────────────────

function LogsDrawer({ ruleId, ruleName, onClose }: { ruleId: string; ruleName: string; onClose: () => void }) {
  const { data: logs, isLoading } = useWorkflowLogs(ruleId);

  const icon = (result: string) => result === 'SUCCESS' ? <CheckCircle size={13} className="text-green-500" />
    : result === 'SKIPPED' ? <Clock size={13} className="text-gray-400" />
    : <XCircle size={13} className="text-red-400" />;

  return (
    <div className="fixed inset-0 bg-black/30 flex justify-end z-50">
      <div className="bg-white w-full max-w-md flex flex-col shadow-2xl">
        <div className="flex items-center justify-between p-4 border-b border-gray-100">
          <div>
            <p className="font-semibold text-sm text-gray-900">Execution Log</p>
            <p className="text-xs text-gray-400 mt-0.5">{ruleName}</p>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg"><X size={15} /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {isLoading ? <Spinner label="Loading logs…" />
            : !logs?.length ? (
              <div className="text-center py-12 text-gray-400">
                <Play size={32} className="mx-auto mb-2 opacity-30" />
                <p className="text-sm">No executions yet</p>
              </div>
            ) : (
              <div className="space-y-2">
                {logs.map(log => (
                  <div key={log.id} className="flex items-start gap-2.5 p-3 bg-gray-50 rounded-xl">
                    <div className="mt-0.5 flex-shrink-0">{icon(log.result)}</div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`text-xs font-medium ${log.result === 'SUCCESS' ? 'text-green-700' : log.result === 'SKIPPED' ? 'text-gray-500' : 'text-red-600'}`}>
                          {log.result}
                        </span>
                        <span className="text-xs text-gray-400">{log.entityType} · {log.entityId.slice(0, 8)}…</span>
                      </div>
                      {log.detail && <p className="text-xs text-gray-500 mt-0.5 truncate">{log.detail}</p>}
                      <p className="text-xs text-gray-300 mt-0.5">{new Date(log.createdAt).toLocaleString()}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function WorkflowsPage() {
  const { data: rules = [], isLoading } = useWorkflows();
  const createRule = useCreateWorkflow();
  const updateRule = useUpdateWorkflow();
  const deleteRule = useDeleteWorkflow();
  const toggleRule = useToggleWorkflow();

  const [showEditor, setShowEditor] = useState(false);
  const [editingRule, setEditingRule] = useState<WorkflowRule | null>(null);
  const [logsFor, setLogsFor] = useState<{ id: string; name: string } | null>(null);
  const runDateRule = useRunDateRule();

  function handleSave(data: Omit<WorkflowRule, 'id' | 'createdAt' | 'runCount' | '_count'>) {
    if (editingRule) {
      updateRule.mutate({ id: editingRule.id, ...data }, { onSuccess: () => { setShowEditor(false); setEditingRule(null); } });
    } else {
      createRule.mutate(data, { onSuccess: () => setShowEditor(false) });
    }
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Zap size={20} className="text-brand-600" />
            <h1 className="text-xl font-bold text-gray-900">Workflow Automation</h1>
          </div>
          <p className="text-sm text-gray-500">Automate repetitive tasks — assign tickets, send emails, update statuses, and more.</p>
        </div>
        <button onClick={() => { setEditingRule(null); setShowEditor(true); }}
          className="flex items-center gap-2 px-4 py-2.5 bg-brand-600 text-white rounded-xl text-sm font-medium hover:bg-brand-700 transition-colors">
          <Plus size={15} /> New Rule
        </button>
      </div>

      {/* Stats bar */}
      {rules.length > 0 && (
        <div className="grid grid-cols-3 gap-4 mb-6">
          {[
            { label: 'Total Rules', value: rules.length, color: 'text-gray-900' },
            { label: 'Active', value: rules.filter(r => r.isActive).length, color: 'text-green-600' },
            { label: 'Total Runs', value: rules.reduce((s, r) => s + r.runCount, 0), color: 'text-brand-600' },
          ].map(stat => (
            <div key={stat.label} className="bg-white border border-gray-200 rounded-xl p-4 text-center">
              <p className={`text-2xl font-bold ${stat.color}`}>{stat.value}</p>
              <p className="text-xs text-gray-500 mt-0.5">{stat.label}</p>
            </div>
          ))}
        </div>
      )}

      {/* Rules list */}
      {isLoading ? <Spinner label="Loading rules…" /> : rules.length === 0 ? (
        <div className="text-center py-20 bg-white border border-dashed border-gray-200 rounded-2xl">
          <div className="w-14 h-14 rounded-2xl bg-brand-50 flex items-center justify-center mx-auto mb-4">
            <Zap size={24} className="text-brand-400" />
          </div>
          <h3 className="text-base font-semibold text-gray-700 mb-1">No automation rules yet</h3>
          <p className="text-sm text-gray-400 max-w-sm mx-auto mb-5">
            Create your first rule to automatically assign tickets, send follow-up emails, or update record statuses.
          </p>
          <button onClick={() => { setEditingRule(null); setShowEditor(true); }}
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-brand-600 text-white rounded-xl text-sm font-medium hover:bg-brand-700">
            <Plus size={14} /> Create first rule
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {rules.map(rule => (
            <div key={rule.id} data-testid="workflow-rule" className="bg-white border border-gray-200 rounded-xl p-4 hover:border-brand-200 transition-colors">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3 min-w-0">
                  {/* Active toggle */}
                  <button onClick={() => toggleRule.mutate(rule.id)} className="flex-shrink-0">
                    {rule.isActive
                      ? <ToggleRight size={22} className="text-brand-600" />
                      : <ToggleLeft size={22} className="text-gray-300" />}
                  </button>

                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`font-medium text-sm ${rule.isActive ? 'text-gray-900' : 'text-gray-400'}`}>
                        {rule.name}
                      </span>
                      <span className="text-xs px-2 py-0.5 bg-violet-50 text-violet-600 rounded-full font-medium flex-shrink-0">
                        {TRIGGERS.find(t => t.value === rule.trigger)?.label || rule.trigger}
                      </span>
                    </div>
                    {rule.description && (
                      <p className="text-xs text-gray-400 mt-0.5 truncate">{rule.description}</p>
                    )}
                    <div className="flex items-center gap-3 mt-1.5">
                      <span className="text-xs text-gray-400">{rule.conditions.length} condition{rule.conditions.length !== 1 ? 's' : ''}</span>
                      <span className="text-gray-200">·</span>
                      <span className="text-xs text-gray-400">{rule.actions.length} action{rule.actions.length !== 1 ? 's' : ''}</span>
                      <span className="text-gray-200">·</span>
                      <span className="text-xs text-gray-400">{rule.runCount} run{rule.runCount !== 1 ? 's' : ''}</span>
                    </div>
                  </div>
                </div>

                <RowActions items={[
                  ...(rule.trigger === 'DATE_FIELD_REACHED' ? [{
                    label: 'Run now (test)', icon: <Play size={14} />,
                    onClick: () => runDateRule.mutate(rule.id, {
                      onSuccess: (res: any) => addToast(res.message, res.fired > 0 ? 'success' : 'info'),
                      onError: (err: any) => addToast(err?.response?.data?.error || 'Failed to run rule', 'error'),
                    }),
                  }] : []),
                  { label: 'View logs', icon: <Eye size={14} />, onClick: () => setLogsFor({ id: rule.id, name: rule.name }) },
                  { label: 'Edit', icon: <Edit2 size={14} />, onClick: () => { setEditingRule(rule); setShowEditor(true); } },
                  { label: 'Delete', icon: <Trash2 size={14} />, onClick: () => { if (confirm('Delete this rule?')) deleteRule.mutate(rule.id); }, variant: 'danger' },
                ]} />
              </div>

              {/* Conditions + Actions preview */}
              {(rule.conditions.length > 0 || rule.actions.length > 0) && (
                <div className="mt-3 flex flex-wrap gap-1.5 pl-9">
                  {rule.conditions.map((c, i) => (
                    <span key={i} className="text-xs px-2 py-0.5 bg-blue-50 text-blue-600 rounded-full">
                      {c.field} {c.operator} "{c.value}"
                    </span>
                  ))}
                  {rule.actions.map((a, i) => (
                    <span key={i} className="text-xs px-2 py-0.5 bg-green-50 text-green-600 rounded-full">
                      → {ACTION_TYPES.find(t => t.value === a.type)?.label || a.type}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {showEditor && (
        <RuleEditor
          initial={editingRule ? {
            name: editingRule.name,
            description: editingRule.description,
            trigger: editingRule.trigger,
            conditions: editingRule.conditions,
            actions: editingRule.actions,
            isActive: editingRule.isActive,
            dateConfig: editingRule.dateConfig,
          } : empty()}
          onSave={handleSave}
          onClose={() => { setShowEditor(false); setEditingRule(null); }}
          saving={createRule.isPending || updateRule.isPending}
        />
      )}

      {logsFor && <LogsDrawer ruleId={logsFor.id} ruleName={logsFor.name} onClose={() => setLogsFor(null)} />}
    </div>
  );
}
