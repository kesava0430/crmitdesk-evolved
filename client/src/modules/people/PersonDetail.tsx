import { useState } from 'react';
import { usePerson, useRecordExit, type PersonProfile } from '../../api/people';
import {
  Button, Modal, Badge, StatusBadge, Avatar, Card, Field, Input, Select, Textarea, FormError, Alert,
  type BadgeProps,
} from '../../shared/components';
import { Users, LogOut, Shield, Briefcase, Pencil } from 'lucide-react';
import { useFormat } from '../../hooks/useFormat';
import { EditPersonModal } from './PersonForms';

/**
 * A person's profile — the one detail view behind People, the Org Chart's
 * directory and Logins & Invites. Reads GET /people/:id, so the Edit button
 * appears exactly when the server says this caller may edit (the `access`
 * block), rather than when a client-side role guess thinks so.
 *
 * Masked values: the API returns bank/tax columns already masked ('••••1234')
 * or removed, per the caller's field permissions. This view renders whatever
 * came back — a client-side hide would only be a suggestion.
 */

export const STATUS_VARIANT: Record<string, NonNullable<BadgeProps['variant']>> = {
  ACTIVE: 'green',
  PROBATION: 'yellow',
  ON_LEAVE: 'blue',
  NOTICE_PERIOD: 'orange',
  SUSPENDED: 'red',
  EXITED: 'gray',
};

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] font-semibold uppercase tracking-wider text-fg-subtle mb-2">{children}</p>;
}

function ProfileField({ label, value, mono = false }: { label: string; value?: string | null; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] text-fg-subtle">{label}</p>
      <p className={`text-[12.5px] text-fg break-words ${mono ? 'font-mono' : ''}`}>{value || '—'}</p>
    </div>
  );
}

const address = (p: PersonProfile) =>
  [p.addressLine1, p.addressLine2, p.city, p.state, p.postalCode, p.country].filter(Boolean).join(', ');

export function PersonDetailModal({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { data: p, isLoading, error } = usePerson(id);
  const [exitOpen, setExitOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const fmt = useFormat();

  if (!id) return null;
  const canEdit = !!p?.access.canEdit;

  return (
    <>
      <Modal
        open={!!id && !exitOpen && !editing}
        onClose={onClose}
        title="Person profile"
        subtitle={p?.employeeCode}
        icon={<Users size={16} />}
        size="xl"
        footer={
          p && canEdit ? (
            <>
              {p.employmentStatus !== 'EXITED' && (
                <Button variant="secondary" icon={<LogOut size={13} />} onClick={() => setExitOpen(true)}>
                  Record exit
                </Button>
              )}
              <Button icon={<Pencil size={13} />} onClick={() => setEditing(true)}>
                Edit details
              </Button>
            </>
          ) : undefined
        }
      >
        {isLoading && (
          <div className="space-y-4" aria-hidden="true">
            <div className="flex items-center gap-4">
              <div className="skeleton w-14 h-14 rounded-full" />
              <div className="space-y-2 flex-1">
                <div className="skeleton h-4 w-1/3" />
                <div className="skeleton h-3 w-1/2" />
              </div>
            </div>
            <div className="skeleton h-24 w-full" />
          </div>
        )}
        {error && <Alert tone="danger">{(error as any)?.response?.data?.error || 'Could not load this person.'}</Alert>}
        {p && (
          <div className="space-y-6 animate-fade-in">
            {/* ── Identity ── */}
            <div className="flex items-start gap-4">
              <Avatar name={p.displayName} src={p.photoUrl ?? undefined} size="lg" />
              <div className="min-w-0 flex-1">
                <p className="text-[16px] font-semibold text-fg tracking-tight break-words">{p.displayName}</p>
                <p className="text-[12.5px] text-fg-muted mt-0.5 break-words">
                  {[p.designation, p.department?.name].filter(Boolean).join(' · ') || 'No designation set'}
                </p>
                <div className="flex items-center gap-1.5 flex-wrap mt-2">
                  <StatusBadge value={p.employmentStatus} map={STATUS_VARIANT} dot />
                  <StatusBadge value={p.employmentType} fallback="gray" size="sm" />
                  <StatusBadge value={p.workMode} fallback="indigo" size="sm" />
                  {!p.user ? (
                    <Badge variant="orange" size="sm">No login</Badge>
                  ) : !p.user.isActive ? (
                    <Badge variant="red" size="sm">Access revoked</Badge>
                  ) : (
                    <Badge variant="blue" size="sm">{p.person.roleName ?? 'Can sign in'}</Badge>
                  )}
                </div>
              </div>
            </div>

            {/* ── Contact ── */}
            <div>
              <SectionTitle>Contact</SectionTitle>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-x-4 gap-y-3">
                <ProfileField label={p.user ? 'Email (sign-in)' : 'Work email'} value={p.user?.email ?? p.workEmail} />
                <ProfileField label="Phone" value={[p.phone, p.alternatePhone].filter(Boolean).join(' / ')} />
                <ProfileField label="Personal email" value={p.personalEmail} />
                <ProfileField
                  label="Emergency contact"
                  value={p.emergencyContact
                    ? `${p.emergencyContact.name} (${p.emergencyContact.relationship}) · ${p.emergencyContact.phone}`
                    : null}
                />
                <div className="sm:col-span-2 min-w-0"><ProfileField label="Address" value={address(p)} /></div>
              </div>
            </div>

            {/* ── Employment ── */}
            <div>
              <SectionTitle>Employment</SectionTitle>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3">
                <ProfileField label="Designation" value={p.designation} />
                <ProfileField label="Department" value={p.department?.name} />
                <ProfileField label="Reports to" value={p.manager?.displayName} />
                <ProfileField label="Location" value={p.location?.name} />
                <ProfileField label="Joined" value={p.joiningDate ? fmt.date(p.joiningDate) : null} />
                <ProfileField label="Probation ends" value={p.probationEndDate ? fmt.date(p.probationEndDate) : null} />
                <ProfileField label="Cost centre" value={p.costCenter} />
                {p.attendancePolicy && (
                  <ProfileField
                    label="Attendance policy"
                    value={p.attendancePolicy.effective
                      ? `${p.attendancePolicy.effective.name}${p.attendancePolicy.explicitId ? '' : ' (automatic)'}`
                      : null}
                  />
                )}
                {p.lastWorkingDate && <ProfileField label="Last working day" value={fmt.date(p.lastWorkingDate)} />}
              </div>
            </div>

            {(p.bankAccountNumber || p.taxId || p.nationalId) && (
              <Card tone="sunken" padding="sm" flat>
                <div className="flex items-center gap-1.5 mb-2.5">
                  <Shield size={12} className="text-fg-subtle" />
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-fg-subtle">Sensitive details</p>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3">
                  <ProfileField label="Bank" value={p.bankName} />
                  <ProfileField label="Account" value={p.bankAccountNumber} mono />
                  <ProfileField label="Tax ID" value={p.taxId} mono />
                  <ProfileField label="National ID" value={p.nationalId} mono />
                </div>
                <p className="text-[11px] text-fg-subtle mt-2.5">
                  Values shown as •••• are masked by your role's field permissions.
                </p>
              </Card>
            )}

            {!!p.reports?.length && (
              <div>
                <SectionTitle>Direct reports ({p.reports.length})</SectionTitle>
                <div className="flex flex-wrap gap-1.5">
                  {p.reports.map(r => <Badge key={r.id} variant="blue">{r.displayName}</Badge>)}
                </div>
              </div>
            )}

            {!!p.skills?.length && (
              <div>
                <SectionTitle>Skills</SectionTitle>
                <div className="flex flex-wrap gap-1.5">
                  {p.skills.map(s => <Badge key={s.id} variant="teal">{s.skill.name} · L{s.level}</Badge>)}
                </div>
              </div>
            )}

            {!!p.certifications?.length && (
              <div>
                <SectionTitle>Certifications</SectionTitle>
                <div className="space-y-1">
                  {p.certifications.map(c => (
                    <div key={c.id} className="flex items-center gap-2 text-[12.5px] min-w-0">
                      <Briefcase size={12} className="text-fg-subtle shrink-0" />
                      <span className="text-fg truncate" title={c.name}>{c.name}</span>
                      {c.expiresOn && <span className="text-[11px] text-fg-subtle shrink-0">expires {fmt.date(c.expiresOn)}</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>

      <ExitModal person={p ?? null} open={exitOpen} onClose={() => setExitOpen(false)} />
      <EditPersonModal personId={editing ? id : null} onClose={() => setEditing(false)} />
    </>
  );
}

function ExitModal({ person, open, onClose }: { person: PersonProfile | null; open: boolean; onClose: () => void }) {
  const recordExit = useRecordExit();
  const [form, setForm] = useState({ lastWorkingDate: '', exitType: 'RESIGNATION', exitReason: '' });
  const [error, setError] = useState('');
  if (!person) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Record exit — ${person.displayName}`}
      icon={<LogOut size={16} />}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            loading={recordExit.isPending}
            disabled={!form.lastWorkingDate}
            onClick={() => {
              setError('');
              recordExit.mutate(
                { id: person.id, ...form },
                {
                  onSuccess: onClose,
                  onError: (err: any) => setError(err?.response?.data?.error || 'Could not record that exit.'),
                }
              );
            }}
          >
            Record exit
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-[12.5px] text-fg-muted">
          This records the exit and sets the employment status. It does not revoke access, recover assets or reassign
          their open records — run the offboarding checklist for that.
        </p>
        <Field label="Last working day">
          <Input type="date" aria-label="Last working day" value={form.lastWorkingDate} onChange={e => setForm({ ...form, lastWorkingDate: e.target.value })} />
        </Field>
        <Field label="Exit type">
          <Select aria-label="Exit type" value={form.exitType} onChange={e => setForm({ ...form, exitType: e.target.value })}>
            {['RESIGNATION', 'TERMINATION', 'RETIREMENT', 'END_OF_CONTRACT', 'ABSCONDED'].map(t => (
              <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>
            ))}
          </Select>
        </Field>
        <Field label="Reason (optional)">
          <Textarea rows={2} value={form.exitReason} onChange={e => setForm({ ...form, exitReason: e.target.value })} />
        </Field>
        <FormError>{error}</FormError>
      </div>
    </Modal>
  );
}
