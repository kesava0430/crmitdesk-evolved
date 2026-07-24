import { useState } from 'react';
import {
  Brain, Building2, Zap, Code2, Plus, Trash2, Play, Save,
  CheckCircle2, XCircle, Loader2,
  Pencil, ToggleLeft, ToggleRight, X,
} from 'lucide-react';
import {
  useBusinessContext, useSaveBusinessContext,
  useCustomFunctions, useCreateFunction, useUpdateFunction, useDeleteFunction, useRunFunction,
  useCustomScripts, useCreateScript, useUpdateScript, useDeleteScript, useValidateScript,
  type CustomAIFunction, type CustomScript, type InputField,
} from '../api/aiStudio';

// ─── Constants ────────────────────────────────────────────────────────────────

const INDUSTRIES = [
  'Healthcare', 'Legal', 'Real Estate', 'Finance & Banking', 'Insurance',
  'Retail & E-commerce', 'Manufacturing', 'Technology', 'Education',
  'Construction', 'Hospitality', 'Non-profit', 'Government', 'Other',
];

const ENTITY_TYPES = ['ticket', 'contact', 'deal', 'lead', 'asset', 'global'];
const TRIGGERS     = ['onLoad', 'onChange', 'onSubmit', 'onValidate', 'onFieldChange'];
const FIELD_TYPES  = ['text', 'number', 'boolean', 'select'] as const;
const OUTPUT_TYPES = ['text', 'json', 'number'] as const;

const SCRIPT_TEMPLATE = `// Available: context.entity, context.field, context.user
// context.setValue(fieldName, value)
// context.setError(fieldName, message)
// context.notify(message, type?)
// await context.ai(prompt) — calls AI and returns string

// Example: auto-set priority based on title keywords
if (context.entity.title?.toLowerCase().includes('urgent')) {
  context.setValue('priority', 'HIGH');
  context.notify('Priority set to HIGH based on urgent keyword', 'info');
}
`;

// ─── Tab: Business Context ────────────────────────────────────────────────────

function BusinessContextTab() {
  const { data: ctx, isLoading } = useBusinessContext();
  const save = useSaveBusinessContext();

  const [form, setForm] = useState<any>(null);
  const [termKey, setTermKey] = useState('');
  const [termVal, setTermVal] = useState('');

  const current = form ?? ctx ?? {};

  function set(key: string, val: any) {
    setForm((p: any) => ({ ...(p ?? ctx ?? {}), [key]: val }));
  }

  function addTerm() {
    if (!termKey.trim()) return;
    set('terminology', { ...current.terminology, [termKey.trim()]: termVal.trim() });
    setTermKey(''); setTermVal('');
  }

  function removeTerm(key: string) {
    const t = { ...(current.terminology ?? {}) };
    delete t[key];
    set('terminology', t);
  }

  if (isLoading) return <div className="py-16 text-center text-gray-400"><Loader2 size={24} className="animate-spin mx-auto" /></div>;

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <p className="text-sm text-gray-500 mb-4">
          Tell the AI about your business so every AI feature speaks your language and understands your domain.
        </p>
      </div>

      {/* Industry */}
      <div>
        <label className="form-label">Industry</label>
        <select
          value={current.industry ?? ''}
          onChange={e => set('industry', e.target.value)}
          className="ui-input"
        >
          <option value="">Select your industry…</option>
          {INDUSTRIES.map(i => <option key={i}>{i}</option>)}
        </select>
      </div>

      {/* Company description */}
      <div>
        <label className="form-label">Company Description</label>
        <textarea
          rows={3}
          value={current.companyDesc ?? ''}
          onChange={e => set('companyDesc', e.target.value)}
          placeholder="Briefly describe what your company does, who your customers are, and your main business goals…"
          className="ui-input resize-none"
        />
      </div>

      {/* Tone */}
      <div>
        <label className="form-label">AI Response Tone</label>
        <div className="flex gap-3">
          {(['professional', 'casual', 'technical'] as const).map(t => (
            <button
              key={t}
              onClick={() => set('tone', t)}
              className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors capitalize ${
                (current.tone ?? 'professional') === t
                  ? 'bg-brand-600 text-white border-brand-600'
                  : 'border-gray-200 text-gray-700 hover:bg-gray-50'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {/* Domain Terminology */}
      <div>
        <label className="form-label">Domain Terminology</label>
        <p className="text-xs text-gray-500 mb-3">
          Teach the AI your company's specific terms. E.g., "policy" = "insurance coverage", "client" = "patient".
        </p>
        <div className="flex gap-2 mb-2">
          <input
            value={termKey}
            onChange={e => setTermKey(e.target.value)}
            placeholder="Term (e.g. patient)"
            className="flex-1 border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          <input
            value={termVal}
            onChange={e => setTermVal(e.target.value)}
            placeholder="Means (e.g. customer with active policy)"
            className="flex-1 border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          <button
            onClick={addTerm}
            className="px-3 py-1.5 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700"
          >
            Add
          </button>
        </div>
        {Object.entries(current.terminology ?? {}).length > 0 && (
          <div className="space-y-1">
            {Object.entries(current.terminology ?? {}).map(([k, v]) => (
              <div key={k} className="flex items-center gap-2 bg-gray-50 rounded-lg px-3 py-1.5 text-sm">
                <span className="font-medium text-gray-800">{k}</span>
                <span className="text-gray-400">→</span>
                <span className="text-gray-600 flex-1">{v as string}</span>
                <button onClick={() => removeTerm(k)} className="text-gray-400 hover:text-red-500">
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Extra system context */}
      <div>
        <label className="form-label">Additional AI Instructions</label>
        <textarea
          rows={3}
          value={current.customSystem ?? ''}
          onChange={e => set('customSystem', e.target.value)}
          placeholder="Any extra instructions injected into every AI prompt. E.g., 'Always comply with HIPAA guidelines. Never suggest specific medications.'"
          className="ui-input resize-none"
        />
      </div>

      <button
        onClick={() => save.mutate(current)}
        disabled={save.isPending}
        className="flex items-center gap-2 px-5 py-2 bg-brand-600 text-white rounded-lg text-sm font-semibold hover:bg-brand-700 disabled:opacity-50"
      >
        {save.isPending ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
        Save Business Context
      </button>
      {save.isSuccess && (
        <p className="text-sm text-green-600 flex items-center gap-1.5">
          <CheckCircle2 size={14} /> Saved — all AI features now use this context.
        </p>
      )}
    </div>
  );
}

// ─── Tab: Custom AI Functions ─────────────────────────────────────────────────

const EMPTY_FN: Partial<CustomAIFunction> = {
  name: '', description: '', systemPrompt: '', inputSchema: [], outputType: 'text', isActive: true,
};

function FunctionEditor({ fn, onClose }: { fn: Partial<CustomAIFunction>; onClose: () => void }) {
  const [form, setForm]       = useState({ ...EMPTY_FN, ...fn });
  const [newField, setNewField] = useState<Partial<InputField>>({ name: '', type: 'text', label: '', required: false });
  const [testInputs, setTestInputs] = useState<Record<string, string>>({});
  const [testResult, setTestResult] = useState('');
  const [testing, setTesting] = useState(false);

  const createFn = useCreateFunction();
  const updateFn = useUpdateFunction();
  const runFn    = useRunFunction();

  function set(k: string, v: any) { setForm(p => ({ ...p, [k]: v })); }

  function addField() {
    if (!newField.name || !newField.label) return;
    set('inputSchema', [...(form.inputSchema ?? []), { ...newField }]);
    setNewField({ name: '', type: 'text', label: '', required: false });
  }

  function removeField(idx: number) {
    set('inputSchema', (form.inputSchema ?? []).filter((_, i) => i !== idx));
  }

  async function handleSave() {
    if (fn.id) await updateFn.mutateAsync({ id: fn.id, ...form });
    else       await createFn.mutateAsync(form);
    onClose();
  }

  async function handleTest() {
    if (!fn.id) return;
    setTesting(true);
    setTestResult('');
    try {
      const r = await runFn.mutateAsync({ id: fn.id, inputs: testInputs });
      setTestResult(typeof r.output === 'string' ? r.output : JSON.stringify(r.output, null, 2));
    } catch {
      setTestResult('Error running function.');
    } finally {
      setTesting(false);
    }
  }

  const isSaving = createFn.isPending || updateFn.isPending;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div role="dialog" aria-modal="true" className="bg-white rounded-2xl w-full max-w-2xl shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="p-6 border-b border-gray-100 flex items-center justify-between">
          <h3 className="font-semibold text-gray-900">{fn.id ? 'Edit Function' : 'New Custom AI Function'}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
        </div>
        <div className="p-6 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label className="form-label">Function Name *</label>
              <input
                value={form.name ?? ''}
                onChange={e => set('name', e.target.value)}
                placeholder="e.g. Classify Patient Urgency"
                className="ui-input"
              />
            </div>
            <div className="col-span-2">
              <label className="form-label">Description</label>
              <input
                value={form.description ?? ''}
                onChange={e => set('description', e.target.value)}
                placeholder="What does this function do?"
                className="ui-input"
              />
            </div>
            <div className="col-span-2">
              <label className="form-label">System Prompt *</label>
              <textarea
                rows={5}
                value={form.systemPrompt ?? ''}
                onChange={e => set('systemPrompt', e.target.value)}
                placeholder="You are a helpful assistant specializing in… Analyze the provided inputs and return…"
                className="ui-input resize-none font-mono"
              />
            </div>
            <div>
              <label className="form-label">Output Type</label>
              <select
                value={form.outputType ?? 'text'}
                onChange={e => set('outputType', e.target.value)}
                className="ui-input"
              >
                {OUTPUT_TYPES.map(t => <option key={t}>{t}</option>)}
              </select>
            </div>
          </div>

          {/* Input Schema */}
          <div>
            <label className="form-label">Input Fields</label>
            {(form.inputSchema ?? []).map((f, i) => (
              <div key={i} className="flex items-center gap-2 mb-1 bg-gray-50 rounded-lg px-3 py-1.5 text-sm">
                <span className="font-medium text-gray-800 w-24 truncate">{f.label}</span>
                <span className="text-gray-400 text-xs">{f.name}</span>
                <span className="text-xs px-1.5 py-0.5 bg-gray-200 rounded text-gray-600">{f.type}</span>
                {f.required && <span className="text-xs text-red-500">required</span>}
                <button onClick={() => removeField(i)} className="ml-auto text-gray-400 hover:text-red-500"><X size={12} /></button>
              </div>
            ))}
            <div className="flex gap-2 mt-2">
              <input
                value={newField.name ?? ''}
                onChange={e => setNewField(p => ({ ...p, name: e.target.value }))}
                placeholder="field_name"
                className="w-28 border border-gray-200 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-brand-500 font-mono"
              />
              <input
                value={newField.label ?? ''}
                onChange={e => setNewField(p => ({ ...p, label: e.target.value }))}
                placeholder="Label"
                className="flex-1 border border-gray-200 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
              <select
                value={newField.type ?? 'text'}
                onChange={e => setNewField(p => ({ ...p, type: e.target.value as any }))}
                className="w-24 border border-gray-200 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-brand-500"
              >
                {FIELD_TYPES.map(t => <option key={t}>{t}</option>)}
              </select>
              <button onClick={addField} className="px-3 py-1 bg-brand-600 text-white rounded-lg text-xs font-medium hover:bg-brand-700">
                Add
              </button>
            </div>
          </div>

          {/* Test panel */}
          {fn.id && (
            <div className="border border-dashed border-gray-200 rounded-xl p-4">
              <p className="text-xs font-medium text-gray-600 mb-3">Test this function</p>
              {(form.inputSchema ?? []).map(f => (
                <div key={f.name} className="mb-2">
                  <label className="block text-xs text-gray-500 mb-0.5">{f.label}</label>
                  <input
                    value={testInputs[f.name] ?? ''}
                    onChange={e => setTestInputs(p => ({ ...p, [f.name]: e.target.value }))}
                    className="w-full border border-gray-200 rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-brand-400"
                  />
                </div>
              ))}
              {!form.inputSchema?.length && (
                <input
                  value={testInputs['text'] ?? ''}
                  onChange={e => setTestInputs({ text: e.target.value })}
                  placeholder="Enter test input text…"
                  className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-brand-400 mb-2"
                />
              )}
              <button
                onClick={handleTest}
                disabled={testing}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-purple-600 text-white rounded-lg text-xs font-medium hover:bg-purple-700 disabled:opacity-50"
              >
                {testing ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
                Run Test
              </button>
              {testResult && (
                <pre className="mt-3 bg-gray-900 text-green-400 rounded-lg p-3 text-xs overflow-x-auto whitespace-pre-wrap">
                  {testResult}
                </pre>
              )}
            </div>
          )}
        </div>
        <div className="px-6 pb-6 flex gap-3">
          <button onClick={onClose} className="flex-1 py-2 border border-gray-200 rounded-xl text-sm text-gray-600 hover:bg-gray-50">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={isSaving || !form.name || !form.systemPrompt}
            className="flex-1 py-2 bg-brand-600 text-white rounded-xl text-sm font-semibold hover:bg-brand-700 disabled:opacity-50"
          >
            {isSaving ? 'Saving…' : fn.id ? 'Save Changes' : 'Create Function'}
          </button>
        </div>
      </div>
    </div>
  );
}

function FunctionsTab() {
  const { data: fns = [], isLoading } = useCustomFunctions();
  const deleteFn = useDeleteFunction();
  const updateFn = useUpdateFunction();
  const [editing, setEditing] = useState<Partial<CustomAIFunction> | null>(null);

  if (isLoading) return <div className="py-16 text-center text-gray-400"><Loader2 size={24} className="animate-spin mx-auto" /></div>;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-gray-500">Build reusable AI functions your team can call across the product.</p>
        <button
          onClick={() => setEditing(EMPTY_FN)}
          className="flex items-center gap-1.5 px-3 py-2 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700"
        >
          <Plus size={15} /> New Function
        </button>
      </div>

      {fns.length === 0 ? (
        <div className="py-16 text-center text-gray-400 border-2 border-dashed border-gray-200 rounded-xl">
          <Zap size={32} className="mx-auto mb-3 opacity-30" />
          <p className="font-medium">No custom functions yet</p>
          <p className="text-sm mt-1">Create your first AI function to get started.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {fns.map(fn => (
            <div key={fn.id} data-testid="ai-function-card" className={`bg-white rounded-xl border shadow-sm p-4 ${!fn.isActive ? 'opacity-60' : ''}`}>
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-lg bg-purple-100 flex items-center justify-center flex-shrink-0">
                  <Zap size={15} className="text-purple-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="font-semibold text-gray-900 text-sm">{fn.name}</span>
                    <span className="text-xs px-1.5 py-0.5 bg-gray-100 text-gray-600 rounded">{fn.outputType}</span>
                    {fn.runCount > 0 && (
                      <span className="text-xs text-gray-400">{fn.runCount} runs</span>
                    )}
                  </div>
                  {fn.description && <p className="text-xs text-gray-500">{fn.description}</p>}
                  {fn.inputSchema?.length > 0 && (
                    <p className="text-xs text-gray-400 mt-1">
                      Inputs: {fn.inputSchema.map(f => f.label).join(', ')}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => updateFn.mutate({ id: fn.id, isActive: !fn.isActive })}
                    className="text-gray-400 hover:text-brand-600"
                    title={fn.isActive ? 'Disable' : 'Enable'}
                  >
                    {fn.isActive ? <ToggleRight size={18} className="text-brand-600" /> : <ToggleLeft size={18} />}
                  </button>
                  <button onClick={() => setEditing(fn)} className="text-gray-400 hover:text-brand-600">
                    <Pencil size={15} />
                  </button>
                  <button
                    onClick={() => { if (window.confirm('Delete this function?')) deleteFn.mutate(fn.id); }}
                    className="text-gray-400 hover:text-red-500"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && <FunctionEditor fn={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

// ─── Tab: Custom Scripts ──────────────────────────────────────────────────────

const EMPTY_SCRIPT: Partial<CustomScript> = {
  name: '', description: '', entityType: 'ticket', trigger: 'onLoad',
  script: SCRIPT_TEMPLATE, isActive: true,
};

function ScriptEditor({ script, onClose }: { script: Partial<CustomScript>; onClose: () => void }) {
  const [form, setForm] = useState({ ...EMPTY_SCRIPT, ...script });
  const [validation, setValidation] = useState<{ valid: boolean; error?: string } | null>(null);

  const createScript = useCreateScript();
  const updateScript = useUpdateScript();
  const validate     = useValidateScript();

  function set(k: string, v: any) { setForm(p => ({ ...p, [k]: v })); }

  async function handleValidate() {
    const r = await validate.mutateAsync(form.script ?? '');
    setValidation(r);
  }

  async function handleSave() {
    if (script.id) await updateScript.mutateAsync({ id: script.id, ...form });
    else           await createScript.mutateAsync(form);
    onClose();
  }

  const isSaving = createScript.isPending || updateScript.isPending;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div role="dialog" aria-modal="true" className="bg-white rounded-2xl w-full max-w-3xl shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="p-6 border-b border-gray-100 flex items-center justify-between">
          <h3 className="font-semibold text-gray-900">{script.id ? 'Edit Script' : 'New Custom Script'}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
        </div>
        <div className="p-6 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label className="form-label">Script Name *</label>
              <input
                value={form.name ?? ''}
                onChange={e => set('name', e.target.value)}
                placeholder="e.g. Auto-set priority from keywords"
                className="ui-input"
              />
            </div>
            <div>
              <label className="form-label">Entity Type</label>
              <select
                value={form.entityType ?? 'ticket'}
                onChange={e => set('entityType', e.target.value)}
                className="ui-input capitalize"
              >
                {ENTITY_TYPES.map(t => <option key={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className="form-label">Trigger</label>
              <select
                value={form.trigger ?? 'onLoad'}
                onChange={e => set('trigger', e.target.value)}
                className="ui-input"
              >
                {TRIGGERS.map(t => <option key={t}>{t}</option>)}
              </select>
            </div>
            {form.trigger === 'onFieldChange' && (
              <div>
                <label className="form-label">Field Target <span className="text-gray-400">(leave blank for all fields)</span></label>
                <input
                  value={form.fieldTarget ?? ''}
                  onChange={e => set('fieldTarget', e.target.value)}
                  placeholder="e.g. priority"
                  className="ui-input font-mono"
                />
              </div>
            )}
            <div className="col-span-2">
              <label className="form-label">Description</label>
              <input
                value={form.description ?? ''}
                onChange={e => set('description', e.target.value)}
                placeholder="What does this script do?"
                className="ui-input"
              />
            </div>
          </div>

          {/* Code editor */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-medium text-gray-600">Script <span className="text-gray-400">(JavaScript)</span></label>
              <button
                onClick={handleValidate}
                disabled={validate.isPending}
                className="flex items-center gap-1 text-xs text-brand-600 hover:text-brand-700"
              >
                {validate.isPending ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
                Validate syntax
              </button>
            </div>
            <textarea
              rows={14}
              value={form.script ?? ''}
              onChange={e => { set('script', e.target.value); setValidation(null); }}
              className="ui-input resize-y font-mono bg-gray-950 text-gray-100"
              spellCheck={false}
            />
            {validation && (
              <div className={`mt-1.5 flex items-center gap-1.5 text-xs ${validation.valid ? 'text-green-600' : 'text-red-600'}`}>
                {validation.valid
                  ? <><CheckCircle2 size={13} /> Syntax OK — script is valid</>
                  : <><XCircle size={13} /> {validation.error}</>
                }
              </div>
            )}
          </div>

          {/* Context reference */}
          <details className="text-xs text-gray-500">
            <summary className="cursor-pointer font-medium text-gray-600 hover:text-gray-800">Available context API</summary>
            <pre className="mt-2 bg-gray-50 rounded-lg p-3 text-xs overflow-x-auto">{`context.entity          // current form data (object)
context.field           // { name, value } — only on onFieldChange
context.user            // { id, name, role }
context.setValue(field, value)   // set a form field
context.setError(field, message) // show validation error
context.notify(msg, type?)       // toast: info|success|warning|error
await context.ai(prompt)         // call AI, returns string`}</pre>
          </details>
        </div>
        <div className="px-6 pb-6 flex gap-3">
          <button onClick={onClose} className="flex-1 py-2 border border-gray-200 rounded-xl text-sm text-gray-600 hover:bg-gray-50">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={isSaving || !form.name || !form.script}
            className="flex-1 py-2 bg-brand-600 text-white rounded-xl text-sm font-semibold hover:bg-brand-700 disabled:opacity-50"
          >
            {isSaving ? 'Saving…' : script.id ? 'Save Changes' : 'Create Script'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ScriptsTab() {
  const { data: scripts = [], isLoading } = useCustomScripts();
  const deleteScript = useDeleteScript();
  const updateScript = useUpdateScript();
  const [editing, setEditing] = useState<Partial<CustomScript> | null>(null);

  if (isLoading) return <div className="py-16 text-center text-gray-400"><Loader2 size={24} className="animate-spin mx-auto" /></div>;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-gray-500">
          Write JavaScript that runs on form events — auto-fill fields, validate inputs, call AI, or show notifications.
        </p>
        <button
          onClick={() => setEditing(EMPTY_SCRIPT)}
          className="flex items-center gap-1.5 px-3 py-2 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700"
        >
          <Plus size={15} /> New Script
        </button>
      </div>

      {scripts.length === 0 ? (
        <div className="py-16 text-center text-gray-400 border-2 border-dashed border-gray-200 rounded-xl">
          <Code2 size={32} className="mx-auto mb-3 opacity-30" />
          <p className="font-medium">No custom scripts yet</p>
          <p className="text-sm mt-1">Create scripts to automate form behaviour across your CRM & IT Desk forms.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {scripts.map(s => (
            <div key={s.id} data-testid="ai-script-card" className={`bg-white rounded-xl border shadow-sm p-4 ${!s.isActive ? 'opacity-60' : ''}`}>
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-lg bg-emerald-100 flex items-center justify-center flex-shrink-0">
                  <Code2 size={15} className="text-emerald-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="font-semibold text-gray-900 text-sm">{s.name}</span>
                    <span className="text-xs px-1.5 py-0.5 bg-emerald-100 text-emerald-700 rounded capitalize">{s.entityType}</span>
                    <span className="text-xs px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded">{s.trigger}</span>
                    {s.fieldTarget && (
                      <span className="text-xs px-1.5 py-0.5 bg-gray-100 text-gray-600 rounded font-mono">.{s.fieldTarget}</span>
                    )}
                  </div>
                  {s.description && <p className="text-xs text-gray-500">{s.description}</p>}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => updateScript.mutate({ id: s.id, isActive: !s.isActive })}
                    className="text-gray-400 hover:text-brand-600"
                  >
                    {s.isActive ? <ToggleRight size={18} className="text-brand-600" /> : <ToggleLeft size={18} />}
                  </button>
                  <button onClick={() => setEditing(s)} className="text-gray-400 hover:text-brand-600">
                    <Pencil size={15} />
                  </button>
                  <button
                    onClick={() => { if (window.confirm('Delete this script?')) deleteScript.mutate(s.id); }}
                    className="text-gray-400 hover:text-red-500"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && <ScriptEditor script={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

const TABS = [
  { id: 'context',   label: 'Business Context', icon: Building2, desc: 'Domain & terminology' },
  { id: 'functions', label: 'Custom Functions',  icon: Zap,       desc: 'Build AI-powered functions' },
  { id: 'scripts',   label: 'Custom Scripts',    icon: Code2,     desc: 'Form & field automation' },
] as const;

type TabId = typeof TABS[number]['id'];

export default function AIStudioPage() {
  const [tab, setTab] = useState<TabId>('context');

  return (
    <div className="p-6 max-w-5xl mx-auto animate-slide-up">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-purple-500 to-brand-600 flex items-center justify-center">
          <Brain size={20} className="text-white" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">AI Studio</h1>
          <p className="text-sm text-gray-500">Configure your AI to match your domain, build custom functions, and automate forms</p>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 mb-6 bg-gray-100 rounded-xl p-1">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex-1 flex items-center justify-center gap-2 py-2.5 px-3 rounded-lg text-sm font-medium transition-all ${
              tab === t.id
                ? 'bg-white shadow text-brand-700'
                : 'text-gray-500 hover:text-gray-800'
            }`}
          >
            <t.icon size={15} />
            <span className="hidden sm:inline">{t.label}</span>
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div>
        {tab === 'context'   && <BusinessContextTab />}
        {tab === 'functions' && <FunctionsTab />}
        {tab === 'scripts'   && <ScriptsTab />}
      </div>
    </div>
  );
}
