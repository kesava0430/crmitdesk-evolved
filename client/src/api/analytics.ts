import { useQuery } from '@tanstack/react-query';
import { api } from './client';

export interface OverviewData {
  tickets: { current: number; change: number };
  leads: { current: number; change: number };
  revenue: { current: number; change: number };
  avgResolutionHours: number | null;
}

export interface TicketAnalytics {
  volume: { labels: string[]; created: number[]; resolved: number[]; forecast: number[] };
  byStatus: { status: string; count: number }[];
  byPriority: { priority: string; count: number }[];
  byCategory: { category: string; count: number }[];
  avgResolutionHours: number | null;
  slaCompliance: number | null;
}

export interface CrmAnalytics {
  leads: {
    byStatus: { status: string; count: number }[];
    overTime: { labels: string[]; values: number[] };
    conversionRate: number;
  };
  deals: {
    pipeline: { stage: string; count: number; value: number }[];
    winRate: number | null;
    revenue: { labels: string[]; values: number[] };
  };
}

export function useAnalyticsOverview() {
  return useQuery<OverviewData>({ queryKey: ['analytics-overview'], queryFn: () => api.get('/analytics/overview').then(r => r.data) });
}

export function useTicketAnalytics(days = 30) {
  return useQuery<TicketAnalytics>({ queryKey: ['analytics-tickets', days], queryFn: () => api.get(`/analytics/tickets?days=${days}`).then(r => r.data) });
}

export function useCrmAnalytics(days = 30) {
  return useQuery<CrmAnalytics>({ queryKey: ['analytics-crm', days], queryFn: () => api.get(`/analytics/crm?days=${days}`).then(r => r.data) });
}
