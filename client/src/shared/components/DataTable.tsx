/**
 * DataTable — one table style for the whole product.
 *
 * The audit found five mutually incompatible table-header styles:
 *   • `text-left px-4 py-3 … tracking-wider` (21 uses, CRM/IT Desk)
 *   • `px-4 py-3 text-left … tracking-wide` (25 uses, top-level pages)
 *   • a light-only fork of that with no `dark:` at all (12 uses, TemplatesPage)
 *   • `pb-2 font-medium` on a bare `<tr>` (14 uses, HR + public docs)
 *   • styles hoisted onto `<thead>` (PlatformAdminPage)
 * They differed in letter-spacing, padding, which element carried the
 * background, and whether dark mode worked.
 *
 * The visual now lives in the `.ui-table` CSS class (index.css) so it is
 * theme-aware and row density follows --ui-row-py. This file provides both a
 * declarative API (`<DataTable columns rows>`) for straightforward lists and
 * composable parts (`<Table><Th/><Td/>`) for tables with complex cells.
 */

import { isValidElement } from 'react';
import { ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';
import { useMediaQuery, MD_UP } from '../../hooks/useMediaQuery';

/* ── Composable parts ──────────────────────────────────────────────── */

export function Table({
  children,
  minWidth,
  clickableRows = false,
  stickyFirst = false,
  className = '',
}: {
  children: React.ReactNode;
  /** Below this the container scrolls horizontally instead of squashing cells. */
  minWidth?: number;
  clickableRows?: boolean;
  /** Pin the first column while the rest scrolls sideways (wide grids on phones). */
  stickyFirst?: boolean;
  className?: string;
}) {
  return (
    <div className="table-container max-w-full">
      <table
        className={`ui-table ${clickableRows ? 'ui-table--clickable' : ''} ${stickyFirst ? 'ui-table--sticky-first' : ''} ${className}`}
        style={minWidth ? { minWidth } : undefined}
      >
        {children}
      </table>
    </div>
  );
}

export function Th({
  children,
  align = 'left',
  hideBelow,
  sortable,
  sorted,
  onSort,
  className = '',
  ...props
}: React.ThHTMLAttributes<HTMLTableCellElement> & {
  align?: 'left' | 'right' | 'center';
  /** Hide this column under the given breakpoint. */
  hideBelow?: 'sm' | 'md' | 'lg';
  sortable?: boolean;
  sorted?: 'asc' | 'desc' | false;
  onSort?: () => void;
}) {
  const hide = hideBelow ? { sm: 'hidden sm:table-cell', md: 'hidden md:table-cell', lg: 'hidden lg:table-cell' }[hideBelow] : '';
  const alignCls = align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : '';

  return (
    <th
      {...props}
      aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined}
      className={`${hide} ${alignCls} ${className}`}
    >
      {sortable ? (
        <button
          type="button"
          onClick={onSort}
          className={`inline-flex items-center gap-1 hover:text-fg transition-colors ${
            align === 'right' ? 'flex-row-reverse' : ''
          }`}
        >
          {children}
          {sorted === 'asc' ? <ArrowUp size={11} />
            : sorted === 'desc' ? <ArrowDown size={11} />
            : <ArrowUpDown size={11} className="opacity-40" />}
        </button>
      ) : children}
    </th>
  );
}

export function Td({
  children,
  align = 'left',
  hideBelow,
  muted,
  className = '',
  ...props
}: React.TdHTMLAttributes<HTMLTableCellElement> & {
  align?: 'left' | 'right' | 'center';
  hideBelow?: 'sm' | 'md' | 'lg';
  /** Secondary cell — de-emphasised text. */
  muted?: boolean;
}) {
  const hide = hideBelow ? { sm: 'hidden sm:table-cell', md: 'hidden md:table-cell', lg: 'hidden lg:table-cell' }[hideBelow] : '';
  const alignCls = align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : '';
  return (
    <td {...props} className={`${hide} ${alignCls} ${muted ? '!text-fg-muted' : ''} ${className}`}>
      {children}
    </td>
  );
}

/* ── Declarative API ───────────────────────────────────────────────── */

export interface Column<T> {
  key: string;
  header: React.ReactNode;
  /** Cell renderer. Return any node; keep it cheap, it runs per row. */
  cell: (row: T, index: number) => React.ReactNode;
  align?: 'left' | 'right' | 'center';
  hideBelow?: 'sm' | 'md' | 'lg';
  muted?: boolean;
  width?: string | number;
  /**
   * Role of this column in the phone card layout (below `md`).
   *   • 'title'   — the card's heading (default: first non-actions column)
   *   • 'actions' — top-right of the card (default: key 'actions', and any
   *                 column with an empty header — those are controls)
   *   • 'field'   — a "Label: value" line (default for the rest, up to
   *                 `mobileFields` of them, most important first)
   *   • 'hidden'  — not shown on phones
   */
  mobile?: 'title' | 'actions' | 'field' | 'hidden';
  /** Label for the phone card when `header` is not plain text. */
  mobileLabel?: string;
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string;
  onRowClick?: (row: T) => void;
  minWidth?: number;
  /** Shown in place of the body when `rows` is empty. */
  empty?: React.ReactNode;
  loading?: boolean;
  className?: string;
  /**
   * Phone layout (below `md`). 'cards' (default) renders each row as a
   * stacked card built from the column definitions. 'scroll' keeps the grid
   * — for tables that are genuinely two-dimensional — scrolling inside its
   * card with the first column pinned.
   */
  mobile?: 'cards' | 'scroll';
  /** Max "Label: value" lines per phone card (default 4). */
  mobileFields?: number;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  minWidth,
  empty,
  loading,
  className = '',
  mobile = 'cards',
  mobileFields = 4,
}: DataTableProps<T>) {
  const isDesktop = useMediaQuery(MD_UP);

  if (loading) {
    return (
      <div className="p-4 space-y-2">
        <div className="skeleton h-9 w-full" />
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="skeleton h-12 w-full" style={{ opacity: 1 - i * 0.15 }} />
        ))}
      </div>
    );
  }

  if (!rows.length && empty) return <>{empty}</>;

  if (!isDesktop && mobile === 'cards') {
    return <MobileCardList columns={columns} rows={rows} rowKey={rowKey} onRowClick={onRowClick} maxFields={mobileFields} />;
  }

  const stickyFirst = !isDesktop && mobile === 'scroll';

  return (
    <Table minWidth={minWidth} clickableRows={!!onRowClick} stickyFirst={stickyFirst} className={className}>
      <thead>
        <tr>
          {columns.map(c => (
            <Th
              key={c.key}
              align={c.align}
              hideBelow={c.hideBelow}
              style={c.width ? { width: c.width } : undefined}
            >
              {c.header}
            </Th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr
            key={rowKey(row, i)}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
          >
            {columns.map(c => (
              <Td key={c.key} align={c.align} hideBelow={c.hideBelow} muted={c.muted}>
                {c.cell(row, i)}
              </Td>
            ))}
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/* ── Phone card list ───────────────────────────────────────────────── */

const isEmptyCell = (v: React.ReactNode) =>
  v === null || v === undefined || v === false || v === '' ||
  (Array.isArray(v) && v.every(x => x === null || x === undefined || x === false || x === ''));

const hideRank = { undefined: 0, sm: 1, md: 2, lg: 3 } as const;

function columnLabel<T>(c: Column<T>): string | null {
  if (c.mobileLabel) return c.mobileLabel;
  if (typeof c.header === 'string' || typeof c.header === 'number') return String(c.header) || null;
  // <span>Text</span> style headers
  if (isValidElement(c.header)) {
    const ch = (c.header.props as { children?: unknown }).children;
    if (typeof ch === 'string') return ch;
  }
  return null;
}

/**
 * Rows as stacked cards: the title column as the heading, the next most
 * important columns (those not hidden at the smallest breakpoints) as
 * "Label: value" lines, and the actions column top-right. Replaces a table
 * that was wider than the screen and cut off inside its card.
 */
function MobileCardList<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  maxFields,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string;
  onRowClick?: (row: T) => void;
  maxFields: number;
}) {
  const visible = columns.filter(c => c.mobile !== 'hidden');
  // Header-less columns are controls (row menus, reorder arrows, toggles):
  // they all go top-right with the actions.
  const actionCols = visible.filter(c =>
    c.mobile === 'actions' || (!c.mobile && (c.key === 'actions' || (!c.header && columnLabel(c) === null))));
  const rest = visible.filter(c => !actionCols.includes(c));
  const titleCol = rest.find(c => c.mobile === 'title') ?? rest.find(c => !c.mobile) ?? rest[0];
  const fieldCols = rest
    .filter(c => c !== titleCol && c.mobile !== 'title')
    .map((c, i) => ({ c, i }))
    // Explicit 'field' first, then by how early the desktop table hides it.
    .sort((a, b) =>
      (a.c.mobile === 'field' ? -1 : 0) - (b.c.mobile === 'field' ? -1 : 0) ||
      hideRank[String(a.c.hideBelow) as keyof typeof hideRank] - hideRank[String(b.c.hideBelow) as keyof typeof hideRank] ||
      a.i - b.i)
    .slice(0, maxFields)
    // ...but keep the table's column order on screen.
    .sort((a, b) => a.i - b.i)
    .map(x => x.c);

  return (
    <ul className="divide-y divide-line-subtle" role="list">
      {rows.map((row, i) => {
        const fields = fieldCols
          .map(c => ({ c, label: columnLabel(c), value: c.cell(row, i) }))
          .filter(f => !isEmptyCell(f.value));
        return (
          <li
            key={rowKey(row, i)}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
            className={`px-4 py-3 text-[13px] ${
              onRowClick ? 'cursor-pointer active:bg-surface-hover transition-colors' : ''
            }`}
          >
            {/* Title and controls share the first line; the fields below get
                the card's full width whatever the controls take. */}
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1 font-medium text-fg break-words">
                {titleCol?.cell(row, i)}
              </div>
              {actionCols.length > 0 && (
                <div className="shrink-0 -mr-1.5 -my-1 flex items-center gap-1 flex-wrap justify-end max-w-[60%]">
                  {actionCols.map(c => <div key={c.key} className="contents">{c.cell(row, i)}</div>)}
                </div>
              )}
            </div>
            {fields.length > 0 && (
              <dl className="mt-1.5 grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12.5px] items-center">
                {fields.map(({ c, label, value }) => label ? (
                  <div key={c.key} className="contents">
                    <dt className="text-fg-subtle whitespace-nowrap max-w-[8.5rem] truncate">{label}</dt>
                    <dd className={`min-w-0 break-words ${c.muted ? 'text-fg-muted' : 'text-fg'}`}>{value}</dd>
                  </div>
                ) : (
                  <dd key={c.key} className={`col-span-2 min-w-0 break-words ${c.muted ? 'text-fg-muted' : 'text-fg'}`}>{value}</dd>
                ))}
              </dl>
            )}
          </li>
        );
      })}
    </ul>
  );
}
