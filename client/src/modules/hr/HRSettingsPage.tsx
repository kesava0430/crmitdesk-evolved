import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import {
  PageHeader, PageBody, Card, CardHeader, Button, Modal, Badge, EmptyState,
  RowActions, Field, Input, Checkbox, Alert, SkeletonTable,
} from '../../shared/components';
import { Building2, Plus, Pencil, Trash2, Tag, MapPin, Wifi } from 'lucide-react';

interface OfficeLocation {
  id: string; name: string; latitude: number; longitude: number;
  radiusMeters: number; allowedIps: string | null; isActive: boolean;
}
interface LeaveType {
  id: string; name: string; annualQuota: number; isPaid: boolean; color: string; isActive: boolean;
}

const emptyOffice = { name: '', latitude: '', longitude: '', radiusMeters: '150', allowedIps: '' };
const emptyType = { name: '', annualQuota: '12', isPaid: true, color: '#4f46e5' };

function OfficeLocationsSection() {
  const qc = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<OfficeLocation | null>(null);
  const [form, setForm] = useState(emptyOffice);
  const [error, setError] = useState('');
  const [locating, setLocating] = useState(false);
  const [detectingIp, setDetectingIp] = useState(false);
  const [detectingHost, setDetectingHost] = useState(false);
  const [checkingHosts, setCheckingHosts] = useState(false);
  const [hostNote, setHostNote] = useState<{ tone: 'success' | 'warning'; text: string } | null>(null);

  const { data, isLoading } = useQuery<OfficeLocation[]>({
    queryKey: ['office-locations'],
    queryFn: () => api.get('/hr/attendance/office-locations').then(r => r.data),
  });

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        name: form.name,
        latitude: Number(form.latitude),
        longitude: Number(form.longitude),
        radiusMeters: Number(form.radiusMeters),
        allowedIps: form.allowedIps.trim() || null,
      };
      return editing
        ? api.patch(`/hr/attendance/office-locations/${editing.id}`, payload)
        : api.post('/hr/attendance/office-locations', payload);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['office-locations'] }); closeModal(); },
    onError: (err: any) => setError(err?.response?.data?.error || 'Could not save office location.'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/hr/attendance/office-locations/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['office-locations'] }),
  });

  const toggleActive = useMutation({
    mutationFn: (loc: OfficeLocation) => api.patch(`/hr/attendance/office-locations/${loc.id}`, { isActive: !loc.isActive }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['office-locations'] }),
  });

  function openCreate() { setEditing(null); setForm(emptyOffice); setError(''); setHostNote(null); setModalOpen(true); }
  function openEdit(loc: OfficeLocation) {
    setEditing(loc);
    setForm({
      name: loc.name, latitude: String(loc.latitude), longitude: String(loc.longitude),
      radiusMeters: String(loc.radiusMeters), allowedIps: loc.allowedIps || '',
    });
    setError(''); setHostNote(null); setModalOpen(true);
  }
  function closeModal() { setModalOpen(false); setEditing(null); }

  function useMyLocation() {
    if (!navigator.geolocation) { setError('Geolocation is not supported on this device/browser.'); return; }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      pos => { setForm(f => ({ ...f, latitude: String(pos.coords.latitude), longitude: String(pos.coords.longitude) })); setLocating(false); },
      () => { setError('Could not get current location.'); setLocating(false); },
      { enableHighAccuracy: true, timeout: 15000 }
    );
  }

  // Fetches the caller's public IP exactly as the server sees it (same
  // extractClientIp() logic used at check-in time), so this can never
  // populate an IP that check-in would then fail to match.
  async function useMyIp() {
    setDetectingIp(true);
    setError('');
    try {
      const { data } = await api.get('/hr/attendance/my-ip');
      const ip = data?.ip;
      if (!ip) { setError('Could not detect your public IP.'); return; }
      setForm(f => {
        const existing = f.allowedIps.split(',').map(s => s.trim()).filter(Boolean);
        if (existing.includes(ip)) return f;
        return { ...f, allowedIps: [...existing, ip].join(', ') };
      });
    } catch {
      setError('Could not detect your public IP.');
    } finally {
      setDetectingIp(false);
    }
  }

  // Best-effort reverse-DNS of the current public IP. Only a name that
  // forward-resolves back to this IP is offered (anything else would never
  // match at check-in). Typical ISP dynamic IPs have no usable name — the
  // fallback message points the admin at a DDNS hostname instead.
  async function useMyDnsName() {
    setDetectingHost(true);
    setError('');
    setHostNote(null);
    try {
      const { data } = await api.get('/hr/attendance/my-host');
      if (data?.host && data.verified) {
        const host = data.host as string;
        setForm(f => {
          const existing = f.allowedIps.split(',').map(s => s.trim()).filter(Boolean);
          if (existing.includes(host)) return f;
          return { ...f, allowedIps: [...existing, host].join(', ') };
        });
        setHostNote({ tone: 'success', text: `Added ${host} — it currently resolves back to your IP (${data.ip}).` });
      } else if (data?.host) {
        setHostNote({ tone: 'warning', text: `Your IP's DNS name (${data.host}) doesn't resolve back to it, so it can't be used for check-in. Set up a free dynamic-DNS hostname (DuckDNS, No-IP, or your router's DDNS feature) and enter it here instead.` });
      } else {
        setHostNote({ tone: 'warning', text: 'Your current IP has no DNS name. Set up a free dynamic-DNS hostname (DuckDNS, No-IP, or your router\'s DDNS feature) and enter it here — it will follow your office IP automatically.' });
      }
    } catch {
      setError('Could not look up a DNS name for your IP.');
    } finally {
      setDetectingHost(false);
    }
  }

  // Verifies every hostname currently typed in the allowlist: does it
  // resolve, and does it point at this network right now?
  async function verifyHostnames() {
    const hosts = form.allowedIps.split(',').map(s => s.trim()).filter(h => h && /[a-z]/i.test(h));
    if (!hosts.length) { setHostNote({ tone: 'warning', text: 'No hostnames in the list yet — add one first.' }); return; }
    setCheckingHosts(true);
    setHostNote(null);
    try {
      const results = await Promise.all(hosts.map(h =>
        api.get('/hr/attendance/check-host', { params: { host: h } }).then(r => r.data).catch(() => ({ host: h, resolvedIps: [], matchesIp: false }))
      ));
      const lines = results.map((r: any) =>
        r.resolvedIps.length === 0 ? `${r.host}: does not resolve`
          : r.matchesIp ? `${r.host}: OK — points at your current IP`
          : `${r.host}: resolves to ${r.resolvedIps.join(', ')} (not your current network)`
      );
      const allOk = results.every((r: any) => r.matchesIp);
      setHostNote({ tone: allOk ? 'success' : 'warning', text: lines.join(' · ') });
    } finally {
      setCheckingHosts(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Office Locations"
        icon={<Building2 size={14} />}
        className="mb-3"
        actions={<Button size="sm" icon={<Plus size={13} />} onClick={openCreate}>Add Location</Button>}
      />
      <p className="text-xs text-fg-subtle mb-4">Employees must be within the radius of an active location, or on an allowed IP/network, to check in.</p>

      {isLoading ? <SkeletonTable rows={2} /> : (data || []).length === 0 ? (
        <EmptyState
          compact
          icon={<Building2 />}
          title="No office locations yet"
          description="Add your office's coordinates so employees can check in from on-site."
          action={{ label: 'Add location', onClick: openCreate }}
        />
      ) : (
        <div className="space-y-2">
          {(data || []).map(loc => (
            <div key={loc.id} className="flex items-center justify-between gap-3 p-3 border border-line-subtle rounded-card flex-wrap">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-fg text-sm">{loc.name}</span>
                  <Badge variant={loc.isActive ? 'green' : 'gray'}>{loc.isActive ? 'Active' : 'Inactive'}</Badge>
                </div>
                <p className="text-xs text-fg-subtle mt-0.5 tabular-nums">
                  {loc.latitude.toFixed(5)}, {loc.longitude.toFixed(5)} · {loc.radiusMeters}m radius
                  {loc.allowedIps && ` · IP allowlist: ${loc.allowedIps}`}
                </p>
              </div>
              <RowActions items={[
                { label: 'Edit', icon: <Pencil size={13} />, onClick: () => openEdit(loc) },
                { label: loc.isActive ? 'Deactivate' : 'Activate', icon: <MapPin size={13} />, onClick: () => toggleActive.mutate(loc) },
                { label: 'Delete', icon: <Trash2 size={13} />, variant: 'danger', onClick: () => { if (confirm(`Delete "${loc.name}"?`)) remove.mutate(loc.id); } },
              ]} />
            </div>
          ))}
        </div>
      )}

      <Modal open={modalOpen} onClose={closeModal} title={editing ? 'Edit office location' : 'Add office location'} icon={<Building2 size={16} />}
        footer={<>
          <Button variant="secondary" onClick={closeModal}>Cancel</Button>
          <Button onClick={() => { setError(''); save.mutate(); }} loading={save.isPending} disabled={!form.name || !form.latitude || !form.longitude}>
            {editing ? 'Save Changes' : 'Add Location'}
          </Button>
        </>}>
        <div className="space-y-1">
          {error && <Alert tone="danger" className="mb-3">{error}</Alert>}
          <div className="form-section">
            <p className="form-section-title">Location</p>
            <div className="space-y-4">
              <Field label="Name">
                <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Main Office" />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Latitude">
                  <Input value={form.latitude} onChange={e => setForm(f => ({ ...f, latitude: e.target.value }))} placeholder="12.9716" />
                </Field>
                <Field label="Longitude">
                  <Input value={form.longitude} onChange={e => setForm(f => ({ ...f, longitude: e.target.value }))} placeholder="77.5946" />
                </Field>
              </div>
              <Button variant="ghost" size="xs" icon={<MapPin size={12} />} loading={locating} onClick={useMyLocation} disabled={locating}>
                Use my current location
              </Button>
            </div>
          </div>
          <div className="form-section">
            <p className="form-section-title">Check-in rules</p>
            <div className="space-y-4">
              <Field label="Radius (meters)">
                <Input type="number" min={10} max={50000} value={form.radiusMeters} onChange={e => setForm(f => ({ ...f, radiusMeters: e.target.value }))} />
              </Field>
              <Field
                label="Allowed IPs / CIDR / hostname (optional)"
                hint="Comma-separated. If set, check-in also verifies the employee's public IP matches the office network. Office on a dynamic IP? Enter a dynamic-DNS hostname (e.g. office.myco.ddns.net) instead of an IP — it's resolved to the office's current address at every check-in."
              >
                <Input value={form.allowedIps} onChange={e => setForm(f => ({ ...f, allowedIps: e.target.value }))} placeholder="203.0.113.4, 203.0.113.0/24, office.myco.ddns.net" />
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  <Button variant="ghost" size="xs" icon={<Wifi size={12} />} loading={detectingIp} onClick={useMyIp} disabled={detectingIp}>
                    Use my current IP
                  </Button>
                  <Button variant="ghost" size="xs" icon={<Wifi size={12} />} loading={detectingHost} onClick={useMyDnsName} disabled={detectingHost}>
                    Use my DNS name
                  </Button>
                  <Button variant="ghost" size="xs" loading={checkingHosts} onClick={verifyHostnames} disabled={checkingHosts}>
                    Verify hostnames
                  </Button>
                </div>
                {hostNote && (
                  <p className={`mt-1.5 text-xs ${hostNote.tone === 'success' ? 'text-success' : 'text-warning-fg'}`}>
                    {hostNote.text}
                  </p>
                )}
              </Field>
            </div>
          </div>
        </div>
      </Modal>
    </Card>
  );
}

const COLOR_SWATCHES = ['#4f46e5', '#0891b2', '#059669', '#d97706', '#dc2626', '#7c3aed', '#db2777', '#64748b'];

function LeaveTypesSection() {
  const qc = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<LeaveType | null>(null);
  const [form, setForm] = useState(emptyType);
  const [error, setError] = useState('');

  const { data, isLoading } = useQuery<LeaveType[]>({
    queryKey: ['leave-types', 'all'],
    queryFn: () => api.get('/hr/leave/types', { params: { all: '1' } }).then(r => r.data),
  });

  const save = useMutation({
    mutationFn: () => {
      const payload = { name: form.name, annualQuota: Number(form.annualQuota), isPaid: form.isPaid, color: form.color };
      return editing
        ? api.patch(`/hr/leave/types/${editing.id}`, payload)
        : api.post('/hr/leave/types', payload);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['leave-types'] }); closeModal(); },
    onError: (err: any) => setError(err?.response?.data?.error || 'Could not save leave type.'),
  });

  const toggleActive = useMutation({
    mutationFn: (t: LeaveType) => t.isActive
      ? api.delete(`/hr/leave/types/${t.id}`)
      : api.patch(`/hr/leave/types/${t.id}`, { isActive: true }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['leave-types'] }),
  });

  function openCreate() { setEditing(null); setForm(emptyType); setError(''); setModalOpen(true); }
  function openEdit(t: LeaveType) {
    setEditing(t);
    setForm({ name: t.name, annualQuota: String(t.annualQuota), isPaid: t.isPaid, color: t.color });
    setError(''); setModalOpen(true);
  }
  function closeModal() { setModalOpen(false); setEditing(null); }

  return (
    <Card>
      <CardHeader
        title="Leave Types"
        icon={<Tag size={14} />}
        className="mb-3"
        actions={<Button size="sm" icon={<Plus size={13} />} onClick={openCreate}>Add Type</Button>}
      />

      {isLoading ? <SkeletonTable rows={2} /> : (data || []).length === 0 ? (
        <EmptyState
          compact
          icon={<Tag />}
          title="No leave types yet"
          description="Add the kinds of leave your team can take — Annual, Sick, Casual and so on."
          action={{ label: 'Add type', onClick: openCreate }}
        />
      ) : (
        <div className="space-y-2">
          {(data || []).map(t => (
            <div key={t.id} className="flex items-center justify-between gap-3 p-3 border border-line-subtle rounded-card flex-wrap">
              <div className="flex items-center gap-2 min-w-0">
                <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: t.color }} />
                <span className="font-medium text-fg text-sm truncate" title={t.name}>{t.name}</span>
                <span className="text-xs text-fg-subtle tabular-nums">{t.annualQuota} days/yr · {t.isPaid ? 'Paid' : 'Unpaid'}</span>
                {!t.isActive && <Badge variant="gray">Inactive</Badge>}
              </div>
              <RowActions items={[
                { label: 'Edit', icon: <Pencil size={13} />, onClick: () => openEdit(t) },
                { label: t.isActive ? 'Deactivate' : 'Activate', icon: <Tag size={13} />, onClick: () => toggleActive.mutate(t) },
              ]} />
            </div>
          ))}
        </div>
      )}

      <Modal open={modalOpen} onClose={closeModal} title={editing ? 'Edit leave type' : 'Add leave type'} icon={<Tag size={16} />} size="sm"
        footer={<>
          <Button variant="secondary" onClick={closeModal}>Cancel</Button>
          <Button onClick={() => { setError(''); save.mutate(); }} loading={save.isPending} disabled={!form.name}>
            {editing ? 'Save Changes' : 'Add Type'}
          </Button>
        </>}>
        <div className="space-y-4">
          {error && <Alert tone="danger">{error}</Alert>}
          <Field label="Name">
            <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Annual Leave" />
          </Field>
          <Field label="Annual quota (days)">
            <Input type="number" min={0} max={365} value={form.annualQuota} onChange={e => setForm(f => ({ ...f, annualQuota: e.target.value }))} />
          </Field>
          <Checkbox
            label="Paid leave"
            checked={form.isPaid}
            onChange={e => setForm(f => ({ ...f, isPaid: e.target.checked }))}
          />
          <Field label="Color">
            <div className="flex gap-2 flex-wrap">
              {COLOR_SWATCHES.map(c => (
                <button key={c} type="button" onClick={() => setForm(f => ({ ...f, color: c }))}
                  className={`w-7 h-7 rounded-full shrink-0 ${
                    form.color === c ? 'ring-2 ring-fg ring-offset-2 ring-offset-surface-raised' : ''
                  }`}
                  style={{ background: c }}
                  aria-label={c}
                />
              ))}
            </div>
          </Field>
        </div>
      </Modal>
    </Card>
  );
}

export default function HRSettingsPage() {
  return (
    <div>
      <PageHeader title="HR Settings" subtitle="Configure office locations and leave types" />
      <PageBody width="full" className="max-w-4xl mx-auto">
        <OfficeLocationsSection />
        <LeaveTypesSection />
      </PageBody>
    </div>
  );
}
