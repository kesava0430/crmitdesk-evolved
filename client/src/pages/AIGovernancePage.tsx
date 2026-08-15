import { useState } from 'react';
import {
  useAiObservability,
  useAiLogs,
  useSetAiBudget,
  useKnowledgeStats,
  useReindexKnowledge,
  useKnowledgeAsk,
  useAiFeedback,
} from '../api/work';
import { PageHeader, Button, Badge, Spinner, EmptyState } from '../shared/components';
import { Brain, Database, RefreshCw, DollarSign, AlertTriangle, ThumbsUp, ThumbsDown, Search } from 'lucide-react';
import { useFormat } from '../hooks/useFormat';

/**
 * AI governance & observability (§41, §43, §78, §79, §81).
 *
 * This page exists because of a specific problem: before it, an AI call left
 * no trace. You could not answer "what did AI cost us this month", "how often
 * is it wrong", "which fields did it see", or "did a person or the model take
 * that action" — and no CFO renews spend they can't measure.
 */

const field =
  'w-full px-3 py-2 text-[13px] border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 text-gray-900 dark:text-white';

const STATUS_VARIANT: Record<string, any> = {
  SUCCESS: 'green',
  ERROR: 'red',
  CACHED: 'blue',
  BLOCKED: 'orange',
  BUDGET_EXCEEDED: 'red',
};

function Stat({ label, value, sub, tone }: { label: string; value: string | number; sub?: string; tone?: string }) {
  return (
    <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-3.5">
      <p className="text-xs text-gray-500 dark:text-gray-400">{label}</p>
      <p className={`text-xl font-bold mt-0.5 ${tone ?? 'text-gray-900 dark:text-white'}`}>{value}</p>
      {sub && <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-0.5">{sub}</p>}
    </div>
  );
}

function ObservabilityPanel() {
  const [days, setDays] = useState(30);
  const { data, isLoading } = useAiObservability(days);
  const setBudget = useSetAiBudget();
  const [limit, setLimit] = useState('');
  const [hardStop, setHardStop] = useState(false);

  if (isLoading) return <Spinner />;
  if (!data) return null;

  const overBudget = data.budget.limitUsd > 0 && data.budget.percentUsed >= 100;
  const nearBudget = data.budget.limitUsd > 0 && data.budget.percentUsed >= 80 && !overBudget;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <select className={`${field} w-auto`} value={days} onChange={e => setDays(Number(e.target.value))}>
          {[7, 30, 90, 365].map(d => (
            <option key={d} value={d}>
              Last {d} days
            </option>
          ))}
        </select>
      </div>

      {(overBudget || nearBudget) && (
        <div
          className={`flex items-start gap-2 rounded-xl p-3.5 border ${
            overBudget
              ? 'bg-red-50 dark:bg-red-950/40 border-red-100 dark:border-red-900'
              : 'bg-amber-50 dark:bg-amber-950/40 border-amber-100 dark:border-amber-900'
          }`}
        >
          <AlertTriangle size={15} className={overBudget ? 'text-red-500 mt-0.5' : 'text-amber-500 mt-0.5'} />
          <p className={`text-[12.5px] ${overBudget ? 'text-red-900 dark:text-red-200' : 'text-amber-900 dark:text-amber-200'}`}>
            {overBudget ? 'Monthly AI budget exhausted' : 'Approaching your monthly AI budget'} — $
            {data.budget.spendUsd.toFixed(2)} of ${data.budget.limitUsd.toFixed(2)} ({data.budget.percentUsed}%).
            {data.budget.hardStop
              ? ' Hard stop is on, so further AI calls are being blocked.'
              : ' Hard stop is off, so calls continue.'}
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="AI calls" value={data.totalCalls.toLocaleString()} />
        <Stat
          label="Success rate"
          value={`${data.successRate}%`}
          sub={`${data.errorCount} error${data.errorCount === 1 ? '' : 's'}`}
          tone={data.successRate >= 95 ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}
        />
        <Stat label="Total cost" value={`$${data.totalCostUsd.toFixed(2)}`} sub={`${data.totalTokens.toLocaleString()} tokens`} />
        <Stat label="Avg latency" value={`${data.avgLatencyMs} ms`} />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Actions executed" value={data.actionsExecuted} sub="AI wrote to a record" />
        <Stat label="Rated helpful" value={data.feedbackUp} tone="text-emerald-600 dark:text-emerald-400" />
        <Stat label="Rated unhelpful" value={data.feedbackDown} tone="text-red-600 dark:text-red-400" />
        <Stat
          label="Budget used"
          value={data.budget.limitUsd > 0 ? `${data.budget.percentUsed}%` : 'No limit'}
          sub={data.budget.limitUsd > 0 ? `of $${data.budget.limitUsd.toFixed(2)}` : 'Set one below'}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
          <p className="px-4 py-2.5 text-[13px] font-semibold text-gray-900 dark:text-white border-b border-gray-100 dark:border-gray-800">
            By feature
          </p>
          {data.byFeature.length ? (
            data.byFeature.slice(0, 12).map(f => (
              <div
                key={f.feature}
                className="flex items-center gap-3 px-4 py-2 border-b border-gray-50 dark:border-gray-800 last:border-0"
              >
                <span className="text-[12.5px] font-mono text-gray-700 dark:text-gray-200 flex-1 truncate">{f.feature}</span>
                <span className="text-[12px] text-gray-500">{f.calls}</span>
                <span className="text-[12px] text-gray-400 w-16 text-right">${f.costUsd.toFixed(3)}</span>
              </div>
            ))
          ) : (
            <p className="px-4 py-6 text-[12.5px] text-gray-400 text-center">No AI calls in this period</p>
          )}
        </div>

        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
          <p className="px-4 py-2.5 text-[13px] font-semibold text-gray-900 dark:text-white border-b border-gray-100 dark:border-gray-800">
            By model
          </p>
          {data.byModel.length ? (
            data.byModel.map(m => (
              <div
                key={m.model}
                className="flex items-center gap-3 px-4 py-2 border-b border-gray-50 dark:border-gray-800 last:border-0"
              >
                <span className="text-[12.5px] font-mono text-gray-700 dark:text-gray-200 flex-1 truncate">{m.model}</span>
                <span className="text-[12px] text-gray-500">{m.calls}</span>
                <span className="text-[12px] text-gray-400 w-16 text-right">${m.costUsd.toFixed(3)}</span>
              </div>
            ))
          ) : (
            <p className="px-4 py-6 text-[12.5px] text-gray-400 text-center">No models used yet</p>
          )}
        </div>
      </div>

      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
        <div className="flex items-center gap-1.5 mb-1">
          <DollarSign size={14} className="text-gray-400" />
          <p className="text-[13px] font-semibold text-gray-900 dark:text-white">Monthly budget</p>
        </div>
        <p className="text-[12px] text-gray-500 dark:text-gray-400 mb-3">
          With hard stop off, hitting the limit only raises an alert — calls keep working. Turn it on to block AI once
          the limit is reached.
        </p>
        <div className="flex items-center gap-2 flex-wrap">
          <input
            className={`${field} w-40`}
            placeholder="Limit in USD"
            value={limit}
            onChange={e => setLimit(e.target.value)}
          />
          <label className="flex items-center gap-1.5 text-[12.5px] text-gray-600 dark:text-gray-300">
            <input type="checkbox" checked={hardStop} onChange={e => setHardStop(e.target.checked)} />
            Hard stop at limit
          </label>
          <Button
            size="sm"
            disabled={!limit || Number.isNaN(Number(limit))}
            loading={setBudget.isPending}
            onClick={() => setBudget.mutate({ limitUsd: Number(limit), hardStop })}
          >
            Save budget
          </Button>
        </div>
      </div>
    </div>
  );
}

function LogsPanel() {
  const [status, setStatus] = useState('');
  const { data, isLoading } = useAiLogs({ status: status || undefined });
  const fmt = useFormat();

  return (
    <>
      <select className={`${field} w-auto mb-3`} value={status} onChange={e => setStatus(e.target.value)}>
        <option value="">All statuses</option>
        {['SUCCESS', 'ERROR', 'CACHED', 'BUDGET_EXCEEDED'].map(s => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>

      {isLoading ? (
        <Spinner />
      ) : !data?.data.length ? (
        <EmptyState
          icon={<Brain />}
          title="No AI activity yet"
          description="Every AI call will be recorded here with its tokens, cost, latency and what it was allowed to see."
        />
      ) : (
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
          {data.data.map(l => (
            <div key={l.id} className="px-4 py-2.5 border-b border-gray-100 dark:border-gray-800 last:border-0">
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant={STATUS_VARIANT[l.status] ?? 'gray'}>{l.status}</Badge>
                <span className="text-[12.5px] font-mono text-gray-700 dark:text-gray-200">{l.feature}</span>
                <span className="text-[11.5px] text-gray-400">{l.model}</span>
                {l.actionExecuted && <Badge variant="purple">action: {l.actionName}</Badge>}
                {l.feedback === 'UP' && <ThumbsUp size={11} className="text-emerald-500" />}
                {l.feedback === 'DOWN' && <ThumbsDown size={11} className="text-red-500" />}
                <span className="ml-auto text-[11px] text-gray-400">{fmt.dateTime(l.createdAt)}</span>
              </div>
              <div className="flex items-center gap-3 mt-1 text-[11px] text-gray-400 dark:text-gray-500 flex-wrap">
                <span>{l.totalTokens.toLocaleString()} tokens</span>
                <span>${Number(l.costUsd).toFixed(5)}</span>
                <span>{l.latencyMs} ms</span>
                {l.user && <span>· {l.user.name}</span>}
                {!!l.redactedFields.length && (
                  <span className="text-amber-600 dark:text-amber-400">
                    · {l.redactedFields.length} field(s) withheld: {l.redactedFields.slice(0, 3).join(', ')}
                  </span>
                )}
              </div>
              {l.errorMessage && (
                <p className="text-[11.5px] text-red-600 dark:text-red-400 mt-1">{l.errorMessage}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function KnowledgePanel() {
  const { data, isLoading } = useKnowledgeStats();
  const reindex = useReindexKnowledge();
  const ask = useKnowledgeAsk();
  const feedback = useAiFeedback();
  const fmt = useFormat();
  const [question, setQuestion] = useState('');
  const [result, setResult] = useState<Awaited<ReturnType<typeof ask.mutateAsync>> | null>(null);
  const [error, setError] = useState('');

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-[12.5px] text-gray-500 dark:text-gray-400">
          Retrieval filters by your permissions <em>before</em> ranking, so a restricted user never learns a document
          exists.
        </p>
        <Button
          size="sm"
          variant="secondary"
          loading={reindex.isPending}
          onClick={() => reindex.mutate()}
        >
          <RefreshCw size={13} /> Re-index knowledge base
        </Button>
      </div>

      {reindex.data && (
        <div className="bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-100 dark:border-emerald-900 rounded-xl p-3">
          <p className="text-[12.5px] text-emerald-900 dark:text-emerald-200">
            {reindex.data.message} Vector backend: <strong>{reindex.data.vectorBackend}</strong>. Embedding cost: $
            {reindex.data.costUsd.toFixed(4)}.
          </p>
        </div>
      )}
      {reindex.isError && (
        <div className="bg-red-50 dark:bg-red-950/40 border border-red-100 dark:border-red-900 rounded-xl p-3">
          <p className="text-[12.5px] text-red-900 dark:text-red-200">
            {(reindex.error as any)?.response?.data?.error || 'Re-indexing failed.'}
          </p>
        </div>
      )}

      {isLoading ? (
        <Spinner />
      ) : data ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Stat label="Documents" value={data.documents} />
          <Stat label="Chunks" value={data.chunks} />
          <Stat label="Vector backend" value={data.vectorBackend} sub={data.vectorBackend === 'pgvector' ? 'ANN search' : 'in-process cosine'} />
          <Stat label="Last indexed" value={data.lastIndexedAt ? fmt.date(data.lastIndexedAt) : 'Never'} />
        </div>
      ) : null}

      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
        <div className="flex items-center gap-1.5 mb-2">
          <Search size={14} className="text-gray-400" />
          <p className="text-[13px] font-semibold text-gray-900 dark:text-white">Ask the knowledge base</p>
        </div>
        <div className="flex items-center gap-2">
          <input
            className={field}
            value={question}
            onChange={e => setQuestion(e.target.value)}
            placeholder="e.g. How many days of annual leave do employees get?"
            onKeyDown={e => {
              if (e.key === 'Enter' && question.trim()) {
                setError('');
                ask.mutate(question, {
                  onSuccess: setResult,
                  onError: (err: any) => setError(err?.response?.data?.error || 'Could not answer that.'),
                });
              }
            }}
          />
          <Button
            size="sm"
            loading={ask.isPending}
            disabled={!question.trim()}
            onClick={() => {
              setError('');
              ask.mutate(question, {
                onSuccess: setResult,
                onError: (err: any) => setError(err?.response?.data?.error || 'Could not answer that.'),
              });
            }}
          >
            Ask
          </Button>
        </div>

        {error && <p className="text-[12.5px] text-red-600 dark:text-red-400 mt-2">{error}</p>}

        {result && (
          <div className="mt-3 border-t border-gray-100 dark:border-gray-800 pt-3">
            <p className="text-[13px] text-gray-800 dark:text-gray-100 whitespace-pre-wrap">{result.answer}</p>

            {!!result.citations.length && (
              <div className="mt-3">
                <p className="text-[11.5px] font-semibold text-gray-500 dark:text-gray-400 mb-1">Sources</p>
                <div className="space-y-1">
                  {result.citations.map((c, i) => (
                    <p key={c.documentId + i} className="text-[11.5px] text-gray-500 dark:text-gray-400">
                      [{i + 1}] {c.title}
                      {c.heading ? ` → ${c.heading}` : ''} · relevance {(c.score * 100).toFixed(0)}%
                    </p>
                  ))}
                </div>
              </div>
            )}

            <div className="flex items-center gap-2 mt-3">
              <span className="text-[11.5px] text-gray-400">
                Confidence {(result.confidence * 100).toFixed(0)}%
                {result.confidence < 0.4 && ' — human review recommended'}
              </span>
              {result.logId && (
                <>
                  <Button
                    size="xs"
                    variant="secondary"
                    onClick={() => feedback.mutate({ logId: result.logId!, feedback: 'UP' })}
                  >
                    <ThumbsUp size={11} /> Helpful
                  </Button>
                  <Button
                    size="xs"
                    variant="secondary"
                    onClick={() => feedback.mutate({ logId: result.logId!, feedback: 'DOWN' })}
                  >
                    <ThumbsDown size={11} /> Not helpful
                  </Button>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const TABS = [
  { key: 'observability', label: 'Observability', icon: Brain },
  { key: 'knowledge', label: 'Knowledge base', icon: Database },
  { key: 'logs', label: 'Interaction log', icon: Search },
] as const;

export default function AIGovernancePage() {
  const [tab, setTab] = useState<(typeof TABS)[number]['key']>('observability');

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="AI Governance"
        subtitle="What AI cost, whether it worked, what it was allowed to see, and what it did about it."
      />

      <div className="flex-1 overflow-auto p-6">
        <div className="flex rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden w-fit mb-4">
          {TABS.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-[12.5px] font-medium ${
                tab === t.key
                  ? 'bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900'
                  : 'text-gray-600 dark:text-gray-300'
              }`}
            >
              <t.icon size={12} /> {t.label}
            </button>
          ))}
        </div>

        {tab === 'observability' && <ObservabilityPanel />}
        {tab === 'knowledge' && <KnowledgePanel />}
        {tab === 'logs' && <LogsPanel />}
      </div>
    </div>
  );
}
