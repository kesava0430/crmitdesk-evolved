import { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Sparkles, ArrowRight, X, Loader2, ChevronRight, CheckCircle2, ShieldAlert, Zap } from "lucide-react";
import { useNlCommand, usePlanAiAction, useExecuteAiAction } from "../../api/ai";

// Route mapping
const ENTITY_ROUTES: Record<string, string> = {
  ticket:  "/itdesk/tickets",
  contact: "/crm/contacts",
  lead:    "/crm/leads",
  deal:    "/crm/deals",
  article: "/itdesk/articles",
};

const ENTITY_LABELS: Record<string, string> = {
  ticket:  "Ticket",
  contact: "Contact",
  lead:    "Lead",
  deal:    "Deal",
  article: "Article",
};

const SUGGESTIONS = [
  "Create a new ticket about VPN issues",
  "Add a contact named Jane Smith from Acme Corp",
  "Create a deal with Acme Corp worth $50,000",
  "New lead from LinkedIn named John Doe",
];

function confidenceColor(score: number): string {
  if (score >= 80) return "text-emerald-600 bg-emerald-50 border-emerald-200";
  if (score >= 50) return "text-amber-600 bg-amber-50 border-amber-200";
  return "text-red-600 bg-red-50 border-red-200";
}

interface AiCommandBarProps {
  open: boolean;
  onClose: () => void;
}

// Two things can come back from a submitted command:
//  - "legacy": the existing create/update-an-entity flow (ticket/contact/lead/
//    deal/article) — unchanged, still just prefills a form and redirects.
//  - "action": a whitelisted registry action (move a deal's stage, schedule a
//    reminder, add a note, toggle a rule, etc.) with no dedicated create form
//    — this is the new propose -> confirm -> execute flow.
type ResultMode = "legacy" | "action" | "none";

export function AiCommandBar({ open, onClose }: AiCommandBarProps) {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<ResultMode>("none");
  const [searching, setSearching] = useState(false);

  const nlCommand = useNlCommand();
  const planAction = usePlanAiAction();
  const execAction = useExecuteAiAction();

  const result = nlCommand.data;
  const plan = planAction.data;
  const isLoading = searching || nlCommand.isPending || planAction.isPending;
  const isError = mode === "none" && (nlCommand.isError || planAction.isError);

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      setQuery("");
      setMode("none");
      setSearching(false);
      nlCommand.reset();
      planAction.reset();
      execAction.reset();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  async function runCommand(text: string) {
    setMode("none");
    execAction.reset();
    setSearching(true);
    try {
      const legacy = await nlCommand.mutateAsync(text).catch(() => null);
      // A confident, recognized create/update intent keeps today's behavior
      // exactly as-is — never overridden by the new action flow.
      if (legacy && legacy.entity !== "unknown" && legacy.confidence >= 30) {
        setMode("legacy");
        return;
      }
      // Otherwise, see if this matches something in the whitelisted action
      // registry instead — covers requests with no dedicated create form
      // (move a stage, schedule a reminder, add a note, toggle a rule...).
      const proposed = await planAction.mutateAsync(text).catch(() => null);
      if (proposed && proposed.action && proposed.confidence >= 40) {
        setMode("action");
        return;
      }
      // Fall back to the existing "couldn't understand" branch only if we
      // actually have a (low-confidence) legacy result to show — otherwise
      // leave mode as "none" so the generic network-error banner renders
      // instead of a blank panel.
      if (legacy) setMode("legacy");
    } finally {
      setSearching(false);
    }
  }

  function handleSubmit() {
    const trimmed = query.trim();
    if (trimmed.length < 3) return;
    runCommand(trimmed);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") handleSubmit();
  }

  function handleSuggestion(text: string) {
    setQuery(text);
    runCommand(text);
  }

  function navigateToEntity(showCreateModal: boolean) {
    if (!result) return;
    const route = ENTITY_ROUTES[result.entity] ?? "/dashboard";
    onClose();
    navigate(route, {
      state: {
        aiPrefill: result.fields,
        ...(showCreateModal ? { openCreate: true } : {}),
      },
    });
  }

  function handleConfirmAction() {
    if (!plan?.action) return;
    execAction.mutate({ action: plan.action, params: plan.params, command: query.trim() });
  }

  function handleCancelAction() {
    setMode("none");
    execAction.reset();
  }

  const confidencePct = result ? Math.round(result.confidence * 100) : 0;
  const lowConfidence = result && confidencePct < 30;
  const planConfidencePct = plan ? Math.round(plan.confidence) : 0;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="AI Command"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="relative w-full max-w-2xl bg-white rounded-2xl shadow-2xl overflow-hidden">

        {/* Header */}
        <div className="flex items-center gap-3 px-5 pt-5 pb-4 border-b border-gray-100">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-violet-600 flex-shrink-0">
            <Sparkles size={16} className="text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-gray-900">AI Command</p>
            <p className="text-xs text-gray-400">Type a natural language command</p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* Input area */}
        <div className="px-5 pt-4 pb-3">
          <p className="text-xs font-medium text-gray-500 mb-2">What would you like to do?</p>
          <div className="flex gap-2">
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Search or ask AI — what would you like to do? e.g. Move the Acme deal to Proposal..."
              className="flex-1 px-4 py-3 rounded-xl border border-gray-200 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent bg-gray-50 transition-all"
              disabled={isLoading}
            />
            <button
              onClick={handleSubmit}
              disabled={isLoading || query.trim().length < 3}
              className="flex items-center gap-1.5 px-4 py-3 bg-violet-600 hover:bg-violet-700 disabled:bg-violet-300 text-white text-sm font-semibold rounded-xl transition-colors"
            >
              {isLoading ? (
                <Loader2 size={15} className="animate-spin" />
              ) : (
                <><Sparkles size={15} /> Ask AI</>
              )}
            </button>
          </div>
        </div>

        {/* Suggestions */}
        {mode === "none" && !isLoading && !isError && (
          <div className="px-5 pb-4">
            <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Try asking</p>
            <div className="flex flex-col gap-1.5">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => handleSuggestion(s)}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-gray-600 hover:bg-violet-50 hover:text-violet-700 transition-colors text-left group"
                >
                  <ChevronRight size={13} className="text-gray-300 group-hover:text-violet-400 flex-shrink-0" />
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Loading state */}
        {isLoading && (
          <div className="px-5 pb-6 flex items-center gap-3 text-sm text-gray-500">
            <Loader2 size={16} className="animate-spin text-violet-600" />
            Parsing your command with AI...
          </div>
        )}

        {/* Error state */}
        {isError && (
          <div className="mx-5 mb-5 px-4 py-3 rounded-xl bg-red-50 border border-red-200 text-sm text-red-700">
            Something went wrong. Please try again.
          </div>
        )}

        {/* Legacy result: create/update one of the 5 entity types */}
        {mode === "legacy" && result && (
          <div className="px-5 pb-5 space-y-4 border-t border-gray-100 pt-4">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold bg-violet-100 text-violet-700 border border-violet-200">
                {result.intent}
              </span>
              <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold bg-blue-100 text-blue-700 border border-blue-200">
                {ENTITY_LABELS[result.entity] ?? result.entity}
              </span>
              <span className={"inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold border " + confidenceColor(confidencePct)}>
                {confidencePct}% confidence
              </span>
            </div>

            {lowConfidence ? (
              <div className="px-4 py-3 rounded-xl bg-red-50 border border-red-200 text-sm text-red-700">
                I couldn&apos;t understand that command. Try rephrasing.
              </div>
            ) : (
              <>
                {result.explanation && (
                  <p className="text-sm text-gray-600 leading-relaxed">{result.explanation}</p>
                )}

                {Object.keys(result.fields).length > 0 && (
                  <div>
                    <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Parsed fields</p>
                    <div className="flex flex-wrap gap-2">
                      {Object.entries(result.fields).map(([k, v]) => (
                        <span
                          key={k}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-100 text-xs text-gray-700"
                        >
                          <span className="font-semibold text-gray-500">{k}:</span>
                          <span>{String(v)}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                <div className="flex items-center gap-2 pt-1">
                  <button
                    onClick={() => navigateToEntity(false)}
                    className="flex items-center gap-1.5 px-4 py-2.5 bg-violet-600 hover:bg-violet-700 text-white text-sm font-semibold rounded-xl transition-colors"
                  >
                    Go Create {ENTITY_LABELS[result.entity] ?? result.entity}
                    <ArrowRight size={14} />
                  </button>
                  <button
                    onClick={() => navigateToEntity(true)}
                    className="flex items-center gap-1.5 px-4 py-2.5 border border-gray-200 hover:bg-gray-50 text-gray-700 text-sm font-semibold rounded-xl transition-colors"
                  >
                    Edit before creating
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* Registry action: propose -> confirm -> execute */}
        {mode === "action" && plan && (
          <div className="px-5 pb-5 space-y-4 border-t border-gray-100 pt-4">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-indigo-100 text-indigo-700 border border-indigo-200">
                <Zap size={11} /> {plan.label ?? plan.action}
              </span>
              <span className={"inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold border " + confidenceColor(planConfidencePct)}>
                {planConfidencePct}% confidence
              </span>
            </div>

            <p className="text-sm text-gray-600 leading-relaxed">{plan.explanation}</p>

            {Object.keys(plan.params).length > 0 && (
              <div>
                <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-2">This will run with</p>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(plan.params).map(([k, v]) => (
                    <span key={k} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-100 text-xs text-gray-700">
                      <span className="font-semibold text-gray-500">{k}:</span>
                      <span>{String(v)}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}

            {!plan.allowed ? (
              <div className="flex items-center gap-2 px-4 py-3 rounded-xl bg-amber-50 border border-amber-200 text-sm text-amber-700">
                <ShieldAlert size={15} className="flex-shrink-0" />
                Your role isn&apos;t permitted to run this action.
              </div>
            ) : execAction.isSuccess ? (
              <div className="flex items-center gap-2 px-4 py-3 rounded-xl bg-emerald-50 border border-emerald-200 text-sm text-emerald-700">
                <CheckCircle2 size={15} className="flex-shrink-0" />
                {execAction.data?.summary || "Done."}
              </div>
            ) : (
              <>
                {execAction.isError && (
                  <div className="px-4 py-3 rounded-xl bg-red-50 border border-red-200 text-sm text-red-700">
                    {(execAction.error as any)?.response?.data?.error || "Couldn't run that action."}
                  </div>
                )}
                <div className="flex items-center gap-2 pt-1">
                  <button
                    onClick={handleConfirmAction}
                    disabled={execAction.isPending}
                    className="flex items-center gap-1.5 px-4 py-2.5 bg-violet-600 hover:bg-violet-700 disabled:bg-violet-300 text-white text-sm font-semibold rounded-xl transition-colors"
                  >
                    {execAction.isPending ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                    Confirm &amp; Run
                  </button>
                  <button
                    onClick={handleCancelAction}
                    disabled={execAction.isPending}
                    className="flex items-center gap-1.5 px-4 py-2.5 border border-gray-200 hover:bg-gray-50 text-gray-700 text-sm font-semibold rounded-xl transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
