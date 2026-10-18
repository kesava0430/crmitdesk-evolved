/**
 * Desktop grid layout for dashboards — pure.
 *
 * A dashboard stores { [widgetId]: { x, y, w, h } } on a 12-column grid. The
 * client moves and resizes widgets freely; the server normalises whatever it
 * receives (clamps sizes, places widgets that have no cell, removes overlaps
 * and compacts upwards) so a stale or hand-edited layout can never render
 * widgets on top of each other.
 *
 * The block between the layout-core markers is copied verbatim into
 * client/src/shared/components/dashboards/layout.ts so a drag shows exactly
 * what the server will save; tests/unit/dashboards.test.ts fails if the two
 * copies drift apart.
 */

// <layout-core>
export const GRID_COLS = 12;
export const MIN_W = 2;
export const MIN_H = 2;
export const MAX_H = 12;

export interface Cell { x: number; y: number; w: number; h: number }
export type Layout = Record<string, Cell>;

/** Default size per visualisation (grid units; one row is ~80px). */
export function defaultSize(viz: string): { w: number; h: number } {
  switch (viz) {
    case 'kpi': return { w: 3, h: 2 };
    case 'forecast': return { w: 8, h: 5 };
    case 'line': case 'area': case 'stacked_bar': return { w: 6, h: 4 };
    case 'table': return { w: 12, h: 5 };
    case 'pie': case 'donut': return { w: 4, h: 4 };
    case 'note': return { w: 4, h: 3 };
    case 'funnel': return { w: 6, h: 4 };
    default: return { w: 6, h: 4 };
  }
}

function toInt(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

export function clampCell(c: Partial<Cell> | null | undefined, size: { w: number; h: number }): Cell | null {
  if (!c || typeof c !== 'object') return null;
  if (c.x == null && c.y == null) return null;
  const w = Math.min(GRID_COLS, Math.max(MIN_W, toInt(c.w, size.w)));
  const h = Math.min(MAX_H, Math.max(MIN_H, toInt(c.h, size.h)));
  const x = Math.min(GRID_COLS - w, Math.max(0, toInt(c.x, 0)));
  const y = Math.max(0, toInt(c.y, 0));
  return { x, y, w, h };
}

export function overlaps(a: Cell, b: Cell): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Normalised layout for `ids` (in their stacked/phone order).
 *  - cells are clamped to the grid; widgets without a cell get their default
 *    size and the first free spot (reading order) after the placed ones;
 *  - widgets are processed top-to-bottom, left-to-right; each moves up as far
 *    as it can and then down until it overlaps nothing already placed.
 * Deterministic: the same input always gives the same layout.
 */
export function normaliseLayout(ids: string[], layout: Record<string, Partial<Cell> | undefined> | null | undefined, sizes: Record<string, { w: number; h: number }>): Layout {
  const src = layout && typeof layout === 'object' ? layout : {};
  const order = new Map(ids.map((id, i) => [id, i]));
  const withCell: Array<{ id: string; c: Cell }> = [];
  const without: string[] = [];
  for (const id of ids) {
    const c = clampCell(src[id], sizes[id] ?? { w: 6, h: 4 });
    if (c) withCell.push({ id, c }); else without.push(id);
  }
  withCell.sort((a, b) => a.c.y - b.c.y || a.c.x - b.c.x || (order.get(a.id)! - order.get(b.id)!));
  const placed: Array<{ id: string; c: Cell }> = [];
  const collides = (c: Cell) => placed.some(p => overlaps(p.c, c));
  for (const { id, c } of withCell) {
    const cell = { ...c };
    while (cell.y > 0 && !collides({ ...cell, y: cell.y - 1 })) cell.y--;
    while (collides(cell)) cell.y++;
    placed.push({ id, c: cell });
  }
  for (const id of without) {
    const size = sizes[id] ?? { w: 6, h: 4 };
    const w = Math.min(GRID_COLS, Math.max(MIN_W, size.w));
    const h = Math.min(MAX_H, Math.max(MIN_H, size.h));
    let spot: Cell | null = null;
    for (let y = 0; !spot; y++) {
      for (let x = 0; x <= GRID_COLS - w; x++) {
        const c = { x, y, w, h };
        if (!collides(c)) { spot = c; break; }
      }
    }
    placed.push({ id, c: spot });
  }
  const out: Layout = {};
  for (const p of placed) out[p.id] = p.c;
  return out;
}

/** Reading order of a layout (top-to-bottom, left-to-right) — the phone order after a desktop rearrange. */
export function readingOrder(layout: Layout): string[] {
  return Object.entries(layout).sort(([, a], [, b]) => a.y - b.y || a.x - b.x).map(([id]) => id);
}
// </layout-core>
