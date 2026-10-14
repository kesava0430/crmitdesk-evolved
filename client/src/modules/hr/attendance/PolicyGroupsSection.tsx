import { useState } from 'react';
import { Clock, Plus, Pencil, Trash2, Home } from 'lucide-react';
import { Card, CardHeader, Button, Modal, Badge, Field, Input, Select, Checkbox, Alert, SkeletonTable, IconButton, SearchInput } from '../../../shared/components';
import { useDepartments, useLocations } from '../../../api/people';
import { useUsers } from '../../../api/users';
import { usePolicyGroups, useSavePolicyGroup, useDeletePolicyGroup, type PolicyGroup, type LateBand } from '../../../api/attendanceAdmin';
import { WfhSchedulesPanel } from '../wfh/WfhParts';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const EMPLOYMENT_TYPES = ['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN', 'CONSULTANT', 'TEMPORARY'];

type WfhKeys = 'wfhEnabled' | 'wfhApprovalMode' | 'wfhMaxPerMonth' | 'wfhMaxPerWeek' | 'wfhMinNoticeDays' | 'wfhAllowSameDay' | 'wfhAllowHalfDay' | 'wfhRequireCheckIn';
type Form = Omit<PolicyGroup, 'id' | 'lateBands' | 'applicability' | 'weeklyOffs' | 'optionalHolidaysAllowed' | WfhKeys> & { lateBands: LateBand[]; weeklyOffs: number[]; departmentIds: string[]; locationIds: string[]; employmentTypes: string[]; userIds: string[]; optionalHolidaysAllowed: number }
  & { wfhEnabled: boolean; wfhApprovalMode: 'MANAGER' | 'AUTO'; wfhMaxPerMonth: number | null; wfhMaxPerWeek: number | null; wfhMinNoticeDays: number; wfhAllowSameDay: boolean; wfhAllowHalfDay: boolean; wfhRequireCheckIn: boolean };

const empty: Form = {
  name: '', isDefault: false, isActive: true, shiftStart: '09:00', shiftEnd: '18:00', timezone: null, graceMinutes: 15,
  lateBands: [{ untilMinutes: 60, status: 'LATE' }, { untilMinutes: 180, status: 'HALF_DAY' }, { untilMinutes: null, status: 'ABSENT' }],
  minFullDayMinutes: 480, minHalfDayMinutes: 240, earlyDepartureGraceMinutes: 15, earlyDepartureStatus: 'NONE', overtimeAfterMinutes: 0, overtimeMinMinutes: 30,
  lateAllowedPerMonth: 3, lateConversionEvery: 3, lateConversionUnit: 'HALF_DAY', weeklyOffs: [0, 6], assumeShiftEndOnMissingCheckout: false,
  departmentIds: [], locationIds: [], employmentTypes: [], userIds: [], optionalHolidaysAllowed: 2,
  // Work from home — the owner's defaults (same as the migration)
  wfhEnabled: true, wfhApprovalMode: 'MANAGER', wfhMaxPerMonth: 4, wfhMaxPerWeek: null, wfhMinNoticeDays: 0, wfhAllowSameDay: true, wfhAllowHalfDay: true, wfhRequireCheckIn: true,
};

/** Number input for an optional limit: blank = unlimited (null). */
const limitValue = (v: number | null | undefined) => (v == null ? '' : String(v));
const parseLimit = (v: string) => (v.trim() === '' ? null : Math.max(0, Math.round(Number(v))));

/** Browsers accept any string; the server rejects unknown zones, so check here first for a friendlier message. */
function validTimeZone(tz: string) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } }

const addMinutes = (hhmm: string, min: number) => { const [h, m] = hhmm.split(':').map(Number); const t = ((h * 60 + m + min) % 1440 + 1440) % 1440; return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };

function WfhSummaryBadge({ g }: { g: PolicyGroup }) {
  if (g.wfhEnabled === false) return <Badge variant="gray">WFH off</Badge>;
  const limit = g.wfhMaxPerMonth == null ? 'unlimited' : `${g.wfhMaxPerMonth}/mo`;
  return <Badge variant="teal">WFH {limit}{g.wfhApprovalMode === 'AUTO' ? ' · auto' : ''}</Badge>;
}

export function PolicyGroupsSection() {
  const { data, isLoading } = usePolicyGroups();
  const save = useSavePolicyGroup();
  const remove = useDeletePolicyGroup();
  const { data: departments } = useDepartments();
  const { data: locations } = useLocations();
  const { data: users } = useUsers();
  const [userQuery, setUserQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<PolicyGroup | null>(null);
  const [form, setForm] = useState<Form>(empty);
  const [error, setError] = useState('');
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm(f => ({ ...f, [k]: v }));
  const num = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement>) => set(k, Number(e.target.value) as any);

  const openCreate = () => { setEditing(null); setForm(empty); setError(''); setOpen(true); };
  const openEdit = (g: PolicyGroup) => {
    setEditing(g); setError(''); setOpen(true);
    setForm({ ...empty, ...g, optionalHolidaysAllowed: g.optionalHolidaysAllowed ?? 2, lateBands: g.lateBands?.length ? g.lateBands : empty.lateBands, weeklyOffs: g.weeklyOffs ?? [0, 6], departmentIds: g.applicability?.departmentIds ?? [], locationIds: g.applicability?.locationIds ?? [], employmentTypes: g.applicability?.employmentTypes ?? [], userIds: g.applicability?.userIds ?? [] } as Form);
  };
  const scoped = !!(form.departmentIds.length || form.locationIds.length || form.employmentTypes.length || form.userIds.length);
  const editingDefault = !!editing?.isDefault;
  const submit = () => {
    setError('');
    const { departmentIds, locationIds, employmentTypes, userIds, ...rest } = form;
    if (rest.timezone && !validTimeZone(rest.timezone)) return setError(`"${rest.timezone}" isn't a recognised time zone — use an IANA name such as Asia/Kolkata.`);
    if (rest.isDefault && scoped) return setError('The default policy applies to everyone not matched by another policy — clear its "Applies to" filters first.');
    // All scopes cleared → null, which the server now persists as "no scope"
    // (it used to be ignored, leaving the old scope in place). userIds are
    // always sent so the per-person picker round-trips.
    save.mutate({ id: editing?.id, ...rest, applicability: scoped ? { departmentIds, locationIds, employmentTypes, userIds } : null } as any,
      { onSuccess: () => setOpen(false), onError: (e: any) => setError(e?.response?.data?.error || e?.response?.data?.details?.[0]?.message || 'Could not save') });
  };
  const userList = (users ?? []).filter(u => !userQuery.trim() || u.name.toLowerCase().includes(userQuery.toLowerCase()) || u.email.toLowerCase().includes(userQuery.toLowerCase()));
  const userName = (id: string) => users?.find(u => u.id === id)?.name ?? 'Unknown user';
  const toggleIn = (list: any[], v: any) => (list.includes(v) ? list.filter(x => x !== v) : [...list, v]);
  const setBand = (i: number, patch: Partial<LateBand>) => set('lateBands', form.lateBands.map((b, j) => (j === i ? { ...b, ...patch } : b)));

  return (
    <Card>
      <CardHeader title="Attendance Policies" subtitle="Office timing, grace, late bands, minimum hours, overtime, late-arrival conversion and weekly offs — per group of employees." icon={<Clock size={14} />} className="mb-3"
        actions={<Button size="sm" icon={<Plus size={13} />} onClick={openCreate}>Add policy</Button>} />
      {isLoading ? <SkeletonTable rows={2} /> : (
        <div className="space-y-2">
          {(data?.groups ?? []).map(g => (
            <div key={g.id} className="flex items-center justify-between gap-3 p-3 border border-line-subtle rounded-card">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap"><span className="text-sm font-medium text-fg">{g.name}</span>{g.isDefault && <Badge variant="accent">default</Badge>}{!g.isActive && <Badge variant="red">inactive</Badge>}</div>
                <p className="text-xs text-fg-subtle mt-0.5 tabular-nums">{g.shiftStart}–{g.shiftEnd} · grace {g.graceMinutes}m · full day ≥ {Math.round(g.minFullDayMinutes / 60)}h · offs {(g.weeklyOffs ?? []).map(d => WEEKDAYS[d]).join(', ') || 'none'}
                  {g.applicability?.locationIds?.length ? ` · ${g.applicability.locationIds.length} location(s)` : ''}{g.applicability?.departmentIds?.length ? ` · ${g.applicability.departmentIds.length} dept(s)` : ''}{g.applicability?.userIds?.length ? ` · ${g.applicability.userIds.length} person(s)` : ''}{g.timezone ? ` · ${g.timezone}` : ''}</p>
              </div>
              <span className="hidden sm:inline-flex"><WfhSummaryBadge g={g} /></span>
              <span className="inline-flex gap-1 shrink-0"><IconButton label="Edit" icon={<Pencil size={13} />} onClick={() => openEdit(g)} />{!g.isDefault && <IconButton label="Deactivate" tone="danger" icon={<Trash2 size={13} />} onClick={() => remove.mutate(g.id)} />}</span>
            </div>
          ))}
        </div>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title={editing ? `Edit ${editing.name}` : 'New attendance policy'} icon={<Clock size={16} />} size="xl"
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={save.isPending} onClick={submit}>Save policy</Button></>}>
        <div className="space-y-5">
          {error && <Alert tone="danger">{error}</Alert>}
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
            <Field label="Name" className="sm:col-span-2"><Input value={form.name} onChange={e => set('name', e.target.value)} placeholder="e.g. Head office, Factory shift A" /></Field>
            <Field label="Shift start"><Input type="time" value={form.shiftStart} onChange={e => set('shiftStart', e.target.value)} /></Field>
            <Field label="Shift end" hint={form.shiftEnd <= form.shiftStart ? 'Ends the next morning (night shift)' : undefined}><Input type="time" value={form.shiftEnd} onChange={e => set('shiftEnd', e.target.value)} /></Field>
          </div>

          <section className="rounded-card border border-line-subtle p-3 space-y-3">
            <p className="text-[12px] font-semibold text-fg">Arrival</p>
            <Field label="Grace period (minutes)" hint={`Arriving by ${addMinutes(form.shiftStart, form.graceMinutes)} counts as on time`}><Input type="number" min={0} max={240} value={form.graceMinutes} onChange={num('graceMinutes')} className="w-32" /></Field>
            <div>
              <p className="text-[11.5px] text-fg-muted mb-1.5">After the grace period, arrival time decides the day's status:</p>
              <div className="space-y-1.5">
                {form.lateBands.map((b, i) => {
                  const fromMin = i === 0 ? form.graceMinutes : (form.lateBands[i - 1].untilMinutes ?? 0);
                  return (
                    <div key={i} className="grid grid-cols-[auto_1fr_auto_1fr_auto] gap-2 items-center text-[12.5px]">
                      <span className="text-fg-subtle tabular-nums whitespace-nowrap">{addMinutes(form.shiftStart, fromMin + 1)} →</span>
                      {b.untilMinutes === null ? <span className="text-fg-subtle">end of day</span> : (
                        <Input type="number" min={fromMin + 1} value={b.untilMinutes} onChange={e => setBand(i, { untilMinutes: Number(e.target.value) })} />
                      )}
                      <span className="text-fg-subtle whitespace-nowrap">{b.untilMinutes === null ? '' : `min late (${addMinutes(form.shiftStart, b.untilMinutes)})`}</span>
                      <Select value={b.status} onChange={e => setBand(i, { status: e.target.value as LateBand['status'] })}>
                        <option value="PRESENT">Present</option><option value="LATE">Late</option><option value="HALF_DAY">Half day</option><option value="ABSENT">Absent</option>
                      </Select>
                      {b.untilMinutes !== null ? <Button size="xs" variant="ghost" onClick={() => set('lateBands', form.lateBands.filter((_, j) => j !== i))}>Remove</Button> : <span />}
                    </div>
                  );
                })}
                <Button size="xs" variant="secondary" onClick={() => set('lateBands', [...form.lateBands.slice(0, -1), { untilMinutes: (form.lateBands[form.lateBands.length - 2]?.untilMinutes ?? form.graceMinutes) + 60, status: 'HALF_DAY' }, form.lateBands[form.lateBands.length - 1]])}>Add band</Button>
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
              <Field label="Optional holidays / year" hint="Restricted holidays each person may opt into"><Input type="number" min={0} max={31} value={form.optionalHolidaysAllowed} onChange={num('optionalHolidaysAllowed')} /></Field>
              <Field label="Lates allowed / month"><Input type="number" min={0} value={form.lateAllowedPerMonth} onChange={num('lateAllowedPerMonth')} /></Field>
              <Field label="Every N extra lates ="><Input type="number" min={1} value={form.lateConversionEvery} onChange={num('lateConversionEvery')} /></Field>
              <Field label="Converts to"><Select value={form.lateConversionUnit} onChange={e => set('lateConversionUnit', e.target.value as any)}><option value="HALF_DAY">Half day</option><option value="LOP">1 day LOP</option><option value="NONE">Nothing</option></Select></Field>
            </div>
          </section>

          <section className="rounded-card border border-line-subtle p-3 space-y-3">
            <p className="text-[12px] font-semibold text-fg">Hours, departure &amp; overtime</p>
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
              <Field label="Full day needs (minutes)"><Input type="number" min={0} value={form.minFullDayMinutes} onChange={num('minFullDayMinutes')} /></Field>
              <Field label="Half day needs (minutes)"><Input type="number" min={0} value={form.minHalfDayMinutes} onChange={num('minHalfDayMinutes')} /></Field>
              <Field label="Early-departure grace (min)"><Input type="number" min={0} value={form.earlyDepartureGraceMinutes} onChange={num('earlyDepartureGraceMinutes')} /></Field>
              <Field label="Leaving early counts as"><Select value={form.earlyDepartureStatus} onChange={e => set('earlyDepartureStatus', e.target.value as any)}><option value="NONE">Flag only (hours rule decides)</option><option value="HALF_DAY">Half day</option></Select></Field>
              <Field label="Overtime starts (min after shift end)" hint="0 = overtime off"><Input type="number" min={0} value={form.overtimeAfterMinutes} onChange={num('overtimeAfterMinutes')} /></Field>
              <Field label="Minimum overtime to count (min)"><Input type="number" min={0} value={form.overtimeMinMinutes} onChange={num('overtimeMinMinutes')} /></Field>
            </div>
            <Checkbox label="If check-out is missing, assume they left at shift end (otherwise the day is Absent)" checked={form.assumeShiftEndOnMissingCheckout} onChange={e => set('assumeShiftEndOnMissingCheckout', e.target.checked)} />
          </section>

          <section className="rounded-card border border-line-subtle p-3 space-y-3" data-testid="wfh-section">
            <p className="text-[12px] font-semibold text-fg flex items-center gap-1.5"><Home size={13} /> Work from home</p>
            <Checkbox label="Members of this policy can work from home" hint="Off: requests are refused and the group's recurring WFH is ignored. Already-approved days stay." checked={form.wfhEnabled} onChange={e => set('wfhEnabled', e.target.checked)} />
            {form.wfhEnabled && (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                  <Field label="Approval" className="sm:col-span-2">
                    <Select value={form.wfhApprovalMode} onChange={e => set('wfhApprovalMode', e.target.value as any)}>
                      <option value="MANAGER">A manager approves each request</option>
                      <option value="AUTO">Approve automatically (within the limits)</option>
                    </Select>
                  </Field>
                  <Field label="Max days / month" hint="Blank = unlimited"><Input type="number" min={0} max={31} value={limitValue(form.wfhMaxPerMonth)} onChange={e => set('wfhMaxPerMonth', parseLimit(e.target.value))} placeholder="Unlimited" /></Field>
                  <Field label="Max days / week" hint="Blank = unlimited"><Input type="number" min={0} max={7} value={limitValue(form.wfhMaxPerWeek)} onChange={e => set('wfhMaxPerWeek', parseLimit(e.target.value))} placeholder="Unlimited" /></Field>
                  <Field label="Notice (days ahead)" hint="0 = can request for today"><Input type="number" min={0} max={90} value={form.wfhMinNoticeDays} onChange={num('wfhMinNoticeDays')} /></Field>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <Checkbox label="Same-day requests allowed" checked={form.wfhAllowSameDay} onChange={e => set('wfhAllowSameDay', e.target.checked)} />
                  <Checkbox label="Half days allowed" checked={form.wfhAllowHalfDay} onChange={e => set('wfhAllowHalfDay', e.target.checked)} />
                  <Checkbox label="Check-in required on WFH days" hint={form.wfhRequireCheckIn ? 'Judged on hours like a workday (no late marks); no check-in = absent.' : 'WFH days are paid whatever is punched.'} checked={form.wfhRequireCheckIn} onChange={e => set('wfhRequireCheckIn', e.target.checked)} />
                </div>
                <p className="text-[11.5px] text-fg-muted">Limits count approved + pending requests and recurring days (working days only; a half day is 0.5). Managers can override them when applying on someone's behalf. On a WFH day, check-in skips the office location / network checks (face still applies).</p>
                <div>
                  <p className="text-[12px] font-medium text-fg mb-1">Recurring WFH for everyone in this policy</p>
                  {editing ? <WfhSchedulesPanel policyGroupId={editing.id} /> : <p className="text-[11.5px] text-fg-subtle">Save the policy first, then add a weekly pattern (e.g. every Friday).</p>}
                </div>
              </>
            )}
          </section>

          <section className="rounded-card border border-line-subtle p-3 space-y-3">
            <p className="text-[12px] font-semibold text-fg">Weekly offs</p>
            <div className="flex flex-wrap gap-1.5">{WEEKDAYS.map((d, i) => <Button key={d} size="xs" variant={form.weeklyOffs.includes(i) ? 'primary' : 'secondary'} onClick={() => set('weeklyOffs', toggleIn(form.weeklyOffs, i))}>{d}</Button>)}</div>
          </section>

          <section className="rounded-card border border-line-subtle p-3 space-y-3">
            <p className="text-[12px] font-semibold text-fg">Applies to <span className="font-normal text-fg-subtle">(leave empty for the default group; specific people win over location, then department, then employment type)</span></p>
            <div>
              <p className="text-[11px] text-fg-subtle mb-1">Specific people {form.userIds.length ? `(${form.userIds.length})` : ''}</p>
              {form.userIds.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-1.5">
                  {form.userIds.map(id => <Button key={id} size="xs" variant="primary" onClick={() => set('userIds', form.userIds.filter(x => x !== id))} title="Remove">{userName(id)} ×</Button>)}
                </div>
              )}
              <SearchInput value={userQuery} onChange={setUserQuery} placeholder="Search people to add…" />
              {userQuery.trim() && (
                <div className="mt-1 max-h-40 overflow-y-auto rounded-lg border border-line-subtle divide-y divide-line-subtle">
                  {userList.slice(0, 30).map(u => (
                    <button key={u.id} type="button" className="w-full text-left px-2.5 py-1.5 text-[12.5px] hover:bg-surface-sunken flex items-center justify-between"
                      onClick={() => set('userIds', toggleIn(form.userIds, u.id))}>
                      <span className="truncate">{u.name} <span className="text-fg-subtle">· {u.email}</span></span>
                      {form.userIds.includes(u.id) && <Badge variant="accent">added</Badge>}
                    </button>
                  ))}
                  {userList.length === 0 && <p className="px-2.5 py-1.5 text-[12px] text-fg-subtle">No matches</p>}
                </div>
              )}
            </div>
            {!!locations?.data?.length && <div><p className="text-[11px] text-fg-subtle mb-1">Locations / branches</p><div className="flex flex-wrap gap-1.5">{locations.data.map(l => <Button key={l.id} size="xs" variant={form.locationIds.includes(l.id) ? 'primary' : 'secondary'} onClick={() => set('locationIds', toggleIn(form.locationIds, l.id))}>{l.name}</Button>)}</div></div>}
            {!!departments?.data?.length && <div><p className="text-[11px] text-fg-subtle mb-1">Departments</p><div className="flex flex-wrap gap-1.5">{departments.data.map(d => <Button key={d.id} size="xs" variant={form.departmentIds.includes(d.id) ? 'primary' : 'secondary'} onClick={() => set('departmentIds', toggleIn(form.departmentIds, d.id))}>{d.name}</Button>)}</div></div>}
            <div><p className="text-[11px] text-fg-subtle mb-1">Employment type</p><div className="flex flex-wrap gap-1.5">{EMPLOYMENT_TYPES.map(t => <Button key={t} size="xs" variant={form.employmentTypes.includes(t) ? 'primary' : 'secondary'} onClick={() => set('employmentTypes', toggleIn(form.employmentTypes, t))}>{t.toLowerCase().replace('_', ' ')}</Button>)}</div></div>
            <Field label="Timezone override (optional)" hint="IANA name, e.g. Asia/Kolkata. Blank = the employee's location time zone, else the organisation's."><Input value={form.timezone ?? ''} onChange={e => set('timezone', e.target.value.trim() || null)} placeholder="Asia/Kolkata" /></Field>
            <div className="flex gap-4 flex-wrap">
              <Checkbox label="Default policy" hint={editingDefault ? 'To change the default, edit another policy and make it the default.' : scoped ? 'Clear the "Applies to" filters to make this the default.' : undefined}
                checked={form.isDefault} disabled={editingDefault || (!form.isDefault && scoped)} onChange={e => set('isDefault', e.target.checked)} />
              <Checkbox label="Active" checked={form.isActive} disabled={form.isDefault} onChange={e => set('isActive', e.target.checked)} />
            </div>
          </section>
        </div>
      </Modal>
    </Card>
  );
}
