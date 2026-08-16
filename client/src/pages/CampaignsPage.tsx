import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { Mail, Plus, Send, Pencil, Trash2, CheckCircle, Clock, LayoutTemplate } from 'lucide-react';
import {
  SearchableSelect, RowActions, PageHeader, Button, Modal, Card, Badge, EmptyState,
  Field, Input, Textarea, Label, Spinner, RecordTasks, RecordTags} from '../shared/components';
import { Attachments } from '../shared/components/Attachments';
import { useEmailTemplates } from '../api/templates';
import { useFormat } from '../hooks/useFormat';

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

const STATUS_VARIANT = {
  DRAFT: 'gray', SENDING: 'yellow', SENT: 'green',
} as const;

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
    <Modal
      open
      onClose={onClose}
      title={campaign ? 'Edit Campaign' : 'New Campaign'}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} className="flex-1">Cancel</Button>
          <Button type="submit" form="campaign-form" loading={save.isPending} className="flex-1">
            {save.isPending ? 'Saving…' : campaign ? 'Save Changes' : 'Create Campaign'}
          </Button>
        </>
      }
    >
      <form id="campaign-form" onSubmit={e => { e.preventDefault(); save.mutate(form); }} className="space-y-3">
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
            <Field label="Campaign Name" required>
              <Input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} required
                aria-label="Name" placeholder="e.g. Q1 Lead Nurture" />
            </Field>
            <div>
              <Label>Target Audience</Label>
              <SearchableSelect ariaLabel="Target Audience" value={form.targetType} onChange={val => setForm(p => ({ ...p, targetType: val as any }))} required options={[{value:'LEADS',label:'Leads (unconverted)'},{value:'CONTACTS',label:'All Contacts'}]} />
            </div>
          </div>
        </div>
        <div className="form-section">
          <p className="form-section-title">Email Content</p>
          <div className="space-y-4">
            <Field label="Subject Line" required>
              <Input value={form.subject} onChange={e => setForm(p => ({ ...p, subject: e.target.value }))} required
                aria-label="Subject" placeholder="e.g. Exclusive offer just for you" />
            </Field>
            <Field label="Body" required>
              <Textarea value={form.body} onChange={e => setForm(p => ({ ...p, body: e.target.value }))} required rows={10}
                aria-label="Body" placeholder="Write your email content here…" />
            </Field>
          </div>
        </div>
        {campaign && <>
              <RecordTags entityType="CAMPAIGN" entityId={campaign.id} />
              <Attachments entityType="CAMPAIGN" entityId={campaign.id} />
              <RecordTasks entityType="CAMPAIGN" entityId={campaign.id} />
            </>}
      </form>
    </Modal>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function CampaignsPage() {
  const { date } = useFormat();
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
      <PageHeader
        title="Email Campaigns"
        subtitle="Send bulk emails to leads and contacts"
        actions={
          <Button icon={<Plus size={16} />} onClick={() => setModal('new')}>New Campaign</Button>
        }
      />

      {isLoading ? (
        <Spinner label="Loading…" />
      ) : campaigns.length === 0 ? (
        <EmptyState
          icon={<Mail size={24} />}
          title="No campaigns yet"
          description="Create your first email campaign to reach your audience"
          action={{ label: 'Create Campaign', onClick: () => setModal('new') }}
        />
      ) : (
        <div className="space-y-3">
          {campaigns.map(campaign => (
            <Card key={campaign.id} data-testid="campaign-card" className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-card bg-accent-soft text-accent-soft-fg flex items-center justify-center flex-shrink-0">
                <Mail size={18} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3 mb-1">
                  <h3 className="font-semibold text-fg truncate">{campaign.name}</h3>
                  <Badge variant={STATUS_VARIANT[campaign.status] ?? 'gray'}>{campaign.status}</Badge>
                  <Badge variant="gray">
                    {campaign.targetType === 'LEADS' ? 'Leads' : 'Contacts'}
                  </Badge>
                </div>
                <p className="text-sm text-fg-muted truncate">{campaign.subject}</p>
                <div className="flex items-center gap-4 mt-2">
                  {campaign.status === 'SENT' ? (
                    <div className="flex items-center gap-1.5 text-xs text-success">
                      <CheckCircle size={12} /> Sent to {campaign.sentCount} recipients · {date(campaign.sentAt!)}
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5 text-xs text-fg-subtle">
                      <Clock size={12} /> Created {date(campaign.createdAt)}
                    </div>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                {campaign.status === 'DRAFT' && (
                  <Button
                    size="sm"
                    icon={<Send size={13} />}
                    loading={sending === campaign.id}
                    onClick={() => { if (confirm(`Send "${campaign.name}" to all ${campaign.targetType.toLowerCase()}? This cannot be undone.`)) sendCampaign(campaign); }}
                  >
                    {sending === campaign.id ? 'Sending…' : 'Send'}
                  </Button>
                )}
                <RowActions items={[
                  { label: 'Edit campaign', icon: <Pencil size={14} />, onClick: () => setModal(campaign), hidden: campaign.status !== 'DRAFT' },
                  { label: 'Delete campaign', icon: <Trash2 size={14} />, onClick: () => { if (confirm('Delete this campaign?')) remove.mutate(campaign.id); }, variant: 'danger', hidden: campaign.status !== 'DRAFT' },
                ]} />
              </div>
            </Card>
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
