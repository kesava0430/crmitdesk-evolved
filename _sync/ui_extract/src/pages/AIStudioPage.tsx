import { useState } from 'react';
import {
  Brain, Building2, Zap, Code2, Plus, Trash2, Play, Save,
  CheckCircle2, XCircle,
  Pencil, ToggleLeft, ToggleRight, X,
} from 'lucide-react';
import {
  AiGeneratedTag, AiInfo,
  Alert, Badge, Button, Card, Checkbox, EmptyState, Field, IconButton, Input, Modal,
  PageBody, PageHeader, SectionHeader, Select, SkeletonCard, Tabs, Textarea, Toolbar,
} from '../shared/components';
import {
  useBusinessContext, useSaveBusinessContext,
  useGenerateSetup, useApplySetup,
  useCustomFunctions, useCreateFunction, useUpdateFunction, useDeleteFunction, useRunFunction,
  useCustomScripts, useCreateScript, useUpdateScript, useDeleteScript, useValidateScript,
  type CustomAIFunction, type CustomScript, type InputField,
  type LabelOverrides, type DraftWorkflowRule,
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

const TONES = [
  { key: 'professional' as const, label: 'Professional' },
  { key: 'casual'       as const, label: 'Casual' },
  { key: 'technical'    as const, label: 'Technical' },
];

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

/** A monospace code well. `bg-gray-950 text-gray-100` was a hardcoded dark
    panel that stayed black in light mode and clashed with every theme; the
    sunken surface token gives the same "this is code, not prose" reading
    while following the theme. */
const CODE_SURFACE = 'font-mono !bg-surface-sunken text-fg';

// ─── Generate Setup (labels + draft workflow rules from Business Context) ─────
// Two-step propose/confirm: generateSetup only reads context and calls the
// model (nothing persisted yet); this component lets the org admin review
// and edit the result before applySetup actually writes anything. Same
// pattern as the AI Command Bar's propose-then-confirm action cards.

const ENTITY_DISPLAY: Record<string, string> = {
  ticket: 'Ticket', deal: 'Deal', lead: 'Lead', contact: 'Contact',
};
const FIELD_DISPLAY: Record<string, Record<string, string>> = {
  ticket:  { title: 'Title', priority: 'Priority', status: 'Status', description: 'Description' },
  deal:    { title: 'Title', value: 'Value', stage: 'Stage' },
  lead:    { name: 'Name', status: 'Status', source: 'Source' },
  contact: { name: 'Name', email: 'Email', phone: 'Phone', jobTitle: 'Job Title' },
};

function GenerateSetupSection({ hasContext }: { hasContext: boolean }) {
  const generate = useGenerateSetup();
  const apply = useApplySetup();

  const [labels, setLabels] = useState<LabelOverrides | null>(null);
  const [enabledEntities, setEnabledEntities] = useState<Set<string>>(new Set());
  const [enabledFields, setEnabledFields] = useState<Set<string>>(new Set()); // "entity.field"
  const [rules, setRules] = useState<DraftWorkflowRule[]>([]);
  const [enabledRules, setEnabledRules] = useState<Set<string>>(new Set());
  // Per-rule fill-ins for params the AI intentionally left blank (userId/to/url)
  const [ruleInputs, setRuleInputs] = useState<Record<string, Record<string, string>>>({});

  async function handleGenerate() {
    const result = await generate.mutateAsync();
    setLabels(result.labelOverrides);
    setEnabledEntities(new Set(Object.keys(result.labelOverrides.entities ?? {})));
    setEnabledFields(new Set(
      Object.entries(result.labelOverrides.fields ?? {}).flatMap(([entity, fields]) =>
        Object.keys(fields as object).map(f => `${entity}.${f}`))
    ));
    setRules(result.workflowRules);
    setEnabledRules(new Set(result.workflowRules.map(r => r._draftId)));
    setRuleInputs({});
  }

  function updateEntityLabel(entity: string, form: 'singular' | 'plural', value: string) {
    setLabels(prev => prev && ({
      ...prev,
      entities: { ...prev.entities, [entity]: { ...(prev.entities as any)?.[entity], [form]: value } },
    }));
  }

  function updateFieldLabel(entity: string, field: string, value: string) {
    setLabels(prev => prev && ({
      ...prev,
      fields: { ...prev.fields, [entity]: { ...(prev.fields as any)?.[entity], [field]: value } },
    }));
  }

  function toggle(set: Set<string>, setSet: (s: Set<string>) => void, key: string) {
    const next = new Set(set);
    if (next.has(key)) next.delete(key); else next.add(key);
    setSet(next);
  }

  /** Merges any admin-filled ruleInputs into a rule's action params. */
  function resolveRule(rule: DraftWorkflowRule): DraftWorkflowRule {
    const fills = ruleInputs[rule._draftId] ?? {};
    return {
      ...rule,
      actions: rule.actions.map(a => {
        const filled = { ...a.params };
        for (const need of rule.needsInput) {
          const [type, key] = need.split('.');
          if (a.type === type && fills[need]) filled[key] = fills[need];
        }
        return { ...a, params: filled };
      }),
    };
  }

  function stillNeedsInput(rule: DraftWorkflowRule): string[] {
    const fills = ruleInputs[rule._draftId] ?? {};
    return rule.needsInput.filter(need => !fills[need]?.trim());
  }

  async function handleApply() {
    const selectedLabels: LabelOverrides = { entities: {}, fields: {} };
    for (const entity of enabledEntities) {
      if ((labels?.entities as any)?.[entity]) (selectedLabels.entities as any)[entity] = (labels!.entities as any)[entity];
    }
    for (const key of enabledFields) {
      const [entity, field] = key.split('.');
      const val = (labels?.fields as any)?.[entity]?.[field];
      if (val === undefined) continue;
      (selectedLabels.fields as any)[entity] = { ...(selectedLabels.fields as any)[entity], [field]: val };
    }

    const selectedRules = rules
      .filter(r => enabledRules.has(r._draftId))
      .map(resolveRule)
      .filter(r => stillNeedsInput(r).length === 0); // server would drop these anyway — filter client-side so the result count is honest

    await apply.mutateAsync({ labelOverrides: selectedLabels, workflowRules: selectedRules });
    setLabels(null);
    setRules([]);
  }

  const hasEntityLabels = labels && Object.keys(labels.entities ?? {}).length > 0;
  const hasFieldLabels = labels && Object.keys(labels.fields ?? {}).length > 0;

  return (
    <div className="pt-6 mt-6 border-t border-line-subtle space-y-3">
      <SectionHeader
        title={<span className="inline-flex items-center gap-1">Generate Setup <AiInfo id="studio.generateSetup" /></span>}
        subtitle={'Uses your industry and company description above to propose relabeled terminology (e.g. "Tickets" → "Cases") and a handful of draft automation rules tailored to your business — nothing changes until you review and apply.'}
      />

      {!hasContext && (
        <Alert tone="warning">
          Fill in and save your industry and company description above first.
        </Alert>
      )}

      {!labels && !rules.length && (
        <Button
          variant="outline"
          icon={<Brain size={16} />}
          onClick={handleGenerate}
          disabled={!hasContext}
          loading={generate.isPending}
        >
          {generate.isPending ? 'Generating…' : 'Generate setup'}
        </Button>
      )}

      {generate.isError && (
        <Alert tone="danger">
          {(generate.error as any)?.response?.data?.error || 'Could not generate a setup — try again.'}
        </Alert>
      )}

      {(hasEntityLabels || hasFieldLabels) && labels && (
        <div className="mt-4 space-y-4">
          <div>
            <p className="text-sm font-semibold text-fg mb-2">Suggested terminology</p>
            <div className="space-y-2">
              {Object.entries(labels.entities ?? {}).map(([entity, names]) => (
                <Card key={entity} padding="sm" flat>
                  <Checkbox
                    className="mb-2"
                    checked={enabledEntities.has(entity)}
                    onChange={() => toggle(enabledEntities, setEnabledEntities, entity)}
                    label={<span className="font-medium">{ENTITY_DISPLAY[entity] ?? entity} → {(names as any).plural}</span>}
                  />
                  <div className="grid grid-cols-2 gap-2 pl-6 mb-2">
                    <Input inputSize="sm" value={(names as any).singular} placeholder="Singular"
                      aria-label={`${ENTITY_DISPLAY[entity] ?? entity} singular label`}
                      onChange={e => updateEntityLabel(entity, 'singular', e.target.value)} />
                    <Input inputSize="sm" value={(names as any).plural} placeholder="Plural"
                      aria-label={`${ENTITY_DISPLAY[entity] ?? entity} plural label`}
                      onChange={e => updateEntityLabel(entity, 'plural', e.target.value)} />
                  </div>
                  {(labels.fields as any)?.[entity] && (
                    <div className="pl-6 space-y-1.5">
                      {Object.entries((labels.fields as any)[entity] as Record<string, string>).map(([field, val]) => (
                        <div key={field} className="flex items-center gap-2">
                          <Checkbox
                            checked={enabledFields.has(`${entity}.${field}`)}
                            onChange={() => toggle(enabledFields, setEnabledFields, `${entity}.${field}`)}
                            label={<span className="text-xs text-fg-muted">{FIELD_DISPLAY[entity]?.[field] ?? field}:</span>}
                          />
                          <Input
                            inputSize="sm"
                            className="flex-1"
                            aria-label={`${FIELD_DISPLAY[entity]?.[field] ?? field} label`}
                            value={val}
                            onChange={e => updateFieldLabel(entity, field, e.target.value)}
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </Card>
              ))}
            </div>
          </div>

          {rules.length > 0 && (
            <div>
              <p className="text-sm font-semibold text-fg mb-2">Draft automation rules</p>
              <div className="space-y-2">
                {rules.map(rule => {
                  const missing = stillNeedsInput(rule);
                  return (
                    <Card key={rule._draftId} padding="sm" flat>
                      <Checkbox
                        checked={enabledRules.has(rule._draftId)}
                        onChange={() => toggle(enabledRules, setEnabledRules, rule._draftId)}
                        label={<span className="font-medium">{rule.name}</span>}
                        hint={
                          <>
                            {rule.description && <span className="block">{rule.description}</span>}
                            <span className="block text-[11px] text-fg-subtle mt-1">
                              Trigger: {rule.trigger} · Actions: {rule.actions.map(a => a.type).join(', ')}
                            </span>
                          </>
                        }
                      />
                      {rule.needsInput.length > 0 && (
                        <div className="pl-6 mt-2 space-y-1.5">
                          {rule.needsInput.map(need => (
                            <div key={need} className="flex items-center gap-2">
                              <span className="text-[11px] text-fg-muted w-32 shrink-0">{need}:</span>
                              <Input
                                inputSize="sm"
                                className="flex-1"
                                aria-label={need}
                                placeholder={need.endsWith('.userId') ? 'User ID' : need.endsWith('.to') ? 'Recipient email' : 'Webhook URL'}
                                value={ruleInputs[rule._draftId]?.[need] ?? ''}
                                onChange={e => setRuleInputs(p => ({ ...p, [rule._draftId]: { ...p[rule._draftId], [need]: e.target.value } }))}
                              />
                            </div>
                          ))}
                          {missing.length > 0 && (
                            <p className="text-[11px] text-warning">Fill these in, or this rule won't be created.</p>
                          )}
                        </div>
                      )}
                    </Card>
                  );
                })}
              </div>
            </div>
          )}

          <div className="flex items-center gap-3">
            <Button icon={<CheckCircle2 size={16} />} onClick={handleApply} loading={apply.isPending}>
              Apply selected
            </Button>
            <Button variant="ghost" onClick={() => { setLabels(null); setRules([]); }}>
              Discard
            </Button>
          </div>

          {apply.isSuccess && apply.data && (
            <Alert tone="success">
              Applied — {apply.data.rulesCreated} rule{apply.data.rulesCreated === 1 ? '' : 's'} created
              {apply.data.rulesSkipped > 0 ? `, ${apply.data.rulesSkipped} skipped (still missing required input)` : ''}.
            </Alert>
          )}
        </div>
      )}
    </div>
  );
}

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

  if (isLoading) {
    return (
      <div className="max-w-2xl space-y-4" aria-hidden="true">
        <SkeletonCard lines={4} />
        <SkeletonCard lines={3} />
      </div>
    );
  }

  return (
    <div className="max-w-2xl space-y-6">
      <p className="text-sm text-fg-muted flex items-center gap-1 flex-wrap">
        <span>Tell the AI about your business so every AI feature speaks your language and understands your domain.</span>
        <AiInfo id="studio.context" />
      </p>

      {/* Industry */}
      <Field label="Industry">
        <Select
          value={current.industry ?? ''}
          onChange={e => set('industry', e.target.value)}
          placeholder="Select your industry…"
        >
          {INDUSTRIES.map(i => <option key={i}>{i}</option>)}
        </Select>
      </Field>

      {/* Company description */}
      <Field label="Company Description">
        <Textarea
          rows={3}
          value={current.companyDesc ?? ''}
          onChange={e => set('companyDesc', e.target.value)}
          placeholder="Briefly describe what your company does, who your customers are, and your main business goals…"
          className="resize-none"
        />
      </Field>

      {/* Tone */}
      <Field label="AI Response Tone">
        <Tabs
          items={TONES}
          value={(current.tone ?? 'professional') as typeof TONES[number]['key']}
          onChange={t => set('tone', t)}
          variant="segmented"
          aria-label="AI Response Tone"
        />
      </Field>

      {/* Domain Terminology */}
      <Field
        label="Domain Terminology"
        hint={'Teach the AI your company’s specific terms. E.g., "policy" = "insurance coverage", "client" = "patient".'}
      >
        <div className="flex gap-2 mb-2">
          <Input
            className="flex-1"
            aria-label="Term"
            value={termKey}
            onChange={e => setTermKey(e.target.value)}
            placeholder="Term (e.g. patient)"
          />
          <Input
            className="flex-1"
            aria-label="Meaning"
            value={termVal}
            onChange={e => setTermVal(e.target.value)}
            placeholder="Means (e.g. customer with active policy)"
          />
          <Button onClick={addTerm}>Add</Button>
        </div>
        {Object.entries(current.terminology ?? {}).length > 0 && (
          <div className="space-y-1">
            {Object.entries(current.terminology ?? {}).map(([k, v]) => (
              <div key={k} className="flex items-center gap-2 bg-surface-sunken rounded-btn px-3 py-1.5 text-sm">
                <span className="font-medium text-fg">{k}</span>
                <span className="text-fg-subtle">→</span>
                <span className="text-fg-muted flex-1">{v as string}</span>
                <IconButton
                  size="xs"
                  tone="danger"
                  label={`Remove ${k}`}
                  onClick={() => removeTerm(k)}
                  icon={<X size={14} />}
                />
              </div>
            ))}
          </div>
        )}
      </Field>

      {/* Extra system context */}
      <Field label="Additional AI Instructions">
        <Textarea
          rows={3}
          value={current.customSystem ?? ''}
          onChange={e => set('customSystem', e.target.value)}
          placeholder="Any extra instructions injected into every AI prompt. E.g., 'Always comply with HIPAA guidelines. Never suggest specific medications.'"
          className="resize-none"
        />
      </Field>

      <Button size="lg" icon={<Save size={16} />} onClick={() => save.mutate(current)} loading={save.isPending}>
        Save Business Context
      </Button>
      {save.isSuccess && (
        <Alert tone="success">Saved — all AI features now use this context.</Alert>
      )}

      <GenerateSetupSection hasContext={!!(current.industry || current.companyDesc)} />
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
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={fn.id ? 'Edit Function' : 'New Custom AI Function'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button
            onClick={handleSave}
            loading={isSaving}
            disabled={!form.name || !form.systemPrompt}
          >
            {isSaving ? 'Saving…' : fn.id ? 'Save Changes' : 'Create Function'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Function Name" required>
          <Input
            value={form.name ?? ''}
            onChange={e => set('name', e.target.value)}
            placeholder="e.g. Classify Patient Urgency"
          />
        </Field>
        <Field label="Description">
          <Input
            value={form.description ?? ''}
            onChange={e => set('description', e.target.value)}
            placeholder="What does this function do?"
          />
        </Field>
        <Field label="System Prompt" required>
          <Textarea
            rows={5}
            value={form.systemPrompt ?? ''}
            onChange={e => set('systemPrompt', e.target.value)}
            placeholder="You are a helpful assistant specializing in… Analyze the provided inputs and return…"
            className="resize-none font-mono"
          />
        </Field>
        <Field label="Output Type" className="sm:w-1/2">
          <Select value={form.outputType ?? 'text'} onChange={e => set('outputType', e.target.value)}>
            {OUTPUT_TYPES.map(t => <option key={t}>{t}</option>)}
          </Select>
        </Field>

        {/* Input Schema */}
        <Field label="Input Fields">
          {(form.inputSchema ?? []).map((f, i) => (
            <div key={i} className="flex items-center gap-2 mb-1 bg-surface-sunken rounded-btn px-3 py-1.5 text-sm">
              <span className="font-medium text-fg w-24 truncate">{f.label}</span>
              <span className="text-fg-subtle text-xs font-mono">{f.name}</span>
              <Badge variant="gray" size="sm">{f.type}</Badge>
              {f.required && <Badge variant="red" size="sm">required</Badge>}
              <IconButton
                size="xs"
                tone="danger"
                className="ml-auto"
                label={`Remove ${f.label}`}
                onClick={() => removeField(i)}
                icon={<X size={12} />}
              />
            </div>
          ))}
          <div className="flex gap-2 mt-2">
            <Input
              inputSize="sm"
              className="w-28 font-mono"
              aria-label="Field name"
              value={newField.name ?? ''}
              onChange={e => setNewField(p => ({ ...p, name: e.target.value }))}
              placeholder="field_name"
            />
            <Input
              inputSize="sm"
              className="flex-1"
              aria-label="Field label"
              value={newField.label ?? ''}
              onChange={e => setNewField(p => ({ ...p, label: e.target.value }))}
              placeholder="Label"
            />
            <Select
              selectSize="sm"
              className="w-24"
              aria-label="Field type"
              value={newField.type ?? 'text'}
              onChange={e => setNewField(p => ({ ...p, type: e.target.value as any }))}
            >
              {FIELD_TYPES.map(t => <option key={t}>{t}</option>)}
            </Select>
            <Button size="sm" onClick={addField}>Add</Button>
          </div>
        </Field>

        {/* Test panel */}
        {fn.id && (
          <Card padding="sm" tone="sunken" flat className="border-dashed">
            <p className="text-xs font-medium text-fg-muted mb-3">Test this function</p>
            {(form.inputSchema ?? []).map(f => (
              <Field key={f.name} label={f.label} className="mb-2">
                <Input
                  inputSize="sm"
                  value={testInputs[f.name] ?? ''}
                  onChange={e => setTestInputs(p => ({ ...p, [f.name]: e.target.value }))}
                />
              </Field>
            ))}
            {!form.inputSchema?.length && (
              <Input
                inputSize="sm"
                className="mb-2"
                aria-label="Test input text"
                value={testInputs['text'] ?? ''}
                onChange={e => setTestInputs({ text: e.target.value })}
                placeholder="Enter test input text…"
              />
            )}
            <Button size="sm" icon={<Play size={13} />} onClick={handleTest} loading={testing}>
              Run Test
            </Button>
            {testResult && (
              <div className="mt-3">
                <AiGeneratedTag className="mb-1.5" />
                <pre className="rounded-btn p-3 text-xs font-mono overflow-x-auto whitespace-pre-wrap border border-line bg-surface text-fg">
                  {testResult}
                </pre>
              </div>
            )}
          </Card>
        )}
      </div>
    </Modal>
  );
}

function FunctionsTab() {
  const { data: fns = [], isLoading } = useCustomFunctions();
  const deleteFn = useDeleteFunction();
  const updateFn = useUpdateFunction();
  const [editing, setEditing] = useState<Partial<CustomAIFunction> | null>(null);

  if (isLoading) {
    return (
      <div className="space-y-3" aria-hidden="true">
        <SkeletonCard lines={2} />
        <SkeletonCard lines={2} />
        <SkeletonCard lines={2} />
      </div>
    );
  }

  return (
    <div>
      <Toolbar
        className="mb-4"
        right={
          <Button icon={<Plus size={15} />} onClick={() => setEditing(EMPTY_FN)}>
            New Function
          </Button>
        }
      >
        <p className="text-sm text-fg-muted flex items-center gap-1">
          Build reusable AI functions your team can call across the product.
          <AiInfo id="studio.function" />
        </p>
      </Toolbar>

      {fns.length === 0 ? (
        <EmptyState
          icon={<Zap />}
          title="No custom functions yet"
          description="Create your first AI function to get started."
          action={{ label: 'New Function', onClick: () => setEditing(EMPTY_FN) }}
        />
      ) : (
        <div className="space-y-3">
          {fns.map(fn => (
            <Card key={fn.id} data-testid="ai-function-card" padding="sm" className={fn.isActive ? '' : 'opacity-60'}>
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-btn bg-accent-soft flex items-center justify-center flex-shrink-0">
                  <Zap size={15} className="text-accent" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="font-semibold text-fg text-sm">{fn.name}</span>
                    <Badge variant="gray" size="sm">{fn.outputType}</Badge>
                    {fn.runCount > 0 && (
                      <span className="text-xs text-fg-subtle tabular-nums">{fn.runCount} runs</span>
                    )}
                  </div>
                  {fn.description && <p className="text-xs text-fg-muted">{fn.description}</p>}
                  {fn.inputSchema?.length > 0 && (
                    <p className="text-xs text-fg-subtle mt-1">
                      Inputs: {fn.inputSchema.map(f => f.label).join(', ')}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <IconButton
                    label={fn.isActive ? 'Disable' : 'Enable'}
                    tone="accent"
                    onClick={() => updateFn.mutate({ id: fn.id, isActive: !fn.isActive })}
                    icon={fn.isActive ? <ToggleRight size={18} className="text-accent" /> : <ToggleLeft size={18} />}
                  />
                  <IconButton label="Edit function" tone="accent" onClick={() => setEditing(fn)} icon={<Pencil size={15} />} />
                  <IconButton
                    label="Delete function"
                    tone="danger"
                    onClick={() => { if (window.confirm('Delete this function?')) deleteFn.mutate(fn.id); }}
                    icon={<Trash2 size={15} />}
                  />
                </div>
              </div>
            </Card>
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
    <Modal
      open
      onClose={onClose}
      size="xl"
      title={script.id ? 'Edit Script' : 'New Custom Script'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} loading={isSaving} disabled={!form.name || !form.script}>
            {isSaving ? 'Saving…' : script.id ? 'Save Changes' : 'Create Script'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Script Name" required>
          <Input
            value={form.name ?? ''}
            onChange={e => set('name', e.target.value)}
            placeholder="e.g. Auto-set priority from keywords"
          />
        </Field>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Entity Type">
            <Select value={form.entityType ?? 'ticket'} onChange={e => set('entityType', e.target.value)} className="capitalize">
              {ENTITY_TYPES.map(t => <option key={t}>{t}</option>)}
            </Select>
          </Field>
          <Field label="Trigger">
            <Select value={form.trigger ?? 'onLoad'} onChange={e => set('trigger', e.target.value)}>
              {TRIGGERS.map(t => <option key={t}>{t}</option>)}
            </Select>
          </Field>
          {form.trigger === 'onFieldChange' && (
            <Field label={<>Field Target <span className="text-fg-subtle">(leave blank for all fields)</span></>}>
              <Input
                value={form.fieldTarget ?? ''}
                onChange={e => set('fieldTarget', e.target.value)}
                placeholder="e.g. priority"
                className="font-mono"
              />
            </Field>
          )}
        </div>

        <Field label="Description">
          <Input
            value={form.description ?? ''}
            onChange={e => set('description', e.target.value)}
            placeholder="What does this script do?"
          />
        </Field>

        {/* Code editor */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="form-label !mb-0">Script <span className="text-fg-subtle">(JavaScript)</span></label>
            <Button
              variant="ghost"
              size="xs"
              icon={<CheckCircle2 size={12} />}
              onClick={handleValidate}
              loading={validate.isPending}
              className="!text-accent"
            >
              Validate syntax
            </Button>
          </div>
          <Textarea
            rows={14}
            value={form.script ?? ''}
            onChange={e => { set('script', e.target.value); setValidation(null); }}
            aria-label="Script (JavaScript)"
            className={CODE_SURFACE}
            spellCheck={false}
          />
          {validation && (
            <div className={`mt-1.5 flex items-center gap-1.5 text-xs ${validation.valid ? 'text-success' : 'text-danger'}`}>
              {validation.valid
                ? <><CheckCircle2 size={13} /> Syntax OK — script is valid</>
                : <><XCircle size={13} /> {validation.error}</>
              }
            </div>
          )}
        </div>

        {/* Context reference */}
        <details className="text-xs text-fg-muted">
          <summary className="cursor-pointer font-medium text-fg-muted hover:text-fg">Available context API</summary>
          <pre className="mt-2 bg-surface-sunken border border-line-subtle rounded-btn p-3 text-xs overflow-x-auto font-mono text-fg">{`context.entity          // current form data (object)
context.field           // { name, value } — only on onFieldChange
context.user            // { id, name, role }
context.setValue(field, value)   // set a form field
context.setError(field, message) // show validation error
context.notify(msg, type?)       // toast: info|success|warning|error
await context.ai(prompt)         // call AI, returns string`}</pre>
        </details>
      </div>
    </Modal>
  );
}

function ScriptsTab() {
  const { data: scripts = [], isLoading } = useCustomScripts();
  const deleteScript = useDeleteScript();
  const updateScript = useUpdateScript();
  const [editing, setEditing] = useState<Partial<CustomScript> | null>(null);

  if (isLoading) {
    return (
      <div className="space-y-3" aria-hidden="true">
        <SkeletonCard lines={2} />
        <SkeletonCard lines={2} />
        <SkeletonCard lines={2} />
      </div>
    );
  }

  return (
    <div>
      <Toolbar
        className="mb-4"
        right={
          <Button icon={<Plus size={15} />} onClick={() => setEditing(EMPTY_SCRIPT)}>
            New Script
          </Button>
        }
      >
        <p className="text-sm text-fg-muted">
          Write JavaScript that runs on form events — auto-fill fields, validate inputs, call AI, or show notifications.
        </p>
      </Toolbar>

      {scripts.length === 0 ? (
        <EmptyState
          icon={<Code2 />}
          title="No custom scripts yet"
          description="Create scripts to automate form behaviour across your CRM & IT Desk forms."
          action={{ label: 'New Script', onClick: () => setEditing(EMPTY_SCRIPT) }}
        />
      ) : (
        <div className="space-y-3">
          {scripts.map(s => (
            <Card key={s.id} data-testid="ai-script-card" padding="sm" className={s.isActive ? '' : 'opacity-60'}>
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-btn bg-success-soft flex items-center justify-center flex-shrink-0">
                  <Code2 size={15} className="text-success" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                    <span className="font-semibold text-fg text-sm">{s.name}</span>
                    <Badge variant="green" size="sm" className="capitalize">{s.entityType}</Badge>
                    <Badge variant="blue" size="sm">{s.trigger}</Badge>
                    {s.fieldTarget && (
                      <Badge variant="gray" size="sm" className="font-mono">.{s.fieldTarget}</Badge>
                    )}
                  </div>
                  {s.description && <p className="text-xs text-fg-muted">{s.description}</p>}
                </div>
                <div className="flex items-center gap-1">
                  <IconButton
                    label={s.isActive ? 'Disable' : 'Enable'}
                    tone="accent"
                    onClick={() => updateScript.mutate({ id: s.id, isActive: !s.isActive })}
                    icon={s.isActive ? <ToggleRight size={18} className="text-accent" /> : <ToggleLeft size={18} />}
                  />
                  <IconButton label="Edit script" tone="accent" onClick={() => setEditing(s)} icon={<Pencil size={15} />} />
                  <IconButton
                    label="Delete script"
                    tone="danger"
                    onClick={() => { if (window.confirm('Delete this script?')) deleteScript.mutate(s.id); }}
                    icon={<Trash2 size={15} />}
                  />
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {editing && <ScriptEditor script={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

const TABS = [
  { key: 'context'   as const, label: 'Business Context', icon: <Building2 size={15} /> },
  { key: 'functions' as const, label: 'Custom Functions',  icon: <Zap size={15} /> },
  { key: 'scripts'   as const, label: 'Custom Scripts',    icon: <Code2 size={15} /> },
];

type TabId = typeof TABS[number]['key'];

export default function AIStudioPage() {
  const [tab, setTab] = useState<TabId>('context');

  return (
    <div className="animate-slide-up">
      <PageHeader
        title="AI Studio"
        subtitle="Configure your AI to match your domain, build custom functions, and automate forms"
        below={<Tabs items={TABS} value={tab} onChange={setTab} variant="segmented" fill aria-label="AI Studio section" />}
      />

      <PageBody width="narrow">
        {tab === 'context'   && <BusinessContextTab />}
        {tab === 'functions' && <FunctionsTab />}
        {tab === 'scripts'   && <ScriptsTab />}
      </PageBody>
    </div>
  );
}
