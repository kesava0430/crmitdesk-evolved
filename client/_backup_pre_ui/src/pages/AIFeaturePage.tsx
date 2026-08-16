import { useState } from 'react';
import { Sparkles, Plus, Play, Trash2, ToggleLeft, ToggleRight, Zap, Bell, Mail, Tag, Route, BarChart3, ChevronDown, ChevronUp, Edit2 } from 'lucide-react';
import { useAIRules, useCreateAIRule, useUpdateAIRule, useDeleteAIRule, useRunAIRule, useBulkScoreLeads } from '../api/ai';
import { Button, Modal, Spinner, Badge, EmptyState } from '../shared/components';
import { AITypewriter } from '../shared/components/AITypewriter';

const TRIGGERS = [
  { value: 'TICKET_CREATED',       label: 'Ticket Created',        icon: '🎫', desc: 'Fires when a new support ticket is submitted' },
  { value: 'LEAD_SCORED',          label: 'Lead Scored',           icon: '🎯', desc: 'Fires after AI scores a lead' },
  { value: 'DEAL_STAGE_CHANGED',   label: 'Deal Stage Changed',    icon: '🤝', desc: 'Fires when a deal moves to a new stage' },
  { value: 'CONTACT_UPDATED',      label: 'Contact Updated',       icon: '👤', desc: 'Fires when a contact record is updated' },
  { value: 'TICKET_RESOLVED',      label: 'Ticket Resolved',       icon: '✅', desc: 'Fires when a ticket is marked resolved' },
  { value: 'MANUAL',               label: 'Manual / On Demand',    icon: '▶️', desc: 'Run this rule manually whenever needed' },
];

const ACTIONS = [
  { value: 'TAG',           label: 'Auto-Tag',          icon: <Tag size={16} />,       desc: 'Automatically add tags to the entity' },
  { value: 'ROUTE',         label: 'Smart Route',       icon: <Route size={16} />,     desc: 'Route to the right team or agent' },
  { value: 'EMAIL',         label: 'Generate Email',    icon: <Mail size={16} />,      desc: 'Draft a follow-up or notification email' },
  { value: 'NOTIFY',        label: 'Send Notification', icon: <Bell size={16} />,      desc: 'Alert the team with an AI insight' },
  { value: 'SCORE',         label: 'AI Score',          icon: <BarChart3 size={16} />, desc: 'Calculate a custom AI score' },
  { value: 'SUMMARIZE',     label: 'Summarize',         icon: <Zap size={16} />,       desc: 'Generate a concise AI summary' },
  { value: 'CUSTOM_PROMPT', label: 'Custom Prompt',     icon: <Sparkles size={16} />,  desc: 'Write your own AI instruction' },
];

const PROMPT_TEMPLATES: Record<string, string> = {
  TAG: 'Analyze this support ticket and extract 3-5 relevant keyword tags. Return only a JSON array of lowercase strings.',
  ROUTE: 'Based on this ticket\'s content and priority, determine the best team to handle it: Level 1 Support, Level 2 Technical, Security Team, or Management. Return JSON: {"team": "...", "reason": "1 sentence"}',
  EMAIL: 'Write a professional follow-up email based on this context. Return JSON: {"subject": "...", "body": "..."}',
  NOTIFY: 'Analyze this data and generate a brief, actionable alert for the team. Return JSON: {"title": "short alert", "message": "2 sentences", "priority": "low|medium|high"}',
  SCORE: 'Score the quality/risk/priority of this entity on a scale of 0-100. Return JSON: {"score": number, "grade": "A-F", "reason": "1 sentence"}',
  SUMMARIZE: 'Provide a concise 2-3 sentence summary of this content, highlighting the most important points.',
  CUSTOM_PROMPT: 'You are a helpful CRM assistant. Analyze the provided context and give actionable insights.',
};

function RuleCard({ rule, onEdit, onDelete, onToggle }: any) {
  const [expanded, setExpanded] = useState(false);
  const [testOutput, setTestOutput] = useState('');
  const [testInput, setTestInput] = useState('');
  const [testing, setTesting] = useState(false);
  const runRule = useRunAIRule();

  const trigger = TRIGGERS.find(t => t.value === rule.trigger);
  const action = ACTIONS.find(a => a.value === rule.action);

  async function handleTest() {
    setTesting(true);
    setTestOutput('');
    try {
      const result = await runRule.mutateAsync({ id: rule.id, inputText: testInput || undefined });
      setTestOutput(result.result);
    } catch {
      setTestOutput('Error running rule. Check your AI configuration.');
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className={`bg-white dark:bg-gray-900 rounded-xl border ${rule.isActive ? 'border-gray-100 dark:border-gray-800' : 'border-dashed border-gray-200 dark:border-gray-700 opacity-70'} shadow-sm transition-all`}>
      <div className="flex items-center gap-4 p-4">
        <div className="w-10 h-10 rounded-xl bg-indigo-50 dark:bg-indigo-900/30 flex items-center justify-center text-xl flex-shrink-0">
          {trigger?.icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-gray-900 dark:text-gray-100">{rule.name}</span>
            <Badge variant={rule.isActive ? 'green' : 'gray'}>{rule.isActive ? 'Active' : 'Disabled'}</Badge>
          </div>
          <p className="text-xs text-gray-500 mt-0.5">
            <span className="text-indigo-500">{trigger?.label}</span>
            <span className="mx-1">→</span>
            <span className="text-purple-500">{action?.label}</span>
            {rule.runCount > 0 && <span className="ml-2 text-gray-400">· ran {rule.runCount}×</span>}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button onClick={() => onToggle(rule)} className="text-gray-400 hover:text-indigo-500 transition-colors" title={rule.isActive ? 'Disable' : 'Enable'}>
            {rule.isActive ? <ToggleRight size={22} className="text-indigo-500" /> : <ToggleLeft size={22} />}
          </button>
          <button onClick={() => onEdit(rule)} className="p-1.5 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg text-gray-400 hover:text-gray-700 transition-colors">
            <Edit2 size={14} />
          </button>
          <button onClick={() => onDelete(rule.id)} className="p-1.5 hover:bg-red-50 rounded-lg text-gray-400 hover:text-red-600 transition-colors">
            <Trash2 size={14} />
          </button>
          <button onClick={() => setExpanded(e => !e)} className="p-1.5 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg text-gray-400 transition-colors">
            {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-gray-100 dark:border-gray-800 p-4 space-y-4">
          {rule.description && <p className="text-sm text-gray-600 dark:text-gray-400">{rule.description}</p>}

          {rule.customPrompt && (
            <div>
              <p className="text-xs font-medium text-gray-500 mb-1.5">AI Prompt</p>
              <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3 text-xs font-mono text-gray-700 dark:text-gray-300 whitespace-pre-wrap">
                {rule.customPrompt}
              </div>
            </div>
          )}

          <div>
            <p className="text-xs font-medium text-gray-500 mb-1.5">Test this rule</p>
            <textarea
              value={testInput}
              onChange={e => setTestInput(e.target.value)}
              placeholder="Paste some sample text to test with (e.g. a ticket description, deal notes)..."
              rows={3}
              className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-900 resize-none focus:outline-none focus:ring-2 focus:ring-indigo-300"
            />
            <Button size="sm" icon={<Play size={13} />} onClick={handleTest} loading={testing} className="mt-2">
              Run Test
            </Button>
          </div>

          {testOutput && (
            <div>
              <p className="text-xs font-medium text-gray-500 mb-1.5 flex items-center gap-1">
                <Sparkles size={11} className="text-indigo-400" /> AI Output
              </p>
              <div className="bg-indigo-50 dark:bg-indigo-900/20 rounded-xl p-3 border border-indigo-100 dark:border-indigo-800">
                <AITypewriter text={testOutput} speed={12} showIcon={false} />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RuleForm({ initial, onClose }: { initial?: any; onClose: () => void }) {
  const createRule = useCreateAIRule();
  const updateRule = useUpdateAIRule();
  const [form, setForm] = useState({
    name: initial?.name ?? '',
    description: initial?.description ?? '',
    trigger: initial?.trigger ?? 'TICKET_CREATED',
    action: initial?.action ?? 'SUMMARIZE',
    customPrompt: initial?.customPrompt ?? '',
    isActive: initial?.isActive ?? true,
  });
  const f = (k: string) => (e: any) => setForm(p => ({ ...p, [k]: e.target.value }));

  function handleActionChange(action: string) {
    setForm(p => ({
      ...p,
      action,
      customPrompt: p.customPrompt || PROMPT_TEMPLATES[action] || '',
    }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (initial?.id) await updateRule.mutateAsync({ id: initial.id, ...form });
    else await createRule.mutateAsync(form);
    onClose();
  }

  const inp = 'w-full border border-gray-200 dark:border-gray-700 rounded-xl px-3 py-2 text-sm bg-white dark:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-300';

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Rule Name *</label>
        <input required value={form.name} onChange={f('name')} placeholder="e.g. Auto-tag billing tickets" className={inp} />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Description</label>
        <input value={form.description} onChange={f('description')} placeholder="What does this rule do?" className={inp} />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">When this happens (Trigger)</label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {TRIGGERS.map(t => (
            <button key={t.value} type="button" onClick={() => setForm(p => ({ ...p, trigger: t.value }))}
              className={`flex items-start gap-3 p-3 rounded-xl border text-left transition-all ${form.trigger === t.value ? 'border-indigo-400 bg-indigo-50 dark:bg-indigo-900/30' : 'border-gray-200 dark:border-gray-700 hover:border-gray-300'}`}>
              <span className="text-xl">{t.icon}</span>
              <div>
                <p className="text-sm font-medium">{t.label}</p>
                <p className="text-xs text-gray-500">{t.desc}</p>
              </div>
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Then do this (Action)</label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {ACTIONS.map(a => (
            <button key={a.value} type="button" onClick={() => handleActionChange(a.value)}
              className={`flex items-start gap-3 p-3 rounded-xl border text-left transition-all ${form.action === a.value ? 'border-purple-400 bg-purple-50 dark:bg-purple-900/20' : 'border-gray-200 dark:border-gray-700 hover:border-gray-300'}`}>
              <span className={`mt-0.5 ${form.action === a.value ? 'text-purple-500' : 'text-gray-400'}`}>{a.icon}</span>
              <div>
                <p className="text-sm font-medium">{a.label}</p>
                <p className="text-xs text-gray-500">{a.desc}</p>
              </div>
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          AI Prompt
          <span className="text-xs text-gray-400 font-normal ml-2">Tell the AI exactly what to do</span>
        </label>
        <textarea
          value={form.customPrompt}
          onChange={f('customPrompt')}
          rows={5}
          placeholder="Describe what AI should do with the entity data..."
          className={`${inp} resize-none font-mono text-xs`}
        />
        <p className="text-xs text-gray-400 mt-1">
          The AI will receive the full entity data automatically. Just describe what output you want.
        </p>
      </div>

      <div className="flex gap-3 pt-2">
        <button type="button" onClick={onClose} className="flex-1 border border-gray-200 rounded-xl py-2 text-sm text-gray-600 hover:bg-gray-50 transition-colors">
          Cancel
        </button>
        <Button type="submit" className="flex-1" loading={createRule.isPending || updateRule.isPending}>
          {initial?.id ? 'Save Changes' : 'Create Rule'}
        </Button>
      </div>
    </form>
  );
}

export function AIFeaturePage() {
  const { data: rules, isLoading } = useAIRules();
  const deleteRule = useDeleteAIRule();
  const updateRule = useUpdateAIRule();
  const bulkScore = useBulkScoreLeads();
  const [modal, setModal] = useState<null | 'create' | any>(null);
  const [bulkResult, setBulkResult] = useState<any>(null);

  async function handleBulkScore() {
    const result = await bulkScore.mutateAsync();
    setBulkResult(result);
  }

  return (
    <div className="p-4 sm:p-6 space-y-6 animate-slide-up max-w-5xl">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center">
              <Sparkles size={16} className="text-white" />
            </div>
            <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">AI Feature Builder</h1>
          </div>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Create custom AI automations that run on your data — no code required.
          </p>
        </div>
        <div className="flex gap-3">
          <Button
            variant="secondary"
            icon={<BarChart3 size={15} />}
            onClick={handleBulkScore}
            loading={bulkScore.isPending}
          >
            Score All Leads
          </Button>
          <Button icon={<Plus size={15} />} onClick={() => setModal('create')}>
            New Rule
          </Button>
        </div>
      </div>

      {/* Bulk score result */}
      {bulkResult && (
        <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-xl p-4 flex items-center gap-3">
          <Sparkles size={18} className="text-green-600 flex-shrink-0" />
          <div>
            <p className="font-medium text-green-800 dark:text-green-200">Bulk scoring complete!</p>
            <p className="text-sm text-green-700 dark:text-green-300">{bulkResult.scored} leads scored by AI.</p>
          </div>
        </div>
      )}

      {/* Quick actions */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {[
          { icon: '🎫', title: 'Auto-Tag Tickets', desc: 'AI extracts tags from ticket content automatically', trigger: 'TICKET_CREATED', action: 'TAG' },
          { icon: '📧', title: 'Smart Follow-ups', desc: 'Generate follow-up emails when deals change stages', trigger: 'DEAL_STAGE_CHANGED', action: 'EMAIL' },
          { icon: '🔔', title: 'SLA Alerts', desc: 'Get AI-generated alerts when tickets age too long', trigger: 'TICKET_CREATED', action: 'NOTIFY' },
        ].map(t => (
          <button
            key={t.title}
            onClick={() => setModal({ preset: t })}
            className="flex gap-3 p-4 bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 hover:border-indigo-200 hover:shadow-sm transition-all text-left group"
          >
            <span className="text-2xl">{t.icon}</span>
            <div>
              <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 group-hover:text-indigo-600 transition-colors">{t.title}</p>
              <p className="text-xs text-gray-500 mt-0.5">{t.desc}</p>
              <p className="text-xs text-indigo-500 mt-2 font-medium">Use template →</p>
            </div>
          </button>
        ))}
      </div>

      {/* Rules list */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
            Your Rules {rules?.length ? <span className="text-gray-400 font-normal">({rules.length})</span> : null}
          </h2>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-12"><Spinner /></div>
        ) : !rules?.length ? (
          <EmptyState
            icon={<Sparkles size={24} />}
            title="No AI rules yet"
            description="Create your first rule to automate AI actions on your CRM data."
            action={{ label: 'Create First Rule', onClick: () => setModal('create') }}
          />
        ) : (
          <div className="space-y-3">
            {rules.map((rule: any) => (
              <RuleCard
                key={rule.id}
                rule={rule}
                onEdit={setModal}
                onDelete={(id: string) => deleteRule.mutate(id)}
                onToggle={(r: any) => updateRule.mutate({ id: r.id, isActive: !r.isActive })}
                onRun={(r: any) => setModal({ ...r, _run: true })}
              />
            ))}
          </div>
        )}
      </div>

      {/* Create/Edit Modal */}
      <Modal
        open={!!modal}
        onClose={() => setModal(null)}
        title={modal === 'create' ? 'Create AI Rule' : modal?.id ? 'Edit Rule' : modal?.preset ? `Use Template: ${modal.preset.title}` : 'New Rule'}
        size="lg"
      >
        {modal && (
          <RuleForm
            initial={modal?.id ? modal : modal?.preset ? { trigger: modal.preset.trigger, action: modal.preset.action, customPrompt: PROMPT_TEMPLATES[modal.preset.action] } : undefined}
            onClose={() => setModal(null)}
          />
        )}
      </Modal>
    </div>
  );
}
