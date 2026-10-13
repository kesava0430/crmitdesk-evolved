import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { addToast } from '../shared/components/toastStore';

interface PolicyLite { autoCheckoutOnLeave: boolean; autoCheckoutAfterMinutes: number; heartbeatTimeoutMinutes: number; shareLiveLocation: boolean }
interface TodayLite { openSession: { id: string } | null }
interface HeartbeatOutcome {
  open: boolean;
  inside: boolean | null;
  nearestDistanceMeters: number | null;
  minutesUntilAutoCheckout: number | null;
  checkedOut?: { at: string; source: 'AUTO_GEOFENCE' | 'AUTO_TIMEOUT' | 'AUTO_CLOSE' };
}

const OPEN_INTERVAL_MS = 60_000;          // while checked in
const STATUS_POLL_MS = 5 * 60_000;        // not checked in — a cheap status check, no GPS

/**
 * Mounted once in AppLayout. When the org uses geofence auto check-out, a
 * heartbeat timeout, or live location sharing, sends the user's location every
 * minute while they have an open attendance session, from any page in the app.
 * Nothing touches GPS while the user isn't checked in (ATT-29): the session
 * state comes from /hr/attendance/me/today, which the Attendance page also
 * uses, so a check-in there starts the loop immediately.
 *
 * A manager's "Locate now" arrives as an SSE event and triggers an immediate
 * ping. Browsers can't do this in the background. In the Android app the
 * native shell dispatches window events:
 *   'app:resume' → ping straight away;
 *   'app:pause'  → one last heartbeat flagged state:'background', so the
 *                  server suspends the silent-session timeout instead of
 *                  checking a locked phone out (ATT-6/ATT-7).
 */
export function useAttendanceHeartbeat(enabled: boolean) {
  const qc = useQueryClient();
  const { data: policy } = useQuery<PolicyLite>({
    queryKey: ['attendance-policy'],
    queryFn: () => api.get('/hr/attendance/policy').then(r => r.data),
    enabled,
    staleTime: 5 * 60_000,
  });
  const tracking = enabled && !!policy && (policy.autoCheckoutOnLeave || policy.heartbeatTimeoutMinutes > 0 || policy.shareLiveLocation);
  const { data: today } = useQuery<TodayLite>({
    queryKey: ['attendance-me', 'today'],
    queryFn: () => api.get('/hr/attendance/me/today').then(r => r.data),
    enabled: tracking,
    refetchInterval: STATUS_POLL_MS,
    staleTime: 30_000,
  });
  const active = tracking && !!today?.openSession;
  const warnedRef = useRef<number | null>(null);
  const lastPosRef = useRef<{ lat: number; lng: number; accuracy: number } | null>(null);

  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const schedule = (ms: number) => { if (!stopped) { clearTimeout(timer); timer = setTimeout(tick, ms); } };
    const refreshSession = () => qc.invalidateQueries({ queryKey: ['attendance-me'] });

    const tick = async () => {
      if (stopped) return;
      if (document.visibilityState === 'hidden') { schedule(OPEN_INTERVAL_MS); return; }
      let pos: GeolocationPosition;
      try {
        pos = await new Promise<GeolocationPosition>((resolve, reject) =>
          navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 20_000, maximumAge: 30_000 }));
      } catch {
        // No permission / no fix — try again later; the server's timeout rule (if any) handles silence.
        schedule(OPEN_INTERVAL_MS); return;
      }
      lastPosRef.current = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy };
      try {
        const { data } = await api.post<HeartbeatOutcome>('/hr/attendance/heartbeat', {
          lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy, state: 'foreground',
        });
        if (data.checkedOut) {
          qc.invalidateQueries({ queryKey: ['attendance-today'] });
          addToast(
            data.checkedOut.source === 'AUTO_GEOFENCE'
              ? `You were checked out automatically at ${new Date(data.checkedOut.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} because you left the office.`
              : 'You were checked out automatically after the app lost contact.',
            'info', { duration: 12_000, actionLabel: 'View', actionHref: '/hr/attendance' },
          );
          warnedRef.current = null;
          refreshSession(); // → no open session → this effect stops
          return;
        }
        if (!data.open) { refreshSession(); return; }
        if (data.inside === false && data.minutesUntilAutoCheckout != null) {
          // Warn once per "outside" episode so the user can walk back or check out deliberately
          if (warnedRef.current === null) {
            warnedRef.current = Date.now();
            addToast(`You appear to be ${data.nearestDistanceMeters ?? '?'}m from the office — you'll be checked out automatically in about ${data.minutesUntilAutoCheckout} min unless you return.`, 'warning', { duration: 10_000 });
          }
        } else {
          warnedRef.current = null;
        }
        schedule(OPEN_INTERVAL_MS);
      } catch {
        schedule(OPEN_INTERVAL_MS);
      }
    };

    // Final ping before the app is paused: no time to wait for GPS, so send
    // the last known fix (or none) with the background flag.
    const sendBackground = () => {
      const p = lastPosRef.current;
      api.post('/hr/attendance/heartbeat', { ...(p ? { lat: p.lat, lng: p.lng, accuracy: p.accuracy } : {}), state: 'background' }).catch(() => {});
    };

    // Kick off promptly
    schedule(3_000);
    const onLocate = () => schedule(200);
    window.addEventListener('attendance:locate', onLocate);
    // Android app lifecycle (dispatched by the native bootstrap)
    const onResume = () => { refreshSession(); onLocate(); };
    const onPause = () => { clearTimeout(timer); sendBackground(); };
    window.addEventListener('app:resume', onResume);
    window.addEventListener('app:pause', onPause);
    // Pushes relayed by the service worker (app open but backgrounded, or just re-opened from a notification)
    const onSwMessage = (e: MessageEvent) => { if (e.data?.type === 'attendance:locate') onLocate(); };
    navigator.serviceWorker?.addEventListener('message', onSwMessage);
    // Coming back to the foreground (PWA resumed, tab re-focused) → fresh fix straight away
    const onVisible = () => { if (document.visibilityState === 'visible') onLocate(); };
    document.addEventListener('visibilitychange', onVisible);
    // While backgrounded, timers are throttled but position callbacks can still
    // arrive on some platforms — forward them as pings without our own timer.
    // Only registered while a session is open (this effect's condition).
    let watchId: number | null = null;
    let lastWatchPing = 0;
    if (navigator.geolocation?.watchPosition) {
      watchId = navigator.geolocation.watchPosition(pos => {
        lastPosRef.current = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy };
        if (document.visibilityState === 'visible') return; // the foreground loop handles this
        const now = Date.now();
        if (now - lastWatchPing < OPEN_INTERVAL_MS) return;
        lastWatchPing = now;
        // Still flagged background: one stray fix mustn't re-arm the silent-session timeout
        api.post('/hr/attendance/heartbeat', { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy, state: 'background' }).catch(() => {});
      }, () => {}, { enableHighAccuracy: false, maximumAge: 60_000 });
    }
    return () => {
      stopped = true; clearTimeout(timer);
      window.removeEventListener('attendance:locate', onLocate);
      window.removeEventListener('app:resume', onResume);
      window.removeEventListener('app:pause', onPause);
      navigator.serviceWorker?.removeEventListener('message', onSwMessage);
      document.removeEventListener('visibilitychange', onVisible);
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    };
  }, [active, qc]);

  // Even when not checked in, a resume should refresh the session state (a
  // check-in made on another device starts tracking here).
  useEffect(() => {
    if (!tracking || active) return;
    const onResume = () => qc.invalidateQueries({ queryKey: ['attendance-me', 'today'] });
    window.addEventListener('app:resume', onResume);
    return () => window.removeEventListener('app:resume', onResume);
  }, [tracking, active, qc]);
}
