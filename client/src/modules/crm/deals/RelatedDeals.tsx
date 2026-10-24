/**
 * Related deals panel + "Lessons from related deals" AI card + the rule editor.
 *
 * Deals are "related" when they share the fields a CRM admin picked (e.g. a
 * DEAL custom field "Flat / Unit"). The server lists only deals this viewer may
 * open, and the AI card only ever reads those deals' notes; every reason it
 * shows quotes a real note and links to the deal it came from.
 */
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link2, Sparkles, Settings, AlertTriangle, CheckCircle2, ListChecks, HelpCircle, RefreshCw } from 'lucide-react';
import {
  Button, Modal, Badge, Alert, Checkbox, Tabs, AiInfo, AiGeneratedTag, FormActions,
} from '../../../shared/components';
import { api } from '../../../api/client';
import {
  useDealLinkRule, useSaveDealLinkRule, useRelatedDeals, useDealLessons,
  type LinkRuleField, type RelatedDeal, type CitedDeal, type CheckedReason, type LessonsResponse,
} from '../../../api/dealLinks';
import { useFormat } from '../../../hooks/useFormat';

const STATUS_VARIANT = { OPEN: 'blue', WON: 'green', LOST: 'red' } as const;
const STATUS_LABEL = { OPEN: 'Open', WON: 'Won', LOST: 'Lost' } as const;

const keyOf = (f: LinkRuleField) => (f.kind === 'custom' ? `custom:${f.fieldId}` : f.kind);

// ─── Rule editor ─────────────────────────────────────────────────────────────

export function DealLinkRuleModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data } = useDealLinkRule(open);
  const save = useSaveDealLinkRule();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string[]>([]);
  const [mode, setMode] = useState<'ALL' | 'ANY'>('ALL');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!open || !data) return;
    setSelected((data.rule?.fields ?? []).map(keyOf));
    setMode(data.rule?.mode ?? 'ALL');
  }, [open, data]);

  const options: Array<LinkRuleField & { label: string; group: string }> = [
    ...(data?.options.customFields ?? []).map(f => ({ kind: 'custom' as const, fieldId: f.id, label: f.label, group: 'Deal custom fields' })),
    ...(data?.options.builtins ?? []).map(b => ({ kind: b.kind, label: b.label, group: 'Built-in fields' })),
  ];
  const toggle = (k: string) => setSelected(s => (s.includes(k) ? s.filter(x => x !== k) : [...s, k]));

  /* The owner's example field, one click away: most orgs that want this have
     no "unit" field yet, and making them visit Custom Fields first loses them. */
  async function createUnitField() {
    setCreating(true);
    try {
      const f = await api.post('/custom-fields', { entityType: 'DEAL', label: 'Flat / Unit', fieldKey: 'flat_unit', fieldType: 'TEXT' }).then(r => r.data);
      await qc.invalidateQueries({ queryKey: ['deal-link-rule'] });
      qc.invalidateQueries({ queryKey: ['custom-fields'] });
      setSelected(s => [...s, `custom:${f.id}`]);
    } finally { setCreating(false); }
  }

  function submit() {
    const fields = options.filter(o => selected.includes(keyOf(o))).map(o => (o.kind === 'custom' ? { kind: o.kind, fieldId: o.fieldId } : { kind: o.kind }));
    save.mutate({ fields, mode }, { onSuccess: onClose });
  }

  const hasUnitField = (data?.options.customFields ?? []).some(f => /unit|flat/i.test(f.label));
  return (
    <Modal open={open} onClose={onClose} title="Related deals — matching rule" size="md">
      <div className="space-y-4">
        <p className="text-sm text-fg-muted">
          Treat two deals as related when they share the fields you tick — for example the same flat or unit.
          Each deal then lists the others, and the AI can read their notes to explain why earlier ones were lost.
          Matching ignores upper/lower case and extra spaces.
        </p>
        {!hasUnitField && (
          <Alert tone="neutral" icon={null} actions={<Button size="sm" variant="secondary" onClick={createUnitField} loading={creating}>Create “Flat / Unit” field</Button>}>
            <span>Selling units of a project? Add a <strong>Flat / Unit</strong> field to deals (e.g. “Tower B - 502”) and match on it.</span>
          </Alert>
        )}
        {['Deal custom fields', 'Built-in fields'].map(group => {
          const items = options.filter(o => o.group === group);
          return (
            <div key={group}>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-fg-subtle mb-2">{group}</p>
              {items.length === 0
                ? <p className="text-xs text-fg-subtle">None yet — add one under Custom Fields → Deals.</p>
                : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {items.map(o => (
                      <Checkbox key={keyOf(o)} label={o.label} checked={selected.includes(keyOf(o))} onChange={() => toggle(keyOf(o))} />
                    ))}
                  </div>
                )}
            </div>
          );
        })}
        {selected.length > 1 && (
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-fg-subtle mb-2">When several are ticked</p>
            <Tabs aria-label="Match mode" variant="segmented" value={mode} onChange={setMode}
              items={[{ key: 'ALL', label: 'All must match' }, { key: 'ANY', label: 'Any one matches' }]} />
          </div>
        )}
        <FormActions>
          {data?.rule && <Button variant="ghost" onClick={() => save.mutate({ fields: [], mode: 'ALL' }, { onSuccess: onClose })}>Turn off</Button>}
          <Button onClick={submit} loading={save.isPending} disabled={!selected.length}>Save rule</Button>
        </FormActions>
      </div>
    </Modal>
  );
}

// ─── Panel ───────────────────────────────────────────────────────────────────

function DealRow({ d, onOpen }: { d: RelatedDeal; onOpen: () => void }) {
  const { money, date } = useFormat();
  return (
    <li>
      <button type="button" onClick={onOpen}
        className="w-full text-left rounded-card border border-line-subtle bg-surface hover:bg-surface-sunken transition-colors px-3 py-2.5 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <Badge variant={STATUS_VARIANT[d.status]} size="sm" dot>{STATUS_LABEL[d.status]}</Badge>
          <span className="text-sm font-medium text-fg truncate min-w-0 flex-1" title={d.title}>{d.title}</span>
          {/* Beside the title on wider screens; on phones it moves to the
              line below so the title isn't cut to a few characters. */}
          {d.value != null && <span className="hidden sm:inline text-xs font-semibold tabular-nums text-fg-muted shrink-0">{money(d.value)}</span>}
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11.5px] text-fg-subtle">
          {d.value != null && <span className="sm:hidden font-semibold tabular-nums text-fg-muted">{money(d.value)}</span>}
          {d.owner && <span>{d.owner.name}</span>}
          <span>Created {date(d.createdAt)}</span>
          {d.closeDate && <span>Close date {date(d.closeDate)}</span>}
          {d.status === 'OPEN' && <span>{d.stage}</span>}
        </div>
        {d.latestNote && (
          <p className="mt-1.5 text-xs text-fg-muted line-clamp-2 break-words">
            <span className="text-fg-subtle">{d.latestNote.kind} · {date(d.latestNote.date)}: </span>{d.latestNote.text}
          </p>
        )}
      </button>
    </li>
  );
}

function summary(c: { lost: number; won: number; open: number }) {
  return [`${c.lost} lost`, `${c.won} won`, ...(c.open ? [`${c.open} open`] : [])].join(', ');
}

export function RelatedDealsPanel({ dealId, onOpenDeal }: { dealId: string; onOpenDeal: (id: string, title: string) => void }) {
  const [limit, setLimit] = useState(20);
  const [ruleOpen, setRuleOpen] = useState(false);
  const { data, isLoading } = useRelatedDeals(dealId, limit);
  useEffect(() => setLimit(20), [dealId]);

  const header = (
    <div className="flex items-center justify-between gap-2 mb-2">
      <p className="text-sm font-medium text-fg flex items-center gap-1.5">
        <Link2 size={14} className="text-accent" /> Related deals
      </p>
      {data?.configured && data.canEdit && (
        <Button size="xs" variant="ghost" icon={<Settings size={12} />} onClick={() => setRuleOpen(true)}>Matching rule</Button>
      )}
    </div>
  );

  let body: React.ReactNode;
  if (isLoading || !data) {
    body = <div className="skeleton h-16 w-full rounded-card" aria-hidden="true" />;
  } else if (!data.configured) {
    body = (
      <Alert tone="neutral" icon={null}
        actions={data.canEdit ? <Button size="sm" variant="secondary" icon={<Settings size={13} />} onClick={() => setRuleOpen(true)}>Set up</Button> : undefined}>
        <span>
          Link deals that share a field — such as the same flat or unit — to see how earlier deals on it went and why they were lost.
          {!data.canEdit && ' Ask a CRM admin to set it up (Admin → Custom Fields → Deals → Related deals rule, or Set up here on any deal).'}
        </span>
      </Alert>
    );
  } else if (data.missing?.length) {
    body = <p className="text-xs text-fg-muted">Fill in <strong>{data.missing.join(', ')}</strong> on this deal (Edit) to see related deals.</p>;
  } else if (!data.deals?.length) {
    body = <p className="text-xs text-fg-muted">No other deals you can see share {data.sharedOn?.join(' and ') || 'these fields'} yet.</p>;
  } else {
    body = (
      <div className="space-y-2">
        <p className="text-xs text-fg-muted">
          <strong className="text-fg">{summary(data.counts!)}</strong> with {data.sharedOn?.join(data.rule?.mode === 'ANY' ? ' or ' : ' and ')}
        </p>
        <ul className="space-y-1.5">
          {data.deals.map(d => <DealRow key={d.id} d={d} onOpen={() => onOpenDeal(d.id, d.title)} />)}
        </ul>
        {data.hasMore && (
          <Button size="xs" variant="ghost" onClick={() => setLimit(l => l + 20)}>Show more</Button>
        )}
      </div>
    );
  }

  const closed = data?.counts ? data.counts.lost + data.counts.won : 0;
  return (
    <div className="border-t border-line pt-4 space-y-3">
      <div>
        {header}
        {body}
      </div>
      {data?.configured && closed > 0 && <LessonsCard dealId={dealId} onOpenDeal={onOpenDeal} />}
      {data?.canEdit && <DealLinkRuleModal open={ruleOpen} onClose={() => setRuleOpen(false)} />}
    </div>
  );
}

// ─── Lessons (AI) ────────────────────────────────────────────────────────────

function DealLinks({ deals, onOpenDeal }: { deals: CitedDeal[]; onOpenDeal: (id: string, title: string) => void }) {
  return (
    <>
      {deals.map((d, i) => (
        <span key={d.id}>
          {i > 0 && ', '}
          <button type="button" className="underline decoration-dotted underline-offset-2 hover:text-accent" onClick={() => onOpenDeal(d.id, d.title)}>{d.title}</button>
        </span>
      ))}
    </>
  );
}

function ReasonList({ items, onOpenDeal }: { items: CheckedReason[]; onOpenDeal: (id: string, title: string) => void }) {
  const { date } = useFormat();
  return (
    <ul className="space-y-2">
      {items.map((r, i) => (
        <li key={i} className="text-xs">
          <p className="font-medium">{r.reason}</p>
          <p className="mt-0.5 opacity-90 italic break-words">“{r.quote}”</p>
          <p className="mt-0.5 opacity-75">
            — <DealLinks deals={[{ id: r.source.dealId, title: r.source.dealTitle, status: '' }]} onOpenDeal={onOpenDeal} />, {r.source.noteKind}, {date(r.source.noteDate)}
            {r.deals.length > 1 && <> · also <DealLinks deals={r.deals.filter(d => d.id !== r.source.dealId)} onOpenDeal={onOpenDeal} /></>}
          </p>
        </li>
      ))}
    </ul>
  );
}

function LessonsResult({ data, onOpenDeal }: { data: LessonsResponse; onOpenDeal: (id: string, title: string) => void }) {
  const { dateTime } = useFormat();
  if (data.status === 'no_history') return <p className="text-xs text-fg-muted">No won or lost related deals you can see yet — nothing to learn from.</p>;
  if (data.status === 'not_usable') return <p className="text-xs text-fg-muted">Fill in {data.missing?.join(', ')} on this deal first.</p>;
  if (data.status === 'not_configured' || !data.result) return null;
  const r = data.result;
  const nothing = !r.lossReasons.length && !r.whatWorked.length;
  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <AiGeneratedTag />
        <Badge size="sm" variant={r.confidence === 'high' ? 'green' : r.confidence === 'medium' ? 'yellow' : 'gray'}>{r.confidence} confidence</Badge>
        <span className="text-[11px] text-fg-subtle">
          From {data.basedOn?.lost ?? 0} lost and {data.basedOn?.won ?? 0} won deal{(data.basedOn?.won ?? 0) === 1 ? '' : 's'} ({data.basedOn?.notes ?? 0} notes)
          {data.cached && data.generatedAt ? ` · saved ${dateTime(data.generatedAt)}, notes unchanged` : ''}
        </span>
      </div>
      {r.lossReasons.length > 0 && (
        <Alert tone="danger" icon={<AlertTriangle size={15} />} title="Why earlier deals were lost">
          <ReasonList items={r.lossReasons} onOpenDeal={onOpenDeal} />
        </Alert>
      )}
      {r.whatWorked.length > 0 && (
        <Alert tone="success" icon={<CheckCircle2 size={15} />} title="What worked on won deals">
          <ReasonList items={r.whatWorked} onOpenDeal={onOpenDeal} />
        </Alert>
      )}
      {r.checklist.length > 0 && (
        <Alert tone="info" icon={<ListChecks size={15} />} title="Before you proceed">
          <ul className="space-y-1.5">
            {r.checklist.map((c, i) => (
              <li key={i} className="text-xs flex items-start gap-1.5">
                <span className="opacity-60 mt-0.5 shrink-0">&#9744;</span>
                <span>{c.item} <span className="opacity-70">(from <DealLinks deals={c.deals} onOpenDeal={onOpenDeal} />)</span></span>
              </li>
            ))}
          </ul>
        </Alert>
      )}
      {r.unexplained.length > 0 && (
        <Alert tone="warning" icon={<HelpCircle size={15} />} title="No reason recorded">
          <p className="text-xs">
            The notes on <DealLinks deals={r.unexplained} onOpenDeal={onOpenDeal} /> don’t say why {r.unexplained.length === 1 ? 'it was' : 'they were'} lost.
            Adding a short comment when a deal is lost makes this card more useful next time.
          </p>
        </Alert>
      )}
      {nothing && !r.unexplained.length && <p className="text-xs text-fg-muted">The notes didn’t contain anything specific to learn from.</p>}
      {r.caveats.length > 0 && (
        <ul className="text-[11px] text-fg-subtle space-y-0.5">
          {r.caveats.map((c, i) => <li key={i}>• {c}</li>)}
        </ul>
      )}
    </div>
  );
}

function LessonsCard({ dealId, onOpenDeal }: { dealId: string; onOpenDeal: (id: string, title: string) => void }) {
  const lessons = useDealLessons();
  useEffect(() => { lessons.reset(); }, [dealId]); // eslint-disable-line react-hooks/exhaustive-deps
  const err = (lessons.error as any)?.response?.data?.error as string | undefined;
  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-2">
        <p className="text-sm font-medium text-fg flex items-center gap-1.5">
          <Sparkles size={14} className="text-accent" /> Lessons from related deals
          <AiInfo id="deal.pastLessons" />
        </p>
        <Button size="sm" variant="secondary"
          icon={lessons.data?.status === 'ok' ? <RefreshCw size={12} /> : <Sparkles size={12} />}
          onClick={() => lessons.mutate({ dealId, refresh: lessons.data?.status === 'ok' })}
          loading={lessons.isPending}>
          {lessons.data?.status === 'ok' ? 'Re-run' : 'Analyse past deals'}
        </Button>
      </div>
      {!lessons.data && !err && (
        <p className="text-xs text-fg-muted">Reads the notes and comments on the related won and lost deals and tells you why earlier ones were lost and what to check first — quoting each note.</p>
      )}
      {err && <p className="text-xs text-danger">{err}</p>}
      {lessons.data && <LessonsResult data={lessons.data} onOpenDeal={onOpenDeal} />}
    </div>
  );
}
