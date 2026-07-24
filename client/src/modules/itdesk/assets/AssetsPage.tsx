import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../api/client';
import {
  Monitor, Plus, Search, Pencil, Trash2, X, ChevronDown,
  Package, Wrench, Archive, Activity
} from 'lucide-react';
import { SearchableSelect, RowActions } from '../../../shared/components';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Asset {
  id: string;
  name: string;
  type: string;
  serialNumber?: string | null;
  assignedTo?: string | null;
  status: string;
  purchaseDate?: string | null;
  createdAt: string;
  assignee?: { id: string; name: string; email: string } | null;
}

interface Stats {
  total: number;
  active: number;
  retired: number;
  inRepair: number;
  byType: Array<{ type: string; _count: number }>;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const STATUSES = ['active', 'inactive', 'retired', 'in_repair'];
const ASSET_TYPES = ['Laptop', 'Desktop', 'Monitor', 'Phone', 'Tablet', 'Server', 'Printer', 'Network', 'Peripheral', 'Other'];

const STATUS_COLOR: Record<string, string> = {
  active:    'bg-green-100 text-green-700',
  inactive:  'bg-gray-100 text-gray-600',
  retired:   'bg-red-100 text-red-700',
  in_repair: 'bg-yellow-100 text-yellow-700',
};

const STATUS_LABEL: Record<string, string> = {
  active: 'Active', inactive: 'Inactive', retired: 'Retired', in_repair: 'In Repair',
};

// ─── Asset Form Modal ─────────────────────────────────────────────────────────

interface FormData {
  name: string; type: string; serialNumber: string;
  assignedTo: string; status: string; purchaseDate: string;
}

const EMPTY: FormData = { name: '', type: 'Laptop', serialNumber: '', assignedTo: '', status: 'active', purchaseDate: '' };

function AssetModal({ asset, users, onClose }: {
  asset?: Asset; users: { id: string; name: string }[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState<FormData>(asset ? {
    name: asset.name, type: asset.type, serialNumber: asset.serialNumber ?? '',
    assignedTo: asset.assignedTo ?? '', status: asset.status,
    purchaseDate: asset.purchaseDate ? asset.purchaseDate.split('T')[0] : '',
  } : EMPTY);

  const save = useMutation({
    mutationFn: (data: any) =>
      asset ? api.patch(`/itdesk/assets/${asset.id}`, data) : api.post('/itdesk/assets', data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['assets'] }); onClose(); },
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    save.mutate({
      name: form.name, type: form.type,
      serialNumber: form.serialNumber || undefined,
      assignedTo: form.assignedTo || null,
      status: form.status,
      purchaseDate: form.purchaseDate || null,
    });
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div role="dialog" aria-modal="true" className="bg-white rounded-2xl w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="font-semibold text-gray-900">{asset ? 'Edit Asset' : 'Add Asset'}</h2>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-gray-100"><X size={16} /></button>
        </div>
        <form onSubmit={submit} className="p-6 space-y-3">
          <div className="form-section">
            <p className="form-section-title">Asset Information</p>
            <div className="space-y-4">
              <div>
                <label className="form-label">Asset Name <span className="req">*</span></label>
                <input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} required
                  aria-label="Name" className="ui-input" placeholder="e.g. MacBook Pro 14" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="form-label">Type <span className="req">*</span></label>
<SearchableSelect ariaLabel="Type" value={form.type} onChange={val => setForm(p => ({ ...p, type: val }))} required options={ASSET_TYPES.map(t => ({ value: t, label: t }))} />
                </div>
                <div>
                  <label className="form-label">Status</label>
<SearchableSelect ariaLabel="Status" value={form.status} onChange={val => setForm(p => ({ ...p, status: val }))} required options={STATUSES.map(s => ({ value: s, label: STATUS_LABEL[s] }))} />
                </div>
              </div>
              <div>
                <label className="form-label">Serial Number</label>
                <input value={form.serialNumber} onChange={e => setForm(p => ({ ...p, serialNumber: e.target.value }))}
                  aria-label="Serial Number" className="ui-input" placeholder="e.g. SN-12345" />
              </div>
            </div>
          </div>
          <div className="form-section">
            <p className="form-section-title">Assignment</p>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="form-label">Assigned To</label>
<SearchableSelect ariaLabel="Assigned To" value={form.assignedTo} onChange={val => setForm(p => ({ ...p, assignedTo: val }))} options={users.map(u => ({ value: u.id, label: u.name }))} placeholder="— Unassigned —" />
              </div>
              <div>
                <label className="form-label">Purchase Date</label>
                <input type="date" value={form.purchaseDate} onChange={e => setForm(p => ({ ...p, purchaseDate: e.target.value }))} className="ui-input" />
              </div>
            </div>
          </div>
          <div className="flex gap-3 pt-1">
            <button type="button" onClick={onClose} className="flex-1 py-2 border border-gray-200 rounded-xl text-sm text-gray-600 hover:bg-gray-50">Cancel</button>
            <button type="submit" disabled={save.isPending} className="flex-1 py-2 bg-brand-600 text-white rounded-xl text-sm font-semibold hover:bg-brand-700 disabled:opacity-50">
              {save.isPending ? 'Saving…' : asset ? 'Save Changes' : 'Save Asset'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function AssetsPage() {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterType, setFilterType] = useState('');
  const [modal, setModal] = useState<Asset | null | 'new'>(null);

  const { data: statsData } = useQuery<Stats>({
    queryKey: ['assets-stats'],
    queryFn: () => api.get('/itdesk/assets/stats').then(r => r.data),
  });

  const { data: usersData } = useQuery({
    queryKey: ['users-list'],
    queryFn: () => api.get('/admin/users').then(r => r.data?.data ?? r.data ?? []),
  });

  const params = new URLSearchParams();
  if (search) params.set('search', search);
  if (filterStatus) params.set('status', filterStatus);
  if (filterType) params.set('type', filterType);
  params.set('limit', '50');

  const { data, isLoading } = useQuery<{ data: Asset[]; total: number }>({
    queryKey: ['assets', search, filterStatus, filterType],
    queryFn: () => api.get(`/itdesk/assets?${params}`).then(r => r.data),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/itdesk/assets/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['assets'] });
      qc.invalidateQueries({ queryKey: ['assets-stats'] });
    },
  });

  const assets = data?.data ?? [];
  const users = usersData ?? [];

  return (
    <div className="p-4 sm:p-6 animate-slide-up">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Assets</h1>
          <p className="text-sm text-gray-500 mt-0.5">Track hardware and software across your organization</p>
        </div>
        <button onClick={() => setModal('new')}
          className="flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-xl text-sm font-semibold hover:bg-brand-700">
          <Plus size={16} /> Add Asset
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-6">
        {[
          { label: 'Total', value: statsData?.total ?? 0, icon: Package, color: 'text-brand-600 bg-brand-50' },
          { label: 'Active', value: statsData?.active ?? 0, icon: Activity, color: 'text-green-600 bg-green-50' },
          { label: 'In Repair', value: statsData?.inRepair ?? 0, icon: Wrench, color: 'text-yellow-600 bg-yellow-50' },
          { label: 'Retired', value: statsData?.retired ?? 0, icon: Archive, color: 'text-red-600 bg-red-50' },
        ].map(({ label, value, icon: Icon, color }) => (
          <div key={label} className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 p-4 card-hover shadow-sm">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-medium text-gray-500">{label}</p>
              <div className={`w-8 h-8 rounded-xl flex items-center justify-center shadow-sm ${color}`}>
                <Icon size={15} />
              </div>
            </div>
            <p className="text-2xl font-bold text-gray-900 tabular-nums">{value}</p>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="relative flex-1 min-w-[160px] max-w-xs">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search assets…"
            className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand-500" />
        </div>
        <div className="relative">
          <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
            className="appearance-none pl-3 pr-8 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none bg-white">
            <option value="">All Statuses</option>
            {STATUSES.map(s => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </select>
          <ChevronDown size={12} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
        </div>
        <div className="relative">
          <select value={filterType} onChange={e => setFilterType(e.target.value)}
            className="appearance-none pl-3 pr-8 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none bg-white">
            <option value="">All Types</option>
            {ASSET_TYPES.map(t => <option key={t}>{t}</option>)}
          </select>
          <ChevronDown size={12} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
        </div>
        <p className="text-sm text-gray-400 ml-auto">{data?.total ?? 0} assets</p>
      </div>

      {/* Table */}
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 shadow-sm overflow-hidden">
        {isLoading ? (
          <div className="text-center py-12 text-gray-400 text-sm">Loading assets…</div>
        ) : assets.length === 0 ? (
          <div className="text-center py-16">
            <Monitor size={40} className="text-gray-200 mx-auto mb-3" />
            <p className="text-sm font-medium text-gray-500">No assets found</p>
            <p className="text-xs text-gray-400 mt-1">Add your first asset to start tracking</p>
          </div>
        ) : (
          <div className="table-container">
            <table className="w-full text-sm min-w-[640px]">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50/50">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Asset</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Type</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider hidden sm:table-cell">Serial #</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Assigned To</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Status</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider hidden sm:table-cell">Purchase Date</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {assets.map(asset => (
                  <tr key={asset.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                    <td className="px-4 py-3">
                      <p className="font-medium text-gray-900">{asset.name}</p>
                    </td>
                    <td className="px-4 py-3 text-gray-600">{asset.type}</td>
                    <td className="px-4 py-3 text-gray-500 font-mono text-xs hidden sm:table-cell">{asset.serialNumber ?? '—'}</td>
                    <td className="px-4 py-3">
                      {asset.assignee ? (
                        <div className="flex items-center gap-2">
                          <div className="w-6 h-6 rounded-full bg-brand-100 text-brand-700 text-xs font-bold flex items-center justify-center flex-shrink-0">
                            {asset.assignee.name[0]}
                          </div>
                          <span className="text-gray-700 truncate max-w-[100px]">{asset.assignee.name}</span>
                        </div>
                      ) : (
                        <span className="text-gray-400 italic">Unassigned</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLOR[asset.status] ?? 'bg-gray-100 text-gray-600'}`}>
                        {STATUS_LABEL[asset.status] ?? asset.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-500 hidden sm:table-cell">
                      {asset.purchaseDate ? new Date(asset.purchaseDate).toLocaleDateString() : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1 justify-end">
                        <RowActions items={[
                          { label: 'Edit asset', icon: <Pencil size={14} />, onClick: () => setModal(asset) },
                          { label: 'Delete asset', icon: <Trash2 size={14} />, onClick: () => { if (confirm('Delete this asset?')) remove.mutate(asset.id); }, variant: 'danger' },
                        ]} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Modal */}
      {modal && (
        <AssetModal
          asset={modal === 'new' ? undefined : modal}
          users={users}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}
