import { useEffect, useRef, useState } from 'react';
import { Sparkles, Plus, X, Phone, Mail, Users, ClipboardList, Check } from 'lucide-react';
import { useNextStep, invalidateFollowUps, type NextStepSuggestion, type RecordKind } from '../../../api/followups';
import { useCreateActivity } from '../../../api/crm';
import { useCreateTask } from '../../../api/work';
import { useAuth } from '../../../contexts/AuthContext';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '../Button';
import { IconButton } from '../IconButton';
import { AiInfo } from '../AiInfo';

/**
 * "Suggested next step": one follow-up the AI proposes from the record's
 * recent notes, as a chip with a single "Add follow-up" button. Never
 * created automatically.
 *
 * `trigger` changes after something is saved on the record (a comment, a
 * logged call, a sent email); the chip then asks once, after a short pause.
 * The server only calls the model when the record's context changed and at
 * most once per record every few minutes — a cache hit otherwise.
 *
 * Leads get an Activity (their Follow-up Activities list); deals get a Task
 * linked to the deal (the deal's Tasks panel), assigned to you.
 */

const ICON = { CALL: Phone, EMAIL: Mail, MEETING: Users, TASK: ClipboardList } as const;
const WORD = { CALL: 'Call', EMAIL: 'Email', MEETING: 'Meeting', TASK: 'Task' } as const;

export interface NextStepChipProps {
  kind: RecordKind;
  recordId: string;
  contactId?: string | null;
  aiEnabled: boolean;
  /** Bump after a save on the record to get a fresh suggestion (debounced). */
  trigger?: number;
  className?: string;
}

export function NextStepChip({ kind, recordId, contactId, aiEnabled, trigger = 0, className = '' }: NextStepChipProps) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const ask = useNextStep();
  const createActivity = useCreateActivity();
  const createTask = useCreateTask();
  const [s, setS] = useState<NextStepSuggestion | null>(null);
  const [note, setNote] = useState('');
  const [added, setAdded] = useState(false);
  const [hidden, setHidden] = useState(false);
  const first = useRef(true);

  async function run(auto: boolean) {
    setNote(''); setAdded(false);
    try {
      const r = await ask.mutateAsync({ entityType: kind, entityId: recordId, auto });
      setS(r.suggestion); setHidden(false);
      if (!auto && r.stale && r.retryInSeconds) setNote(`Showing the last suggestion — a new one can be asked in ${Math.ceil(r.retryInSeconds / 60)} min.`);
    } catch (e: any) {
      const code = e?.response?.status;
      // Not licensed / not configured: quietly nothing on the automatic path.
      if (!auto) setNote(e?.response?.data?.error || (code === 402 ? 'Needs Advanced AI on your plan.' : 'Could not get a suggestion.'));
    }
  }

  useEffect(() => { setS(null); setNote(''); setAdded(false); setHidden(false); first.current = true; }, [recordId]);
  useEffect(() => {
    if (!aiEnabled) return;
    if (first.current) { first.current = false; if (!trigger) return; }
    const t = setTimeout(() => run(true), 1500);
    return () => clearTimeout(t);
  }, [trigger]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!aiEnabled) return null;

  async function add() {
    if (!s) return;
    try {
      if (kind === 'LEAD') {
        await createActivity.mutateAsync({ leadId: recordId, contactId: contactId ?? undefined, type: s.type, title: s.title, dueAt: s.dueAt, assignedTo: user?.id });
      } else {
        await createTask.mutateAsync({ title: `${WORD[s.type]}: ${s.title}`, dueAt: s.dueAt, entityType: 'DEAL', entityId: recordId, assigneeUserId: user?.id } as any);
      }
      setAdded(true);
      invalidateFollowUps(qc);
      qc.invalidateQueries({ queryKey: [kind === 'LEAD' ? 'leads' : 'deals', recordId] });
    } catch (e: any) {
      setNote(e?.response?.data?.error || 'Could not add the follow-up.');
    }
  }

  const Icon = s ? ICON[s.type] : Sparkles;
  return (
    <div className={`space-y-1.5 ${className}`}>
      {s && !hidden ? (
        <div className="flex items-start gap-2 rounded-card border border-accent/30 bg-accent-soft/40 px-3 py-2">
          <Icon size={14} className="text-accent mt-0.5 shrink-0" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-[12.5px] font-medium text-fg leading-snug">
              <span className="sr-only">Suggested next step: </span>{WORD[s.type]}: {s.title}
            </p>
            <p className="text-[11px] text-fg-muted">{s.dueLabel}{s.defaulted ? ' (suggested time couldn’t be used — next working morning)' : ''}</p>
            {s.reason && <p className="text-[11px] text-fg-subtle mt-0.5">{s.reason}</p>}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {added
              ? <span className="text-[11px] text-success flex items-center gap-1"><Check size={12} aria-hidden="true" /> Added</span>
              : <Button size="xs" icon={<Plus size={12} />} onClick={add} loading={createActivity.isPending || createTask.isPending}>Add follow-up</Button>}
            <IconButton size="xs" label="Dismiss suggestion" icon={<X size={12} />} onClick={() => setHidden(true)} />
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="xs" icon={<Sparkles size={12} />} onClick={() => run(false)} loading={ask.isPending}>Suggest next step</Button>
          <AiInfo id="crm.nextStep" align="left" />
        </div>
      )}
      {note && <p className="text-[11px] text-fg-subtle">{note}</p>}
    </div>
  );
}
