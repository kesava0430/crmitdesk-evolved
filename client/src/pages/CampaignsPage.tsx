import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { Mail, Plus, Send, Pencil, Trash2, X, CheckCircle, Clock, LayoutTemplate } from 'lucide-react';
import { SearchableSelect , RowActions } from '../shared/components';
import { Attachments } from '../shared/components/Attachments';
import { useEmailTemplates } from '../api/templates';

interface Campaign {
  id: string;
  name: string;
  subject: string;
  body: string;
  targetType: 'LEADS' | 'CONTACTS';
  status: 'DRAFT' | 'SENDING' | 'SENT';
  sentAt?: string | null;
  sentCount: number;
  createdAt: string;
}

const STATUS_COLOR: Record<string, string> = {
  DRAFT:   'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300',
  SENDING: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-500/10 dark:text-yellow-400',
  SENT:    'bg-green-100 text-green-700 dark:bg-green-500/10 dark:text-green-400',
};

// ─── Campaign Modal ───────────────────────────────────────────────────────────

function CampaignModal({ campaign, onClose }: { campaign?: Campaign; onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    name: campaign?.name ?? '',
    subject: campaign?.subject ?? '',
    body: campaign?.body ?? '',
    targetType: campaign?.targetType ?? 'LEADS',
  });
  const { data: emailTemplates } = useEmailTemplates();

  const save = useMutation({
    mutationFn: (data: any) =>
      campaign ? api.patch(`/campaigns/${campaign.id}`, data) : api.post('/campaigns', data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['campaigns'] }); onClose(); },
  });

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div role="dialog" aria-modal="true" className="bg-white dark:bg-gray-900 rounded-2xl w-full max-w-2xl shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 sticky top-0 bg-white dark:bg-gray-900 dark:border-gray-800">
          <h2 className="font-semibold text-gray-900 dark:text-white">{campaign ? 'Edit Campaign' : 'New Campaign'}</h2>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800"><X size={16} /></button>
        </div>
        <form onSubmit={e => { e.preventDefault(); save.mutate(form); }} className="p-6 space-y-3">
          {!campaign && emailTemplates && emailTemplates.length > 0 && (
            <div className="form-section">
              <p className="form-section-title flex items-center gap-1.5"><LayoutTemplate size={13} /> Start from a template</p>
              <SearchableSelect
                ariaLabel="Template"
                value=""
                onChange={val => {
                  const t = emailTemplates.find(t => t.id === val);
                  if (t) setForm(p => ({ ...p, subject: t.subject, body: t.body }));
                }}
                options={emailTemplates.map(t => ({ value: t.id, label: t.name }))}
                placeholder="— none, start blank —"
              />
            </div>
          )}
          <div className="form-section">
            <p className="form-section-title">Campaign Details</p>
            <div className="space-y-4">
              <div>
                <label className="form-label">Campaign Name <span className="req">*</span></label>
                <input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} required
                  className="ui-input" aria-label="Name" placeholder="e.g. Q1 Lead Nurture" />
              </div>
              <div>
                <label className="form-label">Target Audience</label>
<SearchableSelect ariaLabel="Target Audience" value={form.targetType} onChange={val => setForm(p => ({ ...p, targetType: val as any }))} required options={[{value:'LEADS',label:'Leads (unconverted)'},{value:'CONTACTS',label:'All Contacts'}]} />
              </div>
            </div>
          </div>
          <div className="form-section">
            <p className="form-section-title">Email Content</p>
            <div className="space-y-4">
              <div>
                <label className="form-label">Subject Line <span className="req">*</span></label>
                <input value={form.subject} onChange={e => setForm(p => ({ ...p, subject: e.target.value }))} required
                  className="ui-input" aria-label="Subject" placeholder="e.g. Exclusive offer just for you" />
              </div>
              <div>
                <label className="form-label">Body <span className="req">*</span></label>
                <textarea value={form.body} onChange={e => setForm(p => ({ ...p, body: e.target.value }))} required rows={10}
                  className="ui-input" aria-label="Body" placeholder="Write your email content here…" />
              </div>
            </div>
          </div>
          {campaign && <Attachments entityType="CAMPAIGN" entityId={campaign.id} />}
          <div className="flex gap-3 pt-1">
            <button type="button" onClick={onClose} className="flex-1 py-2 border border-gray-200 dark:border-gray-700 rounded-xl text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800">Cancel</button>
            <button type="submit" disabled={save.isPending} className="flex-1 py-2 bg-brand-600 text-white rounded-xl text-sm font-semibold hover:bg-brand-700 disabled:opacity-50">
              {save.isPending ? 'Saving…' : campaign ? 'Save Changes' : 'Create Campaign'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function CampaignsPage() {
  const qc = useQueryClient();
  const [modal, setModal] = useState<Campaign | null | 'new'>(null);
  const [sending, setSending] = useState<string | null>(null);

  const { data, isLoading } = useQuery<{ data: Campaign[] }>({
    queryKey: ['campaigns'],
    queryFn: () => api.get('/campaigns').then(r => r.data),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/campaigns/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['campaigns'] }),
  });

  async function sendCampaign(campaign: Campaign) {
    setSending(campaign.id);
    try {
      const r = await api.post(`/campaigns/${campaign.id}/send`);
      alert(r.data.message);
      qc.invalidateQueries({ queryKey: ['campaigns'] });
    } catch (err: any) {
      alert(err.response?.data?.error ?? 'Failed to send campaign');
    } finally {
      setSending(null);
    }
  }

  const campaigns = data?.data ?? [];

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">Email Campaigns</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">Send bulk emails to leads and contacts</p>
        </div>
        <button onClick={() => setModal('new')}
          className="flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-xl text-sm font-semibold hover:bg-brand-700">
          <Plus size={16} /> New Campaign
        </button>
      </div>

      {isLoading ? (
        <div className="text-center py-16 text-gray-400 dark:text-gray-500">Loading…</div>
      ) : campaigns.length === 0 ? (
        <div className="text-center py-20">
          <Mail size={48} className="text-gray-200 dark:text-gray-700 mx-auto mb-4" />
          <p className="font-medium text-gray-500 dark:text-gray-400">No campaigns yet</p>
          <p className="text-sm text-gray-400 dark:text-gray-500 mt-1">Create your first email campaign to reach your audience</p>
          <button onClick={() => setModal('new')} className="mt-4 px-4 py-2 bg-brand-600 text-white rounded-xl text-sm font-semibold hover:bg-brand-700">
            Create Campaign
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {campaigns.map(campaign => (
            <div key={campaign.id} data-testid="campaign-card" className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-5 flex items-start gap-4">
              <div className="w-10 h-10 rounded-xl bg-brand-50 flex items-center justify-center flex-shrink-0">
                <Mail size={18} className="text-brand-600" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3 mb-1">
                  <h3 className="font-semibold text-gray-900 dark:text-white truncate">{campaign.name}</h3>
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_COLOR[campaign.status]}`}>
                    {campaign.status}
                  </span>
                  <span className="text-xs text-gray-400 dark:text-gray-500 bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded-full">
                    {campaign.targetType === 'LEADS' ? 'Leads' : 'Contacts'}
                  </span>
                </div>
                <p className="text-sm text-gray-600 dark:text-gray-300 truncate">{campaign.subject}</p>
                <div className="flex items-center gap-4 mt-2">
                  {campaign.status === 'SENT' ? (
                    <div className="flex items-center gap-1.5 text-xs text-green-600 dark:text-green-400">
                      <CheckCircle size={12} /> Sent to {campaign.sentCount} recipients · {new Date(campaign.sentAt!).toLocaleDateString()}
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5 text-xs text-gray-400 dark:text-gray-500">
                      <Clock size={12} /> Created {new Date(campaign.createdAt).toLocaleDateString()}
                    </div>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                {campaign.status === 'DRAFT' && (
                  <button onClick={() => { if (confirm(`Send "${campaign.name}" to all ${campaign.targetType.toLowerCase()}? This cannot be undone.`)) sendCampaign(campaign); }}
                    disabled={sending === campaign.id}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-brand-600 text-white rounded-lg text-xs font-semibold hover:bg-brand-700 disabled:opacity-50 transition-colors">
                    <Send size={13} /> {sending === campaign.id ? 'Sending…' : 'Send'}
                  </button>
                )}
                <RowActions items={[
                  { label: 'Edit campaign', icon: <Pencil size={14} />, onClick: () => setModal(campaign), hidden: campaign.status !== 'DRAFT' },
                  { label: 'Delete campaign', icon: <Trash2 size={14} />, onClick: () => { if (confirm('Delete this campaign?')) remove.mutate(campaign.id); }, variant: 'danger', hidden: campaign.status !== 'DRAFT' },
                ]} />
              </div>
            </div>
          ))}
        </div>
      )}

      {modal && (
        <CampaignModal
          campaign={modal === 'new' ? undefined : modal}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}
