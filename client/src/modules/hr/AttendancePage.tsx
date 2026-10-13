import { useState, useEffect, lazy, Suspense } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import {
  PageHeader, PageBody, Card, CardHeader, Tabs, Button, Badge, Alert, Avatar,
  DataTable, EmptyState, IconButton,
} from '../../shared/components';
import { LogIn, LogOut, MapPin, Users, Clock, ScanFace, ChevronLeft, ChevronRight, PartyPopper } from 'lucide-react';
import { useFormat } from '../../hooks/useFormat';
import { FaceCaptureModal, type FaceSample } from '../../shared/components/FaceCaptureModal';
import { RegisterSection } from './attendance/RegisterSection';
import { useMyPolicy, useOptionalHolidays, useSetOptionalHoliday } from '../../api/attendanceAdmin';
const LiveMap = lazy(() => import('./LiveMap').then(m => ({ default: m.LiveMap })));

const MANAGER_ROLES = ['SUPER_ADMIN', 'IT_MANAGER', 'CRM_MANAGER'];

interface AttendanceRecord {
  id: string;
  date: string;
  /** Calendar day (YYYY-MM-DD) the session belongs to in the policy time zone — computed by the server */
  day?: string;
  checkInAt: string | null;
  checkOutAt: string | null;
  checkInLocationOk: boolean | null;
  checkInNetworkOk: boolean | null;
  checkInFaceOk?: boolean | null;
  checkInFaceDistance?: number | null;
  checkInPassed?: boolean | null;
  checkOutFaceOk?: boolean | null;
  checkOutPassed?: boolean | null;
  checkOutSource?: string | null;
  source: string;
}

interface VerificationRule { location: boolean; network: boolean; face: boolean; mode: 'ALL' | 'ANY'; enforce: boolean }
interface AttendancePolicy {
  checkInRule: VerificationRule;
  checkOutRule: VerificationRule;
  faceVerificationRequired: boolean;
  faceMatchThreshold: number;
  keepCheckInSelfie: boolean;
  autoCheckoutOnLeave: boolean;
  autoCheckoutAfterMinutes: number;
  heartbeatTimeoutMinutes: number;
  shareLiveLocation: boolean;
  myEnrollment: { samples: number; enrolledAt: string; updatedAt: string; referenceSelfie: string | null } | null;
  /** Latest re-enrolment request. Separate from the enrolment above: a
   *  PENDING request does not change the face attendance matches against. */
  myFaceRequest: { id: string; status: 'PENDING' | 'APPROVED' | 'REJECTED'; samples: number; rejectionReason: string | null; createdAt: string; decidedAt: string | null } | null;
}

function useAttendancePolicy() {
  return useQuery<AttendancePolicy>({
    queryKey: ['attendance-policy'],
    queryFn: () => api.get('/hr/attendance/policy').then(r => r.data),
  });
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

/** GET /hr/attendance/me/today — the server decides what "today" is (policy time zone, night
 *  shifts) and returns the open session from any day, so the client never compares dates itself. */
interface TodayData { date: string; timezone: string; shiftStart: string; shiftEnd: string; sessions: AttendanceRecord[]; openSession: AttendanceRecord | null }

/** "location and network", "location or face", "no verification" */
function ruleSummary(r: VerificationRule) {
  const on = [r.location && 'location', r.network && 'office network', r.face && 'face'].filter(Boolean) as string[];
  if (on.length === 0) return 'no verification';
  const text = on.length === 1 ? on[0] : on.slice(0, -1).join(', ') + (r.mode === 'ALL' ? ' and ' : ' or ') + on[on.length - 1];
  return r.enforce ? text : `${text} (recorded only)`;
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
      className={`text-xs tabular-nums bg-surface-sunken border border-line-subtle rounded-badge text-fg-muted whitespace-nowrap ${
        compact ? 'px-1.5 py-0.5' : 'px-2 py-1'
      }`}
    >
      {fmtTime(session.checkInAt)}{compact ? '–' : ' – '}{session.checkOutAt ? fmtTime(session.checkOutAt) : 'now'}
      {session.checkOutSource === 'AUTO_GEOFENCE' && <span title="Checked out automatically after leaving the office" className="ml-1 text-warning">⤴</span>}
      {session.checkOutSource === 'AUTO_TIMEOUT' && <span title="Checked out automatically — app lost contact" className="ml-1 text-fg-subtle">⏱</span>}
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

  const { data: today } = useQuery<TodayData>({
    queryKey: ['attendance-me', 'today'],
    queryFn: () => api.get('/hr/attendance/me/today').then(r => r.data),
    refetchInterval: 5 * 60_000,
  });
  const { data: policy } = useAttendancePolicy();
  const { data: myPolicy } = useMyPolicy();
  const [face, setFace] = useState<{ mode: 'enrol' | 'verify'; action: 'in' | 'out' } | null>(null);
  // Multiple sessions can exist today — sorted newest-first by the API.
  const todaysSessions = today?.sessions ?? [];
  const isCheckedInNow = !!today?.openSession;
  const totalMinutesToday = sumWorkedMinutes(todaysSessions, now);
  const enrolled = !!policy?.myEnrollment;
  const ruleFor = (action: 'in' | 'out') => (action === 'in' ? policy?.checkInRule : policy?.checkOutRule);
  const needsLocation = (action: 'in' | 'out') => { const r = ruleFor(action); return !r || r.location || r.network; };

  async function postCheck(action: 'in' | 'out', extra: Record<string, unknown> = {}) {
    // Location is only requested when the rule uses it (or the network check, which is recorded alongside).
    // Otherwise none is sent at all — 0,0 used to be stored and plotted in the Atlantic.
    let coords: { lat?: number; lng?: number } = {};
    if (needsLocation(action)) { const pos = await getPosition(); coords = { lat: pos.coords.latitude, lng: pos.coords.longitude }; }
    await api.post(`/hr/attendance/check-${action}`, { ...coords, ...extra });
    qc.invalidateQueries({ queryKey: ['attendance-me'] });
  }

  async function handle(action: 'in' | 'out') {
    setError('');
    // When the rule includes a face, capture it up front (enrolling first if needed) —
    // the server then combines it with location/network per the org's AND/OR rule.
    if (ruleFor(action)?.face) {
      setFace({ mode: enrolled ? 'verify' : 'enrol', action });
      return;
    }
    setBusy(action);
    try {
      await postCheck(action);
    } catch (err: any) {
      const code = err?.response?.data?.code;
      if (code === 'FACE_NOT_ENROLLED' || code === 'FACE_REQUIRED') {
        qc.invalidateQueries({ queryKey: ['attendance-policy'] });
        setFace({ mode: code === 'FACE_NOT_ENROLLED' ? 'enrol' : 'verify', action });
        return;
      }
      setError(err?.response?.data?.error || err?.message || 'Something went wrong.');
    } finally { setBusy(null); }
  }

  /** Called by the capture modal with the live sample(s); throws so the modal can show the server's reason. */
  async function onFaceCaptured(samples: FaceSample[]) {
    if (!face) return;
    if (face.mode === 'enrol') {
      await api.post('/hr/attendance/face/enrol', { descriptors: samples.map(s => s.descriptor), referenceSelfie: samples[0]?.selfie });
      qc.invalidateQueries({ queryKey: ['attendance-policy'] });
    }
    // Straight on to the actual check-in/out with the last sample so the user isn't asked twice
    const last = samples[samples.length - 1];
    await postCheck(face.action, { faceDescriptor: last.descriptor, selfie: last.selfie });
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
          <p className="font-semibold text-fg mt-0.5 tabular-nums">{fmtHours(totalMinutesToday)}</p>
        </div>
        <div className="w-px h-8 bg-line" />
        <div>
          <p className="text-fg-subtle text-xs uppercase tracking-wide">Sessions</p>
          <p className="font-semibold text-fg mt-0.5 tabular-nums">{todaysSessions.length}</p>
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
      <p className="text-[11px] text-fg-subtle mt-4 flex items-center justify-center gap-1.5 flex-wrap">
        {policy ? (
          <>
            <MapPin size={11} /> Check-in: {ruleSummary(policy.checkInRule)} · Check-out: {ruleSummary(policy.checkOutRule)}
            {policy.faceVerificationRequired && <> · <ScanFace size={11} /> face</>}
            {myPolicy && <> · shift {myPolicy.shiftStart}–{myPolicy.shiftEnd}{myPolicy.timezone && myPolicy.timezone !== timezone ? ` (${myPolicy.timezone})` : ''}</>}
            {policy.autoCheckoutOnLeave && <> · auto check-out after {policy.autoCheckoutAfterMinutes} min outside the office (keep the app open)</>}
            {policy.shareLiveLocation && <> · your location is shared with managers while you're checked in</>}
          </>
        ) : <><MapPin size={11} /> Requires location access and being on-site</>}
        {' '}· check in/out as many times as you need in a day
      </p>

      {face && (
        <FaceCaptureModal
          open
          mode={face.mode}
          onClose={() => setFace(null)}
          onCaptured={onFaceCaptured}
          title={face.mode === 'enrol' ? `Enrol your face to check ${face.action}` : 'Face verification'}
          subtitle={face.mode === 'enrol'
            ? `Your organisation's check-${face.action} rule includes face verification. We'll capture 3 quick samples now and check you ${face.action} straight after. A numeric face signature and one reference photo are stored for matching${policy?.keepCheckInSelfie ? ', and a small photo is kept with each verified check-in for your manager to review' : ''}.`
            : undefined}
        />
      )}
    </Card>
  );
}

/**
 * Self-service view of the user's enrolled face. Shown only when the org
 * requires face verification.
 *
 * First enrolment applies immediately; replacing an enrolled face raises a
 * request a Super Admin has to approve, and the existing face keeps working
 * for attendance throughout. There is no "remove" action — it would be a way
 * to reach the unreviewed first-enrolment path by deleting your way back to
 * it, and the server refuses that route for the same reason.
 */
function FaceIdCard() {
  const qc = useQueryClient();
  const { data: policy } = useAttendancePolicy();
  const { date } = useFormat();
  const [mode, setMode] = useState<'enrol' | 'reenrol' | null>(null);
  if (!policy?.faceVerificationRequired) return null;
  const e = policy.myEnrollment;
  const request = policy.myFaceRequest;
  const pending = request?.status === 'PENDING';
  const rejected = request?.status === 'REJECTED';

  async function enrol(samples: FaceSample[]) {
    await api.post('/hr/attendance/face/enrol', { descriptors: samples.map(s => s.descriptor), referenceSelfie: samples[0]?.selfie });
    qc.invalidateQueries({ queryKey: ['attendance-policy'] });
  }
  async function submitReenrolment(samples: FaceSample[]) {
    await api.post('/hr/attendance/face/reenrol', {
      descriptors: samples.map(s => s.descriptor),
      sampleImages: samples.map(s => s.selfie),
    });
    qc.invalidateQueries({ queryKey: ['attendance-policy'] });
  }

  return (
    <Card>
      <CardHeader title="Face ID" subtitle="Used to confirm it's you at check-in." />
      <div className="flex items-center gap-4 mt-3 flex-wrap">
        {e?.referenceSelfie ? (
          <img src={e.referenceSelfie} alt="Enrolled face" className="w-16 h-16 rounded-lg object-cover -scale-x-100 border border-line" />
        ) : (
          <div className="w-16 h-16 rounded-lg bg-surface-sunken border border-line flex items-center justify-center text-fg-subtle"><ScanFace size={22} /></div>
        )}
        <div className="flex-1 min-w-[180px]">
          {e ? (
            <>
              <p className="text-[13px] font-medium text-fg flex items-center gap-2">
                Verified <Badge variant="green">{e.samples} samples</Badge>
                {pending && <Badge variant="orange">Pending Verification</Badge>}
              </p>
              <p className="text-[12px] text-fg-muted">
                {pending
                  ? `Replacement submitted ${date(request!.createdAt)} — your current Face ID stays active until it's approved.`
                  : `Since ${date(e.enrolledAt)}. Your face signature and reference photo are stored for matching; ask HR to remove them.`}
              </p>
            </>
          ) : (
            <>
              <p className="text-[13px] font-medium text-fg">Not enrolled yet</p>
              <p className="text-[12px] text-fg-muted">You'll be asked to enrol the first time you check in, or do it now.</p>
            </>
          )}
        </div>
        <div className="flex gap-2">
          {/* Hidden rather than disabled while pending: there is no second
              request to make, so the button has nothing to offer. */}
          {!pending && (
            <Button size="sm" variant="secondary" icon={<ScanFace size={14} />} onClick={() => setMode(e ? 'reenrol' : 'enrol')}>
              {e ? 'Re-enrol' : 'Enrol now'}
            </Button>
          )}
        </div>
      </div>

      {rejected && e && (
        <Alert tone="warning" className="mt-3">
          Your last re-enrolment request was rejected{request?.decidedAt ? ` on ${date(request.decidedAt)}` : ''}.
          {request?.rejectionReason ? ` Reason: ${request.rejectionReason}` : ''} Your existing Face ID is unchanged — you can submit a new request.
        </Alert>
      )}

      {mode === 'enrol' && <FaceCaptureModal open mode="enrol" onClose={() => setMode(null)} onCaptured={enrol} />}
      {mode === 'reenrol' && (
        <FaceCaptureModal
          open
          mode="enrol"
          onClose={() => setMode(null)}
          onCaptured={submitReenrolment}
          submitLabel="Submit for Verification"
          title="Re-enrol your face"
          subtitle="We'll capture 3 samples and send them to a Super Admin for approval. Your current Face ID keeps working for attendance until they approve the replacement."
        />
      )}
    </Card>
  );
}

interface DayGroup { date: string; sessions: AttendanceRecord[] }

/** Groups by the server-computed `day` key (policy time zone) — never by a device-local
 *  toDateString() of a UTC date, which split or merged days east/west of UTC. */
function groupByDate(records: AttendanceRecord[]): DayGroup[] {
  const map = new Map<string, AttendanceRecord[]>();
  for (const r of records) {
    const key = r.day ?? r.date.slice(0, 10);
    const list = map.get(key) || [];
    list.push(r);
    map.set(key, list);
  }
  return Array.from(map.entries()).map(([key, sessions]) => ({ date: key, sessions }));
}

const monthKeyOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
function shiftMonthKey(m: string, delta: number) { const [y, mo] = m.split('-').map(Number); return monthKeyOf(new Date(y, mo - 1 + delta, 1)); }

function MyHistory() {
  const [month, setMonth] = useState(monthKeyOf(new Date()));
  const { data, isLoading } = useQuery<AttendanceRecord[]>({
    queryKey: ['attendance-me', 'month', month],
    queryFn: () => api.get('/hr/attendance/me', { params: { month } }).then(r => r.data),
  });

  const days = groupByDate(data || []);
  const label = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const isCurrent = month === monthKeyOf(new Date());

  return (
    <Card padding="none">
      <div className="p-card pb-0">
        <CardHeader title={isCurrent ? 'This month' : label} actions={
          <div className="flex items-center gap-1">
            <IconButton label="Previous month" icon={<ChevronLeft size={14} />} onClick={() => setMonth(m => shiftMonthKey(m, -1))} />
            <span className="text-xs text-fg-muted min-w-[7.5rem] text-center">{label}</span>
            <IconButton label="Next month" icon={<ChevronRight size={14} />} disabled={isCurrent} onClick={() => setMonth(m => shiftMonthKey(m, 1))} />
          </div>
        } />
      </div>
      <DataTable<DayGroup>
        minWidth={560}
        loading={isLoading}
        rows={days}
        rowKey={d => d.date}
        empty={
          <EmptyState
            compact
            icon={<Clock />}
            title={isCurrent ? 'No records yet this month' : 'No records in this month'}
            description="Your check-ins will appear here day by day."
          />
        }
        columns={[
          { key: 'date', header: 'Date', cell: d => <span className="tabular-nums">{new Date(`${d.date}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}</span> },
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
            cell: d => <span className="font-medium text-fg tabular-nums">{fmtHours(sumWorkedMinutes(d.sessions))}</span>,
          },
          {
            key: 'verified',
            header: 'Verified',
            cell: d => {
              const allVerified = d.sessions.every(s => s.source === 'SELF' && (s.checkInPassed ?? (s.checkInLocationOk && s.checkInNetworkOk)));
              const anyManual = d.sessions.some(s => s.source === 'MANUAL');
              const faceVerified = d.sessions.some(s => s.checkInFaceOk || s.checkOutFaceOk);
              return anyManual ? <Badge variant="gray">Manual entry</Badge>
                : allVerified ? <span className="inline-flex items-center gap-1"><Badge variant="green">Verified</Badge>{faceVerified && <Badge variant="teal"><ScanFace size={10} className="mr-0.5" />Face</Badge>}</span>
                : <Badge variant="yellow">Partial</Badge>;
            },
          },
        ]}
      />
    </Card>
  );
}

/** Employee opt-in to optional (restricted) holidays, up to the policy's yearly allowance (ATT-26). */
function OptionalHolidaysCard() {
  const year = new Date().getFullYear();
  const { data } = useOptionalHolidays(year);
  const setChoice = useSetOptionalHoliday();
  const [error, setError] = useState('');
  if (!data || data.holidays.length === 0) return null;
  return (
    <Card>
      <CardHeader title="Optional holidays" icon={<PartyPopper size={14} />} subtitle={`Pick up to ${data.allowed} restricted holiday${data.allowed === 1 ? '' : 's'} in ${year} — ${data.used} chosen. A chosen day counts as a paid holiday for you.`} />
      {error && <Alert tone="danger" className="mt-2">{error}</Alert>}
      <ul className="divide-y divide-line-subtle mt-2">
        {data.holidays.map(h => {
          const key = h.date.slice(0, 10);
          const past = key < data.today;
          const full = !h.optedIn && data.used >= data.allowed;
          return (
            <li key={h.id} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className="text-sm text-fg">{h.name} {h.optedIn && <Badge variant="green">chosen</Badge>}</p>
                <p className="text-xs text-fg-subtle tabular-nums">{new Date(`${key}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}</p>
              </div>
              {!past && (
                <Button size="xs" variant={h.optedIn ? 'ghost' : 'secondary'} disabled={full || setChoice.isPending} title={full ? 'You have used your allowance' : undefined}
                  onClick={() => { setError(''); setChoice.mutate({ id: h.id, optIn: !h.optedIn }, { onError: (e: any) => setError(e?.response?.data?.error || 'Could not save') }); }}>
                  {h.optedIn ? 'Remove' : 'Take this day'}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
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

  const rows = data || [];
  const present = rows.filter(r => r.sessions.length > 0).length;

  return (
    <Card padding="none">
      <div className="p-card pb-0">
        <CardHeader
          title="Team — Today"
          icon={<Users size={14} />}
          actions={<span className="text-xs text-fg-subtle tabular-nums">{present} / {rows.length} checked in at some point</span>}
        />
      </div>
      <DataTable<TodayRow>
        minWidth={560}
        loading={isLoading}
        rows={rows}
        rowKey={r => r.user.id}
        empty={
          <EmptyState
            compact
            icon={<Users />}
            title="No team members yet"
            description="People will appear here as soon as they have accounts."
          />
        }
        columns={[
          {
            key: 'employee',
            header: 'Employee',
            cell: r => (
              <div className="flex items-center gap-2">
                <Avatar name={r.user.name} src={r.user.avatarUrl} size="sm" />
                <span className="text-fg truncate" title={r.user.name}>{r.user.name}</span>
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
              <span className="inline-flex items-center gap-1 tabular-nums">
                <Clock size={12} className="text-fg-subtle" /> {fmtHours(r.totalMinutes)}
              </span>
            ),
          },
          {
            key: 'status',
            header: 'Status',
            cell: r => r.sessions.length === 0 ? <Badge variant="gray">Not checked in</Badge>
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
  const [tab, setTab] = useState<'me' | 'team' | 'register' | 'map'>('me');
  const { data: policy } = useAttendancePolicy();

  return (
    <div>
      <PageHeader
        title="Attendance"
        subtitle="Mark and track daily attendance"
        below={isManager ? (
          <Tabs<'me' | 'team' | 'register' | 'map'>
            aria-label="Attendance views"
            variant="segmented"
            value={tab}
            onChange={setTab}
            items={[
              { key: 'me', label: 'My Attendance' },
              { key: 'team', label: 'Team' },
              { key: 'register', label: 'Register' },
              ...(policy?.shareLiveLocation ? [{ key: 'map' as const, label: 'Live map' }] : []),
            ]}
          />
        ) : undefined}
      />

      <PageBody width="full" className={tab === 'map' || tab === 'register' ? 'max-w-7xl mx-auto' : 'max-w-4xl mx-auto'}>
        {tab === 'me' ? (
          <div className="space-y-5">
            <CheckInWidget />
            <FaceIdCard />
            <OptionalHolidaysCard />
            <MyHistory />
            {user?.id && <RegisterSection canEdit={false} onlyUserId={user.id} />}
          </div>
        ) : tab === 'register' ? (
          <RegisterSection canEdit />
        ) : tab === 'map' ? (
          <Suspense fallback={<div className="p-6 text-[13px] text-fg-subtle">Loading map…</div>}><LiveMap /></Suspense>
        ) : (
          <TeamToday />
        )}
      </PageBody>
    </div>
  );
}
