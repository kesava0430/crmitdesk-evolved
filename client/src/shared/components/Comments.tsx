import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import { Send, Trash2, LayoutTemplate } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { useReplyTemplates } from '../../api/templates';
import { SearchableSelect } from './SearchableSelect';

interface CommentsProps {
  entityType: 'DEAL' | 'TICKET' | 'CONTACT';
  entityId: string;
}

export function Comments({ entityType, entityId }: CommentsProps) {
  const [body, setBody] = useState('');
  const { user } = useAuth();
  const qc = useQueryClient();
  const key = ['comments', entityType, entityId];
  // Canned-response picker only makes sense on tickets (support replies).
  const { data: replyTemplates } = useReplyTemplates();
  const showReplyTemplates = entityType === 'TICKET' && (replyTemplates?.length ?? 0) > 0;

  const { data: comments = [] } = useQuery({
    queryKey: key,
    queryFn: () => api.get(`/comments/${entityType}/${entityId}`).then(r => r.data),
    enabled: !!entityId,
  });

  const create = useMutation({
    mutationFn: () => api.post(`/comments/${entityType}/${entityId}`, { body }).then(r => r.data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: key }); setBody(''); },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/comments/${id}`).then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });

  return (
    <div className="border-t dark:border-gray-800 pt-4 mt-4">
      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">Comments ({comments.length})</h3>

      <div className="space-y-3 mb-4 max-h-64 overflow-y-auto">
        {comments.length === 0 && (
          <p className="text-xs text-gray-400 dark:text-gray-500 text-center py-4">Nothing yet. Be the first to add a note.</p>
        )}
        {comments.map((c: any) => (
          <div key={c.id} className="flex gap-2 group">
            <div className="w-7 h-7 rounded-full bg-brand-100 dark:bg-brand-500/10 text-brand-600 dark:text-brand-400 flex items-center justify-center text-xs font-bold flex-shrink-0 mt-0.5">
              {c.author?.name?.[0]?.toUpperCase()}
            </div>
            <div className="flex-1 bg-gray-50 dark:bg-gray-800 rounded-xl px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-gray-700 dark:text-gray-300">{c.author?.name}</span>
                <div className="flex items-center gap-1">
                  <span className="text-xs text-gray-400 dark:text-gray-500">{formatDistanceToNow(new Date(c.createdAt), { addSuffix: true })}</span>
                  {c.author?.id === user?.id && (
                    <button onClick={() => remove.mutate(c.id)} className="opacity-0 group-hover:opacity-100 p-0.5 text-gray-300 dark:text-gray-600 hover:text-red-500 dark:hover:text-red-400 transition-all">
                      <Trash2 size={11} />
                    </button>
                  )}
                </div>
              </div>
              <p className="text-sm text-gray-600 dark:text-gray-400 mt-0.5 whitespace-pre-wrap">{c.body}</p>
            </div>
          </div>
        ))}
      </div>

      {showReplyTemplates && (
        <div className="mb-2 ml-9 flex items-center gap-2">
          <LayoutTemplate size={13} className="text-gray-400 dark:text-gray-500 flex-shrink-0" />
          <div className="flex-1 max-w-xs">
            <SearchableSelect
              ariaLabel="Canned response"
              value=""
              onChange={val => {
                const template = replyTemplates?.find(t => t.id === val);
                if (template) setBody(prev => (prev.trim() ? `${prev}\n\n${template.body}` : template.body));
              }}
              options={(replyTemplates ?? []).map(t => ({ value: t.id, label: t.name }))}
              placeholder="Insert canned response…"
            />
          </div>
        </div>
      )}
      <div className="flex gap-2">
        <div className="w-7 h-7 rounded-full bg-brand-100 dark:bg-brand-500/10 text-brand-600 dark:text-brand-400 flex items-center justify-center text-xs font-bold flex-shrink-0 mt-1">
          {user?.name?.[0]?.toUpperCase()}
        </div>
        <div className="flex-1 flex gap-2">
          <textarea
            value={body}
            onChange={e => setBody(e.target.value)}
            placeholder="Add a comment..."
            rows={2}
            onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && body.trim()) create.mutate(); }}
            className="flex-1 border border-gray-200 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 dark:placeholder-gray-500 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 resize-none"
          />
          <button
            onClick={() => body.trim() && create.mutate()}
            disabled={!body.trim() || create.isPending}
            className="self-end p-2 bg-brand-600 hover:bg-brand-700 text-white rounded-xl disabled:opacity-40 transition-colors"
          >
            <Send size={15} />
          </button>
        </div>
      </div>
      <p className="text-xs text-gray-400 dark:text-gray-500 mt-1 ml-9">Ctrl+Enter to send</p>
    </div>
  );
}
