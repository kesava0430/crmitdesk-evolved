import { useQuery } from '@tanstack/react-query';
import { api } from './client';

export interface PlatformOrgSummary {
  id: string;
  name: string;
  slug: string;
  plan: string;
  createdAt: string;
  subscription: {
    plan: string;
    status: string;
    seats: number;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    stripeCustomerId: string | null;
  } | null;
  branding: { companyName: string; logoUrl: string | null; primaryColor: string; supportEmail: string | null } | null;
  emailSending: { connected: boolean; email: string | null; smtpHost: string | null; lastSyncAt: string | null };
  whatsappSending: { connected: boolean; phoneNumber: string | null; notifyNumber: string | null };
  counts: { users: number; contacts: number; tickets: number };
}

export interface PlatformOrgDetail extends Omit<PlatformOrgSummary, 'emailSending' | 'whatsappSending' | 'counts'> {
  emailAccount: { email: string; imapHost: string; smtpHost: string; smtpPort: number; lastSyncAt: string | null } | null;
  whatsAppConfig: { phoneNumber: string; notifyNumber: string | null; createdAt: string } | null;
  users: { id: string; name: string; email: string; role: string; isActive: boolean; createdAt: string }[];
  _count: { contacts: number; tickets: number; deals: number };
}

/** Platform-admin only: every org's plan/license/branding/sending-connection status (GET /platform/orgs). */
export const usePlatformOrgs = (enabled = true) =>
  useQuery({
    queryKey: ['platform-orgs'],
    queryFn: () => api.get('/platform/orgs').then(r => r.data as PlatformOrgSummary[]),
    enabled,
  });

/** Platform-admin only: single org detail incl. staff list (GET /platform/orgs/:id). */
export const usePlatformOrg = (id: string | null, enabled = true) =>
  useQuery({
    queryKey: ['platform-orgs', id],
    queryFn: () => api.get(`/platform/orgs/${id}`).then(r => r.data as PlatformOrgDetail),
    enabled: enabled && !!id,
  });
