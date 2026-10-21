import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import { saveOrShareBlob } from '../native/download';
import { isNative } from '../native/platform';
import { addToast } from '../shared/components/toastStore';

export type LayoutKey = 'STANDARD' | 'MODERN' | 'MINIMAL' | 'DETAILED' | 'COMPACT' | 'CORPORATE' | 'BRANCH' | 'STATEMENT' | 'CUSTOM_HTML';
export type WatermarkSource = 'LOGO' | 'IMAGE';
/** Mirrors server/src/utils/payslipWatermark.ts — the server clamps to the same ranges. */
export const WATERMARK_LIMITS = { opacity: { min: 0.03, max: 0.3 }, size: { min: 20, max: 90 }, rotation: { min: -45, max: 45 } } as const;
export interface LayoutInfo { key: LayoutKey; name: string; description: string; defaults: Record<string, boolean> }
export interface FieldInfo { key: string; label: string; group: 'Employee' | 'Blocks'; default: boolean }
export interface Applicability { departmentIds?: string[]; locationIds?: string[]; employmentTypes?: string[] }
export interface PayslipTemplate {
  id: string; name: string; layout: LayoutKey; isDefault: boolean; isActive: boolean;
  companyName: string | null; companyAddress: string | null; logoUrl: string | null;
  primaryColor: string; accentColor: string | null; headerTitle: string; headerNote: string | null; footerNote: string | null;
  showSignature: boolean; signatureLabel: string; signatoryName: string | null; signatureUrl: string | null;
  showFields: Record<string, boolean> | null; applicability: Applicability | null;
  /** Faded mark behind the payslip content (HTML + PDF). LOGO reuses logoUrl. */
  watermarkEnabled: boolean; watermarkSource: WatermarkSource; watermarkImageUrl: string | null;
  watermarkOpacity: number; watermarkSize: number; watermarkRotation: number; watermarkRepeat: boolean;
  /** CUSTOM_HTML only: HTML with {{placeholders}} and optional CSS (server/src/utils/payslipHtmlTemplate.ts) */
  htmlBody?: string | null; htmlCss?: string | null;
  payslipCount?: number; createdAt: string; updatedAt: string;
}
export type PlaceholderType = 'text' | 'money' | 'image' | 'flag' | 'list' | 'object';
export interface PlaceholderInfo { path: string; label: string; group: string; type: PlaceholderType; list?: string }
export interface TemplateIssue { message: string; line: number }
export interface CustomHtmlInfo {
  layout: LayoutInfo; placeholders: PlaceholderInfo[]; starter: { html: string; css: string }; maxBytes: number;
  /** Whether this server can print custom HTML templates to PDF (headless Chromium) */
  pdf: { available: boolean; detail: string };
}
export type TemplateInput = Omit<PayslipTemplate, 'id' | 'payslipCount' | 'createdAt' | 'updatedAt'>;

export const usePayslipTemplates = () => useQuery<{ templates: PayslipTemplate[]; layouts: LayoutInfo[]; fields: FieldInfo[]; customHtml?: CustomHtmlInfo }>({
  queryKey: ['payslip-templates'], queryFn: () => api.get('/hr/payroll/templates').then(r => r.data),
});

const inv = (qc: ReturnType<typeof useQueryClient>) => { qc.invalidateQueries({ queryKey: ['payslip-templates'] }); qc.invalidateQueries({ queryKey: ['payslip-template'] }); };
export function useSaveTemplate() { const qc = useQueryClient(); return useMutation({ mutationFn: ({ id, ...d }: Partial<TemplateInput> & { id?: string }) => (id ? api.put(`/hr/payroll/templates/${id}`, d) : api.post('/hr/payroll/templates', d)).then(r => r.data), onSuccess: () => inv(qc) }); }
export function useDeleteTemplate() { const qc = useQueryClient(); return useMutation({ mutationFn: (id: string) => api.delete(`/hr/payroll/templates/${id}`).then(r => r.data), onSuccess: () => inv(qc) }); }
export function useDuplicateTemplate() { const qc = useQueryClient(); return useMutation({ mutationFn: (id: string) => api.post(`/hr/payroll/templates/${id}/duplicate`).then(r => r.data), onSuccess: () => inv(qc) }); }

export interface TemplatePreview {
  html: string;
  /** true = a complete custom-HTML document: show it ONLY in a sandboxed iframe (srcdoc), never inject it */
  isolated?: boolean;
  issues?: TemplateIssue[]; unknown?: string[]; removed?: string[];
}
/** Preview HTML of an unsaved template (debounced by the caller via the query key). */
export const useTemplatePreview = (draft: Partial<TemplateInput> | null, payslipId?: string) => useQuery<TemplatePreview>({
  queryKey: ['payslip-template-preview', draft, payslipId ?? ''],
  queryFn: () => api.post('/hr/payroll/templates/preview', draft, { params: { payslipId } }).then(r => r.data),
  enabled: !!draft, placeholderData: prev => prev, staleTime: 60_000,
});

export const usePayslipHtml = (id?: string, templateId?: string) => useQuery<{ html: string; isolated?: boolean; template: { layout: LayoutKey } }>({
  queryKey: ['payslip-html', id, templateId ?? ''],
  // sandbox=1: this client shows custom-HTML payslips in a sandboxed iframe (PayslipPrintPage); without it the server sends an "update the app" notice instead.
  queryFn: () => api.get(`/hr/payroll/payslips/${id}/html`, { params: { embed: '1', sandbox: '1', templateId } }).then(r => r.data),
  enabled: !!id,
});

/** Fetch a PDF through the authenticated client and hand it to the user (share sheet in the app — see native/download.ts). */
export async function downloadPdf(path: string, filename: string, open = false) {
  let res;
  try { res = await api.get(path, { responseType: 'blob', timeout: 120_000, _silent: true } as any); }
  catch (e) {
    // The error body of a blob request is a Blob, so the global handler can only say "server error";
    // read the real reason (e.g. "the PDF engine isn't installed") and show that instead.
    addToast(await apiErrorMessage(e, 'Could not download the PDF'), 'error');
    throw e;
  }
  await saveOrShareBlob(new Blob([res.data], { type: 'application/pdf' }), filename, { open });
}

/** Sample PDF of an unsaved (draft) template — POSTs the editor's current values. */
export async function downloadDraftPdf(draft: Partial<TemplateInput>, filename: string) {
  // _silent: the editor shows the reason inline.
  const res = await api.post('/hr/payroll/templates/preview', draft, { params: { format: 'pdf' }, responseType: 'blob', timeout: 120_000, _silent: true } as any);
  // A real download on the web (window.open after an await is popup-blocked); the share sheet in the app.
  await saveOrShareBlob(new Blob([res.data], { type: 'application/pdf' }), filename);
}

/** Axios error → message. A failed blob request carries its JSON error body as a Blob. */
export async function apiErrorMessage(e: any, fallback: string): Promise<string> {
  const data = e?.response?.data;
  if (data instanceof Blob) { try { return JSON.parse(await data.text())?.error || fallback; } catch { return fallback; } }
  return data?.error || e?.message || fallback;
}

/**
 * "Print view" for a payslip. On the web it opens the print page in a new
 * tab — under the app's base path (a bare '/hr/...' 404'd on
 * app.zenkara.in/zenkara). The app has no tabs and window.print() does
 * nothing in a WebView, so there it opens the same server-rendered PDF.
 */
export function openPayslipPrintView(id: string, payslipNumber?: string) {
  if (isNative) return downloadPdf(`/hr/payroll/payslips/${id}/pdf`, `${payslipNumber || `payslip-${id}`}.pdf`, true);
  window.open(`${import.meta.env.BASE_URL}hr/payroll/payslips/${id}/print`, '_blank');
}
export function useEmailPayslip() { const qc = useQueryClient(); return useMutation({ mutationFn: (id: string) => api.post(`/hr/payroll/payslips/${id}/email`).then(r => r.data), onSuccess: () => { qc.invalidateQueries({ queryKey: ['payroll-run'] }); qc.invalidateQueries({ queryKey: ['payslips'] }); } }); }
export function useEmailRun() { const qc = useQueryClient(); return useMutation({ mutationFn: ({ id, onlyUnsent = true }: { id: string; onlyUnsent?: boolean }) => api.post(`/hr/payroll/runs/${id}/email`, { onlyUnsent }).then(r => r.data as { sent: number; skipped: number; failed: { id: string; reason?: string }[] }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['payroll-run'] }); qc.invalidateQueries({ queryKey: ['payroll-run-history'] }); } }); }
