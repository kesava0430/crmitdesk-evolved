import { useState, useRef, useEffect } from 'react';
import {
  Mail, MessageCircle, Settings, RefreshCw, Send, Check,
  MailOpen, Inbox, Wifi, WifiOff,
  CheckCheck, Phone, MessageSquareText, ChevronLeft
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import {
  useConversations, useConversation, useSendReply, useUpdateConversation,
  useInboxSettings, useConnectEmail, useDisconnectEmail,
  useConnectWhatsApp, useDisconnectWhatsApp, useTriggerSync,
  type Conversation, type Channel,
} from '../../api/inbox';
import {
  Spinner, Modal, Tabs, Button, IconButton, Field, Input, Textarea,
  Alert, Badge, EmptyState,
} from '../../shared/components';
import { useFormat } from '../../hooks/useFormat';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function timeAgo(date: string | null | undefined) {
  if (!date) return '';
  try { return formatDistanceToNow(new Date(date), { addSuffix: true }); }
  catch { return ''; }
}

function channelIcon(channel: Channel, size = 14) {
  if (channel === 'EMAIL') return <Mail size={size} className="text-blue-500" />;
  if (channel === 'CHAT') return <MessageSquareText size={size} className="text-violet-500" />;
  return <MessageCircle size={size} className="text-green-500" />;
}

function channelAvatarBg(channel: Channel) {
  return channel === 'EMAIL' ? 'bg-blue-100 dark:bg-blue-500/10' : channel === 'CHAT' ? 'bg-violet-100 dark:bg-violet-500/10' : 'bg-green-100 dark:bg-green-500/10';
}

/* Conversation status → shared Badge variant, instead of a local colour map. */
const conversationStatusVariant: Record<string, 'green' | 'yellow' | 'gray'> = {
  OPEN: 'green', PENDING: 'yellow', CLOSED: 'gray',
};

// ─── Settings Modal ────────────────────────────────────────────────────────────

function SettingsModal({ onClose }: { onClose: () => void }) {
  const { data: settings, isLoading } = useInboxSettings();
  const connectEmail = useConnectEmail();
  const disconnectEmail = useDisconnectEmail();
  const connectWA = useConnectWhatsApp();
  const disconnectWA = useDisconnectWhatsApp();

  const [emailForm, setEmailForm] = useState({
    email: '', password: '',
    imapHost: 'imap.gmail.com', imapPort: 993,
    smtpHost: 'smtp.gmail.com', smtpPort: 587,
  });
  const [waForm, setWaForm] = useState({ accountSid: '', authToken: '', phoneNumber: '', notifyNumber: '' });
  const [tab, setTab] = useState<'email' | 'whatsapp'>('email');

  return (
    <Modal open onClose={onClose} title="Inbox Settings" icon={<Settings size={18} />}>
      <Tabs
        aria-label="Inbox settings"
        variant="underline"
        fill
        value={tab}
        onChange={setTab}
        className="-mt-2 mb-4"
        items={[
          { key: 'email', label: 'Email (IMAP)', icon: <Mail size={14} /> },
          { key: 'whatsapp', label: 'WhatsApp (Twilio)', icon: <MessageCircle size={14} /> },
        ]}
      />

      {isLoading ? <Spinner label="Loading settings…" /> : tab === 'email' ? (
        settings?.emailAccount ? (
          /* Email connected */
          <Alert
            tone="success"
            icon={<Wifi size={18} />}
            actions={
              <Button size="xs" variant="ghost" onClick={() => disconnectEmail.mutate(undefined, { onSuccess: () => {} })}>
                Disconnect
              </Button>
            }
          >
            <p className="font-medium text-sm">{settings.emailAccount.email}</p>
            <p className="text-xs mt-0.5 opacity-80">
              {settings.emailAccount.imapHost}:{settings.emailAccount.imapPort} · SMTP {settings.emailAccount.smtpHost}:{settings.emailAccount.smtpPort}
            </p>
            {settings.emailAccount.lastSyncAt && (
              <p className="text-xs mt-0.5 opacity-70">Last synced {timeAgo(settings.emailAccount.lastSyncAt)}</p>
            )}
          </Alert>
        ) : (
          /* Email form */
          <form onSubmit={e => { e.preventDefault(); connectEmail.mutate(emailForm, { onSuccess: onClose }); }}
            className="space-y-3">
            <Alert tone="info">
              For Gmail, use an <strong>App Password</strong> (not your regular password). Enable 2FA → Google Account → Security → App Passwords.
            </Alert>
            <div className="form-section">
              <p className="form-section-title">Credentials</p>
              <div className="space-y-4">
                <Field label="Email Address" required htmlFor="inbox-email">
                  <Input id="inbox-email" value={emailForm.email}
                    onChange={e => setEmailForm(f => ({ ...f, email: e.target.value }))}
                    type="email" required placeholder="you@gmail.com" />
                </Field>
                <Field label="App Password" required htmlFor="inbox-password">
                  <Input id="inbox-password" value={emailForm.password}
                    onChange={e => setEmailForm(f => ({ ...f, password: e.target.value }))}
                    type="password" required placeholder="xxxx xxxx xxxx xxxx" />
                </Field>
              </div>
            </div>
            <div className="form-section">
              <p className="form-section-title">Server Settings</p>
              <div className="grid grid-cols-2 gap-4">
                <Field label="IMAP Host" required htmlFor="inbox-imap-host">
                  <Input id="inbox-imap-host" value={emailForm.imapHost}
                    onChange={e => setEmailForm(f => ({ ...f, imapHost: e.target.value }))}
                    required placeholder="imap.gmail.com" />
                </Field>
                <Field label="IMAP Port" required htmlFor="inbox-imap-port">
                  <Input id="inbox-imap-port" value={emailForm.imapPort}
                    onChange={e => setEmailForm(f => ({ ...f, imapPort: Number(e.target.value) }))}
                    type="number" required />
                </Field>
                <Field label="SMTP Host" required htmlFor="inbox-smtp-host">
                  <Input id="inbox-smtp-host" value={emailForm.smtpHost}
                    onChange={e => setEmailForm(f => ({ ...f, smtpHost: e.target.value }))}
                    required placeholder="smtp.gmail.com" />
                </Field>
                <Field label="SMTP Port" required htmlFor="inbox-smtp-port">
                  <Input id="inbox-smtp-port" value={emailForm.smtpPort}
                    onChange={e => setEmailForm(f => ({ ...f, smtpPort: Number(e.target.value) }))}
                    type="number" required />
                </Field>
              </div>
            </div>
            {connectEmail.isError && (
              <Alert tone="danger">
                {(connectEmail.error as any)?.response?.data?.error || 'Connection failed'}
              </Alert>
            )}
            <Button type="submit" block loading={connectEmail.isPending} icon={<Mail size={14} />}>
              Connect Email &amp; Start Sync
            </Button>
          </form>
        )
      ) : (
        /* WhatsApp tab */
        settings?.whatsAppConfig ? (
          <div className="space-y-4">
            <Alert
              tone="success"
              icon={<MessageCircle size={18} />}
              actions={
                <Button size="xs" variant="ghost" onClick={() => disconnectWA.mutate(undefined, { onSuccess: () => {} })}>
                  Disconnect
                </Button>
              }
            >
              <p className="font-medium text-sm">{settings.whatsAppConfig.phoneNumber}</p>
              <p className="text-xs mt-0.5 opacity-80">Account: {settings.whatsAppConfig.accountSid}</p>
              <p className="text-xs mt-0.5 opacity-80">
                Notification number: {settings.whatsAppConfig.notifyNumber || <span className="italic opacity-80">same as above</span>}
              </p>
            </Alert>
            <Alert tone="neutral" icon={null} title="Twilio Webhook URL">
              <code className="block text-xs bg-surface rounded-btn border border-line px-2 py-1 my-1 font-mono break-all">
                {window.location.origin.replace('5173', '4000')}/api/inbox/whatsapp/webhook
              </code>
              <p className="text-fg-muted">Set this as the webhook in your Twilio console under WhatsApp sandbox or number settings.</p>
            </Alert>
          </div>
        ) : (
          <form onSubmit={e => { e.preventDefault(); connectWA.mutate(waForm, { onSuccess: onClose }); }}
            className="space-y-3">
            <Alert tone="success">
              Get credentials from <strong>console.twilio.com</strong>. Use the WhatsApp Sandbox for testing or a production number for live messages.
            </Alert>
            <div className="form-section">
              <p className="form-section-title">Twilio Credentials</p>
              <div className="space-y-4">
                <Field label="Account SID" required htmlFor="wa-sid">
                  <Input id="wa-sid" value={waForm.accountSid}
                    onChange={e => setWaForm(f => ({ ...f, accountSid: e.target.value }))}
                    required placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" className="font-mono" />
                </Field>
                <Field label="Auth Token" required htmlFor="wa-token">
                  <Input id="wa-token" value={waForm.authToken}
                    onChange={e => setWaForm(f => ({ ...f, authToken: e.target.value }))}
                    type="password" required placeholder="Your auth token" />
                </Field>
                <Field label="WhatsApp Phone Number" required htmlFor="wa-phone">
                  <Input id="wa-phone" value={waForm.phoneNumber}
                    onChange={e => setWaForm(f => ({ ...f, phoneNumber: e.target.value }))}
                    required placeholder="+14155238886" />
                </Field>
                <Field
                  label="Notification Number"
                  htmlFor="wa-notify"
                  hint={'Where "org default" deal/ticket reminders and workflow WhatsApp actions are sent.'}
                >
                  <Input id="wa-notify" aria-label="Notification Number" value={waForm.notifyNumber}
                    onChange={e => setWaForm(f => ({ ...f, notifyNumber: e.target.value }))}
                    placeholder="+14155551234 (optional — defaults to the number above)" />
                </Field>
              </div>
            </div>
            {connectWA.isError && (
              <Alert tone="danger">
                {(connectWA.error as any)?.response?.data?.error || 'Connection failed'}
              </Alert>
            )}
            <Button type="submit" block loading={connectWA.isPending} icon={<MessageCircle size={14} />}>
              Connect WhatsApp
            </Button>
          </form>
        )
      )}
    </Modal>
  );
}

// ─── Conversation List Item ────────────────────────────────────────────────────

function ConvItem({ conv, selected, onClick }: { conv: Conversation; selected: boolean; onClick: () => void }) {
  const lastMsg = conv.messages?.[0];

  return (
    <button onClick={onClick}
      className={`w-full text-left p-3 border-b border-line-subtle hover:bg-surface-hover transition-colors ${selected ? 'bg-accent-soft border-l-2 border-l-accent' : ''}`}>
      <div className="flex items-start gap-2.5">
        {/* Channel icon */}
        <div className={`w-8 h-8 rounded-full shrink-0 flex items-center justify-center ${channelAvatarBg(conv.channel)}`}>
          {channelIcon(conv.channel, 14)}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-1">
            <span className={`text-sm truncate ${conv.unreadCount > 0 ? 'font-semibold text-fg' : 'font-medium text-fg'}`}>
              {conv.contactName}
            </span>
            <span className="text-xs text-fg-subtle shrink-0">{timeAgo(conv.lastMessageAt)}</span>
          </div>
          {conv.subject && (
            <p className="text-xs text-fg-muted truncate mt-0.5">{conv.subject}</p>
          )}
          {lastMsg && (
            <p className="text-xs text-fg-subtle truncate mt-0.5 leading-snug">
              {lastMsg.direction === 'OUTBOUND' && <span className="text-accent">You: </span>}
              {lastMsg.body}
            </p>
          )}
        </div>

        {conv.unreadCount > 0 && (
          <span className="shrink-0 bg-accent text-accent-fg text-xs rounded-full w-5 h-5 flex items-center justify-center font-medium">
            {conv.unreadCount > 9 ? '9+' : conv.unreadCount}
          </span>
        )}
      </div>
    </button>
  );
}

// ─── Message Bubble ───────────────────────────────────────────────────────────

function MessageBubble({ msg }: { msg: { direction: string; body: string; sentAt: string; fromAddress: string } }) {
  const { time } = useFormat();
  const isOut = msg.direction === 'OUTBOUND';
  return (
    <div className={`flex ${isOut ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[88%] sm:max-w-[75%] rounded-card px-4 py-2.5 ${
        isOut
          ? 'bg-accent text-accent-fg rounded-br-md'
          : 'bg-surface border border-line text-fg rounded-bl-md shadow-ui-sm'
      }`}>
        <p className="text-sm whitespace-pre-wrap leading-relaxed">{msg.body}</p>
        <div className={`flex items-center gap-1 mt-1 ${isOut ? 'justify-end' : 'justify-start'}`}>
          <span className={`text-xs ${isOut ? 'text-accent-fg/70' : 'text-fg-subtle'}`}>
            {time(msg.sentAt)}
          </span>
          {isOut && <CheckCheck size={11} className="text-accent-fg/70" />}
        </div>
      </div>
    </div>
  );
}

// ─── Main InboxPage ────────────────────────────────────────────────────────────

const CHANNEL_TABS = [
  { key: 'ALL' as const, label: 'All' },
  { key: 'EMAIL' as const, label: 'Email', icon: <Mail size={10} /> },
  { key: 'WHATSAPP' as const, label: 'WhatsApp', icon: <MessageCircle size={10} /> },
  { key: 'CHAT' as const, label: 'Live Chat', icon: <MessageSquareText size={10} /> },
];

const STATUS_TABS = [
  { key: 'OPEN' as const, label: 'Open' },
  { key: 'CLOSED' as const, label: 'Closed' },
  { key: 'ALL' as const, label: 'All' },
];

export function InboxPage() {
  const [channelFilter, setChannelFilter] = useState<Channel | 'ALL'>('ALL');
  const [statusFilter, setStatusFilter] = useState<'OPEN' | 'CLOSED' | 'ALL'>('OPEN');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState('');
  const [showSettings, setShowSettings] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  const { data: listData, isLoading: listLoading } = useConversations({
    channel: channelFilter !== 'ALL' ? channelFilter : undefined,
    status: statusFilter !== 'ALL' ? statusFilter : undefined,
  });
  const { data: conversation, isLoading: convLoading } = useConversation(selectedId);
  const { data: settings } = useInboxSettings();

  const sendReply = useSendReply();
  const updateConv = useUpdateConversation();
  const triggerSync = useTriggerSync();

  const conversations = listData?.data || [];

  // Auto-scroll messages to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [conversation?.messages?.length]);

  // Auto-select first conversation — desktop only. On a narrow (mobile)
  // viewport the list and thread are two separate full-width screens (see
  // the responsive classes below), so auto-jumping straight into a thread
  // would skip past the list entirely; better to let the user tap one.
  useEffect(() => {
    const isDesktop = window.matchMedia('(min-width: 640px)').matches;
    if (isDesktop && !selectedId && conversations.length > 0) {
      setSelectedId(conversations[0].id);
    }
  }, [conversations.length]);

  const hasEmail = !!settings?.emailAccount;
  const hasWhatsApp = !!settings?.whatsAppConfig;

  function handleSend() {
    if (!replyBody.trim() || !selectedId) return;
    sendReply.mutate(
      { conversationId: selectedId, body: replyBody.trim() },
      { onSuccess: () => setReplyBody('') },
    );
  }

  return (
    <div className="flex h-full bg-canvas overflow-hidden">
      {/* ── Left panel: conversation list ──
          Full-width on mobile, fixed 320px column on sm+. On mobile, hidden
          once a conversation is selected (see the thread panel's back
          button) rather than rendered side-by-side, which used to force
          the whole layout wider than the viewport. */}
      <div className={`w-full sm:w-80 sm:shrink-0 flex-col bg-surface sm:border-r border-line ${selectedId ? 'hidden sm:flex' : 'flex'}`}>
        {/* Header */}
        <div className="px-4 py-3.5 border-b border-line-subtle">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Inbox size={18} className="text-accent" />
              <h1 className="font-semibold text-fg">Unified Inbox</h1>
            </div>
            <div className="flex items-center gap-1">
              <IconButton
                label="Sync email"
                tone="accent"
                icon={<RefreshCw size={14} className={triggerSync.isPending ? 'animate-spin' : ''} />}
                disabled={!hasEmail || triggerSync.isPending}
                onClick={() => triggerSync.mutate(undefined, {})}
              />
              <IconButton
                label="Inbox settings"
                tone="accent"
                icon={<Settings size={14} />}
                onClick={() => setShowSettings(true)}
              />
            </div>
          </div>

          {/* Channel filter pills */}
          <Tabs
            aria-label="Filter by channel"
            variant="pill"
            value={channelFilter}
            onChange={setChannelFilter}
            items={CHANNEL_TABS}
          />

          {/* Status filter */}
          <Tabs
            aria-label="Filter by status"
            variant="pill"
            className="mt-2"
            value={statusFilter}
            onChange={setStatusFilter}
            items={STATUS_TABS}
          />
        </div>

        {/* Channel connection prompts */}
        {(!hasEmail || !hasWhatsApp) && (
          <div className="px-3 py-2 border-b border-line-subtle">
            <Alert tone="warning">
              {!hasEmail && !hasWhatsApp
                ? 'No channels connected.'
                : !hasEmail ? 'Email not connected.'
                : 'WhatsApp not connected.'}
              {' '}
              <button type="button" onClick={() => setShowSettings(true)} className="underline font-medium">Connect now →</button>
            </Alert>
          </div>
        )}

        {/* Conversation list */}
        <div className="flex-1 overflow-y-auto">
          {listLoading ? (
            <div className="p-4"><Spinner label="Loading conversations…" /></div>
          ) : conversations.length === 0 ? (
            <EmptyState
              compact
              icon={<Inbox />}
              title="No conversations yet"
              description={hasEmail || hasWhatsApp
                ? 'New messages will appear here automatically'
                : 'Connect Email or WhatsApp in Settings'}
              action={{ label: 'Open Settings', onClick: () => setShowSettings(true) }}
            />
          ) : (
            conversations.map(conv => (
              <ConvItem
                key={conv.id}
                conv={conv}
                selected={conv.id === selectedId}
                onClick={() => setSelectedId(conv.id)}
              />
            ))
          )}
        </div>
      </div>

      {/* ── Right panel: message thread ──
          Hidden on mobile until a conversation is selected, then takes the
          full screen (with a back button below to return to the list). */}
      <div className={`flex-1 flex-col min-w-0 ${selectedId ? 'flex' : 'hidden sm:flex'}`}>
        {selectedId && conversation ? (
          <>
            {/* Thread header */}
            <div className="px-4 sm:px-6 py-3 sm:py-4 bg-surface border-b border-line flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 sm:gap-3 min-w-0">
                <IconButton
                  label="Back to conversations"
                  size="md"
                  className="sm:hidden -ml-1"
                  icon={<ChevronLeft size={18} />}
                  onClick={() => setSelectedId(null)}
                />
                <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${channelAvatarBg(conversation.channel)}`}>
                  {channelIcon(conversation.channel, 18)}
                </div>
                <div className="min-w-0">
                  <h2 className="font-semibold text-fg truncate">{conversation.contactName}</h2>
                  <div className="flex items-center gap-2 mt-0.5">
                    {conversation.contactEmail && (
                      <span className="text-xs text-fg-subtle truncate">{conversation.contactEmail}</span>
                    )}
                    {conversation.contactPhone && !conversation.contactEmail && (
                      <span className="text-xs text-fg-subtle flex items-center gap-1">
                        <Phone size={10} /> {conversation.contactPhone.replace('whatsapp:', '')}
                      </span>
                    )}
                    {conversation.subject && (
                      <span className="text-xs text-fg-subtle truncate">· {conversation.subject}</span>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <Badge variant={conversationStatusVariant[conversation.status] ?? 'gray'}>
                  {conversation.status}
                </Badge>
                {conversation.status === 'OPEN' && (
                  <Button size="sm" variant="secondary" icon={<Check size={12} />}
                    onClick={() => updateConv.mutate({ id: conversation.id, status: 'CLOSED' })}>
                    Close
                  </Button>
                )}
                {conversation.status === 'CLOSED' && (
                  <Button size="sm" variant="outline" icon={<MailOpen size={12} />}
                    onClick={() => updateConv.mutate({ id: conversation.id, status: 'OPEN' })}>
                    Reopen
                  </Button>
                )}
              </div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-3 sm:px-6 py-4 space-y-3 bg-canvas">
              {convLoading ? (
                <div className="flex items-center justify-center h-32">
                  <Spinner label="Loading messages…" />
                </div>
              ) : conversation.messages && conversation.messages.length > 0 ? (
                <>
                  {conversation.messages.map(msg => (
                    <MessageBubble key={msg.id} msg={msg} />
                  ))}
                  <div ref={messagesEndRef} />
                </>
              ) : (
                <div className="flex flex-col items-center justify-center h-32 text-center">
                  <p className="text-sm text-fg-subtle">No messages yet</p>
                </div>
              )}
            </div>

            {/* Reply composer */}
            <div className="px-3 sm:px-6 py-3 sm:py-4 bg-surface border-t border-line">
              {conversation.status === 'CLOSED' ? (
                <div className="text-center text-sm text-fg-subtle py-2">
                  This conversation is closed.{' '}
                  <button type="button" onClick={() => updateConv.mutate({ id: conversation.id, status: 'OPEN' })}
                    className="text-accent underline">Reopen</button> to reply.
                </div>
              ) : (
                <div className="flex gap-3 items-end">
                  <div className="flex-1 relative">
                    <Textarea
                      value={replyBody}
                      aria-label="Reply"
                      onChange={e => setReplyBody(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSend();
                      }}
                      placeholder={`Reply via ${conversation.channel === 'EMAIL' ? 'email' : conversation.channel === 'CHAT' ? 'live chat' : 'WhatsApp'}… (⌘↵ to send)`}
                      rows={3}
                      className="resize-none bg-surface-sunken"
                    />
                  </div>
                  <Button
                    size="lg"
                    aria-label="Send reply"
                    className="shrink-0 !px-3.5"
                    icon={<Send size={18} />}
                    disabled={!replyBody.trim()}
                    loading={sendReply.isPending}
                    onClick={handleSend}
                  />
                </div>
              )}
              {sendReply.isError && (
                <p className="text-xs text-danger mt-2">
                  {(sendReply.error as any)?.response?.data?.error || 'Failed to send reply'}
                </p>
              )}
            </div>
          </>
        ) : (
          /* No conversation selected */
          <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
            <EmptyState
              icon={<Inbox />}
              title="Unified Inbox"
              description={conversations.length > 0
                ? 'Select a conversation on the left to view messages and reply.'
                : 'Your inbox is empty. Connect Email or WhatsApp to start receiving messages.'}
              action={(!hasEmail || !hasWhatsApp)
                ? { label: 'Configure Channels', onClick: () => setShowSettings(true) }
                : undefined}
            />
            <div className="mt-2 flex flex-wrap justify-center gap-4">
              <Badge variant={hasEmail ? 'green' : 'gray'}>
                {hasEmail ? <Wifi size={12} /> : <WifiOff size={12} />}
                Email {hasEmail ? 'Connected' : 'Not Connected'}
              </Badge>
              <Badge variant={hasWhatsApp ? 'green' : 'gray'}>
                {hasWhatsApp ? <Wifi size={12} /> : <WifiOff size={12} />}
                WhatsApp {hasWhatsApp ? 'Connected' : 'Not Connected'}
              </Badge>
            </div>
          </div>
        )}
      </div>

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </div>
  );
}
