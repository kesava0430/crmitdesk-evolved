import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { Palette, Eye, CheckCircle } from 'lucide-react';

interface Branding {
  primaryColor: string;
  logoUrl: string;
  faviconUrl: string;
  companyName: string;
  supportEmail: string;
  portalWelcome: string;
}

const DEFAULT: Branding = {
  primaryColor: '#6366f1',
  logoUrl: '',
  faviconUrl: '',
  companyName: '',
  supportEmail: '',
  portalWelcome: 'Welcome to our support portal',
};

export default function BrandingPage() {
  const qc = useQueryClient();
  const [form, setForm] = useState<Branding>(DEFAULT);
  const [saved, setSaved] = useState(false);

  const { data } = useQuery({
    queryKey: ['branding'],
    queryFn: () => api.get('/branding').then(r => r.data).catch(() => null),
  });

  useEffect(() => {
    if (data) setForm({ ...DEFAULT, ...data });
  }, [data]);

  const save = useMutation({
    mutationFn: (body: Branding) => api.post('/branding', body).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['branding'] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Palette size={24} className="text-brand-600" />
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Org Branding</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">Customize your organization's appearance and portal</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        {/* Form */}
        <div className="lg:col-span-3 space-y-5">
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm p-5 space-y-4">
            <h2 className="font-semibold text-gray-800 dark:text-gray-100">Brand Identity</h2>

            <div>
              <label className="form-label">Company Name</label>
              <input className="ui-input"
                value={form.companyName} onChange={e => setForm(f => ({ ...f, companyName: e.target.value }))} />
            </div>

            <div>
              <label className="form-label">Primary Color</label>
              <div className="flex items-center gap-3">
                <input type="color" value={form.primaryColor}
                  onChange={e => setForm(f => ({ ...f, primaryColor: e.target.value }))}
                  className="w-12 h-10 rounded-lg border border-gray-200 dark:border-gray-700 cursor-pointer" />
                <input aria-label="Primary Color" className="ui-input flex-1 font-mono"
                  value={form.primaryColor}
                  onChange={e => setForm(f => ({ ...f, primaryColor: e.target.value }))} />
              </div>
            </div>

            <div>
              <label className="form-label">Logo URL</label>
              <input className="ui-input"
                aria-label="Logo URL" placeholder="https://…/logo.png"
                value={form.logoUrl} onChange={e => setForm(f => ({ ...f, logoUrl: e.target.value }))} />
            </div>

            <div>
              <label className="form-label">Favicon URL</label>
              <input className="ui-input"
                aria-label="Favicon URL" placeholder="https://…/favicon.ico"
                value={form.faviconUrl} onChange={e => setForm(f => ({ ...f, faviconUrl: e.target.value }))} />
            </div>
          </div>

          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm p-5 space-y-4">
            <h2 className="font-semibold text-gray-800 dark:text-gray-100">Customer Portal</h2>

            <div>
              <label className="form-label">Support Email</label>
              <input type="email" className="ui-input"
                placeholder="support@yourcompany.com"
                value={form.supportEmail} onChange={e => setForm(f => ({ ...f, supportEmail: e.target.value }))} />
            </div>

            <div>
              <label className="form-label">Portal Welcome Message</label>
              <textarea aria-label="Portal Welcome Message" className="ui-input"
                rows={3}
                value={form.portalWelcome}
                onChange={e => setForm(f => ({ ...f, portalWelcome: e.target.value }))} />
            </div>
          </div>

          <button
            onClick={() => save.mutate(form)}
            disabled={save.isPending}
            className="flex items-center gap-2 px-6 py-2.5 bg-brand-600 text-white rounded-lg hover:bg-brand-700 font-medium text-sm disabled:opacity-50"
          >
            {saved ? <><CheckCircle size={16} /> Saved!</> : save.isPending ? 'Saving…' : 'Save Branding'}
          </button>
        </div>

        {/* Live preview */}
        <div className="lg:col-span-2">
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden sticky top-6">
            <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-800 flex items-center gap-2">
              <Eye size={15} className="text-gray-400 dark:text-gray-500" />
              <span className="text-sm font-medium text-gray-600 dark:text-gray-300">Portal Preview</span>
            </div>
            <div className="p-4" style={{ '--preview-color': form.primaryColor } as React.CSSProperties}>
              {/* Simulated portal header */}
              <div className="rounded-lg overflow-hidden border border-gray-100">
                <div className="p-3 flex items-center gap-2" style={{ backgroundColor: form.primaryColor }}>
                  {form.logoUrl ? (
                    <img src={form.logoUrl} alt="Logo" className="h-6 object-contain" onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                  ) : (
                    <div className="w-6 h-6 bg-white/30 rounded" />
                  )}
                  <span className="text-white font-semibold text-sm">{form.companyName || 'Your Company'}</span>
                </div>
                <div className="p-4 bg-gray-50 text-center">
                  <p className="text-sm text-gray-600">{form.portalWelcome || 'Welcome to our support portal'}</p>
                  <button className="mt-3 px-4 py-1.5 text-white text-xs rounded-lg" style={{ backgroundColor: form.primaryColor }}>
                    Submit a Ticket
                  </button>
                </div>
              </div>
              {/* Color swatch */}
              <div className="mt-4 grid grid-cols-3 gap-2">
                {[form.primaryColor, form.primaryColor + 'cc', form.primaryColor + '44'].map((c, i) => (
                  <div key={i} className="h-8 rounded-lg" style={{ backgroundColor: c }} />
                ))}
              </div>
              <p className="text-xs text-gray-400 text-center mt-2">{form.primaryColor}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
