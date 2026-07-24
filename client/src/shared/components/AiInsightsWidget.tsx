import { Sparkles, AlertTriangle, CheckCircle, Info, RefreshCw } from 'lucide-react';
import { useAiInsights } from '../../api/ai';

type InsightType = 'warning' | 'success' | 'info' | string;

function insightIcon(type: InsightType) {
  if (type === 'warning') return <AlertTriangle size={15} className="text-amber-500 flex-shrink-0" />;
  if (type === 'success') return <CheckCircle size={15} className="text-green-500 flex-shrink-0" />;
  return <Info size={15} className="text-blue-500 flex-shrink-0" />;
}

function insightBg(type: InsightType) {
  if (type === 'warning') return 'bg-amber-50 border-amber-100';
  if (type === 'success') return 'bg-green-50 border-green-100';
  return 'bg-blue-50 border-blue-100';
}

function SkeletonCard() {
  return (
    <div className="border border-gray-100 rounded-xl p-4 animate-pulse">
      <div className="flex items-start gap-3">
        <div className="w-4 h-4 rounded-full bg-gray-200 flex-shrink-0 mt-0.5" />
        <div className="flex-1 space-y-2">
          <div className="h-3 bg-gray-200 rounded w-2/3" />
          <div className="h-2 bg-gray-100 rounded w-full" />
          <div className="h-2 bg-gray-100 rounded w-3/4" />
        </div>
      </div>
    </div>
  );
}

export function AiInsightsWidget() {
  const insights = useAiInsights();

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-50 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles size={15} className="text-violet-500" />
          <span className="text-sm font-semibold text-gray-800">AI Insights</span>
          <span className="ml-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-violet-100 text-violet-600">Live</span>
        </div>
        <button
          onClick={() => insights.mutate()}
          disabled={insights.isPending}
          className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-700 disabled:opacity-40 transition-colors"
        >
          <RefreshCw size={12} className={insights.isPending ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      <div className="p-5 space-y-3">
        {insights.isPending && (
          <>
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </>
        )}

        {insights.isError && (
          <div className="text-center py-6 text-sm text-gray-400">
            Failed to load insights.{' '}
            <button onClick={() => insights.mutate()} className="text-violet-500 hover:underline">Retry</button>
          </div>
        )}

        {insights.data && insights.data.insights.length === 0 && (
          <div className="text-center py-6">
            <CheckCircle size={24} className="text-green-400 mx-auto mb-2" />
            <p className="text-sm font-medium text-gray-600">All clear — no critical insights</p>
            <p className="text-xs text-gray-400 mt-1">Your CRM and IT Desk look healthy right now.</p>
          </div>
        )}

        {insights.data?.insights.map((insight: { type: string; title: string; description: string; action?: string }, i: number) => (
          <div key={i} className={`border rounded-xl p-4 ${insightBg(insight.type)}`}>
            <div className="flex items-start gap-3">
              {insightIcon(insight.type)}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-gray-800 mb-0.5">{insight.title}</p>
                <p className="text-xs text-gray-600 leading-relaxed">{insight.description}</p>
                {insight.action && (
                  <p className="text-xs font-medium mt-2 text-violet-600">{insight.action}</p>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
