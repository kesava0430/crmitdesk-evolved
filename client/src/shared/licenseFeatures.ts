/** Display names for licence feature keys (server utils/stripe.ts FEATURE_KEYS)
 *  and the hosted_storage module. One map for Billing, the licence builder,
 *  Platform Admin and the sidebar lock tooltips. */
export const FEATURE_LABELS: Record<string, string> = {
  ai_advanced: 'Advanced AI',
  workflow_automation: 'Workflow automation',
  customer_portal: 'Customer portal',
  advanced_analytics: 'Advanced analytics',
  custom_branding: 'Custom branding',
  sso: 'Single sign-on (Entra ID)',
  directory_sync: 'Directory sync',
  api_access: 'API access',
  custom_modules: 'Custom modules',
  hr_core: 'HR (people, leave, org chart)',
  payroll: 'Payroll',
  attendance: 'Attendance',
  campaigns: 'Campaigns',
  crm: 'CRM (contacts, leads, deals)',
  itdesk: 'IT Desk (tickets)',
  sales_docs: 'Quotes & invoices',
  assets: 'Assets',
  knowledge_base: 'Knowledge base',
  hosted_storage: 'Hosted storage',
};

/** Same order as the server's FEATURE_KEYS. */
export const FEATURE_KEYS = [
  'ai_advanced', 'workflow_automation', 'customer_portal', 'advanced_analytics', 'custom_branding',
  'sso', 'directory_sync', 'api_access', 'custom_modules', 'hr_core', 'payroll', 'attendance', 'campaigns',
  'crm', 'itdesk', 'sales_docs', 'assets', 'knowledge_base',
] as const;

export const featureLabel = (key: string) => FEATURE_LABELS[key] ?? key.replace(/_/g, ' ');
