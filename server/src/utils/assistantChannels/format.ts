/**
 * Chat formatting for the messaging assistant — pure and unit-tested.
 *
 * WhatsApp and Slack both render *bold* and plain line breaks, nothing else
 * reliably, and both are read on phones: short lines, a few rows at most, and
 * a link to the full answer (with its chart) in the app. Every number here
 * comes from the query result (fmtValue with the org's currency) — never from
 * model text.
 */
import { fmtValue, fmtNumber, fmtMoney } from '../analytics/answer';
import type { AskResult } from '../analytics/ask';
import type { ActionPlan, PlanStep } from '../aiActions/planner';
import type { ExecutionReport } from '../aiActions/executor';
import type { PendingChoose, PendingConfirm } from './state';

export type Channel = 'whatsapp' | 'slack';

/** Twilio's WhatsApp body limit is 1600; Slack allows far more but phones don't. */
export const MAX_REPLY_CHARS: Record<Channel, number> = { whatsapp: 1500, slack: 3500 };

export function clip(text: string, max: number): string {
  const t = String(text ?? '').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

const MAX_ROWS = 5;

function rowLines(r: AskResult['results'][number]): string[] {
  const currency = r.meta.currency;
  const dims = r.columns.filter(c => c.role === 'dimension');
  const measures = r.columns.filter(c => c.role === 'measure');
  const fields = r.columns.filter(c => c.role === 'field');
  if (r.meta.kind === 'list') {
    const shown = fields.slice(0, 4);
    return r.rows.slice(0, MAX_ROWS).map(row => `• ${shown.map(c => fmtValue(row[c.key], c, currency)).join(' · ')}`);
  }
  if (!dims.length || !measures.length) return [];
  // A time series reads best as its most recent buckets; a breakdown as its top rows.
  const rows = r.meta.bucket ? r.rows.slice(-MAX_ROWS) : r.rows.slice(0, MAX_ROWS);
  return rows.map(row => {
    const label = dims.map(d => fmtValue(row[d.key], d, currency)).join(' / ');
    const values = measures.map(m => (measures.length > 1 ? `${m.label}: ` : '') + fmtValue(row[m.key], m, currency)).join(', ');
    return `• ${label} — ${values}`;
  });
}

/** An answer from answerQuestion, as chat text. `link` opens the full answer in the app. */
export function formatAnswer(a: AskResult, opts: { channel: Channel; link?: string }): string {
  const lines: string[] = [];
  if (a.status === 'unanswerable') {
    lines.push(a.answer);
    const topics = a.available.slice(0, 6).map(x => x.label);
    if (topics.length) lines.push('', `You can ask about: ${topics.join(', ')}.`);
    const ex = a.available.flatMap(x => x.examples).slice(0, 2);
    if (ex.length) lines.push(`For example: “${ex[0]}”${ex[1] ? ` or “${ex[1]}”` : ''}`);
    return clip(lines.join('\n'), MAX_REPLY_CHARS[opts.channel]);
  }
  if (a.title) lines.push(`*${a.title}*`);
  lines.push(a.answer);
  const first = a.results[0];
  if (a.forecast && a.forecast.method !== 'none' && a.forecast.totals) {
    const f = a.forecast;
    const money = f.measure?.format === 'money';
    const v = (n: number) => (money ? fmtMoney(n, f.currency) : fmtNumber(n, f.currency));
    const t = a.forecast.totals;
    lines.push('', `Projected ${f.horizon.human}: *${v(t.projected)}* (likely ${v(t.lower)}–${v(t.upper)})`);
    for (const d of (f.derived ?? []).slice(0, 2)) {
      if (d.projected === null || d.projected === undefined) continue;
      const dv = (n: number) => (d.format === 'money' ? fmtMoney(n, f.currency) : fmtNumber(n, f.currency));
      lines.push(`${d.label}: ${dv(d.projected)}`);
    }
  } else if (first) {
    const rows = rowLines(first);
    if (rows.length) {
      lines.push('', ...rows);
      const more = first.rows.length - rows.length;
      if (more > 0 && !first.meta.bucket) lines.push(`…and ${more} more`);
    }
  }
  if (first?.meta.description) lines.push('', `_${first.meta.description}_`);
  if (opts.link) lines.push(`Full answer and chart: ${opts.link}`);
  return clip(lines.join('\n'), MAX_REPLY_CHARS[opts.channel]);
}

function stepLines(s: PlanStep, n: number | null): string[] {
  const out = [`${n !== null ? `${n}. ` : ''}${s.preview?.title || s.label}`];
  for (const c of (s.preview?.changes ?? []).slice(0, 6)) {
    out.push(`   • ${c.field}: ${c.before ? `${c.before} → ` : ''}${c.after ?? '—'}`);
  }
  for (const note of (s.preview?.notes ?? []).slice(0, 3)) out.push(`   ${note}`);
  for (const w of s.warnings.slice(0, 2)) out.push(`   Note: ${w}`);
  return out;
}

/** A ready plan waiting for "yes". */
export function formatPlanPrompt(plan: ActionPlan, pending: PendingConfirm, channel: Channel, minutes: number): string {
  const multi = plan.steps.length > 1;
  const lines = [plan.explanation ? plan.explanation : 'Here’s what I’ll do:', ''];
  plan.steps.forEach((s, i) => lines.push(...stepLines(s, multi ? i + 1 : null)));
  lines.push('');
  if (pending.highRisk) {
    const high = plan.steps.filter(s => s.risk === 'high').map(s => s.label.toLowerCase());
    lines.push(`*High-risk:* ${high.join(', ')}. After YES you’ll be asked to type *${pending.phrase}* to run it.`);
  }
  lines.push(`Reply *YES* to run ${multi ? 'all steps' : 'it'} or *NO* to cancel (expires in ${minutes} min).`);
  return clip(lines.join('\n'), MAX_REPLY_CHARS[channel]);
}

export function formatSecondConfirm(pending: PendingConfirm): string {
  return `This can’t be undone from chat. To run it, reply exactly:\n*${pending.phrase}*\n\nReply NO to cancel.`;
}

/** "Which contact did you mean?" with numbered options. */
export function formatChoices(p: PendingChoose, channel: Channel): string {
  const lines = [`Which ${p.noun} did you mean by “${p.query}”?`];
  p.candidates.slice(0, 9).forEach((c, i) => lines.push(`${i + 1}. ${c.label}${c.hint ? ` — ${c.hint}` : ''}`));
  lines.push('', 'Reply with the number, or NO to cancel.');
  return clip(lines.join('\n'), MAX_REPLY_CHARS[channel]);
}

/** A plan that can't run as proposed: who can't do what, or what's missing. */
export function formatBlocked(plan: ActionPlan, channel: Channel): string {
  const lines = ['I can’t run that as asked:'];
  for (const s of plan.steps) {
    if (!s.allowed) lines.push(`• ${s.label}: ${s.blockedReason ?? 'not allowed for your role'}`);
    for (const e of s.errors.slice(0, 3)) lines.push(`• ${s.label}: ${e}`);
  }
  lines.push('', 'Rephrase with the details (who, what, when), or do it in the app.');
  return clip(lines.join('\n'), MAX_REPLY_CHARS[channel]);
}

/** The executor's report, with links to what was created or changed. */
export function formatReport(report: ExecutionReport, channel: Channel, linkFor: (path: string) => string): string {
  const lines: string[] = [];
  if (report.ok) lines.push(report.steps.length > 1 ? `Done — ${report.summary}` : `Done. ${report.summary}`);
  else lines.push(report.summary);
  if (report.steps.length > 1 || report.steps.some(s => s.output?.link)) {
    lines.push('');
    for (const s of report.steps) {
      const mark = s.status === 'done' ? 'Done' : s.status === 'failed' ? 'Failed' : 'Not started';
      const link = s.status === 'done' && typeof s.output?.link === 'string' ? ` ${linkFor(s.output.link)}` : '';
      lines.push(`${s.index}. ${mark}: ${s.status === 'done' ? (s.summary ?? s.label) : s.status === 'failed' ? `${s.label} — ${s.error}` : s.label}${link}`);
    }
  }
  return clip(lines.join('\n'), MAX_REPLY_CHARS[channel]);
}

export const HELP_TEXT = (channel: Channel) => [
  '*Zenkara 360 assistant*',
  channel === 'whatsapp'
    ? 'Start a message with *zen* to talk to me, e.g.:'
    : 'Message me here or use */zen*, e.g.:',
  `• ${channel === 'whatsapp' ? 'zen ' : ''}How many tickets are open?`,
  `• ${channel === 'whatsapp' ? 'zen ' : ''}Create a high priority ticket: VPN down for sales`,
  `• ${channel === 'whatsapp' ? 'zen ' : ''}I need leave tomorrow, I’m unwell`,
  'I always show you what I’ll do and wait for YES before changing anything.',
].join('\n');
