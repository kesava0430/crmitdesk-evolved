import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageCircle, Slack, ShieldCheck, Copy, Check } from 'lucide-react';
import { api } from '../api/client';
import {
  PageBody, Card, CardHeader, Field, Input, Toggle, Button, Badge, Alert, SkeletonCard,
} from '../shared/components';

/**
 * Integrations → Messaging assistant. The same assistant as the in-app chat,
 * reachable over WhatsApp (the org's Twilio number from Inbox → Settings) and
 * Slack (the org's own Slack app). Server: modules/assistantChannels +
 * utils/assistantChannels.
 */

interface Settings {
  whatsappEnabled: boolean;
  slackEnabled: boolean;
  slackEmailMatch: boolean;
  slackTeamId: string | null;
  hasSlackBotToken: boolean;
  hasSlackSigningSecret: boolean;
  urls: { slackEvents: string; slackCommands: string; whatsappWebhook: string };
  whatsappNumber: string | null;
  aiLicensed: boolean;
  linkedUsers: { whatsapp: number; slack: number };
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 2000); } catch { /* clipboard blocked — the text is selectable */ }
  }
  return (
    <Button size="xs" variant="secondary" icon={done ? <Check size={12} /> : <Copy size={12} />} onClick={copy} aria-label={`${label}: ${text.slice(0, 40)}`}>
      {done ? 'Copied' : label}
    </Button>
  );
}

function UrlRow({ label, url }: { label: string; url: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[12px] font-medium text-fg-muted mb-1">{label}</p>
      <div className="flex flex-col sm:flex-row sm:items-center gap-2 min-w-0">
        <code className="flex-1 min-w-0 break-all text-[12px] bg-surface-sunken border border-line-subtle rounded-input px-2 py-1.5 text-fg">{url}</code>
        <div className="shrink-0"><CopyButton text={url} /></div>
      </div>
    </div>
  );
}

function slackManifest(s: Settings): string {
  return [
    'display_information:',
    '  name: Zenkara 360',
    '  description: Ask questions and get work done in Zenkara 360',
    'features:',
    '  app_home:',
    '    messages_tab_enabled: true',
    '    messages_tab_read_only_enabled: false',
    '  bot_user:',
    '    display_name: Zenkara 360',
    '    always_online: true',
    '  slash_commands:',
    '    - command: /zen',
    `      url: ${s.urls.slackCommands}`,
    '      description: Ask Zenkara 360 or get work done',
    '      usage_hint: how many tickets are open?',
    '      should_escape: false',
    'oauth_config:',
    '  scopes:',
    '    bot:',
    '      - chat:write',
    '      - im:history',
    '      - commands',
    '      - users:read',
    '      - users:read.email',
    'settings:',
    '  event_subscriptions:',
    `    request_url: ${s.urls.slackEvents}`,
    '    bot_events:',
    '      - message.im',
    '  org_deploy_enabled: false',
    '  socket_mode_enabled: false',
    '  token_rotation_enabled: false',
  ].join('\n');
}

function Steps({ items }: { items: React.ReactNode[] }) {
  return (
    <ol className="list-decimal pl-5 space-y-1.5 text-[13px] text-fg-muted marker:text-fg-subtle">
      {items.map((it, i) => <li key={i} className="pl-1">{it}</li>)}
    </ol>
  );
}

export default function AssistantChannelsPage() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery<Settings>({
    queryKey: ['assistant-channel-settings'],
    queryFn: () => api.get('/channels/settings').then(r => r.data),
  });
  const [botToken, setBotToken] = useState('');
  const [secret, setSecret] = useState('');
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.put('/channels/settings', body).then(r => r.data as Settings),
    onSuccess: (s) => {
      qc.setQueryData(['assistant-channel-settings'], s);
      setBotToken(''); setSecret('');
      setMsg({ tone: 'success', text: 'Saved.' });
    },
    onError: (err: any) => setMsg({ tone: 'danger', text: err?.response?.data?.error ?? 'Could not save.' }),
  });
  useEffect(() => { if (msg?.tone === 'success') { const t = setTimeout(() => setMsg(null), 3000); return () => clearTimeout(t); } }, [msg]);

  if (isLoading) {
    return <PageBody width="narrow"><SkeletonCard lines={3} /><SkeletonCard lines={5} /><SkeletonCard lines={6} /></PageBody>;
  }
  if (error || !data) {
    return <PageBody width="narrow"><Alert tone="danger">{(error as any)?.response?.data?.error ?? 'Could not load the assistant settings.'}</Alert></PageBody>;
  }
  const s = data;

  return (
    <PageBody width="narrow">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-card flex items-center justify-center shrink-0 bg-accent-soft text-accent">
          <MessageCircle size={20} />
        </div>
        <div className="min-w-0">
          <h1 className="text-[18px] font-semibold text-fg leading-tight tracking-tight">Messaging assistant</h1>
          <p className="text-[13px] text-fg-muted mt-0.5">Staff can ask questions and get day-to-day work done from WhatsApp and Slack. Nothing changes until they reply YES.</p>
        </div>
      </div>

      {!s.aiLicensed && (
        <Alert tone="warning">The assistant needs Advanced AI on your plan. You can set it up now; staff will be told it isn’t included until it’s added under Billing.</Alert>
      )}

      <Card>
        <CardHeader title="How it stays safe" icon={<ShieldCheck size={15} className="text-accent" />} className="mb-3" />
        <ul className="space-y-1.5 text-[13px] text-fg-muted list-disc pl-5">
          <li>Only staff who proved their identity can use it: a WhatsApp number verified with a one-time code sent from that phone, or a Slack account linked from My Profile. Anyone else gets a polite refusal and no data.</li>
          <li>Answers and actions use the person’s own role, record access and your enabled areas — exactly as in the app.</li>
          <li>Every change is shown first and runs only after YES. High-risk changes (payroll, loans, user access, sending messages) also need a typed phrase like “CONFIRM PAYROLL”. Unanswered plans expire after 15 minutes.</li>
          <li>Everything is in the Audit Log and AI Governance, marked with the channel it came from.</li>
        </ul>
      </Card>

      {/* ── WhatsApp ─────────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="WhatsApp"
          subtitle={s.whatsappNumber ? `Answers on your number ${s.whatsappNumber}` : 'Connect your WhatsApp number first'}
          icon={<MessageCircle size={15} className="text-accent" />}
          actions={s.whatsappEnabled ? <Badge variant="green" dot>On</Badge> : <Badge>Off</Badge>}
          className="mb-4"
        />
        <div className="space-y-4">
          {!s.whatsappNumber && (
            <Alert tone="info">The assistant answers on the same WhatsApp number your Inbox uses. Connect it in <Link to="/inbox" className="text-accent hover:underline">Inbox → Settings</Link> first.</Alert>
          )}
          <Toggle
            checked={s.whatsappEnabled}
            disabled={!s.whatsappNumber || save.isPending}
            onChange={v => save.mutate({ whatsappEnabled: v })}
            label="Allow staff to use the assistant over WhatsApp"
            hint={`${s.linkedUsers.whatsapp} staff member${s.linkedUsers.whatsapp === 1 ? '' : 's'} verified their number.`}
          />
          <div className="rounded-input bg-surface-sunken border border-line-subtle p-3 text-[12.5px] text-fg-muted space-y-1">
            <p className="font-medium text-fg">Which messages go to the assistant</p>
            <p>Only messages from a verified staff number that start with <b>zen</b> (e.g. “zen how many tickets are open?”), and that person’s replies to a plan waiting for their YES. Every other message — all customers, and staff writing without “zen” — lands in the Inbox exactly as before. Assistant conversations are never shown in the shared Inbox.</p>
          </div>
          <div>
            <p className="text-[13px] font-semibold text-fg mb-2">Set up</p>
            <Steps items={[
              <>In the Twilio console, open your WhatsApp sender and make sure “A message comes in” is set to the URL below (method POST). It is the same webhook the Inbox already uses:</>,
              <>Turn on the switch above.</>,
              <>Each staff member adds their mobile number to their profile, then opens <b>My Profile → Connections → WhatsApp assistant</b>, taps <b>Get code</b> and sends “zen link &lt;code&gt;” to {s.whatsappNumber ?? 'your WhatsApp number'} from that phone.</>,
            ]} />
            <div className="mt-3"><UrlRow label="Twilio webhook (A message comes in)" url={s.urls.whatsappWebhook} /></div>
            <p className="text-[11.5px] text-fg-subtle mt-2">If you use Meta’s WhatsApp Cloud API directly instead of Twilio, the assistant isn’t available yet — the Inbox connects through Twilio.</p>
          </div>
        </div>
      </Card>

      {/* ── Slack ────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Slack"
          subtitle="Direct messages to your Zenkara 360 app, and the /zen command"
          icon={<Slack size={15} className="text-accent" />}
          actions={s.slackEnabled ? <Badge variant="green" dot>On</Badge> : <Badge>Off</Badge>}
          className="mb-4"
        />
        <div className="space-y-4">
          <div>
            <p className="text-[13px] font-semibold text-fg mb-2">1. Create the Slack app</p>
            <Steps items={[
              <>Go to <a href="https://api.slack.com/apps?new_app=1" target="_blank" rel="noreferrer" className="text-accent hover:underline">api.slack.com/apps</a> → <b>Create New App</b> → <b>From an app manifest</b>, pick your workspace.</>,
              <>Paste the manifest below (YAML) and create the app. It already contains your request URLs, the /zen command, the direct-message event and the scopes.</>,
              <>Open <b>Install App</b> → install it to your workspace, then copy the <b>Bot User OAuth Token</b> (starts with xoxb-).</>,
              <>Open <b>Basic Information → App Credentials</b> and copy the <b>Signing Secret</b>.</>,
              <>Paste both below, save, and turn Slack on. (If Slack says the Request URL isn’t verified, save the credentials here first, then click Retry in Slack → Event Subscriptions.)</>,
            ]} />
            <div className="mt-3">
              <div className="flex items-center justify-between gap-2 mb-1">
                <p className="text-[12px] font-medium text-fg-muted">App manifest</p>
                <CopyButton text={slackManifest(s)} label="Copy manifest" />
              </div>
              <pre className="text-[11.5px] leading-snug bg-surface-sunken border border-line-subtle rounded-input p-3 overflow-x-auto max-h-64 text-fg">{slackManifest(s)}</pre>
            </div>
            <div className="mt-3 space-y-3">
              <UrlRow label="Event Subscriptions → Request URL" url={s.urls.slackEvents} />
              <UrlRow label="Slash command /zen → Request URL" url={s.urls.slackCommands} />
            </div>
          </div>

          <div className="border-t border-line-subtle pt-4 space-y-4">
            <p className="text-[13px] font-semibold text-fg">2. Credentials</p>
            <Field label="Bot User OAuth Token" hint={s.hasSlackBotToken ? 'Saved (encrypted). Leave empty to keep it.' : 'Starts with xoxb-'}>
              <Input type="password" autoComplete="off" value={botToken} onChange={e => setBotToken(e.target.value)} placeholder={s.hasSlackBotToken ? '•••••••• saved' : 'xoxb-…'} aria-label="Slack bot token" />
            </Field>
            <Field label="Signing Secret" hint={s.hasSlackSigningSecret ? 'Saved (encrypted). Leave empty to keep it.' : 'Basic Information → App Credentials'}>
              <Input type="password" autoComplete="off" value={secret} onChange={e => setSecret(e.target.value)} placeholder={s.hasSlackSigningSecret ? '•••••••• saved' : 'signing secret'} aria-label="Slack signing secret" />
            </Field>
            <Button
              variant="secondary"
              disabled={!botToken && !secret}
              loading={save.isPending}
              onClick={() => save.mutate({ ...(botToken ? { slackBotToken: botToken } : {}), ...(secret ? { slackSigningSecret: secret } : {}) })}
            >
              Save credentials
            </Button>
          </div>

          <div className="border-t border-line-subtle pt-4 space-y-4">
            <p className="text-[13px] font-semibold text-fg">3. Turn it on</p>
            <Toggle
              checked={s.slackEnabled}
              disabled={save.isPending || (!s.slackEnabled && (!s.hasSlackBotToken || !s.hasSlackSigningSecret))}
              onChange={v => save.mutate({ slackEnabled: v })}
              label="Allow staff to use the assistant over Slack"
              hint={`${s.linkedUsers.slack} staff member${s.linkedUsers.slack === 1 ? '' : 's'} linked their Slack account. Each person types “link” to the app in Slack (or /zen link) and enters the code in My Profile → Connections.`}
            />
            <Toggle
              checked={s.slackEmailMatch}
              disabled={save.isPending}
              onChange={v => save.mutate({ slackEmailMatch: v })}
              label="Recognise people by their Slack email"
              hint="Skips the link code when someone’s Slack email is exactly their Zenkara 360 email. Turn on only if your Slack workspace’s emails are managed by your company."
            />
            <div className="text-[12.5px] text-fg-muted">
              Workspace: {s.slackTeamId ? <><code className="text-fg">{s.slackTeamId}</code> (only this workspace is accepted){' '}
                <Button size="xs" variant="ghost" onClick={() => save.mutate({ resetSlackTeam: true })}>Reset</Button></> : 'set automatically on the first request from your Slack app'}
            </div>
          </div>
        </div>
      </Card>

      {msg && <Alert tone={msg.tone} onDismiss={() => setMsg(null)}>{msg.text}</Alert>}
    </PageBody>
  );
}
