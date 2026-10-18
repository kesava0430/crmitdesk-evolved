import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Sparkles, LayoutDashboard, Home, Copy, Trash2, ExternalLink, Wand2, X, Save, Pencil } from 'lucide-react';
import {
  useDashboards, useCreateDashboard, useDeleteDashboard, useDuplicateDashboard, useSetHome, proposeDashboard, renderSpecs, apiError,
  type DashboardSummary, type Proposal, type RenderResponse,
} from '../api/dashboards';
import { useLicense } from '../api/billing';
import { useAnalyticsCatalog } from '../api/analytics';
import { useAuth } from '../contexts/AuthContext';
import { useModules } from '../shared/modules';
import { Alert, Badge, Button, Card, EmptyState, Input, PageBody, PageHeader, Tabs, Textarea, AiNote } from '../shared/components';
import { RowActions } from '../shared/components/RowActions';
import { addToast } from '../shared/components/toastStore';
import { PlanFeatureNotice } from '../shared/components/PlanFeatureNotice';
import { DashboardGrid } from '../shared/components/dashboards/DashboardGrid';
import { NewDashboardDialog } from '../shared/components/dashboards/DashboardDialogs';
import { visibilityBadge } from './DashboardViewPage';

/* Each suggestion names the dataset it is built on: it is only offered when
   the org has the area AND the viewer's catalog has that data (an IT agent
   isn't offered a leads projection the server would refuse). */
const SUGGESTIONS: Array<{ q: string; area: 'crm' | 'itdesk' | 'hr'; dataset: string }> = [
  { q: 'Create a dashboard projecting our leads for the upcoming days — if the business continues the same way, where will we be?', area: 'crm', dataset: 'leads' },
  { q: 'HR dashboard: headcount, attendance trends, leave and payroll cost by department', area: 'hr', dataset: 'payslips' },
  { q: 'HR dashboard: headcount, attendance trends and leave', area: 'hr', dataset: 'employees' },
  { q: 'Help desk dashboard: open tickets, weekly volume and top agents', area: 'itdesk', dataset: 'tickets' },
];

function AiBuilder({ areas }: { areas: { crm: boolean; itdesk: boolean; hr: boolean } }) {
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [preview, setPreview] = useState<RenderResponse | null>(null);
  const [title, setTitle] = useState('');
  const create = useCreateDashboard();
  const navigate = useNavigate();
  const { data: catalog } = useAnalyticsCatalog();
  const has = (k: string) => !catalog || catalog.datasets.some(d => d.key === k);
  const suggestions = SUGGESTIONS.filter(s => areas[s.area] && has(s.dataset))
    // The payroll variant replaces the plain HR one for people who may see pay.
    .filter((s, _i, all) => !(s.dataset === 'employees' && all.some(x => x.dataset === 'payslips')))
    .map(s => s.q);

  const build = async (q: string) => {
    if (!q.trim()) return;
    setPrompt(q); setBusy(true); setError(null); setProposal(null); setPreview(null); setWarnings([]);
    try {
      const r = await proposeDashboard(q.trim());
      if (r.status !== 'proposed' || !r.proposal) { setError(r.message ?? 'The AI couldn’t build that dashboard.'); return; }
      setProposal(r.proposal); setWarnings(r.warnings); setTitle(r.proposal.title);
      // Preview with real numbers — rendered by the server as you.
      setPreview(await renderSpecs(r.proposal.widgets));
    } catch (e) { setError(apiError(e, 'AI request failed.')); } finally { setBusy(false); }
  };

  const save = (thenEdit: boolean) => {
    if (!proposal) return;
    create.mutate({ title: title.trim() || proposal.title, description: proposal.description, widgets: proposal.widgets, layout: proposal.layout }, {
      onSuccess: d => { addToast('Dashboard saved', 'success', 3000); navigate(`/dashboards/${d.id}${thenEdit ? '?edit=1' : ''}`); },
      onError: e => addToast(apiError(e), 'error'),
    });
  };

  const widgets = proposal?.widgets.map((spec, i) => ({ id: String(i), spec })) ?? [];
  const rendered = useMemo(() => Object.fromEntries((preview?.widgets ?? []).map(w => [w.id, w])), [preview]);

  return (
    <Card padding="none" className="overflow-hidden min-w-0" data-testid="ai-dashboard-builder">
      <div className="px-4 sm:px-5 py-4 border-b border-line-subtle flex items-center gap-2">
        <Wand2 size={15} className="text-accent" />
        <h2 className="text-[13.5px] font-semibold text-fg">Ask AI to build a dashboard</h2>
      </div>
      <div className="p-4 sm:p-5 space-y-4 min-w-0">
        <AiNote id="dashboard.build" does="Describe what you want to track; the AI picks the charts, numbers and projections from your own data, and you preview them with real numbers before saving." />
        <div className="flex flex-col sm:flex-row gap-2">
          <Textarea rows={2} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder={suggestions[0] ?? 'e.g. A dashboard of my team’s work this month'}
            aria-label="Describe the dashboard" className="flex-1" maxLength={800}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); build(prompt); } }} />
          <Button onClick={() => build(prompt)} loading={busy} disabled={!prompt.trim()} icon={<Sparkles size={13} />} className="sm:self-start">Build</Button>
        </div>
        {!proposal && !busy && suggestions.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {suggestions.map(q => (
              <Button key={q} variant="secondary" size="xs" onClick={() => build(q)} className="!rounded-badge !h-auto !py-1 text-left !whitespace-normal max-w-full">{q}</Button>
            ))}
          </div>
        )}
        {busy && <p className="text-[13px] text-accent animate-pulse flex items-center gap-2"><Sparkles size={13} /> Designing it from your data…</p>}
        {error && <Alert tone="danger" onDismiss={() => setError(null)}>{error}</Alert>}
        {proposal && (
          <div className="space-y-3 min-w-0" data-testid="ai-dashboard-proposal">
            <div className="flex flex-col sm:flex-row sm:items-end gap-3">
              <div className="flex-1 min-w-0">
                <label className="text-[11px] font-semibold text-fg-subtle uppercase tracking-widest" htmlFor="proposal-title">Preview</label>
                <Input id="proposal-title" value={title} onChange={e => setTitle(e.target.value)} maxLength={120} className="mt-1 font-semibold" />
                {proposal.description && <p className="text-[12px] text-fg-muted mt-1">{proposal.description}</p>}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button icon={<Save size={13} />} onClick={() => save(false)} loading={create.isPending}>Save</Button>
                <Button variant="secondary" icon={<Pencil size={13} />} onClick={() => save(true)} disabled={create.isPending}>Save &amp; edit</Button>
                <Button variant="ghost" icon={<X size={13} />} onClick={() => { setProposal(null); setPreview(null); }}>Discard</Button>
              </div>
            </div>
            {warnings.length > 0 && <Alert tone="warning">{warnings.join(' ')}</Alert>}
            <div className="rounded-card border border-dashed border-line p-2 sm:p-3 bg-surface-sunken/50">
              <DashboardGrid widgets={widgets} layout={proposal.layout} rendered={rendered} loading={!preview} currency={preview?.currency ?? 'USD'} editing={false} menuFor={() => []} />
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

function DashboardCard({ d, isHome }: { d: DashboardSummary; isHome: boolean }) {
  const navigate = useNavigate();
  const del = useDeleteDashboard();
  const dup = useDuplicateDashboard();
  const setHome = useSetHome();
  return (
    <Card interactive padding="sm" onClick={() => navigate(`/dashboards/${d.id}`)} className="flex flex-col gap-2 min-w-0" data-testid="dashboard-card">
      <div className="flex items-start gap-2 min-w-0">
        <div className="w-8 h-8 rounded-btn bg-accent-soft text-accent flex items-center justify-center shrink-0"><LayoutDashboard size={15} /></div>
        <div className="min-w-0 flex-1" data-user-content>
          <p className="text-[13.5px] font-semibold text-fg truncate">{d.title}</p>
          <p className="text-[11.5px] text-fg-muted truncate">{d.description || `${d.widgetCount} widget${d.widgetCount === 1 ? '' : 's'}`}</p>
        </div>
        <div onClick={e => e.stopPropagation()} className="shrink-0">
          <RowActions triggerLabel={`Actions for ${d.title}`} items={[
            { label: 'Open', icon: <ExternalLink size={13} />, onClick: () => navigate(`/dashboards/${d.id}`) },
            { label: isHome ? 'Remove from my home' : 'Set as my home', icon: <Home size={13} />, onClick: () => setHome.mutate({ dashboardId: isHome ? null : d.id }) },
            { label: 'Duplicate', icon: <Copy size={13} />, onClick: () => dup.mutate(d.id, { onSuccess: c => navigate(`/dashboards/${c.id}`), onError: e => addToast(apiError(e), 'error') }) },
            { label: 'Delete', icon: <Trash2 size={13} />, variant: 'danger', hidden: !d.access.delete, onClick: () => { if (window.confirm(`Delete “${d.title}”?`)) del.mutate(d.id, { onError: e => addToast(apiError(e), 'error') }); } },
          ]} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 mt-auto">
        {visibilityBadge(d.visibility)}
        {isHome && <Badge variant="green" size="sm"><span className="inline-flex items-center gap-1"><Home size={11} /> Home</span></Badge>}
        <span className="text-[11px] text-fg-subtle ml-auto whitespace-nowrap">{!d.access.isOwner ? `${d.owner.name} · ` : ''}{new Date(d.updatedAt).toLocaleDateString()}</span>
      </div>
    </Card>
  );
}

export default function DashboardsPage() {
  const { user } = useAuth();
  const { data, isLoading } = useDashboards();
  const { data: lic } = useLicense(!!user?.role);
  const modules = useModules();
  const [tab, setTab] = useState<'mine' | 'shared'>('mine');
  const [newOpen, setNewOpen] = useState(false);
  const aiEnabled = !!lic?.features.includes('ai_advanced');
  const areas = { crm: modules.isModuleOn('crm'), itdesk: modules.isModuleOn('itdesk'), hr: modules.isModuleOn('hr_core') };
  const items = tab === 'mine' ? data?.mine ?? [] : data?.shared ?? [];

  return (
    <div className="animate-slide-up">
      <PageHeader
        title="Dashboards"
        subtitle="Your own charts and numbers from live data — each person sees them with their own permissions."
        actions={<Button icon={<Plus size={14} />} onClick={() => setNewOpen(true)}>New dashboard</Button>}
      />
      <PageBody>
        {aiEnabled ? <AiBuilder areas={areas} /> : lic && <PlanFeatureNotice feature="ai_advanced" what="Building dashboards with AI" />}
        <section className="space-y-3">
          <Tabs<'mine' | 'shared'> value={tab} onChange={setTab} aria-label="Dashboards"
            items={[{ key: 'mine', label: 'My dashboards', count: data?.mine.length }, { key: 'shared', label: 'Shared with me', count: data?.shared.length }]} />
          {isLoading ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">{[0, 1, 2].map(i => <div key={i} className="h-24 skeleton" />)}</div>
          ) : items.length ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {items.map(d => <DashboardCard key={d.id} d={d} isHome={data?.home?.dashboardId === d.id} />)}
            </div>
          ) : (
            <EmptyState compact icon={<LayoutDashboard />}
              title={tab === 'mine' ? 'No dashboards yet' : 'Nothing shared with you yet'}
              description={tab === 'mine' ? (aiEnabled ? 'Ask AI above, start an empty one, or pin any Ask AI answer.' : 'Start an empty dashboard and add charts from your data.') : 'Dashboards others share with everyone or with your role appear here.'}
              action={tab === 'mine' ? { label: 'New dashboard', onClick: () => setNewOpen(true) } : undefined} />
          )}
        </section>
      </PageBody>
      <NewDashboardDialog open={newOpen} onClose={() => setNewOpen(false)} />
    </div>
  );
}
