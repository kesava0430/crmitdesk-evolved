import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { PageHeader, Button, Modal, Badge, Spinner, EmptyState, RowActions } from '../../shared/components';
import { Building2, Plus, Pencil, Trash2, Tag, MapPin } from 'lucide-react';

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

  function openCreate() { setEditing(null); setForm(emptyOffice); setError(''); setModalOpen(true); }
  function openEdit(loc: OfficeLocation) {
    setEditing(loc);
    setForm({
      name: loc.name, latitude: String(loc.latitude), longitude: String(loc.longitude),
      radiusMeters: String(loc.radiusMeters), allowedIps: loc.allowedIps || '',
    });
    setError(''); setModalOpen(true);
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

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm font-semibold text-gray-800 flex items-center gap-1.5"><Building2 size={14} /> Office Locations</p>
        <Button size="sm" icon={<Plus size={13} />} onClick={openCreate}>Add Location</Button>
      </div>
      <p className="text-xs text-gray-400 mb-4">Employees must be within the radius of an active location, or on an allowed IP/network, to check in.</p>

      {isLoading ? <Spinner /> : (data || []).length === 0 ? (
        <EmptyState icon={<Building2 size={20} />} title="No office locations yet" description="Add one so employees can check in" />
      ) : (
        <div className="space-y-2">
          {(data || []).map(loc => (
            <div key={loc.id} className="flex items-center justify-between gap-3 p-3 border border-gray-100 rounded-xl flex-wrap">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-gray-800 text-sm">{loc.name}</span>
                  <Badge variant={loc.isActive ? 'green' : 'gray'}>{loc.isActive ? 'Active' : 'Inactive'}</Badge>
                </div>
                <p className="text-xs text-gray-400 mt-0.5">
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
        <div className="space-y-4">
          {error && <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{error}</p>}
          <div>
            <label className="form-label">Name</label>
            <input className="ui-input" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Main Office" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="form-label">Latitude</label>
              <input className="ui-input" value={form.latitude} onChange={e => setForm(f => ({ ...f, latitude: e.target.value }))} placeholder="12.9716" />
            </div>
            <div>
              <label className="form-label">Longitude</label>
              <input className="ui-input" value={form.longitude} onChange={e => setForm(f => ({ ...f, longitude: e.target.value }))} placeholder="77.5946" />
            </div>
          </div>
          <button type="button" onClick={useMyLocation} disabled={locating} className="text-xs font-medium text-brand-600 hover:text-brand-700 flex items-center gap-1">
            {locating ? <Spinner /> : <MapPin size={12} />} Use my current location
          </button>
          <div>
            <label className="form-label">Radius (meters)</label>
            <input className="ui-input" type="number" min={10} max={50000} value={form.radiusMeters} onChange={e => setForm(f => ({ ...f, radiusMeters: e.target.value }))} />
          </div>
          <div>
            <label className="form-label">Allowed IPs / CIDR (optional)</label>
            <input className="ui-input" value={form.allowedIps} onChange={e => setForm(f => ({ ...f, allowedIps: e.target.value }))} placeholder="203.0.113.4, 203.0.113.0/24" />
            <p className="text-[11px] text-gray-400 mt-1">Comma-separated. If set, check-in also verifies the employee's public IP matches the office network.</p>
          </div>
        </div>
      </Modal>
    </div>
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
    <div className="card p-5">
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm font-semibold text-gray-800 flex items-center gap-1.5"><Tag size={14} /> Leave Types</p>
        <Button size="sm" icon={<Plus size={13} />} onClick={openCreate}>Add Type</Button>
      </div>

      {isLoading ? <Spinner /> : (data || []).length === 0 ? (
        <EmptyState icon={<Tag size={20} />} title="No leave types yet" description="Add types like Annual, Sick, Casual" />
      ) : (
        <div className="space-y-2">
          {(data || []).map(t => (
            <div key={t.id} className="flex items-center justify-between gap-3 p-3 border border-gray-100 rounded-xl flex-wrap">
              <div className="flex items-center gap-2 min-w-0">
                <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: t.color }} />
                <span className="font-medium text-gray-800 text-sm">{t.name}</span>
                <span className="text-xs text-gray-400">{t.annualQuota} days/yr · {t.isPaid ? 'Paid' : 'Unpaid'}</span>
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
          {error && <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{error}</p>}
          <div>
            <label className="form-label">Name</label>
            <input className="ui-input" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Annual Leave" />
          </div>
          <div>
            <label className="form-label">Annual quota (days)</label>
            <input className="ui-input" type="number" min={0} max={365} value={form.annualQuota} onChange={e => setForm(f => ({ ...f, annualQuota: e.target.value }))} />
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={form.isPaid} onChange={e => setForm(f => ({ ...f, isPaid: e.target.checked }))} />
            Paid leave
          </label>
          <div>
            <label className="form-label">Color</label>
            <div className="flex gap-2 flex-wrap">
              {COLOR_SWATCHES.map(c => (
                <button key={c} type="button" onClick={() => setForm(f => ({ ...f, color: c }))}
                  className="w-7 h-7 rounded-full shrink-0"
                  style={{ background: c, outline: form.color === c ? '2px solid #111827' : 'none', outlineOffset: 2 }}
                  aria-label={c}
                />
              ))}
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
}

export default function HRSettingsPage() {
  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-4xl mx-auto">
      <PageHeader title="HR Settings" subtitle="Configure office locations and leave types" />
      <OfficeLocationsSection />
      <LeaveTypesSection />
    </div>
  );
}
