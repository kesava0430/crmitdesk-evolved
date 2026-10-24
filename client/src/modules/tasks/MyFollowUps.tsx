import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlarmClock, Clock, Check, BellOff, ExternalLink, Phone, Mail, Users, ClipboardList, Settings2 } from 'lucide-react';
import {
  useMyFollowUps, useCompleteFollowUp, useSnoozeFollowUp, useFollowUpPrefs, useSaveFollowUpPrefs, type MyFollowUp,
} from '../../api/followups';
import { Card, Button, IconButton, Input, Toggle, followUpDueText } from '../../shared/components';
import { useFormat } from '../../hooks/useFormat';

/**
 * "Follow-ups" at the top of My Work: the CRM calls, emails, meetings and
 * tasks you're responsible for that are overdue or due today (org timezone),
 * overdue first, with one-click done / snooze / open. Permission-filtered on
 * the server; not shown at all when CRM is off for the org.
 */

const ICON: Record<string, any> = { CALL: Phone, EMAIL: Mail, MEETING: Users, TASK: ClipboardList };

export function recordLink(r: MyFollowUp['record']): string {
  if (r.kind === 'LEAD') return `/crm/leads?followups=${encodeURIComponent(r.id)}`;
  if (r.kind === 'DEAL') return `/crm/deals?deal=${encodeURIComponent(r.id)}`;
  return `/crm/contacts/${encodeURIComponent(r.id)}`;
}

function Row({ f, timezone }: { f: MyFollowUp; timezone: string }) {
  const done = useCompleteFollowUp();
  const snooze = useSnoozeFollowUp();
  const [snoozing, setSnoozing] = useState(false);
  const [custom, setCustom] = useState('');
  const [error, setError] = useState('');
  const Icon = ICON[f.type] ?? ClipboardList;
  const overdue = f.status === 'OVERDUE';
  const due = followUpDueText(f, timezone);
  const when = overdue
    ? (f.days > 0 ? `Overdue ${f.days} day${f.days === 1 ? '' : 's'} · ${due}` : `Overdue · ${due}`)
    : f.dateOnly ? 'Due today' : `Due today · ${due.split(', ')[1] ?? due}`;

  async function doSnooze(preset: '1h' | '3h' | 'tomorrow' | 'custom') {
    setError('');
    try {
      await snooze.mutateAsync({ source: f.source, id: f.id, preset, ...(preset === 'custom' ? { until: custom ? new Date(custom).toISOString() : '' } : {}) });
      setSnoozing(false);
    } catch (e: any) { setError(e?.response?.data?.error || 'Could not snooze.'); }
  }

  return (
    <div className="px-4 py-3 border-b border-line-subtle last:border-0">
      <div className="flex items-start gap-3">
        <span className={`mt-0.5 w-7 h-7 rounded-btn flex items-center justify-center shrink-0 ${overdue ? 'bg-danger-soft text-danger' : 'bg-warning-soft text-warning-fg'}`} aria-hidden="true">
          <Icon size={14} />
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-[13.5px] font-medium text-fg break-words">{f.title}</p>
          <div className="flex items-center gap-x-2 gap-y-0.5 mt-0.5 flex-wrap text-[11.5px]">
            <span className={`inline-flex items-center gap-1 font-medium ${overdue ? 'text-danger' : 'text-warning-fg'}`}>
              {overdue ? <AlarmClock size={11} aria-hidden="true" /> : <Clock size={11} aria-hidden="true" />}{when}
            </span>
            <Link to={recordLink(f.record)} className="text-fg-muted hover:text-accent truncate max-w-full">
              {f.record.kind === 'LEAD' ? 'Lead' : f.record.kind === 'DEAL' ? 'Deal' : 'Contact'}: {f.record.name}
            </Link>
          </div>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <IconButton label={`Mark “${f.title}” done`} tone="success" icon={<Check size={15} />} disabled={done.isPending} onClick={() => done.mutate({ source: f.source, id: f.id })} />
          <IconButton label={`Snooze “${f.title}”`} icon={<BellOff size={14} />} aria-expanded={snoozing} onClick={() => setSnoozing(v => !v)} />
          <Link to={recordLink(f.record)} aria-label={`Open ${f.record.name}`} title={`Open ${f.record.name}`}
            className="inline-flex items-center justify-center w-7 h-7 icon-touch rounded-btn text-fg-subtle hover:text-accent hover:bg-accent-soft">
            <ExternalLink size={14} />
          </Link>
        </div>
      </div>
      {snoozing && (
        <div className="mt-2 ml-10 flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-fg-subtle mr-1">Snooze until</span>
          <Button size="xs" variant="secondary" onClick={() => doSnooze('1h')} disabled={snooze.isPending}>1 hour</Button>
          <Button size="xs" variant="secondary" onClick={() => doSnooze('3h')} disabled={snooze.isPending}>3 hours</Button>
          <Button size="xs" variant="secondary" onClick={() => doSnooze('tomorrow')} disabled={snooze.isPending}>Tomorrow morning</Button>
          <Input aria-label="Snooze until (date and time)" type="datetime-local" inputSize="sm" className="w-48" value={custom} onChange={e => setCustom(e.target.value)} />
          <Button size="xs" onClick={() => doSnooze('custom')} disabled={!custom || snooze.isPending}>Set</Button>
          {error && <span className="basis-full text-[11px] text-danger">{error}</span>}
        </div>
      )}
    </div>
  );
}

function Prefs() {
  const { data } = useFollowUpPrefs();
  const save = useSaveFollowUpPrefs();
  if (!data) return null;
  return (
    <div className="px-4 py-3 border-b border-line-subtle bg-surface-sunken space-y-3">
      <Toggle checked={data.digest} onChange={v => save.mutate({ digest: v })} label="Morning summary"
        hint="One notification at the start of the working day: how many follow-ups are due today and overdue." />
      <Toggle checked={data.whatsapp} disabled={!data.whatsappAvailable && !data.whatsapp} onChange={v => save.mutate({ whatsapp: v })}
        label="Also remind me on WhatsApp" hint={data.whatsappHint ?? 'Due reminders also go to your verified WhatsApp number.'} />
    </div>
  );
}

export function MyFollowUps({ enabled }: { enabled: boolean }) {
  const { timezone } = useFormat();
  const { data } = useMyFollowUps(enabled);
  const [showPrefs, setShowPrefs] = useState(false);
  if (!enabled || !data) return null;
  const tz = data.timezone || timezone;
  return (
    <Card padding="none" className="overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-line-subtle">
        <AlarmClock size={14} className={data.overdue ? 'text-danger' : 'text-warning'} aria-hidden="true" />
        <h2 className="text-[13px] font-semibold text-fg">Follow-ups</h2>
        <span className="text-[11px] text-fg-subtle tabular-nums">
          {data.overdue ? `${data.overdue} overdue` : ''}{data.overdue && data.today ? ' · ' : ''}{data.today ? `${data.today} today` : ''}
          {!data.overdue && !data.today ? 'nothing due today' : ''}
        </span>
        <IconButton className="ml-auto" size="xs" label="Follow-up reminder settings" icon={<Settings2 size={13} />} aria-expanded={showPrefs} onClick={() => setShowPrefs(v => !v)} />
      </div>
      {showPrefs && <Prefs />}
      {data.items.length === 0
        ? <p className="px-4 py-3 text-[12.5px] text-fg-muted">No overdue or due-today follow-ups. Nice.</p>
        : data.items.map(f => <Row key={`${f.source}:${f.id}`} f={f} timezone={tz} />)}
    </Card>
  );
}
