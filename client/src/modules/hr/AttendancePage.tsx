import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import { PageHeader, Spinner, Badge } from '../../shared/components';
import { LogIn, LogOut, MapPin, AlertCircle, Users } from 'lucide-react';

const MANAGER_ROLES = ['SUPER_ADMIN', 'IT_MANAGER', 'CRM_MANAGER'];

interface AttendanceRecord {
  id: string;
  date: string;
  checkInAt: string | null;
  checkOutAt: string | null;
  checkInLocationOk: boolean | null;
  checkInNetworkOk: boolean | null;
  source: string;
}

function fmtTime(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Wraps navigator.geolocation in a promise; rejects with a friendly message. */
function getPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Geolocation is not supported on this device/browser.'));
    navigator.geolocation.getCurrentPosition(resolve, err => {
      if (err.code === err.PERMISSION_DENIED) reject(new Error('Location permission denied — allow location access to mark attendance.'));
      else reject(new Error('Could not get your location. Please try again.'));
    }, { enableHighAccuracy: true, timeout: 15000 });
  });
}

function CheckInWidget() {
  const qc = useQueryClient();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'in' | 'out' | null>(null);
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const { data: month } = useQuery<AttendanceRecord[]>({
    queryKey: ['attendance-me'],
    queryFn: () => api.get('/hr/attendance/me').then(r => r.data),
  });
  const today = month?.find(r => new Date(r.date).toDateString() === new Date().toDateString());

  async function handle(action: 'in' | 'out') {
    setBusy(action); setError('');
    try {
      const pos = await getPosition();
      await api.post(`/hr/attendance/check-${action}`, { lat: pos.coords.latitude, lng: pos.coords.longitude });
      qc.invalidateQueries({ queryKey: ['attendance-me'] });
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Something went wrong.');
    } finally { setBusy(null); }
  }

  return (
    <div className="card p-6 text-center">
      <p className="text-3xl font-bold text-gray-900 tabular-nums">{now.toLocaleTimeString()}</p>
      <p className="text-sm text-gray-400 mt-1">{now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</p>

      <div className="flex items-center justify-center gap-6 mt-5 text-sm">
        <div>
          <p className="text-gray-400 text-xs uppercase tracking-wide">Checked in</p>
          <p className="font-semibold text-gray-800 mt-0.5">{fmtTime(today?.checkInAt ?? null)}</p>
        </div>
        <div className="w-px h-8 bg-gray-200" />
        <div>
          <p className="text-gray-400 text-xs uppercase tracking-wide">Checked out</p>
          <p className="font-semibold text-gray-800 mt-0.5">{fmtTime(today?.checkOutAt ?? null)}</p>
        </div>
      </div>

      {error && (
        <div className="mt-4 flex items-start gap-2 text-left bg-red-50 border border-red-100 text-red-700 text-xs px-3 py-2.5 rounded-xl">
          <AlertCircle size={14} className="shrink-0 mt-0.5" /> {error}
        </div>
      )}

      <div className="flex gap-3 mt-5 justify-center flex-wrap">
        <button
          onClick={() => handle('in')}
          disabled={!!today?.checkInAt || busy !== null}
          className="flex items-center gap-2 px-5 py-2.5 bg-green-600 hover:bg-green-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-xl transition-colors"
        >
          {busy === 'in' ? <Spinner /> : <LogIn size={15} />} Check In
        </button>
        <button
          onClick={() => handle('out')}
          disabled={!today?.checkInAt || !!today?.checkOutAt || busy !== null}
          className="flex items-center gap-2 px-5 py-2.5 bg-gray-800 hover:bg-gray-900 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-xl transition-colors"
        >
          {busy === 'out' ? <Spinner /> : <LogOut size={15} />} Check Out
        </button>
      </div>
      <p className="text-[11px] text-gray-400 mt-4 flex items-center justify-center gap-1.5">
        <MapPin size={11} /> Requires location access and being on-site
      </p>
    </div>
  );
}

function MyHistory() {
  const { data, isLoading } = useQuery<AttendanceRecord[]>({
    queryKey: ['attendance-me'],
    queryFn: () => api.get('/hr/attendance/me').then(r => r.data),
  });

  if (isLoading) return <Spinner />;
  return (
    <div className="card p-5">
      <p className="text-sm font-semibold text-gray-800 mb-3">This month</p>
      <div className="table-container">
        <table className="w-full text-sm min-w-[480px]">
          <thead><tr className="text-left text-xs text-gray-400 uppercase tracking-wide border-b border-gray-100">
            <th className="pb-2 font-medium">Date</th>
            <th className="pb-2 font-medium">Check In</th>
            <th className="pb-2 font-medium">Check Out</th>
            <th className="pb-2 font-medium">Verified</th>
          </tr></thead>
          <tbody className="divide-y divide-gray-50">
            {(data || []).map(r => (
              <tr key={r.id}>
                <td className="py-2.5">{new Date(r.date).toLocaleDateString()}</td>
                <td className="py-2.5">{fmtTime(r.checkInAt)}</td>
                <td className="py-2.5">{fmtTime(r.checkOutAt)}</td>
                <td className="py-2.5">
                  {r.source === 'MANUAL' ? <Badge variant="gray">Manual entry</Badge>
                    : r.checkInLocationOk && r.checkInNetworkOk ? <Badge variant="green">Verified</Badge>
                    : r.checkInAt ? <Badge variant="yellow">Partial</Badge> : '—'}
                </td>
              </tr>
            ))}
            {(data || []).length === 0 && (
              <tr><td colSpan={4} className="py-6 text-center text-gray-400">No records yet this month</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface TodayRow { user: { id: string; name: string; role: string; avatarUrl?: string }; record: AttendanceRecord | null }

function TeamToday() {
  const { data, isLoading } = useQuery<TodayRow[]>({
    queryKey: ['attendance-today'],
    queryFn: () => api.get('/hr/attendance/today').then(r => r.data),
  });

  if (isLoading) return <Spinner />;
  const rows = data || [];
  const present = rows.filter(r => r.record?.checkInAt).length;

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm font-semibold text-gray-800 flex items-center gap-1.5"><Users size={14} /> Team — Today</p>
        <span className="text-xs text-gray-400">{present} / {rows.length} checked in</span>
      </div>
      <div className="table-container">
        <table className="w-full text-sm min-w-[480px]">
          <thead><tr className="text-left text-xs text-gray-400 uppercase tracking-wide border-b border-gray-100">
            <th className="pb-2 font-medium">Employee</th>
            <th className="pb-2 font-medium">Check In</th>
            <th className="pb-2 font-medium">Check Out</th>
            <th className="pb-2 font-medium">Status</th>
          </tr></thead>
          <tbody className="divide-y divide-gray-50">
            {rows.map(({ user, record }) => (
              <tr key={user.id}>
                <td className="py-2.5">
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded-full bg-brand-100 text-brand-600 flex items-center justify-center text-xs font-bold shrink-0">
                      {user.name[0]?.toUpperCase()}
                    </div>
                    <span className="text-gray-800">{user.name}</span>
                  </div>
                </td>
                <td className="py-2.5">{fmtTime(record?.checkInAt ?? null)}</td>
                <td className="py-2.5">{fmtTime(record?.checkOutAt ?? null)}</td>
                <td className="py-2.5">
                  {!record?.checkInAt ? <Badge variant="red">Absent</Badge>
                    : record.checkInLocationOk && record.checkInNetworkOk ? <Badge variant="green">On-site</Badge>
                    : <Badge variant="yellow">Unverified</Badge>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function AttendancePage() {
  const { user } = useAuth();
  const isManager = MANAGER_ROLES.includes(user?.role || '');
  const [tab, setTab] = useState<'me' | 'team'>('me');

  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-4xl mx-auto">
      <PageHeader title="Attendance" subtitle="Mark and track daily attendance" />

      {isManager && (
        <div className="flex gap-1 bg-gray-100 p-1 rounded-xl w-fit">
          {(['me', 'team'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-4 py-1.5 text-[13px] font-semibold rounded-lg transition-all ${tab === t ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>
              {t === 'me' ? 'My Attendance' : 'Team'}
            </button>
          ))}
        </div>
      )}

      {tab === 'me' ? (
        <div className="space-y-5">
          <CheckInWidget />
          <MyHistory />
        </div>
      ) : (
        <TeamToday />
      )}
    </div>
  );
}
