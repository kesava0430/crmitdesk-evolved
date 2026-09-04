/**
 * WebFormsPage — Admin → Web Forms.
 *
 * Managers create public web-to-lead / web-to-ticket forms here, flip them
 * active/inactive, and grab the public link or an iframe embed snippet to
 * drop on the org's own website. Submissions become real Leads/Tickets and
 * run the same workflows (department routing, AI auto-assign, notifications)
 * as in-app records — pair a form with an AI Auto-Assign rule and inbound
 * requests route themselves.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  PanelTop, Plus, Link2, Code2, Trash2, CheckCircle2,
  ExternalLink, MousePointerClick, KeyRound, RefreshCw,
} from 'lucide-react';
import { api } from '../api/client';
import {
  Alert, Badge, Button, Card, EmptyState, Field, Input, Modal,
  PageBody, PageHeader, Select, Textarea, Toggle,
} from '../shared/components';
import { addToast } from '../shared/components/toastStore';

interface WebForm {
  id: string;
  name: string;
  type: 'LEAD' | 'TICKET';
  title: string | null;
  intro: string | null;
  isActive: boolean;
  intakeToken: string | null;
  submissionCount: number;
  lastSubmissionAt: string | null;
  createdAt: string;
}

export default function WebFormsPage() {
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [draft, setDraft] = useState({ name: '', type: 'LEAD' as 'LEAD' | 'TICKET', title: '', intro: '' });
  const [copied, setCopied] = useState<string | null>(null);

  const { data: forms, isLoading } = useQuery<WebForm[]>({
    queryKey: ['web-forms'],
    queryFn: async () => (await api.get('/web-forms')).data,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['web-forms'] });

  const createMut = useMutation({
    mutationFn: async () =>
      (await api.post('/web-forms', {
        name: draft.name,
        type: draft.type,
        title: draft.title.trim() || undefined,
        intro: draft.intro.trim() || undefined,
      })).data,
    onSuccess: () => {
      invalidate();
      setShowCreate(false);
      setDraft({ name: '', type: 'LEAD', title: '', intro: '' });
      addToast('Form created — copy its link or embed code below', 'success');
    },
    onError: (e: any) => addToast(e?.response?.data?.error || 'Could not create form', 'error'),
  });

  const toggleMut = useMutation({
    mutationFn: async ({ id, isActive }: { id: string; isActive: boolean }) =>
      (await api.patch(`/web-forms/${id}`, { isActive })).data,
    onSuccess: invalidate,
    onError: (e: any) => addToast(e?.response?.data?.error || 'Update failed', 'error'),
  });

  const rotateMut = useMutation({
    mutationFn: async (id: string) => (await api.post(`/web-forms/${id}/rotate-token`)).data,
    onSuccess: () => { invalidate(); addToast('New intake token issued — update your integrations', 'success'); },
    onError: (e: any) => addToast(e?.response?.data?.error || 'Could not rotate token', 'error'),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/web-forms/${id}`)).data,
    onSuccess: () => { invalidate(); addToast('Form deleted', 'success'); },
    onError: (e: any) => addToast(e?.response?.data?.error || 'Delete failed', 'error'),
  });

  const publicUrl = (id: string) => `${window.location.origin}/form/${id}`;
  const embedSnippet = (id: string) =>
    `<iframe src="${publicUrl(id)}" style="width:100%;max-width:560px;height:640px;border:0;border-radius:12px" title="Contact form"></iframe>`;

  async function copyText(key: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(c => (c === key ? null : c)), 1800);
    } catch {
      addToast('Could not copy — select the link text and copy manually', 'error');
    }
  }

  return (
    <div>
      <PageHeader
        title="Web Forms"
        subtitle="Public forms you can embed on your website — submissions become leads or tickets automatically"
        actions={
          <Button icon={<Plus size={14} />} onClick={() => setShowCreate(true)}>
            New form
          </Button>
        }
      />
      <PageBody>
        <div className="max-w-3xl space-y-5">
          <Alert tone="info">
            Each form has a public link that works <strong>without login</strong> — share it directly
            or embed it on your site with the iframe snippet. Pair it with an{' '}
            <strong>AI Auto-Assign</strong> workflow rule (Workflows → On lead/ticket created) and
            every submission is routed to the right department and person automatically.
          </Alert>

          {isLoading ? (
            <p className="text-sm text-fg-muted py-6 text-center">Loading…</p>
          ) : !forms?.length ? (
            <Card>
              <EmptyState
                icon={<MousePointerClick size={22} />}
                title="No web forms yet"
                description="Create a lead form for your website's contact page, or a ticket form for a customer support portal."
                action={{ label: 'Create your first form', onClick: () => setShowCreate(true) }}
              />
            </Card>
          ) : (
            <div className="space-y-4">
              {forms.map(form => (
                <Card key={form.id} className="space-y-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <PanelTop size={15} className="text-fg-subtle shrink-0" />
                        <span className="text-[14.5px] font-semibold text-fg">{form.name}</span>
                        <Badge variant={form.type === 'LEAD' ? 'blue' : 'purple'}>
                          {form.type === 'LEAD' ? 'Lead form' : 'Ticket form'}
                        </Badge>
                        {!form.isActive && <Badge variant="gray">Inactive</Badge>}
                      </div>
                      <p className="text-[12.5px] text-fg-muted mt-1">
                        {form.submissionCount} submission{form.submissionCount === 1 ? '' : 's'}
                        {form.lastSubmissionAt && ` · last ${new Date(form.lastSubmissionAt).toLocaleString()}`}
                      </p>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <Toggle
                        label={form.isActive ? 'Active' : 'Off'}
                        checked={form.isActive}
                        onChange={(v: boolean) => toggleMut.mutate({ id: form.id, isActive: v })}
                      />
                      <Button
                        variant="ghost" size="sm"
                        onClick={() => {
                          if (window.confirm(`Delete "${form.name}"? Its public link will stop working.`)) {
                            deleteMut.mutate(form.id);
                          }
                        }}
                      >
                        <Trash2 size={14} className="text-danger" />
                      </Button>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="secondary" size="sm"
                      icon={copied === `link-${form.id}` ? <CheckCircle2 size={13} className="text-success" /> : <Link2 size={13} />}
                      onClick={() => copyText(`link-${form.id}`, publicUrl(form.id))}
                    >
                      {copied === `link-${form.id}` ? 'Copied' : 'Copy link'}
                    </Button>
                    <Button
                      variant="secondary" size="sm"
                      icon={copied === `embed-${form.id}` ? <CheckCircle2 size={13} className="text-success" /> : <Code2 size={13} />}
                      onClick={() => copyText(`embed-${form.id}`, embedSnippet(form.id))}
                    >
                      {copied === `embed-${form.id}` ? 'Copied' : 'Copy embed code'}
                    </Button>
                    <a
                      href={publicUrl(form.id)} target="_blank" rel="noreferrer"
                      className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12.5px] font-medium text-fg-muted hover:text-fg hover:bg-surface-sunken transition-colors"
                    >
                      <ExternalLink size={13} /> Preview
                    </a>
                  </div>
                  <code className="block text-[11.5px] text-fg-subtle bg-surface-sunken rounded-md px-2.5 py-1.5 truncate">
                    {publicUrl(form.id)}
                  </code>
                  {/* Webhook intake — for Zoho webhooks / Google Apps Script /
                      Zapier. The token lifts the per-IP rate limit for
                      server-to-server traffic and proves the caller is yours. */}
                  {form.intakeToken && (
                    <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-line-subtle">
                      <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-fg-muted">
                        <KeyRound size={13} /> Webhook intake token
                      </span>
                      <code className="text-[11.5px] text-fg-subtle bg-surface-sunken rounded px-2 py-0.5">
                        {form.intakeToken.slice(0, 12)}…
                      </code>
                      <Button
                        variant="secondary" size="xs"
                        icon={copied === `tok-${form.id}` ? <CheckCircle2 size={12} className="text-success" /> : <Link2 size={12} />}
                        onClick={() => copyText(`tok-${form.id}`, form.intakeToken!)}
                      >
                        {copied === `tok-${form.id}` ? 'Copied' : 'Copy token'}
                      </Button>
                      <Button
                        variant="ghost" size="xs"
                        icon={<RefreshCw size={12} />}
                        onClick={() => {
                          if (window.confirm('Issue a new token? Integrations using the current one will lose the rate-limit bypass until updated.')) {
                            rotateMut.mutate(form.id);
                          }
                        }}
                      >
                        Rotate
                      </Button>
                      <span className="text-[11px] text-fg-subtle">
                        Send as <code>x-intake-token</code> header from Zoho / Google Forms / Zapier
                      </span>
                    </div>
                  )}
                </Card>
              ))}
            </div>
          )}
        </div>
      </PageBody>

      <Modal open={showCreate} onClose={() => setShowCreate(false)} title="New web form">
        <form onSubmit={e => { e.preventDefault(); createMut.mutate(); }} className="space-y-4">
          <Field label="Form name" required hint="Internal name — visitors never see this">
            <Input
              required
              value={draft.name}
              onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
              placeholder="Website contact form"
            />
          </Field>
          <Field label="Submissions become">
            <Select
              value={draft.type}
              onChange={e => setDraft(d => ({ ...d, type: e.target.value as 'LEAD' | 'TICKET' }))}
              options={[
                { value: 'LEAD', label: 'Leads (sales inquiry form)' },
                { value: 'TICKET', label: 'Tickets (support request form)' },
              ]}
            />
          </Field>
          <Field label="Public title" hint="Shown as the form heading (optional)">
            <Input
              value={draft.title}
              onChange={e => setDraft(d => ({ ...d, title: e.target.value }))}
              placeholder={draft.type === 'LEAD' ? 'Contact our sales team' : 'Submit a support request'}
            />
          </Field>
          <Field label="Intro text">
            <Textarea
              value={draft.intro}
              onChange={e => setDraft(d => ({ ...d, intro: e.target.value }))}
              placeholder="Tell us a bit about what you need and we'll get back within one business day."
              rows={2}
            />
          </Field>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="secondary" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button type="submit" disabled={!draft.name.trim() || createMut.isPending}>
              {createMut.isPending ? 'Creating…' : 'Create form'}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
