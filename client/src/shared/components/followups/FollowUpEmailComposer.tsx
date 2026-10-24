import { useEffect, useState } from 'react';
import { Sparkles, Send, Copy, Check, AlertTriangle, RefreshCw, Mail, ShieldCheck, PenLine } from 'lucide-react';
import {
  useDraftFollowUpEmail, useEmailChannel, useCheckEmail, useSendFollowUpEmail,
  type RecordKind, type EmailDraft, type FactFlag,
} from '../../../api/followups';
import { useToneCheck } from '../../../api/ai';
import { Button } from '../Button';
import { Modal } from '../Modal';
import { Alert } from '../Alert';
import { Input, Textarea, Select, Label, Checkbox } from '../Field';
import { AiInfo, AiGeneratedTag } from '../AiInfo';
import { ToneCheckResult } from './ToneCheckResult';

/**
 * Follow-up email for a lead or deal: AI draft from the record's real
 * context (or write your own), edit, fact-check, then Send — always behind a
 * confirmation that says exactly who it goes to, from which address, and
 * whether replies will come back into the record. Nothing is sent otherwise.
 *
 * The server flags every amount/percent/date/weekday/time in the draft that
 * it can't find in the record ("check: ₹80,00,000 not found in the deal").
 * Editing the text marks those flags stale; the confirm step re-checks.
 */

const PURPOSES = [
  { value: 'check_in', label: 'Check-in' },
  { value: 'after_site_visit', label: 'After site visit / meeting' },
  { value: 'send_quote', label: 'Send / follow up on quote' },
  { value: 'payment_reminder', label: 'Payment / loan reminder' },
  { value: 're_engage', label: 'Re-engage a cold lead' },
];
const TONES = [{ value: 'friendly', label: 'Friendly' }, { value: 'formal', label: 'Formal' }, { value: 'concise', label: 'Concise' }];
const LANGS = [{ value: 'en', label: 'English' }, { value: 'hi', label: 'हिन्दी (Hindi)' }, { value: 'te', label: 'తెలుగు (Telugu)' }];

function errText(err: any, fallback: string): string {
  return err?.response?.data?.error || err?.message || fallback;
}

export interface FollowUpEmailComposerProps {
  kind: RecordKind;
  recordId: string;
  /** Advanced AI licensed for the org — without it the composer is manual-only. */
  aiEnabled: boolean;
  /** Called after a successful send (e.g. to trigger a next-step suggestion). */
  onSent?: () => void;
}

export function FollowUpEmailComposer({ kind, recordId, aiEnabled, onSent }: FollowUpEmailComposerProps) {
  const draft = useDraftFollowUpEmail(kind);
  const check = useCheckEmail();
  const sendMut = useSendFollowUpEmail();
  const toneCheck = useToneCheck();
  const [opts, setOpts] = useState({ purpose: 'check_in', tone: 'friendly', language: 'en' });
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [ai, setAi] = useState<EmailDraft | null>(null);
  const [flags, setFlags] = useState<FactFlag[]>([]);
  const [flagsStale, setFlagsStale] = useState(false);
  const [copied, setCopied] = useState<'subject' | 'body' | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [readIt, setReadIt] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [error, setError] = useState('');
  const channel = useEmailChannel(kind, recordId, open);
  const word = kind === 'DEAL' ? 'deal' : 'lead';

  // A different record: start clean.
  useEffect(() => { setOpen(false); setSubject(''); setBody(''); setAi(null); setFlags([]); setResult(null); setError(''); }, [recordId]);

  async function generate(refresh = false) {
    setError(''); setResult(null);
    try {
      const d = await draft.mutateAsync({ id: recordId, ...opts, refresh });
      setAi(d); setSubject(d.subject); setBody(d.body); setFlags(d.flags); setFlagsStale(false); setOpen(true);
    } catch (e) { setError(errText(e, 'Could not draft the email.')); }
  }

  function edit(field: 'subject' | 'body', v: string) {
    if (field === 'subject') setSubject(v); else setBody(v);
    setFlagsStale(true);
  }

  async function recheck(): Promise<FactFlag[]> {
    try {
      const r = await check.mutateAsync({ entityType: kind, entityId: recordId, subject, body });
      setFlags(r.flags); setFlagsStale(false);
      return r.flags;
    } catch { return flags; }
  }

  async function openConfirm() {
    setReadIt(false); setResult(null); setError('');
    setConfirming(true);
    if (flagsStale || !ai) await recheck();
  }

  async function doSend() {
    try {
      const r = await sendMut.mutateAsync({ entityType: kind, entityId: recordId, subject, body, aiDraft: !!ai, unverified: flags.map(f => f.text) });
      setResult({ ok: r.sent, message: r.message });
      setConfirming(false);
      if (r.sent) { setOpen(false); setSubject(''); setBody(''); setAi(null); setFlags([]); onSent?.(); }
    } catch (e) { setError(errText(e, 'The email was not sent.')); setConfirming(false); }
  }

  function copy(text: string, f: 'subject' | 'body') {
    navigator.clipboard?.writeText(text);
    setCopied(f); setTimeout(() => setCopied(null), 2000);
  }

  const ch = channel.data;
  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-end gap-2">
        {aiEnabled && (
          <>
            <div className="min-w-[150px] flex-1">
              <Label>Purpose</Label>
              <Select aria-label="Email purpose" selectSize="sm" value={opts.purpose} onChange={e => setOpts(o => ({ ...o, purpose: e.target.value }))} options={PURPOSES} />
            </div>
            <div className="w-[110px]">
              <Label>Tone</Label>
              <Select aria-label="Email tone" selectSize="sm" value={opts.tone} onChange={e => setOpts(o => ({ ...o, tone: e.target.value }))} options={TONES} />
            </div>
            <div className="w-[130px]">
              <Label>Language</Label>
              <Select aria-label="Email language" selectSize="sm" value={opts.language} onChange={e => setOpts(o => ({ ...o, language: e.target.value }))} options={LANGS} />
            </div>
          </>
        )}
        <div className="flex items-center gap-1.5">
          {aiEnabled && (
            <Button size="sm" icon={<Sparkles size={13} />} onClick={() => generate(!!ai)} loading={draft.isPending}>
              {ai ? 'Regenerate' : 'Draft with AI'}
            </Button>
          )}
          {aiEnabled && <AiInfo id={`${word}.followUp`} align="left" />}
          {!open && (
            <Button size="sm" variant="secondary" icon={<PenLine size={13} />} onClick={() => { setOpen(true); setAi(null); setFlags([]); }}>
              Write
            </Button>
          )}
        </div>
      </div>

      {error && <Alert tone="danger">{error}</Alert>}
      {result && <Alert tone={result.ok ? 'success' : 'warning'} icon={result.ok ? <Check size={15} /> : undefined}>{result.message}</Alert>}

      {open && (
        <div className="space-y-2">
          {ai && (
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-fg-subtle">
              <AiGeneratedTag />
              <span>
                Based on {ai.basedOn.notes} note{ai.basedOn.notes === 1 ? '' : 's'}
                {ai.basedOn.notesAvailable > ai.basedOn.notes ? ` (newest of ${ai.basedOn.notesAvailable})` : ''}
                {ai.basedOn.planned ? `, ${ai.basedOn.planned} planned follow-up${ai.basedOn.planned === 1 ? '' : 's'}` : ''}
                {ai.basedOn.quote ? ', the latest quote' : ''}
                {ai.basedOn.lessons ? ', lessons from related deals' : ''}
                {ai.cached ? ' · from cache' : ''}
              </span>
            </div>
          )}
          <div>
            <div className="flex items-center justify-between">
              <Label>Subject</Label>
              <Button variant="ghost" size="xs" onClick={() => copy(subject, 'subject')} icon={copied === 'subject' ? <Check size={12} className="text-success" /> : <Copy size={12} />}>{copied === 'subject' ? 'Copied' : 'Copy'}</Button>
            </div>
            <Input aria-label="Email subject" value={subject} onChange={e => edit('subject', e.target.value)} placeholder="Subject" />
          </div>
          <div>
            <div className="flex items-center justify-between">
              <Label>Message</Label>
              <div className="flex items-center gap-1">
                {aiEnabled && (
                  <Button variant="ghost" size="xs" icon={<Sparkles size={11} />} disabled={toneCheck.isPending || !body.trim()} onClick={() => toneCheck.mutate({ subject, body })}>
                    {toneCheck.isPending ? 'Checking…' : 'Tone check'}
                  </Button>
                )}
                <Button variant="ghost" size="xs" onClick={() => copy(body, 'body')} icon={copied === 'body' ? <Check size={12} className="text-success" /> : <Copy size={12} />}>{copied === 'body' ? 'Copied' : 'Copy'}</Button>
              </div>
            </div>
            <Textarea aria-label="Email message" rows={9} value={body} onChange={e => edit('body', e.target.value)} placeholder="Write your message…" />
          </div>

          {flags.length > 0 && (
            <Alert tone="warning" icon={<AlertTriangle size={15} />} title={flagsStale ? 'Check these before sending (edited since the check)' : 'Check these before sending'}>
              <ul className="space-y-0.5">
                {flags.map((f, i) => <li key={i} className="text-xs">{f.message}</li>)}
              </ul>
            </Alert>
          )}
          {ai && !flags.length && !flagsStale && (
            <p className="text-[11px] text-success flex items-center gap-1"><ShieldCheck size={12} aria-hidden="true" /> Every amount and date in the draft was found in the {word}.</p>
          )}
          {toneCheck.data && <ToneCheckResult data={toneCheck.data} />}

          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <Button variant="ghost" size="sm" icon={<RefreshCw size={12} />} onClick={recheck} loading={check.isPending} disabled={!body.trim()}>
              Check facts
            </Button>
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" onClick={() => { setOpen(false); setAi(null); setFlags([]); }}>Discard</Button>
              <Button size="sm" icon={<Send size={13} />} onClick={openConfirm} disabled={!subject.trim() || !body.trim()}>Send…</Button>
            </div>
          </div>
        </div>
      )}

      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Send this email?"
        icon={<Mail size={16} />}
        size="md"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirming(false)}>Cancel</Button>
            <Button icon={<Send size={13} />} onClick={doSend} loading={sendMut.isPending} disabled={!ch?.canSend || !readIt}>Send now</Button>
          </>
        }
      >
        <div className="space-y-3 text-sm">
          {channel.isLoading ? <p className="text-fg-muted">Checking how this will be sent…</p> : ch && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <dt className="text-fg-muted">To</dt>
              <dd className="min-w-0 break-words">{ch.to ? `${ch.toName} <${ch.to}>` : <span className="text-danger">No email on the contact — add one first.</span>}</dd>
              <dt className="text-fg-muted">From</dt>
              <dd className="min-w-0 break-words">{ch.via === 'ORG_MAILBOX' ? `Your organisation's mailbox (${ch.mailbox})` : 'The platform mailer, with replies going to your own email'}</dd>
              <dt className="text-fg-muted">Subject</dt>
              <dd className="min-w-0 break-words">{subject}</dd>
            </dl>
          )}
          {ch && (
            <p className="text-xs text-fg-muted">
              {ch.replyTracking
                ? `It's logged on this ${word} as a sent email. When the customer replies, the reply is added here too and you're notified.`
                : `It's logged on this ${word} as a sent email. Replies go to your inbox and are not added here automatically — connect the org mailbox in Inbox → Settings for that.`}
            </p>
          )}
          {flags.length > 0 && (
            <Alert tone="warning" icon={<AlertTriangle size={15} />} title="Not found in the record">
              <ul className="space-y-0.5">{flags.map((f, i) => <li key={i} className="text-xs">{f.message}</li>)}</ul>
            </Alert>
          )}
          <Checkbox checked={readIt} onChange={() => setReadIt(v => !v)} label={flags.length ? 'I’ve checked the flagged facts and read the whole email' : 'I’ve read the whole email'} />
        </div>
      </Modal>
    </div>
  );
}
