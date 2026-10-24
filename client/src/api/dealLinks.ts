import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

/** Related deals (server/src/utils/dealLinks) — rule, panel, hints, AI lessons. */

export type LinkFieldKind = 'custom' | 'account' | 'contact' | 'pipeline';
export interface LinkRuleField { kind: LinkFieldKind; fieldId?: string; label?: string }
export interface LinkRule { fields: LinkRuleField[]; mode: 'ALL' | 'ANY' }

export interface LinkRuleResponse {
  rule: LinkRule | null;
  canEdit: boolean;
  options: {
    customFields: Array<{ id: string; label: string; fieldType: string }>;
    builtins: Array<{ kind: LinkFieldKind; label: string }>;
  };
}

export interface RelatedDeal {
  id: string;
  title: string;
  status: 'OPEN' | 'WON' | 'LOST';
  stage: string;
  value: number | null;
  createdAt: string;
  closeDate: string | null;
  owner: { id: string; name: string } | null;
  latestNote: { text: string; date: string; kind: string } | null;
}

export interface RelatedDealsResponse {
  configured: boolean;
  canEdit: boolean;
  rule?: LinkRule;
  sharedOn?: string[];
  missing?: string[];
  deals?: RelatedDeal[];
  counts?: { lost: number; won: number; open: number; total: number };
  hasMore?: boolean;
}

export interface CitedDeal { id: string; title: string; status: string }
export interface CheckedReason {
  reason: string;
  quote: string;
  source: { dealId: string; dealTitle: string; noteDate: string; noteKind: string };
  deals: CitedDeal[];
}
export interface LessonsResponse {
  status: 'ok' | 'no_history' | 'not_configured' | 'not_usable';
  cached?: boolean;
  generatedAt?: string;
  missing?: string[];
  basedOn?: { lost: number; won: number; notes: number };
  result?: {
    lossReasons: CheckedReason[];
    whatWorked: CheckedReason[];
    checklist: Array<{ item: string; deals: CitedDeal[] }>;
    unexplained: CitedDeal[];
    confidence: 'low' | 'medium' | 'high';
    caveats: string[];
    droppedUnsupported: number;
  };
}

export const useDealLinkRule = (enabled = true) =>
  useQuery<LinkRuleResponse>({
    queryKey: ['deal-link-rule'],
    queryFn: () => api.get('/crm/deals/link-rule').then(r => r.data),
    enabled,
  });

export const useSaveDealLinkRule = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (rule: LinkRule) => api.put('/crm/deals/link-rule', {
      mode: rule.mode,
      fields: rule.fields.map(f => (f.kind === 'custom' ? { kind: 'custom', fieldId: f.fieldId } : { kind: f.kind })),
    }).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['deal-link-rule'] });
      qc.invalidateQueries({ queryKey: ['deal-related'] });
      qc.invalidateQueries({ queryKey: ['deal-related-counts'] });
    },
  });
};

export const useRelatedDeals = (dealId: string, limit: number) =>
  useQuery<RelatedDealsResponse>({
    queryKey: ['deal-related', dealId, limit],
    queryFn: () => api.get(`/crm/deals/${dealId}/related`, { params: { limit } }).then(r => r.data),
    enabled: !!dealId,
    placeholderData: prev => prev,
  });

export const useDealLessons = () =>
  useMutation({
    mutationFn: ({ dealId, refresh }: { dealId: string; refresh?: boolean }) =>
      api.post(`/ai/deal/${dealId}/past-lessons`, { refresh: !!refresh }).then(r => r.data as LessonsResponse),
  });

export interface PreviewInput {
  excludeId?: string;
  accountId?: string | null;
  contactId?: string | null;
  custom?: Record<string, string | null>;
}

/** Create/edit form hint. `key` should already be debounced by the caller. */
export const useRelatedPreview = (input: PreviewInput | null) =>
  useQuery<{ configured: boolean; counts?: { lost: number; won: number; open: number }; sharedOn?: string[] }>({
    queryKey: ['deal-related-preview', input],
    queryFn: () => api.post('/crm/deals/related-preview', input).then(r => r.data),
    enabled: !!input,
    staleTime: 30_000,
  });

/** Board cards: { dealId: { lost, won, open } } for related deals. */
export const useRelatedCounts = (ids: string[], enabled = true) =>
  useQuery<{ configured: boolean; counts: Record<string, { lost: number; won: number; open: number }> }>({
    queryKey: ['deal-related-counts', ids],
    queryFn: () => api.get('/crm/deals/related-counts', { params: { ids: ids.join(',') } }).then(r => r.data),
    enabled: enabled && ids.length > 0,
    staleTime: 60_000,
  });
