// ORPHANED / DEAD FILE — not imported anywhere in the app.
//
// AppLayout only mounts `AISmartSearch` (see shared/components/AISmartSearch.tsx)
// in the top bar; this earlier command-palette-style search was superseded
// by it and never removed. Safe to delete. (Left in place only because this
// environment's filesystem mount didn't allow deleting/renaming files;
// please remove it directly on your machine.)
import { useState, useRef, useEffect } from 'react';
import { Search, Users, TrendingUp, Ticket, Target, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client';
import { useQuery } from '@tanstack/react-query';

export function GlobalSearch() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  const { data } = useQuery({
    queryKey: ['global-search', q],
    queryFn: () => api.get('/search', { params: { q } }).then(r => r.data),
    enabled: q.length >= 2,
    staleTime: 500,
  });

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen(true);
        setTimeout(() => inputRef.current?.focus(), 50);
      }
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  const hasResults = data && (data.contacts?.length || data.deals?.length || data.tickets?.length || data.leads?.length);

  function go(path: string) {
    navigate(path);
    setOpen(false);
    setQ('');
  }

  return (
    <>
      <button
        onClick={() => { setOpen(true); setTimeout(() => inputRef.current?.focus(), 50); }}
        className="flex items-center gap-2 w-full px-3 py-2 text-sm text-gray-400 dark:text-gray-500 border border-gray-200 dark:border-gray-700 rounded-lg hover:border-gray-300 dark:hover:border-gray-600 hover:bg-gray-50/60 dark:hover:bg-gray-800/60 transition-all bg-white dark:bg-gray-900"
      >
        <Search size={14} className="shrink-0" />
        <span className="flex-1 text-left text-gray-400 dark:text-gray-500">Search...</span>
        <kbd className="hidden sm:inline text-[10px] bg-gray-100 text-gray-400 px-1.5 py-0.5 rounded font-mono border border-gray-200 dark:bg-gray-800 dark:text-gray-500 dark:border-gray-700">⌘K</kbd>
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-24 px-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setOpen(false)} />
          <div className="relative bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-xl overflow-hidden">
            <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-100 dark:border-gray-800">
              <Search size={18} className="text-gray-400 dark:text-gray-500 flex-shrink-0" />
              <input
                ref={inputRef}
                value={q}
                onChange={e => setQ(e.target.value)}
                placeholder="Search contacts, deals, tickets..."
                className="flex-1 text-sm focus:outline-none text-gray-900 bg-transparent dark:text-gray-100 dark:placeholder-gray-500"
              />
              {q && <button onClick={() => setQ('')} className="text-gray-300 hover:text-gray-500 dark:text-gray-600 dark:hover:text-gray-400"><X size={16} /></button>}
            </div>

            {q.length < 2 && (
              <div className="px-4 py-8 text-center text-sm text-gray-400 dark:text-gray-500">
                Type at least 2 characters to search
              </div>
            )}

            {q.length >= 2 && !hasResults && (
              <div className="px-4 py-8 text-center text-sm text-gray-400 dark:text-gray-500">No results for "{q}"</div>
            )}

            {hasResults && (
              <div className="divide-y divide-gray-50 dark:divide-gray-800 max-h-96 overflow-y-auto">
                {data.contacts?.length > 0 && (
                  <div className="p-2">
                    <p className="px-2 py-1 text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">Contacts</p>
                    {data.contacts.map((c: any) => (
                      <button key={c.id} onClick={() => go('/crm/contacts')}
                        className="flex items-center gap-3 w-full px-3 py-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 text-left transition-colors">
                        <div className="w-7 h-7 rounded-full bg-violet-100 text-violet-600 dark:bg-violet-500/10 dark:text-violet-300 flex items-center justify-center text-xs font-bold flex-shrink-0">{c.name[0]}</div>
                        <div><p className="text-sm font-medium text-gray-900 dark:text-gray-100">{c.name}</p><p className="text-xs text-gray-400 dark:text-gray-500">{c.email} · {c.jobTitle}</p></div>
                        <Users size={14} className="text-gray-300 dark:text-gray-600 ml-auto" />
                      </button>
                    ))}
                  </div>
                )}
                {data.deals?.length > 0 && (
                  <div className="p-2">
                    <p className="px-2 py-1 text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">Deals</p>
                    {data.deals.map((d: any) => (
                      <button key={d.id} onClick={() => go('/crm/deals')}
                        className="flex items-center gap-3 w-full px-3 py-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 text-left transition-colors">
                        <div className="w-7 h-7 rounded-full bg-blue-100 text-blue-600 dark:bg-blue-500/10 dark:text-blue-300 flex items-center justify-center text-xs font-bold flex-shrink-0">D</div>
                        <div><p className="text-sm font-medium text-gray-900 dark:text-gray-100">{d.title}</p><p className="text-xs text-gray-400 dark:text-gray-500">{d.stage} · ${Number(d.value).toLocaleString()}</p></div>
                        <TrendingUp size={14} className="text-gray-300 dark:text-gray-600 ml-auto" />
                      </button>
                    ))}
                  </div>
                )}
                {data.tickets?.length > 0 && (
                  <div className="p-2">
                    <p className="px-2 py-1 text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">Tickets</p>
                    {data.tickets.map((t: any) => (
                      <button key={t.id} onClick={() => go('/itdesk/tickets')}
                        className="flex items-center gap-3 w-full px-3 py-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 text-left transition-colors">
                        <div className="w-7 h-7 rounded-full bg-orange-100 text-orange-600 dark:bg-orange-500/10 dark:text-orange-300 flex items-center justify-center text-xs font-bold flex-shrink-0">T</div>
                        <div><p className="text-sm font-medium text-gray-900 dark:text-gray-100">{t.title}</p><p className="text-xs text-gray-400 dark:text-gray-500">{t.status} · {t.priority}</p></div>
                        <Ticket size={14} className="text-gray-300 dark:text-gray-600 ml-auto" />
                      </button>
                    ))}
                  </div>
                )}
                {data.leads?.length > 0 && (
                  <div className="p-2">
                    <p className="px-2 py-1 text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">Leads</p>
                    {data.leads.map((l: any) => (
                      <button key={l.id} onClick={() => go('/crm/leads')}
                        className="flex items-center gap-3 w-full px-3 py-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 text-left transition-colors">
                        <div className="w-7 h-7 rounded-full bg-indigo-100 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300 flex items-center justify-center text-xs font-bold flex-shrink-0">L</div>
                        <div><p className="text-sm font-medium text-gray-900 dark:text-gray-100">{l.contact?.name}</p><p className="text-xs text-gray-400 dark:text-gray-500">{l.status} · {l.source}</p></div>
                        <Target size={14} className="text-gray-300 dark:text-gray-600 ml-auto" />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div className="px-4 py-2 border-t border-gray-50 dark:border-gray-800 flex items-center gap-3 text-xs text-gray-400 dark:text-gray-500">
              <span>↑↓ navigate</span><span>↵ select</span><span>Esc close</span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
