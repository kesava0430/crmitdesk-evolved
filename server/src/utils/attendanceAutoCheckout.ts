// ─── Automatic check-out ─────────────────────────────────────────────────────
//
// Two ways an open session can be closed without the user pressing Check Out:
//
//   AUTO_GEOFENCE — the app kept sending location heartbeats and every one for
//                   autoCheckoutAfterMinutes placed the user outside all office
//                   radii. Check-out time = the moment they were first seen outside.
//   AUTO_TIMEOUT  — no heartbeat for heartbeatTimeoutMinutes (app closed, phone
//                   off). Check-out time = the last heartbeat. Off by default.
//
// Web apps can't track location in the background, so heartbeats only flow
// while the app is open in a tab (or as an installed PWA in the foreground).
// The sweep below runs server-side every minute so the geofence rule still
// completes even if the tab was closed right after the user walked out.
//
// A third closer, AUTO_CLOSE, is the daily close-out (closeForgottenSessions):
// a session still open hours after its shift ended is closed at shift end so a
// forgotten Friday check-out doesn't stay "on site" (and nudged) all weekend.
//
// The Android app tells us when it is paused (screen locked, app switched) with
// a final heartbeat flagged state='background'. A paused WebView can't send
// pings, so the silent-session timeout is suspended for that session until the
// app comes back; the close-out still applies.

import { prisma } from './prisma';
import { verifyAgainstOffices } from './attendanceVerification';
import { sseManager, SSEEvent } from './sse';
import { logAction } from './auditLog';
import { sendPushToUser } from './webPush';
import { policiesForOrg, recordDayKey } from './attendanceRegister';
import { shiftEndInstant } from './attendanceEngine';

/** Nudges only go to sessions that started within this window (one long shift plus slack). */
const NUDGE_WINDOW_MS = 16 * 3_600_000;

/** GPS fixes looser than this are ignored for the geofence decision. */
export const MAX_USABLE_ACCURACY_M = 250;

export type AutoSource = 'AUTO_GEOFENCE' | 'AUTO_TIMEOUT' | 'AUTO_CLOSE';

export async function closeSession(record: { id: string; orgId: string; userId: string; lastSeenLat: number | null; lastSeenLng: number | null; lastSeenInside: boolean | null }, at: Date, source: AutoSource) {
  const closed = await prisma.attendanceRecord.update({
    where: { id: record.id },
    data: {
      checkOutAt: at,
      checkOutLat: record.lastSeenLat, checkOutLng: record.lastSeenLng,
      checkOutLocationOk: record.lastSeenInside, checkOutNetworkOk: null,
      checkOutPassed: null, checkOutSource: source, outsideSince: null, backgroundedAt: null,
    },
    select: { id: true, checkOutAt: true },
  });
  logAction(record.userId, 'UPDATE', 'AttendanceRecord', record.id, { action: 'check_out', source });
  sseManager.broadcastAll(record.orgId, SSEEvent.ATTENDANCE_UPDATED, { userId: record.userId, type: 'check_out', source });
  return closed;
}

export interface HeartbeatOutcome {
  open: boolean;
  inside: boolean | null;
  nearestDistanceMeters: number | null;
  outsideSince: Date | null;
  /** Set when this heartbeat closed the session */
  checkedOut?: { at: Date; source: AutoSource };
  /** Minutes until an AUTO_GEOFENCE check-out if the user stays outside */
  minutesUntilAutoCheckout: number | null;
}

/**
 * Record a heartbeat for the user's open session and apply the geofence rule.
 * `lat`/`lng` may be null on a background ping (no fresh fix before pause):
 * the state is recorded, the location is left as it was.
 */
export async function recordHeartbeat(orgId: string, userId: string, lat: number | null, lng: number | null, accuracy: number | undefined, state: 'foreground' | 'background' = 'foreground'): Promise<HeartbeatOutcome> {
  const now = new Date();
  const session = await prisma.attendanceRecord.findFirst({
    where: { userId, orgId, checkInAt: { not: null }, checkOutAt: null },
    orderBy: { checkInAt: 'desc' },
  });
  if (!session) return { open: false, inside: null, nearestDistanceMeters: null, outsideSince: null, minutesUntilAutoCheckout: null };
  const backgroundedAt = state === 'background' ? (session.backgroundedAt ?? now) : null;
  if (lat == null || lng == null) {
    await prisma.attendanceRecord.update({ where: { id: session.id }, data: { lastSeenAt: now, backgroundedAt } });
    return { open: true, inside: session.lastSeenInside, nearestDistanceMeters: null, outsideSince: session.outsideSince, minutesUntilAutoCheckout: null };
  }

  const [policy, offices] = await Promise.all([
    prisma.attendancePolicy.upsert({ where: { orgId }, create: { orgId }, update: {} }),
    prisma.officeLocation.findMany({ where: { orgId, isActive: true } }),
  ]);

  const usable = offices.length > 0 && (accuracy == null || accuracy <= MAX_USABLE_ACCURACY_M);
  const geo = usable ? verifyAgainstOffices(offices, lat, lng, '') : null;
  const inside: boolean | null = geo ? geo.locationOk : null;

  // Only a *usable* outside fix starts or continues the outside clock; an
  // unusable one (poor accuracy) leaves the previous state alone.
  const outsideSince = inside === null ? session.outsideSince : inside ? null : (session.outsideSince ?? now);

  const updated = await prisma.attendanceRecord.update({
    where: { id: session.id },
    data: { lastSeenAt: now, lastSeenLat: lat, lastSeenLng: lng, lastSeenInside: inside, outsideSince, backgroundedAt },
  });
  if (policy.shareLiveLocation) {
    await prisma.attendanceLocationPing.create({ data: { orgId, userId, recordId: session.id, at: now, lat, lng, accuracy: accuracy ?? null, inside } });
    sseManager.broadcastAll(orgId, SSEEvent.ATTENDANCE_UPDATED, { userId, type: 'location' });
  }

  const graceMs = policy.autoCheckoutAfterMinutes * 60_000;
  if (policy.autoCheckoutOnLeave && outsideSince && now.getTime() - outsideSince.getTime() >= graceMs) {
    await closeSession(updated, outsideSince, 'AUTO_GEOFENCE');
    return { open: false, inside, nearestDistanceMeters: geo?.nearestDistanceMeters ?? null, outsideSince, checkedOut: { at: outsideSince, source: 'AUTO_GEOFENCE' }, minutesUntilAutoCheckout: 0 };
  }

  const minutesUntilAutoCheckout = policy.autoCheckoutOnLeave && outsideSince
    ? Math.max(0, Math.ceil((outsideSince.getTime() + graceMs - now.getTime()) / 60_000))
    : null;
  return { open: true, inside, nearestDistanceMeters: geo?.nearestDistanceMeters ?? null, outsideSince, minutesUntilAutoCheckout };
}

/** Purge location pings older than each org's retention (called hourly from index.ts). */
export async function purgeOldLocationPings(now = new Date()): Promise<number> {
  const policies = await prisma.attendancePolicy.findMany({ select: { orgId: true, locationRetentionDays: true } });
  let total = 0;
  for (const p of policies) {
    const cutoff = new Date(now.getTime() - p.locationRetentionDays * 86_400_000);
    const { count } = await prisma.attendanceLocationPing.deleteMany({ where: { orgId: p.orgId, at: { lt: cutoff } } });
    total += count;
  }
  return total;
}

/**
 * Clear check-in/out selfies older than each org's selfieRetentionDays (hourly
 * from index.ts). The pass/fail result and face distance stay on the record.
 */
export async function purgeOldSelfies(now = new Date()): Promise<number> {
  const policies = await prisma.attendancePolicy.findMany({ select: { orgId: true, selfieRetentionDays: true } });
  let total = 0;
  for (const p of policies) {
    const cutoff = new Date(now.getTime() - Math.max(1, p.selfieRetentionDays) * 86_400_000);
    const a = await prisma.attendanceRecord.updateMany({ where: { orgId: p.orgId, checkInAt: { lt: cutoff }, checkInSelfie: { not: null } }, data: { checkInSelfie: null } });
    const b = await prisma.attendanceRecord.updateMany({ where: { orgId: p.orgId, checkInAt: { lt: cutoff }, checkOutSelfie: { not: null } }, data: { checkOutSelfie: null } });
    total += a.count + b.count;
  }
  return total;
}

/** Pure: when should a forgotten open session be closed, and at what time? */
export function closeOutPlan(checkInAt: Date, shiftEnd: Date, afterHours: number): { closeAt: Date; dueAt: Date } {
  // Closed at shift end — or at check-in for someone who started after their
  // shift had already ended (an overtime-only session), never before it began.
  const closeAt = new Date(Math.max(shiftEnd.getTime(), checkInAt.getTime()));
  return { closeAt, dueAt: new Date(closeAt.getTime() + afterHours * 3_600_000) };
}

/**
 * Daily close-out (hourly from index.ts): sessions still open more than
 * autoCloseAfterHours after their shift ended are closed at shift end with
 * checkOutSource AUTO_CLOSE. The engine treats that like a missing check-out
 * (ABSENT unless the policy assumes shift end), so pay doesn't change — the
 * session just stops being "on site", nudged, and blocking the next check-in.
 */
export async function closeForgottenSessions(now = new Date()): Promise<number> {
  const policies = await prisma.attendancePolicy.findMany({ where: { autoCloseAfterHours: { gt: 0 } }, select: { orgId: true, autoCloseAfterHours: true } });
  const hoursByOrg = new Map(policies.map(p => [p.orgId, p.autoCloseAfterHours]));
  // Orgs that never saved a policy get the default (4h) too
  const DEFAULT_HOURS = 4;
  const disabled = new Set((await prisma.attendancePolicy.findMany({ where: { autoCloseAfterHours: 0 }, select: { orgId: true } })).map(p => p.orgId));
  const open = await prisma.attendanceRecord.findMany({
    where: { checkInAt: { not: null, lt: new Date(now.getTime() - 4 * 3_600_000) }, checkOutAt: null },
    select: { id: true, orgId: true, userId: true, date: true, checkInAt: true, lastSeenLat: true, lastSeenLng: true, lastSeenInside: true },
  });
  const byOrg = new Map<string, typeof open>();
  for (const r of open) { if (disabled.has(r.orgId)) continue; const l = byOrg.get(r.orgId) ?? []; l.push(r); byOrg.set(r.orgId, l); }
  let closed = 0;
  for (const [orgId, rows] of byOrg) {
    const policies = await policiesForOrg(orgId, [...new Set(rows.map(r => r.userId))]);
    const hours = hoursByOrg.get(orgId) ?? DEFAULT_HOURS;
    for (const r of rows) {
      const policy = policies.get(r.userId);
      if (!policy) continue;
      const end = shiftEndInstant(policy, recordDayKey(r, policy));
      const plan = closeOutPlan(r.checkInAt!, end, hours);
      if (now.getTime() < plan.dueAt.getTime()) continue;
      // Guarded update: the person may have checked out in the meantime
      const res = await prisma.attendanceRecord.updateMany({
        where: { id: r.id, checkOutAt: null },
        data: { checkOutAt: plan.closeAt, checkOutSource: 'AUTO_CLOSE', checkOutLat: r.lastSeenLat, checkOutLng: r.lastSeenLng, checkOutLocationOk: r.lastSeenInside, checkOutPassed: null, outsideSince: null, backgroundedAt: null },
      });
      if (res.count) {
        closed++;
        logAction(r.userId, 'UPDATE', 'AttendanceRecord', r.id, { action: 'check_out', source: 'AUTO_CLOSE' });
        sseManager.broadcastAll(orgId, SSEEvent.ATTENDANCE_UPDATED, { userId: r.userId, type: 'check_out', source: 'AUTO_CLOSE' });
      }
    }
  }
  return closed;
}

/**
 * Server-side sweep (every minute from index.ts): finishes geofence
 * check-outs whose grace elapsed after the last heartbeat, and closes silent
 * sessions for orgs with a heartbeat timeout.
 */
export async function sweepAutoCheckouts(now = new Date()): Promise<{ geofence: number; timeout: number; nudged: number }> {
  const policies = await prisma.attendancePolicy.findMany({
    where: { OR: [{ autoCheckoutOnLeave: true }, { heartbeatTimeoutMinutes: { gt: 0 } }, { shareLiveLocation: true }] },
  });
  let geofence = 0, timeout = 0, nudged = 0;
  for (const p of policies) {
    // Browsers can't read GPS while the app is closed — the best a PWA can do is
    // a push notification that brings the person back into the app. Sent when a
    // session's last fix is older than nudgeAfterMinutes, repeated at most every
    // nudgeRepeatMinutes, and only to people with no live app connection.
    const tracking = p.autoCheckoutOnLeave || p.shareLiveLocation || p.heartbeatTimeoutMinutes > 0;
    if (tracking && p.nudgeAfterMinutes > 0) {
      const staleBefore = new Date(now.getTime() - p.nudgeAfterMinutes * 60_000);
      const repeatBefore = new Date(now.getTime() - p.nudgeRepeatMinutes * 60_000);
      const rows = await prisma.attendanceRecord.findMany({
        where: {
          // Only sessions from the current shift window: a session forgotten
          // on Friday must not be nudged every 30 minutes all weekend (ATT-17).
          // Older ones are closed by closeForgottenSessions instead.
          orgId: p.orgId, checkOutAt: null, checkInAt: { not: null, gte: new Date(now.getTime() - NUDGE_WINDOW_MS) },
          OR: [{ lastSeenAt: { lte: staleBefore } }, { lastSeenAt: null, checkInAt: { lte: staleBefore } }],
          AND: [{ OR: [{ lastNudgedAt: null }, { lastNudgedAt: { lte: repeatBefore } }] }],
        },
        select: { id: true, userId: true, orgId: true },
      });
      for (const r of rows) {
        if (sseManager.isUserConnected(r.orgId, r.userId)) continue; // app is open; the hook will ping on its own
        await sendPushToUser(r.userId, {
          title: 'Attendance — location update needed',
          body: "You're checked in but we haven't had your location for a while. Tap to open the app and update it.",
          url: '/hr/attendance',
          tag: 'attendance-location', type: 'attendance:locate',
        } as any);
        await prisma.attendanceRecord.update({ where: { id: r.id }, data: { lastNudgedAt: now } });
        nudged++;
      }
    }
    if (p.autoCheckoutOnLeave) {
      const cutoff = new Date(now.getTime() - p.autoCheckoutAfterMinutes * 60_000);
      const rows = await prisma.attendanceRecord.findMany({ where: { orgId: p.orgId, checkOutAt: null, checkInAt: { not: null }, outsideSince: { lte: cutoff } } });
      for (const r of rows) { await closeSession(r, r.outsideSince!, 'AUTO_GEOFENCE'); geofence++; }
    }
    if (p.heartbeatTimeoutMinutes > 0) {
      const cutoff = new Date(now.getTime() - p.heartbeatTimeoutMinutes * 60_000);
      // Sessions that have heartbeated at least once and then gone quiet. A
      // session with no heartbeat at all (older client) is left alone, and so
      // is one whose app said it was going to the background (locked phone):
      // silence is expected there, not a sign the person left (ATT-7).
      const rows = await prisma.attendanceRecord.findMany({ where: { orgId: p.orgId, checkOutAt: null, checkInAt: { not: null }, lastSeenAt: { lte: cutoff }, backgroundedAt: null } });
      for (const r of rows) { await closeSession(r, r.lastSeenAt!, 'AUTO_TIMEOUT'); timeout++; }
    }
  }
  return { geofence, timeout, nudged };
}
