import { useQuery, useMutation } from '@tanstack/react-query';
import { api } from './client';

export interface Subscription {
  id: string;
  orgId: string;
  plan: 'FREE' | 'PRO' | 'ENTERPRISE';
  status: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  seats: number;
  seatsUsed: number;
  createdAt: string;
  planConfig: { name: string; seats: number; price: number; priceId: string | null };
}

export function useSubscription() {
  return useQuery<Subscription>({
    queryKey: ['subscription'],
    queryFn: () => api.get('/billing/subscription').then(r => r.data),
  });
}

export function useCreateCheckout() {
  return useMutation({
    mutationFn: (plan: 'PRO' | 'ENTERPRISE') => api.post('/billing/checkout', { plan }).then(r => r.data),
    onSuccess: (data: { url: string }) => { window.location.href = data.url; },
  });
}

export function useCreatePortal() {
  return useMutation({
    mutationFn: () => api.post('/billing/portal').then(r => r.data),
    onSuccess: (data: { url: string }) => { window.location.href = data.url; },
  });
}
