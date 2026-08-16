import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import {
  PageHeader, PageBody, Card, CardHeader, Tabs, Button, Spinner, Badge, Alert, Avatar,
  DataTable, EmptyState,
} from '../../shared/components';
import { LogIn, LogOut, MapPin, Users, Clock } from 'lucide-react';
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

/** One check-in → check-out window, e.g. "09:02 – 13:30". */
function SessionChip({ session, compact = false }: { session: AttendanceRecord; compact?: boolean }) {
  const { time: fmtTime } = useFormat();
  return (
    <span
      className={`text-xs bg-surface-sunken border border-line-subtle rounded-badge text-fg-muted whitespace-nowrap ${
        compact ? 'px-1.5 py-0.5' : 'px-2 py-1'
      }`}
    >
      {fmtTime(session.checkInAt)}{compact ? '–' : ' – '}{session.checkOutAt ? fmtTime(session.checkOutAt) : 'now'}
    </span>
  );
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
    <Card padding="lg" className="text-center">
      <p className="text-3xl font-bold text-fg tabular-nums">{fmtTime(now)}</p>
      <p className="text-sm text-fg-subtle mt-1">
        {new Intl.DateTimeFormat(undefined, { timeZone: timezone, weekday: 'long', month: 'long', day: 'numeric' }).format(now)}
      </p>

      <div className="flex items-center justify-center gap-6 mt-5 text-sm">
        <div>
          <p className="text-fg-subtle text-xs uppercase tracking-wide">Status</p>
          <p className={`font-semibold mt-0.5 ${isCheckedInNow ? 'text-success' : 'text-fg'}`}>
            {isCheckedInNow ? 'Checked in' : 'Checked out'}
          </p>
        </div>
        <div className="w-px h-8 bg-line" />
        <div>
          <p className="text-fg-subtle text-xs uppercase tracking-wide">Today's total</p>
          <p className="font-semibold text-fg mt-0.5">{fmtHours(totalMinutesToday)}</p>
        </div>
        <div className="w-px h-8 bg-line" />
        <div>
          <p className="text-fg-subtle text-xs uppercase tracking-wide">Sessions</p>
          <p className="font-semibold text-fg mt-0.5">{todaysSessions.length}</p>
        </div>
      </div>

      {todaysSessions.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center justify-center gap-1.5">
          {[...todaysSessions].reverse().map(s => (
            <SessionChip key={s.id} session={s} />
          ))}
        </div>
      )}

      {error && <Alert tone="danger" className="mt-4 text-left">{error}</Alert>}

      <div className="flex gap-3 mt-5 justify-center flex-wrap">
        <Button
          size="lg"
          icon={<LogIn size={15} />}
          loading={busy === 'in'}
          onClick={() => handle('in')}
          disabled={isCheckedInNow || busy !== null}
        >
          Check In
        </Button>
        <Button
          size="lg"
          variant="secondary"
          icon={<LogOut size={15} />}
          loading={busy === 'out'}
          onClick={() => handle('out')}
          disabled={!isCheckedInNow || busy !== null}
        >
          Check Out
        </Button>
      </div>
      <p className="text-[11px] text-fg-subtle mt-4 flex items-center justify-center gap-1.5">
        <MapPin size={11} /> Requires location access and being on-site · check in/out as many times as you need in a day
      </p>
    </Card>
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
  const { date } = useFormat();
  const { data, isLoading } = useQuery<AttendanceRecord[]>({
    queryKey: ['attendance-me'],
    queryFn: () => api.get('/hr/attendance/me').then(r => r.data),
  });

  if (isLoading) return <Spinner />;
  const days = groupByDate(data || []);

  return (
    <Card padding="none">
      <div className="p-card pb-0">
        <CardHeader title="This month" />
      </div>
      <DataTable<DayGroup>
        minWidth={560}
        rows={days}
        rowKey={d => d.date}
        empty={<EmptyState compact icon={<Clock />} title="No records yet this month" />}
        columns={[
          { key: 'date', header: 'Date', cell: d => date(d.date) },
          {
            key: 'sessions',
            header: 'Sessions',
            cell: d => (
              <div className="flex flex-wrap gap-1">
                {[...d.sessions].reverse().map(s => <SessionChip key={s.id} session={s} compact />)}
              </div>
            ),
          },
          {
            key: 'total',
            header: 'Total',
            cell: d => <span className="font-medium text-fg">{fmtHours(sumWorkedMinutes(d.sessions))}</span>,
          },
          {
            key: 'verified',
            header: 'Verified',
            cell: d => {
              const allVerified = d.sessions.every(s => s.source === 'SELF' && s.checkInLocationOk && s.checkInNetworkOk);
              const anyManual = d.sessions.some(s => s.source === 'MANUAL');
              return anyManual ? <Badge variant="gray">Manual entry</Badge>
                : allVerified ? <Badge variant="green">Verified</Badge>
                : <Badge variant="yellow">Partial</Badge>;
            },
          },
        ]}
      />
    </Card>
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
  const { data, isLoading } = useQuery<TodayRow[]>({
    queryKey: ['attendance-today'],
    queryFn: () => api.get('/hr/attendance/today').then(r => r.data),
  });

  if (isLoading) return <Spinner />;
  const rows = data || [];
  const present = rows.filter(r => r.sessions.length > 0).length;

  return (
    <Card padding="none">
      <div className="p-card pb-0">
        <CardHeader
          title="Team — Today"
          icon={<Users size={14} />}
          actions={<span className="text-xs text-fg-subtle">{present} / {rows.length} checked in at some point</span>}
        />
      </div>
      <DataTable<TodayRow>
        minWidth={560}
        rows={rows}
        rowKey={r => r.user.id}
        columns={[
          {
            key: 'employee',
            header: 'Employee',
            cell: r => (
              <div className="flex items-center gap-2">
                <Avatar name={r.user.name} src={r.user.avatarUrl} size="sm" />
                <span className="text-fg">{r.user.name}</span>
              </div>
            ),
          },
          {
            key: 'sessions',
            header: 'Sessions',
            cell: r => r.sessions.length === 0 ? <span className="text-fg-subtle">—</span> : (
              <div className="flex flex-wrap gap-1">
                {r.sessions.map(s => <SessionChip key={s.id} session={s} compact />)}
              </div>
            ),
          },
          {
            key: 'total',
            header: 'Total today',
            muted: true,
            cell: r => (
              <span className="inline-flex items-center gap-1">
                <Clock size={12} className="text-fg-subtle" /> {fmtHours(r.totalMinutes)}
              </span>
            ),
          },
          {
            key: 'status',
            header: 'Status',
            cell: r => r.sessions.length === 0 ? <Badge variant="red">Absent</Badge>
              : r.isCheckedInNow ? <Badge variant="green">On-site now</Badge>
              : <Badge variant="yellow">Checked out</Badge>,
          },
        ]}
      />
    </Card>
  );
}

export default function AttendancePage() {
  const { user } = useAuth();
  const isManager = MANAGER_ROLES.includes(user?.role || '');
  const [tab, setTab] = useState<'me' | 'team'>('me');

  return (
    <div>
      <PageHeader
        title="Attendance"
        subtitle="Mark and track daily attendance"
        below={isManager ? (
          <Tabs<'me' | 'team'>
            aria-label="Attendance views"
            variant="segmented"
            value={tab}
            onChange={setTab}
            items={[
              { key: 'me', label: 'My Attendance' },
              { key: 'team', label: 'Team' },
            ]}
          />
        ) : undefined}
      />

      <PageBody width="full" className="max-w-4xl mx-auto">
        {tab === 'me' ? (
          <div className="space-y-5">
            <CheckInWidget />
            <MyHistory />
          </div>
        ) : (
          <TeamToday />
        )}
      </PageBody>
    </div>
  );
}
