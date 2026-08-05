import { useState, useRef, useEffect } from 'react';
import {
  Mail, MessageCircle, Settings, RefreshCw, Send, Check,
  MailOpen, X, Inbox, Wifi, WifiOff, Loader2,
  CheckCheck, AlertCircle, Phone, MessageSquareText
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import {
  useConversations, useConversation, useSendReply, useUpdateConversation,
  useInboxSettings, useConnectEmail, useDisconnectEmail,
  useConnectWhatsApp, useDisconnectWhatsApp, useTriggerSync,
  type Conversation, type Channel,
} from '../../api/inbox';
import { Spinner } from '../../shared/components';

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
  return channel === 'EMAIL' ? 'bg-blue-100' : channel === 'CHAT' ? 'bg-violet-100' : 'bg-green-100';
}

function statusColor(status: string) {
  return status === 'OPEN' ? 'bg-green-100 text-green-700'
    : status === 'PENDING' ? 'bg-yellow-100 text-yellow-700'
    : 'bg-gray-100 text-gray-500';
}

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
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <Settings size={18} className="text-gray-500" />
            <h2 className="font-semibold text-gray-900">Inbox Settings</h2>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg">
            <X size={16} className="text-gray-500" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-100">
          {(['email', 'whatsapp'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 py-3 text-sm font-medium flex items-center justify-center gap-2 border-b-2 transition-colors ${
                tab === t ? 'border-brand-600 text-brand-600' : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}>
              {t === 'email' ? <Mail size={14} /> : <MessageCircle size={14} />}
              {t === 'email' ? 'Email (IMAP)' : 'WhatsApp (Twilio)'}
            </button>
          ))}
        </div>

        <div className="p-5">
          {isLoading ? <Spinner label="Loading settings…" /> : tab === 'email' ? (
            settings?.emailAccount ? (
              /* Email connected */
              <div className="space-y-4">
                <div className="flex items-center gap-3 p-4 bg-green-50 border border-green-100 rounded-xl">
                  <Wifi size={18} className="text-green-600 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-green-800 text-sm">{settings.emailAccount.email}</p>
                    <p className="text-xs text-green-600 mt-0.5">
                      {settings.emailAccount.imapHost}:{settings.emailAccount.imapPort} · SMTP {settings.emailAccount.smtpHost}:{settings.emailAccount.smtpPort}
                    </p>
                    {settings.emailAccount.lastSyncAt && (
                      <p className="text-xs text-green-500 mt-0.5">Last synced {timeAgo(settings.emailAccount.lastSyncAt)}</p>
                    )}
                  </div>
                  <button
                    onClick={() => disconnectEmail.mutate(undefined, { onSuccess: () => {} })}
                    className="text-xs text-red-500 hover:text-red-700 font-medium px-2 py-1 rounded hover:bg-red-50">
                    Disconnect
                  </button>
                </div>
              </div>
            ) : (
              /* Email form */
              <form onSubmit={e => { e.preventDefault(); connectEmail.mutate(emailForm, { onSuccess: onClose }); }}
                className="space-y-3">
                <p className="text-xs text-gray-500 bg-blue-50 border border-blue-100 rounded-xl p-3">
                  For Gmail, use an <strong>App Password</strong> (not your regular password). Enable 2FA → Google Account → Security → App Passwords.
                </p>
                <div className="form-section">
                  <p className="form-section-title">Credentials</p>
                  <div className="space-y-4">
                    <div>
                      <label className="form-label">Email Address <span className="req">*</span></label>
                      <input value={emailForm.email} onChange={e => setEmailForm(f => ({ ...f, email: e.target.value }))}
                        type="email" required placeholder="you@gmail.com" className="ui-input" />
                    </div>
                    <div>
                      <label className="form-label">App Password <span className="req">*</span></label>
                      <input value={emailForm.password} onChange={e => setEmailForm(f => ({ ...f, password: e.target.value }))}
                        type="password" required placeholder="xxxx xxxx xxxx xxxx" className="ui-input" />
                    </div>
                  </div>
                </div>
                <div className="form-section">
                  <p className="form-section-title">Server Settings</p>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="form-label">IMAP Host <span className="req">*</span></label>
                      <input value={emailForm.imapHost} onChange={e => setEmailForm(f => ({ ...f, imapHost: e.target.value }))}
                        required placeholder="imap.gmail.com" className="ui-input" />
                    </div>
                    <div>
                      <label className="form-label">IMAP Port <span className="req">*</span></label>
                      <input value={emailForm.imapPort} onChange={e => setEmailForm(f => ({ ...f, imapPort: Number(e.target.value) }))}
                        type="number" required className="ui-input" />
                    </div>
                    <div>
                      <label className="form-label">SMTP Host <span className="req">*</span></label>
                      <input value={emailForm.smtpHost} onChange={e => setEmailForm(f => ({ ...f, smtpHost: e.target.value }))}
                        required placeholder="smtp.gmail.com" className="ui-input" />
                    </div>
                    <div>
                      <label className="form-label">SMTP Port <span className="req">*</span></label>
                      <input value={emailForm.smtpPort} onChange={e => setEmailForm(f => ({ ...f, smtpPort: Number(e.target.value) }))}
                        type="number" required className="ui-input" />
                    </div>
                  </div>
                </div>
                {connectEmail.isError && (
                  <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-lg p-2">
                    {(connectEmail.error as any)?.response?.data?.error || 'Connection failed'}
                  </p>
                )}
                <button type="submit" disabled={connectEmail.isPending}
                  className="w-full py-2.5 bg-brand-600 text-white rounded-xl text-sm font-medium hover:bg-brand-700 disabled:opacity-40 flex items-center justify-center gap-2">
                  {connectEmail.isPending ? <Loader2 size={14} className="animate-spin" /> : <Mail size={14} />}
                  Connect Email & Start Sync
                </button>
              </form>
            )
          ) : (
            /* WhatsApp tab */
            settings?.whatsAppConfig ? (
              <div className="space-y-4">
                <div className="flex items-center gap-3 p-4 bg-green-50 border border-green-100 rounded-xl">
                  <MessageCircle size={18} className="text-green-600 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-green-800 text-sm">{settings.whatsAppConfig.phoneNumber}</p>
                    <p className="text-xs text-green-600 mt-0.5">Account: {settings.whatsAppConfig.accountSid}</p>
                    <p className="text-xs text-green-600 mt-0.5">
                      Notification number: {settings.whatsAppConfig.notifyNumber || <span className="text-green-500 italic">same as above</span>}
                    </p>
                  </div>
                  <button
                    onClick={() => disconnectWA.mutate(undefined, { onSuccess: () => {} })}
                    className="text-xs text-red-500 hover:text-red-700 font-medium px-2 py-1 rounded hover:bg-red-50">
                    Disconnect
                  </button>
                </div>
                <div className="p-3 bg-gray-50 border border-gray-100 rounded-xl text-xs text-gray-600 space-y-1">
                  <p className="font-medium text-gray-700">Twilio Webhook URL</p>
                  <code className="block text-xs bg-gray-100 rounded px-2 py-1 font-mono break-all">
                    {window.location.origin.replace('5173', '4000')}/api/inbox/whatsapp/webhook
                  </code>
                  <p>Set this as the webhook in your Twilio console under WhatsApp sandbox or number settings.</p>
                </div>
              </div>
            ) : (
              <form onSubmit={e => { e.preventDefault(); connectWA.mutate(waForm, { onSuccess: onClose }); }}
                className="space-y-3">
                <p className="text-xs text-gray-500 bg-green-50 border border-green-100 rounded-xl p-3">
                  Get credentials from <strong>console.twilio.com</strong>. Use the WhatsApp Sandbox for testing or a production number for live messages.
                </p>
                <div className="form-section">
                  <p className="form-section-title">Twilio Credentials</p>
                  <div className="space-y-4">
                    <div>
                      <label className="form-label">Account SID <span className="req">*</span></label>
                      <input value={waForm.accountSid} onChange={e => setWaForm(f => ({ ...f, accountSid: e.target.value }))}
                        required placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" className="ui-input font-mono" />
                    </div>
                    <div>
                      <label className="form-label">Auth Token <span className="req">*</span></label>
                      <input value={waForm.authToken} onChange={e => setWaForm(f => ({ ...f, authToken: e.target.value }))}
                        type="password" required placeholder="Your auth token" className="ui-input" />
                    </div>
                    <div>
                      <label className="form-label">WhatsApp Phone Number <span className="req">*</span></label>
                      <input value={waForm.phoneNumber} onChange={e => setWaForm(f => ({ ...f, phoneNumber: e.target.value }))}
                        required placeholder="+14155238886" className="ui-input" />
                    </div>
                    <div>
                      <label className="form-label">Notification Number</label>
                      <input aria-label="Notification Number" value={waForm.notifyNumber} onChange={e => setWaForm(f => ({ ...f, notifyNumber: e.target.value }))}
                        placeholder="+14155551234 (optional — defaults to the number above)" className="ui-input" />
                      <p className="form-hint">Where "org default" deal/ticket reminders and workflow WhatsApp actions are sent.</p>
                    </div>
                  </div>
                </div>
                {connectWA.isError && (
                  <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-lg p-2">
                    {(connectWA.error as any)?.response?.data?.error || 'Connection failed'}
                  </p>
                )}
                <button type="submit" disabled={connectWA.isPending}
                  className="w-full py-2.5 bg-green-600 text-white rounded-xl text-sm font-medium hover:bg-green-700 disabled:opacity-40 flex items-center justify-center gap-2">
                  {connectWA.isPending ? <Loader2 size={14} className="animate-spin" /> : <MessageCircle size={14} />}
                  Connect WhatsApp
                </button>
              </form>
            )
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Conversation List Item ────────────────────────────────────────────────────

function ConvItem({ conv, selected, onClick }: { conv: Conversation; selected: boolean; onClick: () => void }) {
  const lastMsg = conv.messages?.[0];

  return (
    <button onClick={onClick}
      className={`w-full text-left p-3 border-b border-gray-50 hover:bg-gray-50 transition-colors ${selected ? 'bg-brand-50 border-l-2 border-l-brand-600' : ''}`}>
      <div className="flex items-start gap-2.5">
        {/* Channel icon */}
        <div className={`w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center ${channelAvatarBg(conv.channel)}`}>
          {channelIcon(conv.channel, 14)}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-1">
            <span className={`text-sm truncate ${conv.unreadCount > 0 ? 'font-semibold text-gray-900' : 'font-medium text-gray-700'}`}>
              {conv.contactName}
            </span>
            <span className="text-xs text-gray-400 flex-shrink-0">{timeAgo(conv.lastMessageAt)}</span>
          </div>
          {conv.subject && (
            <p className="text-xs text-gray-500 truncate mt-0.5">{conv.subject}</p>
          )}
          {lastMsg && (
            <p className="text-xs text-gray-400 truncate mt-0.5 leading-snug">
              {lastMsg.direction === 'OUTBOUND' && <span className="text-brand-500">You: </span>}
              {lastMsg.body}
            </p>
          )}
        </div>

        {conv.unreadCount > 0 && (
          <span className="flex-shrink-0 bg-brand-600 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center font-medium">
            {conv.unreadCount > 9 ? '9+' : conv.unreadCount}
          </span>
        )}
      </div>
    </button>
  );
}

// ─── Message Bubble ───────────────────────────────────────────────────────────

function MessageBubble({ msg }: { msg: { direction: string; body: string; sentAt: string; fromAddress: string } }) {
  const isOut = msg.direction === 'OUTBOUND';
  return (
    <div className={`flex ${isOut ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[75%] rounded-2xl px-4 py-2.5 ${
        isOut
          ? 'bg-brand-600 text-white rounded-br-md'
          : 'bg-white border border-gray-200 text-gray-800 rounded-bl-md shadow-sm'
      }`}>
        <p className="text-sm whitespace-pre-wrap leading-relaxed">{msg.body}</p>
        <div className={`flex items-center gap-1 mt-1 ${isOut ? 'justify-end' : 'justify-start'}`}>
          <span className={`text-xs ${isOut ? 'text-brand-200' : 'text-gray-400'}`}>
            {new Date(msg.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
          {isOut && <CheckCheck size={11} className="text-brand-200" />}
        </div>
      </div>
    </div>
  );
}

// ─── Main InboxPage ────────────────────────────────────────────────────────────

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

  // Auto-select first conversation
  useEffect(() => {
    if (!selectedId && conversations.length > 0) {
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
    <div className="flex h-full bg-gray-50">
      {/* ── Left panel: conversation list ── */}
      <div className="w-80 flex-shrink-0 flex flex-col bg-white border-r border-gray-200">
        {/* Header */}
        <div className="px-4 py-3.5 border-b border-gray-100">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Inbox size={18} className="text-brand-600" />
              <h1 className="font-semibold text-gray-900">Unified Inbox</h1>
            </div>
            <div className="flex items-center gap-1">
              <button onClick={() => triggerSync.mutate(undefined, {})}
                disabled={!hasEmail || triggerSync.isPending}
                title="Sync email"
                className="p-1.5 text-gray-400 hover:text-brand-600 hover:bg-brand-50 rounded-lg disabled:opacity-30 transition-colors">
                <RefreshCw size={14} className={triggerSync.isPending ? 'animate-spin' : ''} />
              </button>
              <button onClick={() => setShowSettings(true)}
                className="p-1.5 text-gray-400 hover:text-brand-600 hover:bg-brand-50 rounded-lg transition-colors">
                <Settings size={14} />
              </button>
            </div>
          </div>

          {/* Channel filter pills */}
          <div className="flex gap-1.5">
            {(['ALL', 'EMAIL', 'WHATSAPP', 'CHAT'] as const).map(ch => (
              <button key={ch} onClick={() => setChannelFilter(ch)}
                className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                  channelFilter === ch
                    ? 'bg-brand-600 text-white'
                    : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                }`}>
                {ch === 'EMAIL' && <Mail size={10} />}
                {ch === 'WHATSAPP' && <MessageCircle size={10} />}
                {ch === 'CHAT' && <MessageSquareText size={10} />}
                {ch === 'ALL' ? 'All' : ch === 'EMAIL' ? 'Email' : ch === 'WHATSAPP' ? 'WhatsApp' : 'Live Chat'}
              </button>
            ))}
          </div>

          {/* Status filter */}
          <div className="flex gap-1.5 mt-2">
            {(['OPEN', 'CLOSED', 'ALL'] as const).map(s => (
              <button key={s} onClick={() => setStatusFilter(s)}
                className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                  statusFilter === s
                    ? 'bg-gray-800 text-white'
                    : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                }`}>
                {s === 'ALL' ? 'All' : s === 'OPEN' ? 'Open' : 'Closed'}
              </button>
            ))}
          </div>
        </div>

        {/* Channel connection prompts */}
        {(!hasEmail || !hasWhatsApp) && (
          <div className="px-3 py-2 bg-amber-50 border-b border-amber-100">
            <div className="flex items-start gap-2">
              <AlertCircle size={13} className="text-amber-500 flex-shrink-0 mt-0.5" />
              <div className="text-xs text-amber-700">
                {!hasEmail && !hasWhatsApp
                  ? 'No channels connected.'
                  : !hasEmail ? 'Email not connected.'
                  : 'WhatsApp not connected.'}
                {' '}
                <button onClick={() => setShowSettings(true)} className="underline font-medium">Connect now →</button>
              </div>
            </div>
          </div>
        )}

        {/* Conversation list */}
        <div className="flex-1 overflow-y-auto">
          {listLoading ? (
            <div className="p-4"><Spinner label="Loading conversations…" /></div>
          ) : conversations.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 text-center px-4">
              <Inbox size={32} className="text-gray-300 mb-2" />
              <p className="text-sm font-medium text-gray-500">No conversations yet</p>
              <p className="text-xs text-gray-400 mt-1">
                {hasEmail || hasWhatsApp
                  ? 'New messages will appear here automatically'
                  : 'Connect Email or WhatsApp in Settings'}
              </p>
              <button onClick={() => setShowSettings(true)}
                className="mt-3 text-xs text-brand-600 underline">
                Open Settings
              </button>
            </div>
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

      {/* ── Right panel: message thread ── */}
      <div className="flex-1 flex flex-col min-w-0">
        {selectedId && conversation ? (
          <>
            {/* Thread header */}
            <div className="px-6 py-4 bg-white border-b border-gray-200 flex items-center justify-between">
              <div className="flex items-center gap-3 min-w-0">
                <div className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 ${channelAvatarBg(conversation.channel)}`}>
                  {channelIcon(conversation.channel, 18)}
                </div>
                <div className="min-w-0">
                  <h2 className="font-semibold text-gray-900 truncate">{conversation.contactName}</h2>
                  <div className="flex items-center gap-2 mt-0.5">
                    {conversation.contactEmail && (
                      <span className="text-xs text-gray-400 truncate">{conversation.contactEmail}</span>
                    )}
                    {conversation.contactPhone && !conversation.contactEmail && (
                      <span className="text-xs text-gray-400 flex items-center gap-1">
                        <Phone size={10} /> {conversation.contactPhone.replace('whatsapp:', '')}
                      </span>
                    )}
                    {conversation.subject && (
                      <span className="text-xs text-gray-400 truncate">· {conversation.subject}</span>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2 flex-shrink-0">
                <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${statusColor(conversation.status)}`}>
                  {conversation.status}
                </span>
                {conversation.status === 'OPEN' && (
                  <button
                    onClick={() => updateConv.mutate({ id: conversation.id, status: 'CLOSED' })}
                    className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">
                    <Check size={12} /> Close
                  </button>
                )}
                {conversation.status === 'CLOSED' && (
                  <button
                    onClick={() => updateConv.mutate({ id: conversation.id, status: 'OPEN' })}
                    className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-brand-600 border border-brand-200 rounded-lg hover:bg-brand-50 transition-colors">
                    <MailOpen size={12} /> Reopen
                  </button>
                )}
              </div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3 bg-gray-50">
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
                  <p className="text-sm text-gray-400">No messages yet</p>
                </div>
              )}
            </div>

            {/* Reply composer */}
            <div className="px-6 py-4 bg-white border-t border-gray-200">
              {conversation.status === 'CLOSED' ? (
                <div className="text-center text-sm text-gray-400 py-2">
                  This conversation is closed.{' '}
                  <button onClick={() => updateConv.mutate({ id: conversation.id, status: 'OPEN' })}
                    className="text-brand-600 underline">Reopen</button> to reply.
                </div>
              ) : (
                <div className="flex gap-3 items-end">
                  <div className="flex-1 relative">
                    <textarea
                      value={replyBody}
                      onChange={e => setReplyBody(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSend();
                      }}
                      placeholder={`Reply via ${conversation.channel === 'EMAIL' ? 'email' : conversation.channel === 'CHAT' ? 'live chat' : 'WhatsApp'}… (⌘↵ to send)`}
                      rows={3}
                      className="w-full px-4 py-3 text-sm border border-gray-200 rounded-xl resize-none focus:outline-none focus:ring-2 focus:ring-brand-400 bg-gray-50"
                    />
                  </div>
                  <button
                    onClick={handleSend}
                    disabled={!replyBody.trim() || sendReply.isPending}
                    className="flex-shrink-0 p-3 bg-brand-600 text-white rounded-xl hover:bg-brand-700 disabled:opacity-40 transition-colors">
                    {sendReply.isPending
                      ? <Loader2 size={18} className="animate-spin" />
                      : <Send size={18} />}
                  </button>
                </div>
              )}
              {sendReply.isError && (
                <p className="text-xs text-red-600 mt-2">
                  {(sendReply.error as any)?.response?.data?.error || 'Failed to send reply'}
                </p>
              )}
            </div>
          </>
        ) : (
          /* No conversation selected */
          <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
            <div className="w-16 h-16 rounded-2xl bg-brand-50 flex items-center justify-center mb-4">
              <Inbox size={28} className="text-brand-400" />
            </div>
            <p className="text-lg font-semibold text-gray-700 mb-1">Unified Inbox</p>
            <p className="text-sm text-gray-400 max-w-sm">
              {conversations.length > 0
                ? 'Select a conversation on the left to view messages and reply.'
                : 'Your inbox is empty. Connect Email or WhatsApp to start receiving messages.'}
            </p>
            {(!hasEmail || !hasWhatsApp) && (
              <button onClick={() => setShowSettings(true)}
                className="mt-4 flex items-center gap-2 px-4 py-2.5 bg-brand-600 text-white rounded-xl text-sm font-medium hover:bg-brand-700 transition-colors">
                <Settings size={14} /> Configure Channels
              </button>
            )}
            <div className="mt-6 flex gap-4">
              <div className={`flex items-center gap-2 text-xs px-3 py-1.5 rounded-full border ${
                hasEmail ? 'border-green-200 bg-green-50 text-green-700' : 'border-gray-200 bg-gray-50 text-gray-400'
              }`}>
                {hasEmail ? <Wifi size={12} /> : <WifiOff size={12} />}
                Email {hasEmail ? 'Connected' : 'Not Connected'}
              </div>
              <div className={`flex items-center gap-2 text-xs px-3 py-1.5 rounded-full border ${
                hasWhatsApp ? 'border-green-200 bg-green-50 text-green-700' : 'border-gray-200 bg-gray-50 text-gray-400'
              }`}>
                {hasWhatsApp ? <Wifi size={12} /> : <WifiOff size={12} />}
                WhatsApp {hasWhatsApp ? 'Connected' : 'Not Connected'}
              </div>
            </div>
          </div>
        )}
      </div>

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </div>
  );
}
