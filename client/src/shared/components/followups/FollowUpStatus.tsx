import { AlarmClock, Clock, CalendarClock, CalendarPlus } from 'lucide-react';
import type { FollowUpSummary, FollowUpRef } from '../../../api/followups';

/**
 * Follow-up status for one lead/deal, as a small pill: OVERDUE (red alarm
 * clock + count), DUE TODAY (amber clock + count), UPCOMING (neutral calendar
 * + next date), no date, or — for open records only — a subtle "plan one"
 * nudge. The server computes the summary in the org's timezone
 * (utils/followups); this only draws it.
 *
 * Never colour-only: the pill always carries text ("2 overdue", "Today",
 * "28 Oct"), and the full sentence ("Call Mr. Iyer — overdue 2 days") is its
 * aria-label and tooltip.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "28 Oct" / "28 Oct, 14:30" — date-only values are calendar dates (UTC), timed ones are shown in the org zone. */
export function followUpDueText(ref: Pick<FollowUpRef, 'dueAt' | 'dateOnly'>, timezone: string, withTime = true): string {
  if (!ref.dueAt) return 'No date';
  const d = new Date(ref.dueAt);
  if (ref.dateOnly) return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, day: 'numeric', month: 'short' }).format(d);
  if (!withTime) return day;
  const t = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  return `${day}, ${t}`;
}

const TONE = {
  OVERDUE: 'bg-danger-soft text-danger border-danger/30',
  TODAY: 'bg-warning-soft text-warning-fg border-warning/30',
  UPCOMING: 'bg-surface-sunken text-fg-muted border-line',
  UNDATED: 'bg-surface-sunken text-fg-muted border-line',
  NONE: 'bg-transparent text-fg-subtle border-dashed border-line',
} as const;

export interface FollowUpStatusIconProps {
  summary?: FollowUpSummary | null;
  /** Won / lost / converted / unqualified: no "plan one" nudge. */
  closed?: boolean;
  timezone: string;
  /** Opens the record's follow-ups. */
  onClick?: () => void;
  /** 'compact' = icon + count/date only (board cards, phone rows). */
  size?: 'compact' | 'full';
  className?: string;
}

export function FollowUpStatusIcon({ summary, closed, timezone, onClick, size = 'full', className = '' }: FollowUpStatusIconProps) {
  if (!summary) return null;
  const s = summary.status;
  // Closed records still show work that's planned on them, but get no "plan one" nudge.
  if (s === 'NONE' && closed) return null;
  let Icon = CalendarClock;
  let text = '';
  let aria = summary.label;
  if (s === 'OVERDUE') {
    Icon = AlarmClock;
    text = size === 'compact' ? String(summary.overdue) : `${summary.overdue} overdue`;
    aria = `${summary.overdue} overdue follow-up${summary.overdue === 1 ? '' : 's'}${summary.today ? `, ${summary.today} due today` : ''}. ${summary.label}`;
  } else if (s === 'TODAY') {
    Icon = Clock;
    text = size === 'compact' ? String(summary.today) : summary.today > 1 ? `${summary.today} today` : 'Today';
    aria = `${summary.today} follow-up${summary.today === 1 ? '' : 's'} due today. ${summary.label}`;
  } else if (s === 'UPCOMING') {
    text = summary.next ? followUpDueText(summary.next, timezone, false) : 'Planned';
    aria = `Next follow-up: ${summary.label}`;
  } else if (s === 'UNDATED') {
    text = 'No date';
    aria = `Follow-up planned with no date: ${summary.label}`;
  } else {
    Icon = CalendarPlus;
    text = size === 'compact' ? '' : 'Plan';
    aria = 'No follow-up planned — plan one';
  }
  const cls = `inline-flex items-center gap-1 h-6 px-1.5 rounded-full border text-[11px] font-medium tabular-nums whitespace-nowrap ${TONE[s]} ${onClick ? 'hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring' : ''} ${className}`;
  const inner = (
    <>
      <Icon size={12} aria-hidden="true" className="shrink-0" />
      {text && <span>{text}</span>}
    </>
  );
  return onClick
    ? <button type="button" onClick={e => { e.stopPropagation(); onClick(); }} className={cls} aria-label={aria} title={aria}>{inner}</button>
    : <span role="img" className={cls} aria-label={aria} title={aria}>{inner}</span>;
}

export const FOLLOWUP_FILTERS = [
  { value: 'overdue', label: 'Overdue follow-ups' },
  { value: 'today', label: 'Follow-ups due today' },
  { value: 'none', label: 'No follow-up planned' },
];

/** Client-side filter for the board (which already has every open deal loaded). */
export function matchesFollowUpFilter(s: FollowUpSummary | undefined, f: string): boolean {
  if (!f) return true;
  if (!s) return f === 'none';
  if (f === 'overdue') return s.overdue > 0;
  if (f === 'today') return s.today > 0;
  if (f === 'none') return s.status === 'NONE';
  return true;
}
