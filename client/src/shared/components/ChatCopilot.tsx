/**
 * Chat Copilot — the floating chat that can DO things.
 *
 * A multi-turn conversation with a small routing model: questions get
 * answered from org data, imperatives come back as a whitelisted action plan
 * rendered as a confirm card (the server never executes anything without the
 * user pressing Run — see executeActionHandler's role re-checks). This is the
 * "manage the project from chat" surface: file tickets, add notes, assign
 * work, request or approve leave, create leads — all without leaving the
 * conversation.
 */
import { useEffect, useRef, useState } from 'react';
import { MessageCircle, Send, Sparkles, X, Loader2 } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import { api } from '../../api/client';
import { type AiActionPlan } from '../../api/ai';
import { Button } from './Button';
import { RichText } from './RichText';
import { AnalyticsAnswer, type AnswerView } from './AnalyticsAnswer';

interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
  /** A proposed plan awaiting confirm — rendered as a card under the text. */
  plan?: AiActionPlan;
  /** Set once the plan ran (or was dismissed) so the card locks. */
  planState?: 'done' | 'dismissed' | 'error';
  resultSummary?: string;
  /** Data behind an answered question (chart/table + how it was calculated). */
  analytics?: AnswerView;
}

const SUGGESTIONS = [
  'Create a lead for Ravi from Acme, schedule a follow-up call Friday 11am and remind me on WhatsApp',
  'Create a high priority ticket: boardroom projector flickering',
  'How many tickets are open right now?',
  'Top 5 agents by tickets resolved this month',
  'Add a lead for Maria Gomez from Initech — met at the expo',
  'Request 2 days of annual leave from next Monday',
];

export function ChatCopilot() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  const chat = useMutation({
    mutationFn: (msgs: Array<{ role: string; content: string }>) =>
      api.post('/ai/chat', { messages: msgs }).then(r => r.data as { type: 'plan' | 'reply'; text: string; plan?: AiActionPlan; analytics?: Omit<AnswerView, 'answer'> }),
  });

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, open]);

  /* People type their confirmations — "yes", "confirm", "go ahead" — at
     least as often as they click buttons. If the previous assistant message
     holds a pending plan, treat an affirmation as pressing "Run it" and a
     negation as "Dismiss", instead of routing the word through the model
     as a brand-new command (which used to re-plan "yes confirm" into
     nonsense). */
  const AFFIRM = /^(yes|yes[,!. ]*(please|confirm|do it)?|confirm|ok(ay)?|sure|go ahead|do it|run( it)?|proceed|please do)[.! ]*$/i;
  const NEGATE = /^(no|cancel|dismiss|stop|don'?t|nevermind|never mind)[.! ]*$/i;

  async function send(text?: string) {
    const content = (text ?? input).trim();
    if (!content || chat.isPending) return;
    setInput('');

    const pendingIdx = messages.reduce((acc, m, i) => (m.plan && !m.planState ? i : acc), -1);
    if (pendingIdx >= 0 && AFFIRM.test(content)) {
      setMessages(m => [...m.map((x, i) => (i === pendingIdx ? { ...x, confirmToken: Date.now() } : x)), { role: 'user', content }]);
      return;
    }
    if (pendingIdx >= 0 && NEGATE.test(content)) {
      setMessages(m => [
        ...m.map((x, i) => (i === pendingIdx ? { ...x, dismissToken: Date.now() } : x)),
        { role: 'user', content },
        { role: 'assistant', content: 'Okay, dismissed — nothing was run.' },
      ]);
      return;
    }

    const next: ChatMsg[] = [...messages, { role: 'user', content }];
    setMessages(next);
    try {
      const res = await chat.mutateAsync(
        next.slice(-12).map(m => ({ role: m.role, content: m.content })),
      );
      setMessages(m => [...m, {
        role: 'assistant',
        content: res.text,
        plan: res.type === 'plan' && res.plan?.action ? res.plan : undefined,
        analytics: res.analytics ? { ...res.analytics, answer: res.text, currency: res.analytics.currency ?? res.analytics.forecast?.currency ?? 'USD' } as AnswerView : undefined,
      }]);
    } catch (e: any) {
      setMessages(m => [...m, { role: 'assistant', content: e?.response?.data?.error || 'Something went wrong — try rephrasing.' }]);
    }
  }

  const setPlanState = (idx: number, planState: 'done' | 'dismissed') =>
    setMessages(ms => ms.map((x, j) => (j === idx ? { ...x, planState } : x)));

  return (
    <>
      {/* Launcher */}
      {!open && (
        <button
          type="button"
          aria-label="Open AI chat"
          onClick={() => setOpen(true)}
          className="fixed fab-safe z-40 h-12 w-12 rounded-full bg-accent text-accent-fg shadow-lg
                     border border-accent-active/50 flex items-center justify-center
                     hover:bg-accent-hover active:scale-95 transition-all"
        >
          <MessageCircle size={20} />
        </button>
      )}

      {/* Panel */}
      {open && (
        <div className="fixed fab-safe z-40 w-[400px] max-w-[calc(100vw-2rem)] h-[560px] max-h-[calc(100dvh-6rem)]
                        flex flex-col rounded-modal border border-line bg-surface shadow-2xl overflow-hidden">
          <div className="flex items-center gap-2 px-3.5 py-2.5 border-b border-line-subtle bg-surface-sunken">
            <Sparkles size={14} className="text-accent shrink-0" />
            <p className="text-[13px] font-semibold text-fg">Assistant</p>
            <p className="text-[11px] text-fg-subtle truncate">chats, answers, and takes action</p>
            <button
              type="button" aria-label="Close chat" onClick={() => setOpen(false)}
              className="ml-auto p-1 rounded-btn text-fg-muted hover:text-fg hover:bg-surface-hover"
            >
              <X size={15} />
            </button>
          </div>

          <div ref={listRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-2.5">
            {messages.length === 0 && (
              <div className="pt-2">
                <p className="text-[12.5px] text-fg-muted px-1 mb-2">
                  Ask a question or tell me what to do — I can create tickets and leads, add notes,
                  assign work, file or approve leave, and answer questions about your data.
                </p>
                <div className="space-y-1.5">
                  {SUGGESTIONS.map(s => (
                    <button
                      key={s} type="button" onClick={() => send(s)}
                      className="block w-full text-left text-[12px] px-2.5 py-1.5 rounded-btn border border-line
                                 text-fg-muted hover:text-fg hover:border-line-strong hover:bg-surface-hover transition-colors"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m, i) => (
              <div key={i} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
                <div className={`${m.plan ? 'w-full max-w-full' : 'max-w-[85%]'} rounded-card px-3 py-2 text-[12.5px] leading-relaxed whitespace-pre-wrap ${
                  m.role === 'user'
                    ? 'bg-accent text-accent-fg'
                    : 'bg-surface-sunken border border-line-subtle text-fg'
                }`}>
                  {m.role === 'assistant' ? <RichText content={m.content} className="text-[12.5px]" /> : m.content}
                  {m.analytics && m.analytics.status === 'answered' && (
                    <div className="mt-2 whitespace-normal"><AnalyticsAnswer view={m.analytics} compact hideText /></div>
                  )}
                  {m.plan && (
                    <div className="mt-2 rounded-btn border border-accent/30 bg-surface p-2.5 whitespace-normal">
                      <AiPlanCard
                        plan={m.plan}
                        compact
                        confirmToken={m.confirmToken}
                        dismissToken={m.dismissToken}
                        onDone={() => setPlanState(i, 'done')}
                        onDismiss={() => setPlanState(i, 'dismissed')}
                        onNavigate={() => setOpen(false)}
                      />
                    </div>
                  )}
                </div>
              </div>
            ))}
            {chat.isPending && (
              <div className="flex justify-start">
                <div className="rounded-card px-3 py-2 bg-surface-sunken border border-line-subtle">
                  <Loader2 size={14} className="animate-spin text-fg-subtle" />
                </div>
              </div>
            )}
          </div>

          <form
            onSubmit={e => { e.preventDefault(); send(); }}
            className="flex items-center gap-2 px-3 py-2.5 border-t border-line-subtle bg-surface-sunken"
          >
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              placeholder="Ask or instruct…"
              aria-label="Chat message"
              className="flex-1 h-ctl-sm px-2.5 rounded-btn border border-line bg-surface text-[12.5px] text-fg
                         placeholder:text-fg-subtle focus:outline-none focus:ring-2 focus:ring-accent-ring"
            />
            <Button size="sm" type="submit" disabled={!input.trim() || chat.isPending} icon={<Send size={12} />} aria-label="Send" />
          </form>
        </div>
      )}
    </>
  );
}
