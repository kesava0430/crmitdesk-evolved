/**
 * AiPlanCard — the one confirmation card for an AI action plan, used by the
 * command bar and the chat bubble.
 *
 * Shows every step with exactly what will change (before → after), a risk
 * badge per step, anything the server could not settle on its own (blocked
 * steps, errors, "which Acme deal did you mean?" pickers), and only enables
 * Run once the plan is complete. A plan with a high-risk step (payroll,
 * money, access, outbound messages) needs a second, explicit confirmation.
 * After running it becomes the result card: each step's outcome with a link
 * to the record, and — when a step failed — exactly which steps completed
 * and which never started.
 *
 * The server re-validates everything on execute; this card is a view.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle, ArrowRight, CheckCircle2, ChevronRight, CircleSlash, ExternalLink, Info, Loader2, Play, ShieldAlert, Sparkles, XCircle,
} from 'lucide-react';
import type { AiActionPlan, AiExecutionReport, AiPlanStep, AiRisk } from '../../api/ai';
import { useExecuteAiPlan, useReviewAiPlan } from '../../api/ai';
import { Alert } from './Alert';
import { Badge } from './Badge';
import { Button } from './Button';

const RISK: Record<AiRisk, { label: string; variant: 'green' | 'yellow' | 'red' }> = {
  low: { label: 'Low risk', variant: 'green' },
  medium: { label: 'Medium risk', variant: 'yellow' },
  high: { label: 'High risk', variant: 'red' },
};

function newKey() {
  try { return crypto.randomUUID(); } catch { return `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
}

/** Steps as the API expects them, with the user's picks applied ("userIds.1" paths too). */
function stepsWithPicks(steps: AiPlanStep[], picks: Record<string, string>) {
  return steps.map(s => {
    const params: Record<string, any> = JSON.parse(JSON.stringify(s.params ?? {}));
    for (const n of s.needs) {
      const id = picks[`${s.index}:${n.param}`];
      if (!id) continue;
      const [key, idx] = n.param.split('.');
      if (idx !== undefined && Array.isArray(params[key])) params[key][Number(idx)] = id;
      else params[key] = id;
    }
    return { action: s.action, params };
  });
}

/** Older servers answered with a single action — present it as a one-step plan. */
function normalise(plan: AiActionPlan): AiPlanStep[] {
  if (plan.steps?.length) return plan.steps;
  if (!plan.action) return [];
  return [{
    index: 1, action: plan.action, label: plan.label ?? plan.action, category: 'Shared', params: plan.params ?? {}, risk: 'medium',
    allowed: plan.allowed, errors: [], needs: [], warnings: [], dependsOn: [],
    preview: { title: plan.label ?? plan.action, changes: Object.entries(plan.params ?? {}).map(([k, v]) => ({ field: k, after: typeof v === 'object' ? JSON.stringify(v) : String(v) })) },
  }];
}

export interface AiPlanCardProps {
  plan: AiActionPlan;
  command?: string;
  /** Smaller type for the chat bubble. */
  compact?: boolean;
  onDone?: (report: AiExecutionReport) => void;
  onDismiss?: () => void;
  /** Called before following a record link (e.g. to close the modal). */
  onNavigate?: () => void;
  /** Changes when the person types "yes" in the chat: acts like pressing the
   *  primary button (a second "yes" is the explicit high-risk confirmation). */
  confirmToken?: number;
  /** Changes when the person types "no"/"cancel" in the chat. */
  dismissToken?: number;
}

export function AiPlanCard({ plan: initial, command, compact = false, onDone, onDismiss, onNavigate, confirmToken, dismissToken }: AiPlanCardProps) {
  const navigate = useNavigate();
  const [plan, setPlan] = useState<AiActionPlan>(initial);
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [phase, setPhase] = useState<'review' | 'confirmHigh' | 'done' | 'dismissed'>('review');
  const [report, setReport] = useState<AiExecutionReport | null>(null);
  const key = useRef(newKey());
  const review = useReviewAiPlan();
  const execute = useExecuteAiPlan();

  const steps = useMemo(() => normalise(plan), [plan]);
  const openNeeds = steps.flatMap(s => s.needs.map(n => ({ step: s.index, n }))).filter(x => !picks[`${x.step}:${x.n.param}`]);
  const blocked = steps.filter(s => !s.allowed);
  const withErrors = steps.filter(s => s.errors.length);
  const highRisk = steps.filter(s => s.risk === 'high');
  const hasPicks = Object.keys(picks).length > 0;
  const runnable = steps.length > 0 && !blocked.length && !withErrors.length && openNeeds.length === 0;
  const overall: AiRisk = steps.some(s => s.risk === 'high') ? 'high' : steps.some(s => s.risk === 'medium') ? 'medium' : 'low';

  const text = compact ? 'text-[12px]' : 'text-[13px]';
  const small = compact ? 'text-[11px]' : 'text-[12px]';

  async function applyPicks() {
    const next = await review.mutateAsync({
      steps: stepsWithPicks(steps, picks), planId: plan.planId, interactionLogId: plan.interactionLogId, explanation: plan.explanation, confidence: plan.confidence,
    });
    setPlan(next);
    setPicks({});
  }

  async function run(confirmHighRisk: boolean) {
    try {
      const r = await execute.mutateAsync({
        steps: stepsWithPicks(steps, picks), planId: plan.planId, interactionLogId: plan.interactionLogId,
        confirmHighRisk, idempotencyKey: key.current, command,
      });
      setReport(r);
      setPhase('done');
      onDone?.(r);
    } catch { /* shown below from execute.error */ }
  }

  function onConfirm() {
    if (hasPicks) return void applyPicks();
    if (highRisk.length) return setPhase('confirmHigh');
    void run(false);
  }

  // Typed confirmations from the chat bubble.
  const lastConfirm = useRef(confirmToken);
  useEffect(() => {
    if (confirmToken === undefined || confirmToken === lastConfirm.current) return;
    lastConfirm.current = confirmToken;
    if (execute.isPending || review.isPending) return;
    if (phase === 'confirmHigh') void run(true);
    else if (phase === 'review' && (hasPicks ? openNeeds.length === 0 : runnable)) onConfirm();
  }, [confirmToken]); // eslint-disable-line react-hooks/exhaustive-deps
  const lastDismiss = useRef(dismissToken);
  useEffect(() => {
    if (dismissToken === undefined || dismissToken === lastDismiss.current) return;
    lastDismiss.current = dismissToken;
    if (phase === 'review' || phase === 'confirmHigh') { setPhase('dismissed'); onDismiss?.(); }
  }, [dismissToken]); // eslint-disable-line react-hooks/exhaustive-deps

  function go(link?: string) {
    if (!link) return;
    onNavigate?.();
    navigate(link);
  }

  if (phase === 'dismissed') {
    return <p className={`${small} text-fg-subtle`}>Dismissed — nothing was run.</p>;
  }

  // ── Result card ──
  if (phase === 'done' && report) {
    return (
      <div className="space-y-2.5" data-testid="ai-plan-result">
        <Alert tone={report.ok ? 'success' : report.completed ? 'warning' : 'danger'}>
          <span className={text}>{report.summary}</span>
        </Alert>
        {report.steps.length > 0 && (
          <ol className="space-y-1.5">
            {report.steps.map(s => (
              <li key={s.index} className="flex items-start gap-2 min-w-0">
                <span className="mt-0.5 shrink-0">
                  {s.status === 'done' ? <CheckCircle2 size={14} className="text-success" />
                    : s.status === 'failed' ? <XCircle size={14} className="text-danger" />
                      : <CircleSlash size={14} className="text-fg-subtle" />}
                </span>
                <div className="min-w-0 flex-1">
                  <p className={`${text} text-fg break-words`}>
                    {steps.length > 1 && <span className="font-semibold">{s.index}. </span>}
                    {s.status === 'done' ? s.summary : s.status === 'failed' ? `${s.label} — ${s.error}` : `${s.label} — not started`}
                  </p>
                  {s.status === 'done' && s.output?.link && (
                    <button type="button" onClick={() => go(s.output!.link)}
                      className={`${small} inline-flex items-start gap-1 text-left text-accent hover:underline mt-0.5`}>
                      <span className="min-w-0 break-words">Open {s.output.label ? `“${s.output.label}”` : `the ${s.output.type ?? 'record'}`}</span> <ExternalLink size={11} className="mt-0.5 shrink-0" />
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="ai-plan-card">
      {/* Header */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-1.5 flex-wrap">
          <Badge variant={RISK[overall].variant} size="sm">{overall === 'high' && <ShieldAlert size={11} />} {RISK[overall].label}</Badge>
          {steps.length > 1 && <Badge variant="indigo" size="sm">{steps.length} steps</Badge>}
          {typeof plan.confidence === 'number' && plan.confidence > 0 && <Badge variant="gray" size="sm">{Math.round(plan.confidence)}% confident</Badge>}
        </div>
        {plan.explanation && <p className={`${text} text-fg-muted leading-relaxed`}>{plan.explanation}</p>}
      </div>

      {/* Steps */}
      <ol className="space-y-2">
        {steps.map(s => (
          <li key={s.index} className={`rounded-card border ${s.risk === 'high' ? 'border-danger/40' : 'border-line'} bg-surface overflow-hidden`}>
            <div className={`flex items-start gap-2 px-2.5 py-2 ${s.risk === 'high' ? 'bg-danger-soft/40' : 'bg-surface-sunken'} border-b border-line-subtle`}>
              {steps.length > 1 && (
                <span className="shrink-0 mt-px h-5 w-5 rounded-full bg-accent-soft text-accent-soft-fg text-[11px] font-semibold flex items-center justify-center">{s.index}</span>
              )}
              <div className="min-w-0 flex-1">
                <p className={`${text} font-semibold text-fg break-words`}>{s.preview.title || s.label}</p>
                <p className={`${small} text-fg-subtle`}>
                  {s.label}{s.dependsOn.length ? ` · uses step ${s.dependsOn.join(', ')}` : ''}
                </p>
              </div>
              <Badge variant={RISK[s.risk].variant} size="sm" className="shrink-0">{s.risk === 'high' ? 'High' : s.risk === 'medium' ? 'Medium' : 'Low'}</Badge>
            </div>

            <div className="px-2.5 py-2 space-y-2">
              {s.preview.changes.length > 0 && (
                <dl className={`grid grid-cols-[minmax(0,6.5rem)_minmax(0,1fr)] sm:grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-x-2 gap-y-1 ${small}`}>
                  {s.preview.changes.map((c, i) => (
                    <div key={i} className="contents">
                      <dt className="text-fg-muted break-words">{c.field}</dt>
                      <dd className="text-fg break-words min-w-0">
                        {c.before !== undefined && c.before !== null && c.before !== c.after ? (
                          <span className="inline-flex flex-wrap items-center gap-x-1">
                            <span className="text-fg-subtle line-through decoration-fg-subtle/60">{c.before}</span>
                            <ArrowRight size={11} className="text-fg-subtle shrink-0" />
                            <span className="font-medium">{c.after ?? '—'}</span>
                          </span>
                        ) : (
                          <span className="font-medium">{c.after ?? '—'}</span>
                        )}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}

              {s.preview.target?.link && (
                <button type="button" onClick={() => go(s.preview.target!.link)} className={`${small} inline-flex items-start gap-1 text-left text-accent hover:underline`}>
                  <span className="min-w-0 break-words">View “{s.preview.target.label}”</span> <ExternalLink size={11} className="mt-0.5 shrink-0" />
                </button>
              )}

              {(s.preview.notes ?? []).map((n, i) => (
                <p key={`n${i}`} className={`${small} flex items-start gap-1.5 text-fg-muted`}><Info size={12} className="mt-0.5 shrink-0" /> <span className="min-w-0">{n}</span></p>
              ))}
              {s.warnings.map((w, i) => (
                <p key={`w${i}`} className={`${small} flex items-start gap-1.5 text-warning-fg`}><AlertTriangle size={12} className="mt-0.5 shrink-0" /> <span className="min-w-0">{w}</span></p>
              ))}
              {!s.allowed && (
                <p className={`${small} flex items-start gap-1.5 text-danger-fg`}><ShieldAlert size={12} className="mt-0.5 shrink-0" /> <span className="min-w-0">{s.blockedReason ?? 'You can’t run this step.'}</span></p>
              )}
              {s.errors.map((e, i) => (
                <p key={`e${i}`} className={`${small} flex items-start gap-1.5 text-danger-fg`}><XCircle size={12} className="mt-0.5 shrink-0" /> <span className="min-w-0">{e}</span></p>
              ))}

              {/* "Which one did you mean?" */}
              {s.needs.map(n => {
                const k = `${s.index}:${n.param}`;
                return (
                  <fieldset key={k} className="space-y-1.5">
                    <legend className={`${small} font-medium text-fg mb-1`}>Which {n.noun} did you mean by “{n.query}”?</legend>
                    <div className="flex flex-col gap-1" role="radiogroup">
                      {n.candidates.map(c => {
                        const on = picks[k] === c.id;
                        return (
                          <button key={c.id} type="button" role="radio" aria-checked={on}
                            onClick={() => setPicks(p => ({ ...p, [k]: c.id }))}
                            className={`text-left px-2.5 py-1.5 rounded-btn border ${small} transition-colors min-w-0 ${on ? 'border-accent bg-accent-soft text-accent-soft-fg' : 'border-line hover:bg-surface-hover text-fg'}`}>
                            <span className="font-medium break-words">{c.label}</span>
                            {c.hint && <span className="block text-fg-subtle break-words">{c.hint}</span>}
                          </button>
                        );
                      })}
                    </div>
                  </fieldset>
                );
              })}
            </div>
          </li>
        ))}
      </ol>

      {/* Errors from review / execute */}
      {(review.isError || execute.isError) && (
        <Alert tone="danger"><span className={text}>{((execute.error || review.error) as any)?.response?.data?.error || 'Something went wrong — nothing was run.'}</span></Alert>
      )}

      {/* Second confirmation for high-risk steps */}
      {phase === 'confirmHigh' ? (
        <div className="rounded-card border border-danger/40 bg-danger-soft/50 p-2.5 space-y-2" data-testid="ai-plan-second-confirm">
          <p className={`${text} font-semibold text-danger-fg flex items-center gap-1.5`}><ShieldAlert size={14} /> Confirm the high-risk step{highRisk.length > 1 ? 's' : ''}</p>
          <ul className={`${small} text-fg space-y-0.5 list-disc pl-4`}>
            {highRisk.map(s => <li key={s.index} className="break-words">{s.preview.title || s.label}</li>)}
          </ul>
          <p className={`${small} text-fg-muted`}>This moves money, changes payroll or access, or sends messages that can’t be recalled.</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button size={compact ? 'xs' : 'sm'} variant="danger" loading={execute.isPending} onClick={() => run(true)} icon={<Play size={12} />}>
              Yes, run {steps.length > 1 ? `all ${steps.length} steps` : 'it'}
            </Button>
            <Button size={compact ? 'xs' : 'sm'} variant="ghost" disabled={execute.isPending} onClick={() => setPhase('review')}>Back</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size={compact ? 'xs' : 'sm'}
            onClick={onConfirm}
            disabled={hasPicks ? openNeeds.length > 0 : !runnable}
            loading={execute.isPending || review.isPending}
            icon={hasPicks ? <ChevronRight size={12} /> : highRisk.length ? <ShieldAlert size={12} /> : <CheckCircle2 size={12} />}
            data-testid="ai-plan-confirm"
          >
            {hasPicks ? 'Use these' : highRisk.length ? 'Continue' : steps.length > 1 ? `Confirm & run ${steps.length} steps` : 'Confirm & run'}
          </Button>
          <Button size={compact ? 'xs' : 'sm'} variant="secondary" disabled={execute.isPending}
            onClick={() => { setPhase('dismissed'); onDismiss?.(); }}>
            Cancel
          </Button>
          {!runnable && !hasPicks && (
            <span className={`${small} text-fg-subtle`}>
              {openNeeds.length ? 'Pick the right record to continue.' : blocked.length ? 'Some steps aren’t allowed for you.' : withErrors.length ? 'Fix the problems above (rephrase the request).' : ''}
            </span>
          )}
          {(execute.isPending || review.isPending) && <Loader2 size={13} className="animate-spin text-fg-subtle" />}
        </div>
      )}
      <p className={`${compact ? 'text-[10.5px]' : 'text-[11px]'} text-fg-subtle flex items-center gap-1`}>
        <Sparkles size={10} /> Nothing runs until you confirm; each step is re-checked against your permissions and logged as AI-initiated.
      </p>
    </div>
  );
}
