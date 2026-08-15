import { useState, useCallback, useRef } from 'react';
import { Search, Sparkles, X, Loader2, User, Ticket, TrendingUp, Handshake, BookOpen, Monitor, Receipt } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client';
import { useDebounce } from '../../hooks/useDebounce';
import { useFormat } from '../../hooks/useFormat';

interface SearchResult {
  id: string;
  type: 'contact' | 'ticket' | 'lead' | 'deal' | 'article' | 'asset' | 'invoice';
  title: string;
  subtitle?: string;
  url: string;
}

const ICONS: Record<string, any> = {
  contact: User,
  ticket: Ticket,
  lead: TrendingUp,
  deal: Handshake,
  article: BookOpen,
  asset: Monitor,
  invoice: Receipt,
};

const TYPE_COLORS: Record<string, string> = {
  contact: 'text-blue-500 bg-blue-50 dark:bg-blue-500/10',
  ticket: 'text-orange-500 bg-orange-50 dark:bg-orange-500/10',
  lead: 'text-purple-500 bg-purple-50 dark:bg-purple-500/10',
  deal: 'text-green-500 bg-green-50 dark:bg-green-500/10',
  article: 'text-teal-500 bg-teal-50 dark:bg-teal-500/10',
  asset: 'text-slate-500 bg-slate-50 dark:bg-slate-500/10',
  invoice: 'text-pink-500 bg-pink-50 dark:bg-pink-500/10',
};

function useSearch(query: string) {
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  // Whether the last response actually came back through the AI query
  // interpreter (server/src/utils/ai.ts's interpretSearchQuery) or fell back
  // to plain substring matching — search.controller.ts reports this
  // honestly rather than the "Smart search" label always claiming AI
  // regardless of whether a GROQ/OPENAI key is even configured.
  const [aiPowered, setAiPowered] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const { money } = useFormat();

  const search = useCallback(async (q: string) => {
    if (!q.trim() || q.length < 2) { setResults([]); return; }
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    setLoading(true);
    try {
      // Use the shared, pre-configured `api` client (correct baseURL, and the
      // 'accessToken' key AuthContext actually stores — this previously read
      // a nonexistent 'crm_token' key via a standalone axios call, so every
      // request went out unauthenticated, silently 401'd, and the dropdown
      // never had results to show.
      const { data } = await api.get(
        `/search?q=${encodeURIComponent(q)}&limit=8`,
        { signal: abortRef.current.signal }
      );
      // Normalize to SearchResult array
      const mapped: SearchResult[] = [
        ...(data.contacts ?? []).map((c: any) => ({ id: c.id, type: 'contact', title: c.name, subtitle: c.email, url: `/crm/contacts/${c.id}` })),
        ...(data.tickets ?? []).map((t: any) => ({ id: t.id, type: 'ticket', title: t.title, subtitle: t.status, url: `/itdesk/tickets/${t.id}` })),
        ...(data.leads ?? []).map((l: any) => ({ id: l.id, type: 'lead', title: l.contact?.name ?? l.id, subtitle: l.status, url: `/crm/leads` })),
        ...(data.deals ?? []).map((d: any) => ({ id: d.id, type: 'deal', title: d.title, subtitle: money(Number(d.value ?? 0)), url: `/crm/deals` })),
        ...(data.articles ?? []).map((a: any) => ({ id: a.id, type: 'article', title: a.title, subtitle: 'Knowledge base', url: `/itdesk/articles` })),
        ...(data.assets ?? []).map((a: any) => ({ id: a.id, type: 'asset', title: a.name, subtitle: a.serialNumber ?? a.type, url: `/itdesk/assets` })),
        ...(data.invoices ?? []).map((i: any) => ({ id: i.id, type: 'invoice', title: `${i.invoiceNumber} — ${i.title}`, subtitle: i.status, url: `/invoices` })),
      ].slice(0, 8);
      setResults(mapped);
      setAiPowered(!!data.aiPowered);
    } catch (e: any) {
      if (e?.code !== 'ERR_CANCELED') setResults([]);
    } finally {
      setLoading(false);
    }
  }, [money]);

  const debouncedQuery = useDebounce(query, 300);
  useState(() => { search(debouncedQuery); });

  return { results, loading, aiPowered, search };
}

interface AISmartSearchProps {
  placeholder?: string;
  className?: string;
}

export function AISmartSearch({ placeholder = 'Find contacts, tickets, deals…', className = '' }: AISmartSearchProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { results, loading, aiPowered, search } = useSearch(query);

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = e.target.value;
    setQuery(v);
    setOpen(true);
    search(v);
  }

  function handleSelect(r: SearchResult) {
    setQuery('');
    setOpen(false);
    navigate(r.url);
  }

  return (
    <div className={`relative ${className}`}>
      <div className="relative">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        {loading && <Loader2 size={14} className="absolute right-8 top-1/2 -translate-y-1/2 text-indigo-400 animate-spin" />}
        {query && (
          <button onClick={() => { setQuery(''); setOpen(false); }} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
            <X size={14} />
          </button>
        )}
        <input
          value={query}
          onChange={handleChange}
          onFocus={() => query && setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 200)}
          placeholder={placeholder}
          className="w-full pl-9 pr-8 py-2 text-sm bg-gray-100 dark:bg-gray-800 rounded-xl border border-transparent focus:border-indigo-300 focus:bg-white dark:focus:bg-gray-900 focus:outline-none transition-all"
        />
      </div>

      {open && results.length > 0 && (
        <div className="absolute top-full mt-1 w-full min-w-[320px] bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 shadow-xl z-50 animate-scale-in overflow-hidden">
          <div className="px-3 py-2 border-b border-gray-100 dark:border-gray-800 flex items-center gap-1.5">
            {aiPowered
              ? <Sparkles size={11} className="text-indigo-400" />
              : <Search size={11} className="text-gray-400" />}
            {/* Honest label: only claims "AI search" when the request actually
                went through interpretSearchQuery() server-side (a GROQ/OPENAI
                key is configured) — otherwise says what it is, a keyword match. */}
            <span className="text-xs text-gray-400">{aiPowered ? 'AI search results' : 'Search results'}</span>
          </div>
          <ul className="py-1 max-h-72 overflow-y-auto">
            {results.map(r => {
              const Icon = ICONS[r.type];
              const colorClass = TYPE_COLORS[r.type];
              return (
                <li key={`${r.type}-${r.id}`}>
                  <button
                    onMouseDown={() => handleSelect(r)}
                    className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                  >
                    <span className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 ${colorClass}`}>
                      <Icon size={13} />
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{r.title}</p>
                      {r.subtitle && <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{r.subtitle}</p>}
                    </div>
                    <span className="text-xs text-gray-400 dark:text-gray-500 capitalize flex-shrink-0">{r.type}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
