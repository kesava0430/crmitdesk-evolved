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
  // "License" for attachments: which storage the org uses and, for our
  // hosted S3 option, quota vs usage — same numbers utils/licensing.ts
  // enforces server-side on every upload.
  storageLicense: { provider: 'GOOGLE_DRIVE' | 'HOSTED_S3' | null; connectedEmail: string | null; quotaBytes: number; usedBytes: number };
  counts: { users: number; contacts: number; tickets: number };
}

export interface PlatformOrgDetail extends Omit<PlatformOrgSummary, 'emailSending' | 'whatsappSending' | 'storageLicense' | 'counts'> {
  emailAccount: { email: string; imapHost: string; smtpHost: string; smtpPort: number; lastSyncAt: string | null } | null;
  whatsAppConfig: { phoneNumber: string; notifyNumber: string | null; createdAt: string } | null;
  storageConfig: { provider: 'GOOGLE_DRIVE' | 'HOSTED_S3'; connectedEmail: string | null; rootFolderId: string | null; updatedAt: string } | null;
  storageLicense: { quotaBytes: number; usedBytes: number };
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
