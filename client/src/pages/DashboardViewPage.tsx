import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams, Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, Pencil, Check, Plus, Share2, RefreshCw, Copy, Trash2, Home, Info, Table2, Download, Sparkles, LayoutDashboard, Lock, Users, UserCheck, Clock,
} from 'lucide-react';
import {
  useDashboard, useUpdateDashboard, useDeleteDashboard, useDuplicateDashboard, useAddWidget, useUpdateWidget, useRemoveWidget, useDuplicateWidget,
  useSetHome, useDashboards, renderDashboard, apiError, type Dashboard, type WidgetSpec, type RenderedWidget, type DashboardRange,
} from '../api/dashboards';
import { useLicense } from '../api/billing';
import { useAuth } from '../contexts/AuthContext';
import { Badge, Button, EmptyState, Input, Modal, PageBody, PageHeader, Field, Toggle, Alert } from '../shared/components';
import { addToast } from '../shared/components/toastStore';
import type { RowAction } from '../shared/components/RowActions';
import { RowActions } from '../shared/components/RowActions';
import { DashboardGrid, type GridWidget } from '../shared/components/dashboards/DashboardGrid';
import { WidgetBuilder } from '../shared/components/dashboards/WidgetBuilder';
import {
  ShareDialog, AiChangeWidgetDialog, WidgetDataDialog, DateRangeControl, downloadWidgetCsv,
} from '../shared/components/dashboards/DashboardDialogs';

const VIS: Record<string, { label: string; icon: React.ReactNode }> = {
  PRIVATE: { label: 'Private', icon: <Lock size={11} /> },
  ORG: { label: 'Shared with everyone', icon: <Users size={11} /> },
  ROLES: { label: 'Shared with roles', icon: <UserCheck size={11} /> },
};

export function visibilityBadge(v: string) {
  const x = VIS[v] ?? VIS.PRIVATE;
  return <Badge variant={v === 'PRIVATE' ? 'gray' : 'accent'} size="sm"><span className="inline-flex items-center gap-1">{x.icon}{x.label}</span></Badge>;
}

/**
 * The widgets of one dashboard, rendered for the current viewer. Used by the
 * dashboard page (editable) and by the home Dashboard (read-only embed).
 */
export function DashboardCanvas({ dashboard, editing = false, range, refreshKey = 0, autoRefreshMinutes = 0, onEditWidget, onAskAi, aiEnabled = false, onRendered }: {
  dashboard: Dashboard;
  editing?: boolean;
  /** undefined = the dashboard's saved range. */
  range?: DashboardRange | null;
  refreshKey?: number;
  autoRefreshMinutes?: number;
  onEditWidget?: (w: GridWidget) => void;
  onAskAi?: (w: GridWidget) => void;
  aiEnabled?: boolean;
  onRendered?: (at: string) => void;
}) {
  const qc = useQueryClient();
  const effectiveRange = range === undefined ? dashboard.dateRange : range;
  const widgetsKey = dashboard.widgets.map(w => w.id + JSON.stringify(w.spec)).join('|');
  const renderKey = ['dashboard-render', dashboard.id, JSON.stringify(effectiveRange), widgetsKey, refreshKey];
  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: renderKey,
    queryFn: () => renderDashboard(dashboard.id, { dateRange: effectiveRange ?? null }),
    enabled: dashboard.widgets.length > 0,
    refetchInterval: autoRefreshMinutes > 0 ? autoRefreshMinutes * 60_000 : false,
    // Never shown to anyone else: the cache lives in this browser tab only.
    staleTime: 30_000,
  });
  useEffect(() => { if (data?.renderedAt) onRendered?.(data.renderedAt); }, [data?.renderedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const [overrides, setOverrides] = useState<Record<string, RenderedWidget>>({});
  useEffect(() => setOverrides({}), [data]);
  const rendered = useMemo(() => {
    const m: Record<string, RenderedWidget> = {};
    for (const w of data?.widgets ?? []) m[w.id] = w;
    return { ...m, ...overrides };
  }, [data, overrides]);

  const retry = useCallback(async (id: string) => {
    try {
      const r = await renderDashboard(dashboard.id, { dateRange: effectiveRange ?? null, widgetIds: [id] });
      if (r.widgets[0]) setOverrides(o => ({ ...o, [id]: r.widgets[0] }));
    } catch (e) { addToast(apiError(e), 'error'); }
  }, [dashboard.id, effectiveRange]);


  const update = useUpdateDashboard();
  const remove = useRemoveWidget();
  const dup = useDuplicateWidget();
  const [dialog, setDialog] = useState<{ mode: 'data' | 'how'; w: GridWidget } | null>(null);

  const menuFor = (w: GridWidget): RowAction[] => [
    { label: 'How calculated', icon: <Info size={13} />, onClick: () => setDialog({ mode: 'how', w }) },
    { label: 'View data', icon: <Table2 size={13} />, onClick: () => setDialog({ mode: 'data', w }), hidden: w.spec.kind === 'note' },
    { label: 'Export CSV', icon: <Download size={13} />, onClick: () => downloadWidgetCsv(w.spec, rendered[w.id]), hidden: w.spec.kind === 'note' },
    { label: 'Edit', icon: <Pencil size={13} />, onClick: () => onEditWidget?.(w), hidden: !dashboard.access.edit || !onEditWidget || (w.spec.kind === 'note' && !!w.spec.methodOf) },
    { label: 'Ask AI to change', icon: <Sparkles size={13} />, onClick: () => onAskAi?.(w), hidden: !dashboard.access.edit || !aiEnabled || !onAskAi || w.spec.kind === 'note' },
    { label: 'Duplicate', icon: <Copy size={13} />, onClick: () => dup.mutate({ id: dashboard.id, widgetId: w.id }, { onError: e => addToast(apiError(e), 'error') }), hidden: !dashboard.access.edit },
    { label: 'Remove', icon: <Trash2 size={13} />, variant: 'danger', hidden: !dashboard.access.edit, onClick: () => {
      if (window.confirm(`Remove “${w.spec.title}” from this dashboard?`)) remove.mutate({ id: dashboard.id, widgetId: w.id }, { onError: e => addToast(apiError(e), 'error') });
    } },
  ];

  if (!dashboard.widgets.length) return null;
  return (
    <>
      {error && <Alert tone="danger" actions={<Button size="xs" variant="secondary" onClick={() => refetch()}>Retry</Button>}>{apiError(error, 'Couldn’t load this dashboard.')}</Alert>}
      <div className={isFetching && !isLoading ? 'opacity-90 transition-opacity' : ''}>
        <DashboardGrid
          widgets={dashboard.widgets.map(w => ({ id: w.id, spec: w.spec }))}
          layout={dashboard.layout}
          rendered={rendered}
          loading={isLoading}
          currency={data?.currency ?? 'USD'}
          editing={editing}
          menuFor={menuFor}
          onRetry={retry}
          onLayoutChange={l => update.mutate({ id: dashboard.id, layout: l }, { onError: e => addToast(apiError(e), 'error') })}
          onOrderChange={o => {
            // Optimistic: reorder in the cached dashboard right away.
            qc.setQueryData<Dashboard>(['dashboards', dashboard.id], d => (d ? { ...d, widgets: o.map(id => d.widgets.find(w => w.id === id)!).filter(Boolean) } : d));
            update.mutate({ id: dashboard.id, order: o }, { onError: e => addToast(apiError(e), 'error') });
          }}
        />
      </div>
      <WidgetDataDialog spec={dialog?.w.spec ?? null} rendered={dialog ? rendered[dialog.w.id] : undefined} currency={data?.currency ?? 'USD'} open={!!dialog} mode={dialog?.mode ?? 'how'} onClose={() => setDialog(null)} />
    </>
  );
}

function RenameDialog({ dashboard, open, onClose }: { dashboard: Dashboard; open: boolean; onClose: () => void }) {
  const [title, setTitle] = useState(dashboard.title);
  const [description, setDescription] = useState(dashboard.description ?? '');
  const update = useUpdateDashboard();
  useEffect(() => { if (open) { setTitle(dashboard.title); setDescription(dashboard.description ?? ''); } }, [open, dashboard]);
  return (
    <Modal open={open} onClose={onClose} title="Rename dashboard" size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={!title.trim()} loading={update.isPending}
        onClick={() => update.mutate({ id: dashboard.id, title: title.trim(), description: description.trim() || null }, { onSuccess: onClose, onError: e => addToast(apiError(e), 'error') })}>Save</Button></>}>
      <div className="space-y-3">
        <Field label="Name"><Input value={title} onChange={e => setTitle(e.target.value)} maxLength={120} /></Field>
        <Field label="Description"><Input value={description} onChange={e => setDescription(e.target.value)} maxLength={500} /></Field>
      </div>
    </Modal>
  );
}

export default function DashboardViewPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { user } = useAuth();
  const { data: dashboard, isLoading, error } = useDashboard(id);
  const { data: list } = useDashboards();
  const { data: lic } = useLicense(!!user?.role);
  const aiEnabled = !!lic?.features.includes('ai_advanced');
  const editing = params.get('edit') === '1' && !!dashboard?.access.edit;
  const setEditing = (on: boolean) => setParams(p => { const n = new URLSearchParams(p); if (on) n.set('edit', '1'); else n.delete('edit'); return n; }, { replace: true });

  const [refreshKey, setRefreshKey] = useState(0);
  const [lastAt, setLastAt] = useState<string | null>(null);
  const [builder, setBuilder] = useState<{ open: boolean; widget?: GridWidget }>({ open: false });
  const [aiWidget, setAiWidget] = useState<GridWidget | null>(null);
  const [share, setShare] = useState(false);
  const [rename, setRename] = useState(false);
  // Viewers can look at another period without changing the saved dashboard.
  const [viewRange, setViewRange] = useState<DashboardRange | null | undefined>(undefined);

  const update = useUpdateDashboard();
  const del = useDeleteDashboard();
  const duplicate = useDuplicateDashboard();
  const add = useAddWidget();
  const updWidget = useUpdateWidget();
  const setHome = useSetHome();
  const isHome = list?.home?.dashboardId === id;

  if (isLoading) return <PageBody><div className="h-8 w-60 skeleton" /><div className="grid grid-cols-2 md:grid-cols-4 gap-4">{[0, 1, 2, 3].map(i => <div key={i} className="h-28 skeleton" />)}</div><div className="h-72 skeleton" /></PageBody>;
  if (error || !dashboard) {
    return (
      <PageBody>
        <EmptyState icon={<LayoutDashboard />} title="Dashboard not found" description="It may have been deleted, or it isn’t shared with you." action={{ label: 'All dashboards', onClick: () => navigate('/dashboards') }} />
      </PageBody>
    );
  }
  const d = dashboard;
  const a = d.access;

  const saveWidget = (spec: WidgetSpec) => {
    const w = builder.widget;
    const done = { onSuccess: () => setBuilder({ open: false }), onError: (e: unknown) => addToast(apiError(e), 'error') };
    if (w) updWidget.mutate({ id: d.id, widgetId: w.id, spec }, done);
    else add.mutate({ id: d.id, spec }, done);
  };

  const more: RowAction[] = [
    { label: 'Rename', icon: <Pencil size={13} />, onClick: () => setRename(true), hidden: !a.edit },
    { label: isHome ? 'Remove from my home' : 'Set as my home', icon: <Home size={13} />, onClick: () => setHome.mutate({ dashboardId: isHome ? null : d.id }, { onSuccess: () => addToast(isHome ? 'Your Dashboard page shows the built-in dashboard again.' : 'Shown on your Dashboard page.', 'success', 4000) }) },
    { label: 'Duplicate', icon: <Copy size={13} />, onClick: () => duplicate.mutate(d.id, { onSuccess: c => navigate(`/dashboards/${c.id}`), onError: e => addToast(apiError(e), 'error') }) },
    { label: 'Delete', icon: <Trash2 size={13} />, variant: 'danger', hidden: !a.delete, onClick: () => {
      if (window.confirm(`Delete “${d.title}”? ${d.visibility !== 'PRIVATE' ? 'Everyone it is shared with loses it too.' : ''}`)) del.mutate(d.id, { onSuccess: () => navigate('/dashboards'), onError: e => addToast(apiError(e), 'error') });
    } },
  ];

  return (
    <div className="animate-slide-up">
      <PageHeader
        title={<span data-user-content>{d.title}</span>}
        subtitle={(d.description || !a.isOwner) ? <span data-user-content>{[d.description, !a.isOwner ? `by ${d.owner.name}` : null].filter(Boolean).join(' · ')}</span> : undefined}
        breadcrumb="Dashboards"
        actions={
          <>
            <Link to="/dashboards" className="sr-only">All dashboards</Link>
            {editing ? (
              <>
                <Button variant="secondary" icon={<Plus size={14} />} onClick={() => setBuilder({ open: true })}>Add widget</Button>
                <Button icon={<Check size={14} />} onClick={() => setEditing(false)}>Done</Button>
              </>
            ) : (
              <>
                <Button variant="ghost" icon={<ArrowLeft size={14} />} onClick={() => navigate('/dashboards')} className="max-sm:hidden">All</Button>
                {a.share && <Button variant="secondary" icon={<Share2 size={14} />} onClick={() => setShare(true)}>Share</Button>}
                {a.edit && <Button icon={<Pencil size={14} />} onClick={() => setEditing(true)}>Edit</Button>}
              </>
            )}
            <RowActions items={more} triggerLabel="More dashboard actions" />
          </>
        }
        below={
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 min-w-0">
            {visibilityBadge(d.visibility)}
            <DateRangeControl value={viewRange === undefined ? d.dateRange : viewRange} onChange={r => {
              if (a.edit) { setViewRange(undefined); update.mutate({ id: d.id, dateRange: r }, { onError: e => addToast(apiError(e), 'error') }); }
              else setViewRange(r);
            }} />
            <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} onClick={() => setRefreshKey(k => k + 1)}>Refresh</Button>
            {a.edit && (
              <Toggle checked={d.refreshMinutes > 0} onChange={on => update.mutate({ id: d.id, refreshMinutes: on ? 5 : 0 })} label={<span className="inline-flex items-center gap-1 text-[12px] font-normal text-fg-muted"><Clock size={12} /> Auto-refresh 5 min</span>} />
            )}
            {lastAt && <span className="text-[11px] text-fg-subtle">Updated {new Date(lastAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>}
          </div>
        }
      />
      <PageBody>
        {editing && <p className="text-[12px] text-fg-muted -mb-2 max-md:hidden">Drag a widget by its title to move it; drag the corner to resize. Changes save as you go.</p>}
        {!d.widgets.length ? (
          <EmptyState icon={<LayoutDashboard />} title="No widgets yet"
            description={a.edit ? 'Add a chart, number or table from your data — or pin any Ask AI answer here.' : 'The owner hasn’t added anything yet.'}
            action={a.edit ? { label: 'Add widget', onClick: () => { setEditing(true); setBuilder({ open: true }); } } : undefined} />
        ) : (
          <DashboardCanvas
            dashboard={d} editing={editing} refreshKey={refreshKey} autoRefreshMinutes={d.refreshMinutes} range={viewRange}
            onEditWidget={w => setBuilder({ open: true, widget: w })} onAskAi={setAiWidget} aiEnabled={aiEnabled} onRendered={setLastAt}
          />
        )}
      </PageBody>

      <WidgetBuilder open={builder.open} onClose={() => setBuilder({ open: false })} initial={builder.widget?.spec ?? null} onSave={saveWidget}
        saving={add.isPending || updWidget.isPending} title={builder.widget ? 'Edit widget' : 'Add widget'} />
      <AiChangeWidgetDialog spec={aiWidget?.spec ?? null} open={!!aiWidget} onClose={() => setAiWidget(null)} applying={updWidget.isPending}
        onApply={spec => aiWidget && updWidget.mutate({ id: d.id, widgetId: aiWidget.id, spec }, { onSuccess: () => { setAiWidget(null); addToast('Widget updated', 'success', 3000); }, onError: e => addToast(apiError(e), 'error') })} />
      {a.share && <ShareDialog dashboard={d} open={share} onClose={() => setShare(false)} />}
      {a.edit && <RenameDialog dashboard={d} open={rename} onClose={() => setRename(false)} />}
    </div>
  );
}
