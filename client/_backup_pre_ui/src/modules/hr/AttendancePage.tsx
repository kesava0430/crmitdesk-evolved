import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import { PageHeader, Spinner, Badge } from '../../shared/components';
import { LogIn, LogOut, MapPin, AlertCircle, Users, Clock } from 'lucide-react';
import { useFormat } from '../../hooks/useFormat';

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

function fmtHours(minutes: number) {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

/** Total worked minutes across a set of sessions — mirrors the server's
 *  sumWorkedMinutes() (attendanceVerification.ts): a completed session
 *  contributes checkOut - checkIn, a still-open one contributes up to now. */
function sumWorkedMinutes(sessions: AttendanceRecord[], now: Date = new Date()): number {
  let total = 0;
  for (const s of sessions) {
    if (!s.checkInAt) continue;
    const end = s.checkOutAt ? new Date(s.checkOutAt) : now;
    const mins = (end.getTime() - new Date(s.checkInAt).getTime()) / 60000;
    if (mins > 0) total += mins;
  }
  return total;
}

function isSameDay(iso: string, ref: Date) {
  return new Date(iso).toDateString() === ref.toDateString();
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
  const { time: fmtTime, timezone } = useFormat();
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
  // Multiple sessions can exist today — sorted newest-first by the API.
  const todaysSessions = (month || []).filter(r => isSameDay(r.date, now));
  const lastSession = todaysSessions[0] ?? null;
  const isCheckedInNow = !!(lastSession?.checkInAt && !lastSession?.checkOutAt);
  const totalMinutesToday = sumWorkedMinutes(todaysSessions, now);

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
      <p className="text-3xl font-bold text-gray-900 dark:text-white tabular-nums">{fmtTime(now)}</p>
      <p className="text-sm text-gray-400 dark:text-gray-500 mt-1">
        {new Intl.DateTimeFormat(undefined, { timeZone: timezone, weekday: 'long', month: 'long', day: 'numeric' }).format(now)}
      </p>

      <div className="flex items-center justify-center gap-6 mt-5 text-sm">
        <div>
          <p className="text-gray-400 dark:text-gray-500 text-xs uppercase tracking-wide">Status</p>
          <p className={`font-semibold mt-0.5 ${isCheckedInNow ? 'text-green-600 dark:text-green-400' : 'text-gray-800 dark:text-gray-200'}`}>
            {isCheckedInNow ? 'Checked in' : 'Checked out'}
          </p>
        </div>
        <div className="w-px h-8 bg-gray-200 dark:bg-gray-700" />
        <div>
          <p className="text-gray-400 dark:text-gray-500 text-xs uppercase tracking-wide">Today's total</p>
          <p className="font-semibold text-gray-800 dark:text-gray-200 mt-0.5">{fmtHours(totalMinutesToday)}</p>
        </div>
        <div className="w-px h-8 bg-gray-200 dark:bg-gray-700" />
        <div>
          <p className="text-gray-400 dark:text-gray-500 text-xs uppercase tracking-wide">Sessions</p>
          <p className="font-semibold text-gray-800 dark:text-gray-200 mt-0.5">{todaysSessions.length}</p>
        </div>
      </div>

      {todaysSessions.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center justify-center gap-1.5">
          {[...todaysSessions].reverse().map(s => (
            <span key={s.id} className="text-xs px-2 py-1 bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-lg text-gray-600 dark:text-gray-300">
              {fmtTime(s.checkInAt)} – {s.checkOutAt ? fmtTime(s.checkOutAt) : 'now'}
            </span>
          ))}
        </div>
      )}

      {error && (
        <div className="mt-4 flex items-start gap-2 text-left bg-red-50 dark:bg-red-500/10 border border-red-100 dark:border-red-500/30 text-red-700 dark:text-red-400 text-xs px-3 py-2.5 rounded-xl">
          <AlertCircle size={14} className="shrink-0 mt-0.5" /> {error}
        </div>
      )}

      <div className="flex gap-3 mt-5 justify-center flex-wrap">
        <button
          onClick={() => handle('in')}
          disabled={isCheckedInNow || busy !== null}
          className="flex items-center gap-2 px-5 py-2.5 bg-green-600 hover:bg-green-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-xl transition-colors"
        >
          {busy === 'in' ? <Spinner /> : <LogIn size={15} />} Check In
        </button>
        <button
          onClick={() => handle('out')}
          disabled={!isCheckedInNow || busy !== null}
          className="flex items-center gap-2 px-5 py-2.5 bg-gray-800 hover:bg-gray-900 dark:bg-gray-700 dark:hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-xl transition-colors"
        >
          {busy === 'out' ? <Spinner /> : <LogOut size={15} />} Check Out
        </button>
      </div>
      <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-4 flex items-center justify-center gap-1.5">
        <MapPin size={11} /> Requires location access and being on-site · check in/out as many times as you need in a day
      </p>
    </div>
  );
}

interface DayGroup { date: string; sessions: AttendanceRecord[] }

function groupByDate(records: AttendanceRecord[]): DayGroup[] {
  const map = new Map<string, AttendanceRecord[]>();
  for (const r of records) {
    const key = new Date(r.date).toDateString();
    const list = map.get(key) || [];
    list.push(r);
    map.set(key, list);
  }
  return Array.from(map.entries()).map(([, sessions]) => ({ date: sessions[0].date, sessions }));
}

function MyHistory() {
  const { time: fmtTime, date } = useFormat();
  const { data, isLoading } = useQuery<AttendanceRecord[]>({
    queryKey: ['attendance-me'],
    queryFn: () => api.get('/hr/attendance/me').then(r => r.data),
  });

  if (isLoading) return <Spinner />;
  const days = groupByDate(data || []);

  return (
    <div className="card p-5">
      <p className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-3">This month</p>
      <div className="table-container">
        <table className="w-full text-sm min-w-[560px]">
          <thead><tr className="text-left text-xs text-gray-400 dark:text-gray-500 uppercase tracking-wide border-b border-gray-100 dark:border-gray-800">
            <th className="pb-2 font-medium">Date</th>
            <th className="pb-2 font-medium">Sessions</th>
            <th className="pb-2 font-medium">Total</th>
            <th className="pb-2 font-medium">Verified</th>
          </tr></thead>
          <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
            {days.map(day => {
              const allVerified = day.sessions.every(s => s.source === 'SELF' && s.checkInLocationOk && s.checkInNetworkOk);
              const anyManual = day.sessions.some(s => s.source === 'MANUAL');
              return (
                <tr key={day.date}>
                  <td className="py-2.5 align-top dark:text-gray-300">{date(day.date)}</td>
                  <td className="py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {[...day.sessions].reverse().map(s => (
                        <span key={s.id} className="text-xs px-1.5 py-0.5 bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded text-gray-500 dark:text-gray-400 whitespace-nowrap">
                          {fmtTime(s.checkInAt)}–{s.checkOutAt ? fmtTime(s.checkOutAt) : 'now'}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="py-2.5 align-top font-medium text-gray-700 dark:text-gray-300">{fmtHours(sumWorkedMinutes(day.sessions))}</td>
                  <td className="py-2.5 align-top">
                    {anyManual ? <Badge variant="gray">Manual entry</Badge>
                      : allVerified ? <Badge variant="green">Verified</Badge>
                      : <Badge variant="yellow">Partial</Badge>}
                  </td>
                </tr>
              );
            })}
            {days.length === 0 && (
              <tr><td colSpan={4} className="py-6 text-center text-gray-400 dark:text-gray-500">No records yet this month</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface TodayRow {
  user: { id: string; name: string; role: string; avatarUrl?: string };
  sessions: AttendanceRecord[];
  record: AttendanceRecord | null;
  isCheckedInNow: boolean;
  totalMinutes: number;
}

function TeamToday() {
  const { time: fmtTime } = useFormat();
  const { data, isLoading } = useQuery<TodayRow[]>({
    queryKey: ['attendance-today'],
    queryFn: () => api.get('/hr/attendance/today').then(r => r.data),
  });

  if (isLoading) return <Spinner />;
  const rows = data || [];
  const present = rows.filter(r => r.sessions.length > 0).length;

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm font-semibold text-gray-800 dark:text-gray-200 flex items-center gap-1.5"><Users size={14} /> Team — Today</p>
        <span className="text-xs text-gray-400 dark:text-gray-500">{present} / {rows.length} checked in at some point</span>
      </div>
      <div className="table-container">
        <table className="w-full text-sm min-w-[560px]">
          <thead><tr className="text-left text-xs text-gray-400 dark:text-gray-500 uppercase tracking-wide border-b border-gray-100 dark:border-gray-800">
            <th className="pb-2 font-medium">Employee</th>
            <th className="pb-2 font-medium">Sessions</th>
            <th className="pb-2 font-medium">Total today</th>
            <th className="pb-2 font-medium">Status</th>
          </tr></thead>
          <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
            {rows.map(({ user, sessions, isCheckedInNow, totalMinutes }) => (
              <tr key={user.id}>
                <td className="py-2.5">
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded-full bg-brand-100 dark:bg-brand-500/20 text-brand-600 dark:text-brand-400 flex items-center justify-center text-xs font-bold shrink-0">
                      {user.name[0]?.toUpperCase()}
                    </div>
                    <span className="text-gray-800 dark:text-gray-200">{user.name}</span>
                  </div>
                </td>
                <td className="py-2.5">
                  {sessions.length === 0 ? <span className="text-gray-300 dark:text-gray-600">—</span> : (
                    <div className="flex flex-wrap gap-1">
                      {sessions.map(s => (
                        <span key={s.id} className="text-xs px-1.5 py-0.5 bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded text-gray-500 dark:text-gray-400 whitespace-nowrap">
                          {fmtTime(s.checkInAt)}–{s.checkOutAt ? fmtTime(s.checkOutAt) : 'now'}
                        </span>
                      ))}
                    </div>
                  )}
                </td>
                <td className="py-2.5 text-gray-600 dark:text-gray-400 flex items-center gap-1"><Clock size={12} className="text-gray-300 dark:text-gray-600" /> {fmtHours(totalMinutes)}</td>
                <td className="py-2.5">
                  {sessions.length === 0 ? <Badge variant="red">Absent</Badge>
                    : isCheckedInNow ? <Badge variant="green">On-site now</Badge>
                    : <Badge variant="yellow">Checked out</Badge>}
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
        <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 p-1 rounded-xl w-fit">
          {(['me', 'team'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-4 py-1.5 text-[13px] font-semibold rounded-lg transition-all ${tab === t ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}>
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
