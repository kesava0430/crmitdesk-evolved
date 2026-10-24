/**
 * Dialogs around dashboards: share settings, "Pin to dashboard" (from any AI
 * answer), "Ask AI to change this widget", view data / how calculated, and
 * the dashboard date-range control.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sparkles, Lock, Users, UserCheck, Plus, LayoutDashboard, Download } from 'lucide-react';
import {
  useDashboards, useShareOptions, useShareDashboard, useAddWidget, useCreateDashboard, aiModifyWidget, renderSpecs, apiError,
  type Dashboard, type WidgetSpec, type RenderedWidget, type DashboardRange,
} from '../../../api/dashboards';
import type { AnalyticsWidgetSpec } from '../../../api/analytics';
import { saveOrShareBlob } from '../../../native/download';
import { Modal } from '../Modal';
import { Button } from '../Button';
import { Field, Input, Select, Checkbox, Textarea } from '../Field';
import { Alert } from '../Alert';
import { AiErrorAlert } from '../AiErrorAlert';
import { aiErrorInfo, aiMessage, type AiErrorInfo } from '../../ai/aiError';
import { addToast } from '../toastStore';
import { WidgetView, HowCalculated, widgetCsv } from './WidgetView';

// ─── Share ──────────────────────────────────────────────────────────────────

const LEGACY_LABEL: Record<string, string> = {
  SUPER_ADMIN: 'Super Admin', IT_MANAGER: 'IT Manager', CRM_MANAGER: 'Sales Manager', IT_AGENT: 'IT Technician', SALES_REP: 'Sales Rep', EMPLOYEE: 'Employee',
};

export function ShareDialog({ dashboard, open, onClose }: { dashboard: Dashboard; open: boolean; onClose: () => void }) {
  const [visibility, setVisibility] = useState(dashboard.visibility);
  const [roleIds, setRoleIds] = useState<string[]>(dashboard.roleIds);
  const [legacy, setLegacy] = useState<string[]>(dashboard.legacyRoles);
  const { data } = useShareOptions(open);
  const share = useShareDashboard();
  useEffect(() => { if (open) { setVisibility(dashboard.visibility); setRoleIds(dashboard.roleIds); setLegacy(dashboard.legacyRoles); } }, [open, dashboard]);

  // System roles map 1:1 to legacy roles — tick both so users with and without a Role row match.
  const toggle = (r: { id: string; legacyRole: string | null }, on: boolean) => {
    setRoleIds(ids => (on ? [...new Set([...ids, r.id])] : ids.filter(x => x !== r.id)));
    if (r.legacyRole && LEGACY_LABEL[r.legacyRole]) setLegacy(ls => (on ? [...new Set([...ls, r.legacyRole!])] : ls.filter(x => x !== r.legacyRole)));
  };
  const save = () => share.mutate({ id: dashboard.id, visibility, roleIds, legacyRoles: legacy }, {
    onSuccess: () => { addToast('Sharing updated', 'success', 3000); onClose(); },
    onError: e => addToast(apiError(e), 'error'),
  });

  const opts: Array<[typeof visibility, string, string, React.ReactNode]> = [
    ['PRIVATE', 'Only me', 'Nobody else sees this dashboard.', <Lock size={15} key="l" />],
    ['ORG', 'Everyone in the organisation', 'Read-only for others; managers of shared dashboards can edit it.', <Users size={15} key="u" />],
    ['ROLES', 'Specific roles', 'People with the roles you pick.', <UserCheck size={15} key="r" />],
  ];
  return (
    <Modal open={open} onClose={onClose} title="Share dashboard" size="md"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={save} loading={share.isPending} disabled={visibility === 'ROLES' && !roleIds.length && !legacy.length}>Save</Button></>}>
      <div className="space-y-4">
        <div className="space-y-2" role="radiogroup" aria-label="Who can see this dashboard">
          {opts.map(([v, title, hint, icon]) => (
            <label key={v} className={`flex gap-3 items-start p-3 rounded-card border cursor-pointer ${visibility === v ? 'border-accent bg-accent-soft/40' : 'border-line'}`}>
              <input type="radio" name="vis" className="mt-1" checked={visibility === v} onChange={() => setVisibility(v)} />
              <span className="text-fg-muted mt-0.5">{icon}</span>
              <span className="min-w-0"><span className="block text-[13px] font-medium text-fg">{title}</span><span className="block text-[11.5px] text-fg-muted">{hint}</span></span>
            </label>
          ))}
        </div>
        {visibility === 'ROLES' && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {(data?.roles ?? []).map(r => (
              <Checkbox key={r.id} label={r.name} checked={roleIds.includes(r.id)} onChange={e => toggle(r, e.target.checked)} />
            ))}
          </div>
        )}
        <Alert tone="info">Sharing never shares data: each person sees every widget with their own permissions — numbers they aren't allowed to see show as “not available”.</Alert>
      </div>
    </Modal>
  );
}

// ─── Pin to dashboard ───────────────────────────────────────────────────────

/** "Pin to dashboard" from an AI answer: pick a dashboard you can edit, or create one. */
export function PinToDashboardDialog({ spec, open, onClose }: { spec: AnalyticsWidgetSpec | WidgetSpec | null; open: boolean; onClose: () => void }) {
  const { data } = useDashboards(open);
  const editable = useMemo(() => [...(data?.mine ?? []), ...(data?.shared ?? []).filter(d => d.access.edit)], [data]);
  const [target, setTarget] = useState<string>('');
  const [title, setTitle] = useState('');
  const add = useAddWidget();
  const create = useCreateDashboard();
  const navigate = useNavigate();
  useEffect(() => { if (open) { setTarget(editable[0]?.id ?? 'new'); setTitle('My dashboard'); } }, [open, editable.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const pin = async () => {
    if (!spec) return;
    try {
      let id = target;
      if (target === 'new') id = (await create.mutateAsync({ title: title.trim() || 'My dashboard' })).id;
      await add.mutateAsync({ id, spec: spec as WidgetSpec });
      addToast('Pinned to dashboard', 'success', { duration: 5000, actionLabel: 'Open', actionHref: `/dashboards/${id}` });
      onClose();
    } catch (e) { addToast(apiError(e), 'error'); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Pin to dashboard" icon={<LayoutDashboard size={16} />} size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={pin} loading={add.isPending || create.isPending}>Pin</Button></>}>
      <div className="space-y-3">
        <p className="text-[12.5px] text-fg-muted">“{spec?.title}” keeps its question, not its numbers: the dashboard re-runs it with live data for whoever looks at it.</p>
        <Field label="Dashboard">
          <Select value={target} onChange={e => setTarget(e.target.value)}>
            {editable.map(d => <option key={d.id} value={d.id}>{d.title}</option>)}
            <option value="new">+ New dashboard…</option>
          </Select>
        </Field>
        {target === 'new' && <Field label="New dashboard name"><Input value={title} onChange={e => setTitle(e.target.value)} maxLength={120} /></Field>}
        <button type="button" className="text-[12px] text-accent hover:underline" onClick={() => { onClose(); navigate('/dashboards'); }}>Manage dashboards</button>
      </div>
    </Modal>
  );
}

// ─── Ask AI to change a widget ──────────────────────────────────────────────

export function AiChangeWidgetDialog({ spec, open, onClose, onApply, applying }: {
  spec: WidgetSpec | null; open: boolean; onClose: () => void; onApply: (spec: WidgetSpec) => void; applying?: boolean;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AiErrorInfo | null>(null);
  const [next, setNext] = useState<{ spec: WidgetSpec; r?: RenderedWidget; currency: string } | null>(null);
  useEffect(() => { if (open) { setText(''); setError(null); setNext(null); } }, [open]);

  const ask = async () => {
    if (!spec || !text.trim()) return;
    setBusy(true); setError(null); setNext(null);
    try {
      const res = await aiModifyWidget(spec, text.trim());
      if (res.status !== 'modified' || !res.spec) { setError(aiMessage(res.message ?? 'The AI couldn’t make that change.')); return; }
      const preview = await renderSpecs([res.spec]);
      setNext({ spec: res.spec, r: preview.widgets[0], currency: preview.currency });
    } catch (e) { setError(aiErrorInfo(e, apiError(e))); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Ask AI to change this widget" icon={<Sparkles size={16} className="text-accent" />} size="lg"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button>{next && <Button onClick={() => onApply(next.spec)} loading={applying}>Apply change</Button>}</>}>
      <div className="space-y-3 min-w-0">
        <p className="text-[12.5px] text-fg-muted">Changing <span className="font-medium text-fg">{spec?.title}</span>. Describe the change; you'll see it with real data before anything is saved.</p>
        <div className="flex flex-col sm:flex-row gap-2">
          <Textarea rows={2} value={text} onChange={e => setText(e.target.value)} placeholder="e.g. make it weekly and show only the last 3 months" className="flex-1" maxLength={500}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); } }} />
          <Button onClick={ask} loading={busy} disabled={!text.trim()} icon={<Sparkles size={13} />} className="sm:self-start">Preview</Button>
        </div>
        <AiErrorAlert error={error} onRetry={ask} />
        {next && (
          <div className="rounded-card border border-line p-3 space-y-2 min-w-0">
            <p className="text-[12.5px] font-semibold text-fg truncate">{next.spec.title}</p>
            <WidgetView spec={next.spec} rendered={next.r} currency={next.currency} chartHeight={220} />
            {next.r?.result && <p className="text-[11px] text-fg-muted break-words">{next.r.result.meta.description}</p>}
          </div>
        )}
      </div>
    </Modal>
  );
}

// ─── View data / how calculated ─────────────────────────────────────────────

export function downloadWidgetCsv(spec: WidgetSpec, r: RenderedWidget | undefined) {
  const csv = widgetCsv(r);
  if (!csv) { addToast('Nothing to export yet.', 'info', 3000); return; }
  const name = `${spec.title.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'widget'}.csv`;
  saveOrShareBlob(new Blob([csv], { type: 'text/csv' }), name).catch(() => {});
}

export function WidgetDataDialog({ spec, rendered, currency, open, onClose, mode }: {
  spec: WidgetSpec | null; rendered?: RenderedWidget; currency: string; open: boolean; onClose: () => void; mode: 'data' | 'how';
}) {
  if (!spec) return null;
  const tableSpec: WidgetSpec | null = spec.kind === 'data' ? { ...spec, viz: { ...spec.viz, type: 'table' }, options: { ...spec.options, pageSize: 15 } } : null;
  const fRows = rendered?.forecast;
  return (
    <Modal open={open} onClose={onClose} title={mode === 'how' ? 'How this was calculated' : spec.title} size="lg"
      footer={<>{mode === 'data' && <Button variant="secondary" icon={<Download size={13} />} onClick={() => downloadWidgetCsv(spec, rendered)}>Export CSV</Button>}<Button variant="ghost" onClick={onClose}>Close</Button></>}>
      <div className="space-y-4 min-w-0">
        {mode === 'how' && <HowCalculated spec={spec} rendered={rendered} />}
        {mode === 'data' && (fRows ? (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead><tr className="text-left text-fg-muted border-b border-line-subtle"><th className="py-1.5 pr-3 font-medium">Period</th><th className="py-1.5 pr-3 text-right font-medium">Actual</th><th className="py-1.5 pr-3 text-right font-medium">Projected</th><th className="py-1.5 text-right font-medium">95% range</th></tr></thead>
              <tbody>
                {fRows.history.slice(-14).map(p => <tr key={p.bucket} className="border-b border-line-subtle"><td className="py-1 pr-3">{p.label}</td><td className="py-1 pr-3 text-right tabular-nums">{p.value}</td><td /><td /></tr>)}
                {fRows.projection.map(p => <tr key={p.bucket} className="border-b border-line-subtle last:border-0"><td className="py-1 pr-3">{p.label}</td><td /><td className="py-1 pr-3 text-right tabular-nums">{Math.round(p.value * 10) / 10}</td><td className="py-1 text-right tabular-nums whitespace-nowrap">{Math.round(p.lower * 10) / 10} – {Math.round(p.upper * 10) / 10}</td></tr>)}
              </tbody>
            </table>
            <p className="text-[11px] text-fg-subtle mt-1">Last 14 periods of history shown; the CSV has all of it.</p>
          </div>
        ) : tableSpec ? <WidgetView spec={tableSpec} rendered={rendered} currency={currency} chartHeight={300} /> : <p className="text-[12px] text-fg-muted">Notes have no data table.</p>)}
        {mode === 'data' && <div className="pt-2 border-t border-line-subtle"><HowCalculated spec={spec} rendered={rendered} /></div>}
      </div>
    </Modal>
  );
}

// ─── Date range ─────────────────────────────────────────────────────────────

export const RANGE_PRESETS: Array<[string, string]> = [
  ['', 'Each widget’s own'], ['last_7_days', 'Last 7 days'], ['last_30_days', 'Last 30 days'], ['last_90_days', 'Last 90 days'],
  ['this_month', 'This month'], ['this_quarter', 'This quarter'], ['this_year', 'This year'], ['custom', 'Custom…'],
];

export function DateRangeControl({ value, onChange }: { value: DashboardRange | null; onChange: (r: DashboardRange | null) => void }) {
  const mode = value?.from || value?.to ? 'custom' : value?.preset ?? '';
  const [from, setFrom] = useState(value?.from ?? '');
  const [to, setTo] = useState(value?.to ?? '');
  const [custom, setCustom] = useState(mode === 'custom');
  useEffect(() => { setFrom(value?.from ?? ''); setTo(value?.to ?? ''); setCustom(!!(value?.from || value?.to)); }, [value]);
  return (
    <div className="flex flex-wrap items-center gap-2 min-w-0">
      <Select selectSize="sm" aria-label="Dashboard date range" value={custom ? 'custom' : mode} className="min-w-[150px]"
        onChange={e => {
          const v = e.target.value;
          if (v === 'custom') { setCustom(true); return; }
          setCustom(false);
          onChange(v ? { preset: v } : null);
        }}>
        {RANGE_PRESETS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
      </Select>
      {custom && (
        <>
          <Input inputSize="sm" type="date" aria-label="From" value={from} onChange={e => setFrom(e.target.value)} className="w-[140px]" />
          <Input inputSize="sm" type="date" aria-label="To" value={to} onChange={e => setTo(e.target.value)} className="w-[140px]" />
          <Button size="sm" variant="secondary" disabled={!from || !to || from > to} onClick={() => onChange({ from, to })}>Apply</Button>
        </>
      )}
    </div>
  );
}

export function NewDashboardDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const create = useCreateDashboard();
  const navigate = useNavigate();
  useEffect(() => { if (open) { setTitle(''); setDescription(''); } }, [open]);
  const go = () => create.mutate({ title: title.trim(), description: description.trim() || null }, {
    onSuccess: d => { onClose(); navigate(`/dashboards/${d.id}?edit=1`); },
    onError: e => addToast(apiError(e), 'error'),
  });
  return (
    <Modal open={open} onClose={onClose} title="New dashboard" icon={<Plus size={16} />} size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={go} disabled={!title.trim()} loading={create.isPending}>Create</Button></>}>
      <div className="space-y-3">
        <Field label="Name"><Input autoFocus value={title} onChange={e => setTitle(e.target.value)} maxLength={120} onKeyDown={e => e.key === 'Enter' && title.trim() && go()} /></Field>
        <Field label="Description (optional)"><Input value={description} onChange={e => setDescription(e.target.value)} maxLength={500} /></Field>
      </div>
    </Modal>
  );
}

