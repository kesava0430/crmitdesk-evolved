import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageCircle, Slack, CheckCircle2 } from 'lucide-react';
import { api } from '../api/client';
import { Badge, Button, Input, Alert } from '../shared/components';

/**
 * My Profile → Connections: the messaging assistant (server:
 * modules/assistantChannels). Shows the phone WhatsApp messages are matched
 * by, verifies it with a one-time code sent FROM that phone, and links a
 * Slack account with the code the Slack app shows. Hidden while the org has
 * neither channel switched on.
 */

interface Mine {
  whatsapp: { enabled: boolean; profilePhone: string | null; profilePhoneE164: string | null; verified: boolean; verifiedNumber: string | null; staleLink: boolean; assistantNumber: string | null };
  slack: { enabled: boolean; linked: boolean; slackUserId: string | null };
}

export function MessagingConnections() {
  const qc = useQueryClient();
  const { data } = useQuery<Mine>({ queryKey: ['assistant-channels-me'], queryFn: () => api.get('/channels/me').then(r => r.data) });
  const [code, setCode] = useState<{ code: string; sendTo: string | null; expiresInMinutes: number } | null>(null);
  const [slackCode, setSlackCode] = useState('');
  const [note, setNote] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['assistant-channels-me'] });
  const fail = (err: any, fallback: string) => setNote({ tone: 'danger', text: err?.response?.data?.error ?? fallback });

  const getCode = useMutation({
    mutationFn: () => api.post('/channels/me/whatsapp/code').then(r => r.data),
    onSuccess: d => { setCode(d); setNote(null); },
    onError: e => fail(e, 'Could not create a code.'),
  });
  const unlinkWa = useMutation({ mutationFn: () => api.delete('/channels/me/whatsapp'), onSuccess: () => { setCode(null); refresh(); } });
  const linkSlack = useMutation({
    mutationFn: () => api.post('/channels/me/slack/confirm', { code: slackCode }).then(r => r.data),
    onSuccess: d => { setSlackCode(''); setNote({ tone: 'success', text: d.message }); refresh(); },
    onError: e => fail(e, 'Could not link Slack.'),
  });
  const unlinkSlack = useMutation({ mutationFn: () => api.delete('/channels/me/slack'), onSuccess: refresh });

  if (!data || (!data.whatsapp.enabled && !data.slack.enabled)) return null;
  const wa = data.whatsapp;
  const waLink = code && wa.assistantNumber
    ? `https://wa.me/${wa.assistantNumber.replace(/\D/g, '')}?text=${encodeURIComponent(`zen link ${code.code}`)}`
    : null;

  return (
    <>
      {note && <Alert tone={note.tone} onDismiss={() => setNote(null)}>{note.text}</Alert>}

      {wa.enabled && (
        <div className="border-t border-line-subtle pt-5">
          <p className="text-[13px] font-semibold text-fg flex items-center gap-2"><MessageCircle size={15} className="text-accent" /> WhatsApp assistant</p>
          <p className="text-[11.5px] text-fg-muted mt-1 mb-3">
            Message {wa.assistantNumber ?? 'your company’s WhatsApp number'} starting with “zen” to ask questions or get work done. It always asks before changing anything.
          </p>
          <p className="text-[12.5px] text-fg-muted mb-3 break-words">
            Your phone: {wa.profilePhone ? <b className="text-fg">{wa.profilePhone}</b> : <span className="italic">not set — add it under Work &amp; contact (or ask an admin)</span>}
          </p>
          {wa.verified ? (
            <div className="flex items-center gap-3 flex-wrap">
              <Badge variant="green"><CheckCircle2 size={12} /> Verified {wa.verifiedNumber}</Badge>
              <Button size="xs" variant="ghost" className="!text-danger" loading={unlinkWa.isPending} onClick={() => unlinkWa.mutate()}>Remove</Button>
            </div>
          ) : (
            <div className="space-y-3">
              {wa.staleLink && <p className="text-[12px] text-warning-fg">Your phone changed since you verified — verify the new number.</p>}
              {!wa.profilePhoneE164 && wa.profilePhone && (
                <p className="text-[11.5px] text-fg-subtle">Tip: write your number with the country code (e.g. +91 98765 43210).</p>
              )}
              <Button size="sm" disabled={!wa.profilePhone} loading={getCode.isPending} onClick={() => getCode.mutate()}>Get code</Button>
              {code && (
                <div className="rounded-input bg-surface-sunken border border-line-subtle p-3 text-[13px] text-fg space-y-2">
                  <p>From <b>{wa.profilePhone}</b>, send this to <b>{code.sendTo ?? wa.assistantNumber}</b> within {code.expiresInMinutes} minutes:</p>
                  <p className="font-mono text-[15px] tracking-wide break-all">zen link {code.code}</p>
                  <div className="flex gap-2 flex-wrap">
                    {waLink && <a href={waLink} target="_blank" rel="noreferrer"><Button size="xs" variant="secondary">Open WhatsApp</Button></a>}
                    <Button size="xs" variant="ghost" onClick={refresh}>I’ve sent it</Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {data.slack.enabled && (
        <div className="border-t border-line-subtle pt-5">
          <p className="text-[13px] font-semibold text-fg flex items-center gap-2"><Slack size={15} className="text-accent" /> Slack</p>
          <p className="text-[11.5px] text-fg-muted mt-1 mb-3">Use the assistant from Slack: message the Zenkara 360 app, or type /zen.</p>
          {data.slack.linked ? (
            <div className="flex items-center gap-3 flex-wrap">
              <Badge variant="green"><CheckCircle2 size={12} /> Linked</Badge>
              <Button size="xs" variant="ghost" className="!text-danger" loading={unlinkSlack.isPending} onClick={() => unlinkSlack.mutate()}>Unlink</Button>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-[12.5px] text-fg-muted">In Slack, send <b>link</b> to the Zenkara 360 app (or type <b>/zen link</b>), then enter the code here.</p>
              <div className="flex flex-col sm:flex-row gap-2">
                <Input value={slackCode} onChange={e => setSlackCode(e.target.value)} placeholder="ABCD-EFGH" aria-label="Slack link code" className="sm:max-w-[200px]" />
                <Button size="sm" disabled={slackCode.trim().length < 6} loading={linkSlack.isPending} onClick={() => linkSlack.mutate()}>Link my Slack account</Button>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
