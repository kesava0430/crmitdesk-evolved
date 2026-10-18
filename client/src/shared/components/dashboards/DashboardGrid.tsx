/**
 * Dashboard grid. Desktop (≥ md): a 12-column CSS grid where, in edit mode,
 * a widget's header drags it and the corner handle resizes it — plain
 * pointer events, no grid library. Every preview goes through the same
 * normaliseLayout() the server saves with (layout.ts), so what you drop is
 * what is stored. Phones: one stacked column in the saved order, with
 * up / down buttons in edit mode instead of dragging.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, GripVertical, MoveDiagonal2, CalendarRange } from 'lucide-react';
import type { RenderedWidget, WidgetSpec, Cell } from '../../../api/dashboards';
import { RowActions, type RowAction } from '../RowActions';
import { WidgetView } from './WidgetView';
import { normaliseLayout, defaultSize, overlaps, GRID_COLS, MIN_W, MIN_H, MAX_H, type Layout } from './layout';

export const ROW_PX = 76;
export const GAP_PX = 16;
const HEADER_PX = 42;

export function useIsDesktop(): boolean {
  const q = '(min-width: 768px)';
  const [m, setM] = useState(() => (typeof window !== 'undefined' ? window.matchMedia(q).matches : true));
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setM(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return m;
}

/** Phone chart heights per visualisation. */
function phoneChartHeight(spec: WidgetSpec): number {
  if (spec.kind === 'note') return 0;
  switch (spec.viz.type) {
    case 'forecast': return 240;
    case 'pie': case 'donut': return 180;
    default: return 220;
  }
}

/** Move/resize preview: cells under the target are pushed below it, then the whole layout is normalised. */
export function previewLayout(ids: string[], layout: Layout, id: string, target: Cell, sizes: Record<string, { w: number; h: number }>): Layout {
  const cells: Layout = { ...layout, [id]: target };
  for (const other of ids) {
    if (other === id || !cells[other]) continue;
    if (overlaps(cells[other], target)) cells[other] = { ...cells[other], y: target.y + target.h };
  }
  const order = [id, ...ids.filter(x => x !== id)];
  return normaliseLayout(order, cells, sizes);
}

export interface GridWidget { id: string; spec: WidgetSpec }

interface Props {
  widgets: GridWidget[];
  layout: Layout;
  rendered: Record<string, RenderedWidget | undefined>;
  loading: boolean;
  currency: string;
  editing: boolean;
  menuFor: (w: GridWidget) => RowAction[];
  onLayoutChange?: (layout: Layout) => void;
  onOrderChange?: (order: string[]) => void;
  onRetry?: (id: string) => void;
  enumOrderFor?: (spec: WidgetSpec) => string[];
}

function WidgetCard({ w, r, loading, currency, height, editing, menu, onRetry, dragHandle, enumOrder, footer }: {
  w: GridWidget; r?: RenderedWidget; loading: boolean; currency: string; height: number | null; editing: boolean;
  menu: RowAction[]; onRetry?: () => void; dragHandle?: React.HTMLAttributes<HTMLDivElement>; enumOrder?: string[]; footer?: React.ReactNode;
}) {
  const chartH = height == null ? phoneChartHeight(w.spec) : Math.max(90, height - HEADER_PX - 22);
  return (
    <div
      className={`h-full flex flex-col rounded-card border bg-surface shadow-ui-sm min-w-0 ${editing ? 'border-accent/40' : 'border-line'}`}
      data-testid="dashboard-widget"
      data-widget-id={w.id}
    >
      <div
        className={`flex items-center gap-1.5 pl-3 pr-1.5 shrink-0 border-b border-line-subtle ${editing && dragHandle ? 'cursor-move select-none touch-none' : ''}`}
        style={{ height: HEADER_PX }}
        {...(editing ? dragHandle : {})}
      >
        {editing && dragHandle && <GripVertical size={13} className="text-fg-subtle shrink-0" aria-hidden />}
        <h3 className="text-[12.5px] font-semibold text-fg truncate min-w-0 flex-1" title={w.spec.title}>{w.spec.title}</h3>
        {r?.rangeApplied && <span title="Uses the dashboard date range" className="text-fg-subtle shrink-0"><CalendarRange size={12} aria-label="Uses the dashboard date range" /></span>}
        <div onPointerDown={e => e.stopPropagation()} className="shrink-0">
          <RowActions items={menu} triggerLabel={`Actions for ${w.spec.title}`} />
        </div>
      </div>
      <div className={`flex-1 min-h-0 px-3 py-2.5 ${height != null ? 'overflow-auto' : ''}`}>
        <WidgetView spec={w.spec} rendered={r} loading={loading} currency={currency} chartHeight={chartH} onRetry={onRetry} enumOrder={enumOrder} />
      </div>
      {footer}
    </div>
  );
}

export function DashboardGrid({ widgets, layout, rendered, loading, currency, editing, menuFor, onLayoutChange, onOrderChange, onRetry, enumOrderFor }: Props) {
  const desktop = useIsDesktop();
  const ids = useMemo(() => widgets.map(w => w.id), [widgets]);
  const sizes = useMemo(() => Object.fromEntries(widgets.map(w => [w.id, defaultSize(w.spec.kind === 'note' ? 'note' : w.spec.viz.type)])), [widgets]);
  const base = useMemo(() => normaliseLayout(ids, layout, sizes), [ids, layout, sizes]);
  const [live, setLive] = useState<Layout | null>(null);
  const shown = live ?? base;
  const gridRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; mode: 'move' | 'resize'; startX: number; startY: number; cell: Cell; colW: number } | null>(null);

  useEffect(() => { setLive(null); }, [layout]);

  const begin = (id: string, mode: 'move' | 'resize') => (e: React.PointerEvent) => {
    if (!editing || !gridRef.current) return;
    e.preventDefault();
    const rect = gridRef.current.getBoundingClientRect();
    const colW = (rect.width - GAP_PX * (GRID_COLS - 1)) / GRID_COLS;
    drag.current = { id, mode, startX: e.clientX, startY: e.clientY, cell: shown[id], colW };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = Math.round((e.clientX - d.startX) / (d.colW + GAP_PX));
    const dy = Math.round((e.clientY - d.startY) / (ROW_PX + GAP_PX));
    const c = d.cell;
    const target = d.mode === 'move'
      ? { ...c, x: Math.min(GRID_COLS - c.w, Math.max(0, c.x + dx)), y: Math.max(0, c.y + dy) }
      : { ...c, w: Math.min(GRID_COLS - c.x, Math.max(MIN_W, c.w + dx)), h: Math.min(MAX_H, Math.max(MIN_H, c.h + dy)) };
    setLive(previewLayout(ids, base, d.id, target, sizes));
  };
  const end = () => {
    const d = drag.current;
    drag.current = null;
    if (d && live && JSON.stringify(live) !== JSON.stringify(base)) onLayoutChange?.(live);
    else setLive(null);
  };

  if (!desktop) {
    return (
      <div className="flex flex-col gap-3 min-w-0">
        {widgets.map((w, i) => (
          <WidgetCard
            key={w.id} w={w} r={rendered[w.id]} loading={loading} currency={currency} height={null} editing={editing}
            menu={menuFor(w)} onRetry={onRetry ? () => onRetry(w.id) : undefined} enumOrder={enumOrderFor?.(w.spec)}
            footer={editing && onOrderChange ? (
              <div className="flex justify-end gap-1 px-2 pb-2">
                <button type="button" className="h-8 px-2.5 rounded-btn border border-line text-[12px] text-fg-muted disabled:opacity-40 inline-flex items-center gap-1" disabled={i === 0}
                  onClick={() => { const o = [...ids]; [o[i - 1], o[i]] = [o[i], o[i - 1]]; onOrderChange(o); }} aria-label={`Move ${w.spec.title} up`}>
                  <ArrowUp size={13} /> Up
                </button>
                <button type="button" className="h-8 px-2.5 rounded-btn border border-line text-[12px] text-fg-muted disabled:opacity-40 inline-flex items-center gap-1" disabled={i === widgets.length - 1}
                  onClick={() => { const o = [...ids]; [o[i + 1], o[i]] = [o[i], o[i + 1]]; onOrderChange(o); }} aria-label={`Move ${w.spec.title} down`}>
                  <ArrowDown size={13} /> Down
                </button>
              </div>
            ) : undefined}
          />
        ))}
      </div>
    );
  }

  return (
    <div
      ref={gridRef}
      className="grid min-w-0"
      style={{ gridTemplateColumns: `repeat(${GRID_COLS}, minmax(0, 1fr))`, gridAutoRows: `${ROW_PX}px`, gap: GAP_PX }}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
    >
      {widgets.map(w => {
        const c = shown[w.id];
        if (!c) return null;
        const height = c.h * ROW_PX + (c.h - 1) * GAP_PX;
        return (
          <div key={w.id} className="relative min-w-0" style={{ gridColumn: `${c.x + 1} / span ${c.w}`, gridRow: `${c.y + 1} / span ${c.h}` }}>
            <WidgetCard
              w={w} r={rendered[w.id]} loading={loading} currency={currency} height={height} editing={editing}
              menu={menuFor(w)} onRetry={onRetry ? () => onRetry(w.id) : undefined} enumOrder={enumOrderFor?.(w.spec)}
              dragHandle={{ onPointerDown: begin(w.id, 'move') }}
            />
            {editing && (
              <div
                role="presentation"
                onPointerDown={begin(w.id, 'resize')}
                className="absolute bottom-0.5 right-0.5 w-5 h-5 flex items-center justify-center cursor-se-resize text-fg-subtle hover:text-accent touch-none"
                title="Drag to resize"
              >
                <MoveDiagonal2 size={13} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
