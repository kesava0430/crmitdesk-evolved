/**
 * A plan as plain text — for surfaces without the confirmation card (team
 * chat @ai today; WhatsApp/Slack replies later). Same facts as the card:
 * each step, before → after, risk, open questions.
 */
import type { ActionPlan } from './planner';

export function planAsText(plan: ActionPlan): string {
  const lines: string[] = [];
  if (plan.explanation) lines.push(plan.explanation);
  for (const s of plan.steps) {
    const risk = s.risk === 'high' ? ' ⚠️ high risk' : '';
    lines.push(`**${plan.steps.length > 1 ? `${s.index}. ` : ''}${s.preview.title || s.label}**${risk}`);
    for (const c of s.preview.changes.slice(0, 8)) {
      lines.push(`• ${c.field}: ${c.before !== undefined && c.before !== null && c.before !== c.after ? `${c.before} → ` : ''}${c.after ?? '—'}`);
    }
    for (const n of s.preview.notes ?? []) lines.push(`  ${n}`);
    if (!s.allowed) lines.push(`  ✋ ${s.blockedReason}`);
    for (const e of s.errors) lines.push(`  ❗ ${e}`);
    for (const q of s.needs) lines.push(`  ❓ Which ${q.noun} is “${q.query}”? ${q.candidates.map(c => `${c.label}${c.hint ? ` (${c.hint})` : ''}`).join(' / ')}`);
    for (const w of s.warnings) lines.push(`  ⚠️ ${w}`);
  }
  return lines.join('\n');
}
