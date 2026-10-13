import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../../../utils/prisma';
import { AuthRequest } from '../../../middleware/authenticate';
import { AppError } from '../../../middleware/errorHandler';
import { verifyAgainstOfficesResolved, requestIp, sumWorkedMinutes, detectPtrHostname, checkHostnameAgainstIp, distanceMeters } from '../../../utils/attendanceVerification';
import { sseManager, SSEEvent } from '../../../utils/sse';
import { logAction } from '../../../utils/auditLog';
import {
  DescriptorSchema, SelfieSchema, MAX_ENROLLMENT_SAMPLES, assertPlausibleDescriptor,
  getOrCreateAttendancePolicy, checkFaceSignal, faceNotEnrolledError, faceRequiredError,
} from '../../../utils/faceVerification';
import {
  RuleSchema, DEFAULT_CHECK_IN_RULE, DEFAULT_CHECK_OUT_RULE, parseRule, evaluateRule, describeRule,
  type VerificationRule, type SignalResults,
} from '../../../utils/attendanceRules';
import { recordHeartbeat, closeIfStale } from '../../../utils/attendanceAutoCheckout';
import { sendPushToUser } from '../../../utils/webPush';
import { policyForUser, policiesForOrg, recordsForDays, recordDayKey, RECORD_PUBLIC_SELECT } from '../../../utils/attendanceRegister';
import { shiftDayKey, todayKeyFor, keyToDate, zonedDayStart, addDaysKey, dateKey } from '../../../utils/attendanceEngine';
import { createManualSession } from '../../../utils/attendanceSessions';
import { isHrManager } from '../../../utils/hrAccess';

/** What closeIfStale() needs from an open session */
const OPEN_SELECT = { id: true, orgId: true, userId: true, date: true, checkInAt: true, lastSeenAt: true, lastSeenLat: true, lastSeenLng: true, lastSeenInside: true } as const;

/** A GPS fix at exactly 0,0 is what older face-only clients sent for "no location" (ATT-33). */
const isNullIsland = (lat: number | null | undefined, lng: number | null | undefined) => lat === 0 && lng === 0;

const CheckSchema = z.object({
  /** Omitted/null when the rule doesn't use location (e.g. face-only) — never 0,0 */
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
  /** 128-float descriptor from the browser face model — required when the org's AttendancePolicy demands it */
  faceDescriptor: DescriptorSchema.optional(),
  /** Small JPEG data URL captured with the descriptor; stored as evidence when the policy keeps selfies */
  selfie: SelfieSchema.optional(),
});

interface VerifiedSignals {
  rule: VerificationRule;
  passed: boolean;
  locationOk: boolean;
  networkOk: boolean;
  faceOk: boolean | null;
  faceDistance: number | null;
  ip: string;
}

/**
 * Runs the org's rule for `action` against the three signals and either
 * returns the outcome (recorded on the row) or throws when the rule is
 * enforced and fails. Location/network are evaluated before any face data is
 * touched; a missing face on an enforced rule returns 428 so the client can
 * enrol or capture and retry.
 */
async function verifySignals(
  action: 'in' | 'out',
  req: AuthRequest,
  input: { lat: number | null; lng: number | null; faceDescriptor?: number[] },
): Promise<VerifiedSignals> {
  const orgId = req.user!.orgId;
  const userId = req.user!.id;
  const verb = action === 'in' ? 'check in' : 'check out';
  const policy = await getOrCreateAttendancePolicy(orgId);
  const rule = parseRule(action === 'in' ? policy.checkInRule : policy.checkOutRule, action === 'in' ? DEFAULT_CHECK_IN_RULE : DEFAULT_CHECK_OUT_RULE);

  const offices = await prisma.officeLocation.findMany({ where: { orgId, isActive: true } });
  if (rule.enforce && rule.location && rule.mode === 'ALL' && offices.length === 0) {
    throw new AppError(400, 'No office location is configured yet — ask an admin to set one up in HR Settings.');
  }
  const ip = requestIp(req);
  // Resolved variant: DDNS hostname entries in an office's allowlist are
  // expanded to their current IPs at verification time (attendanceVerification.ts).
  // Without coordinates the location signal simply fails; the network signal
  // is still evaluated against every office's allowlist.
  const hasCoords = input.lat != null && input.lng != null;
  const geo = await verifyAgainstOfficesResolved(offices, hasCoords ? input.lat! : NaN, hasCoords ? input.lng! : NaN, ip);

  const results: SignalResults = {
    location: rule.location ? (offices.length > 0 && hasCoords && geo.locationOk) : null,
    // No allowlist anywhere = the signal doesn't exist for this org; never count it against the user
    network: rule.network ? (geo.networkStatus === 'not_configured' ? null : geo.networkStatus === 'matched') : null,
    face: null,
  };

  let faceDistance: number | null = null;
  if (rule.face) {
    const face = await checkFaceSignal(userId, policy.faceMatchThreshold, input.faceDescriptor);
    if (face.status === 'matched') { results.face = true; faceDistance = face.distance; }
    else if (face.status === 'mismatch') { results.face = false; faceDistance = face.distance; }
    else {
      // Not enrolled / not captured. Under ANY the other signals may still carry
      // the action; otherwise tell the client exactly what to do next.
      results.face = false;
      const without = evaluateRule(rule, results);
      if (rule.enforce && !without.passed) throw face.status === 'not_enrolled' ? faceNotEnrolledError(verb) : faceRequiredError(verb);
    }
  }

  const outcome = evaluateRule(rule, results);
  if (rule.enforce && !outcome.passed) {
    const why: string[] = [];
    if (outcome.failed.includes('location')) {
      why.push(offices.length === 0 ? 'no office location is configured'
        : geo.nearestDistanceMeters != null ? `you're about ${geo.nearestDistanceMeters}m from the office` : "we couldn't confirm your location");
    }
    if (outcome.failed.includes('network')) why.push("you don't appear to be on the office network");
    if (outcome.failed.includes('face')) why.push(`your face didn't match the one enrolled${faceDistance != null ? ` (score ${faceDistance.toFixed(2)}, needs ≤ ${policy.faceMatchThreshold})` : ''}`);
    const needs = rule.mode === 'ALL' ? `requires ${describeRule(rule)}` : `requires at least one of: ${describeRule(rule)}`;
    throw new AppError(403, `${action === 'in' ? 'Check-in' : 'Check-out'} blocked — ${why.join(', ')}. Your organisation's rule ${needs}. Ask a manager to add a manual entry if this is a legitimate exception.`);
  }

  return {
    rule, passed: outcome.passed, ip,
    locationOk: hasCoords && geo.locationOk, networkOk: geo.networkOk,
    faceOk: rule.face ? results.face : null, faceDistance,
  };
}

/** POST /hr/attendance/check-in — starts a new session; a day can have several. */
export async function checkIn(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const body = CheckSchema.parse(req.body);
    const lat = body.lat ?? null, lng = body.lng ?? null;
    const { faceDescriptor, selfie } = body;
    const orgId = req.user!.orgId;
    const userId = req.user!.id;

    // Block only if there's already an OPEN session (checked in, not yet
    // checked out) — on any day: a session left open across midnight must be
    // closed, not doubled. A completed earlier session (lunch break) doesn't block.
    // A session left open on an earlier (finished) day is closed at its shift
    // end first, so a forgotten check-out never blocks today's check-in.
    const now = new Date();
    const { policy: dayPolicy } = await policyForUser(orgId, userId);
    const openSession = await prisma.attendanceRecord.findFirst({
      where: { userId, orgId, checkInAt: { not: null }, checkOutAt: null },
      orderBy: { checkInAt: 'desc' },
      select: OPEN_SELECT,
    });
    if (openSession && !(await closeIfStale(openSession, dayPolicy, now))) {
      throw new AppError(400, "You're already checked in — check out first before starting a new session.");
    }

    const policy = await getOrCreateAttendancePolicy(orgId);
    const v = await verifySignals('in', req, { lat, lng, faceDescriptor });

    // The record's day is the shift day in the employee's policy timezone
    // (IST for an Indian office), not the UTC date (ATT-4).
    const date = keyToDate(shiftDayKey(now, dayPolicy));

    let record;
    try {
      record = await prisma.attendanceRecord.create({
        data: {
          orgId, userId, date,
          checkInAt: now, checkInLat: lat, checkInLng: lng, checkInIp: v.ip,
          checkInLocationOk: v.locationOk, checkInNetworkOk: v.networkOk,
          checkInFaceOk: v.faceOk, checkInFaceDistance: v.faceDistance, checkInPassed: v.passed,
          ...(v.faceOk && policy.keepCheckInSelfie && selfie ? { checkInSelfie: selfie } : {}),
          source: 'SELF',
        },
        select: RECORD_PUBLIC_SELECT,
      });
    } catch (err: any) {
      // Partial unique index: a second, concurrent check-in lost the race (ATT-21)
      if (err?.code === 'P2002') throw new AppError(400, "You're already checked in — check out first before starting a new session.");
      throw err;
    }

    logAction(userId, 'CREATE', 'AttendanceRecord', record.id, { action: 'check_in', passed: v.passed, faceVerified: v.faceOk ?? undefined });
    sseManager.broadcastAll(orgId, SSEEvent.ATTENDANCE_UPDATED, { userId, type: 'check_in' });
    res.json(record);
  } catch (err) { next(err); }
}

/** POST /hr/attendance/check-out — closes the currently-open session. */
export async function checkOut(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const body = CheckSchema.parse(req.body);
    const lat = body.lat ?? null, lng = body.lng ?? null;
    const { faceDescriptor, selfie } = body;
    const orgId = req.user!.orgId;
    const userId = req.user!.id;

    // The latest open session regardless of its date — a night shift that
    // started yesterday (or a session stamped with an old UTC date) must still
    // be closable (ATT-4).
    const openSession = await prisma.attendanceRecord.findFirst({
      where: { userId, orgId, checkInAt: { not: null }, checkOutAt: null },
      orderBy: { checkInAt: 'desc' },
      select: OPEN_SELECT,
    });
    if (!openSession) throw new AppError(400, "You haven't checked in yet — nothing to check out of.");

    // A session from an earlier day is never closed at "now" (that would credit
    // days of work and overtime): it's closed at its shift end, and the person
    // is told they aren't checked in today (H1).
    const { policy: dayPolicy } = await policyForUser(orgId, userId);
    const staleAt = await closeIfStale(openSession, dayPolicy, new Date());
    if (staleAt) {
      const day = recordDayKey(openSession, dayPolicy);
      const record = await prisma.attendanceRecord.findUnique({ where: { id: openSession.id }, select: RECORD_PUBLIC_SELECT });
      return res.json({
        ...record,
        staleClosed: true,
        notice: `You weren't checked in today. Your session from ${day} was never checked out, so it has been closed at the end of that shift (${staleAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: dayPolicy.timezone })}). Ask HR to correct that day if needed, and check in if you're working now.`,
      });
    }

    // By default the check-out rule is recorded but not enforced — an employee
    // who legitimately leaves the office (client visit, end of day from home)
    // can still log a checkout time. Orgs can flip `enforce` in HR Settings.
    const policy = await getOrCreateAttendancePolicy(orgId);
    const v = await verifySignals('out', req, { lat, lng, faceDescriptor });

    const record = await prisma.attendanceRecord.update({
      where: { id: openSession.id },
      data: {
        checkOutAt: new Date(), checkOutLat: lat, checkOutLng: lng, checkOutIp: v.ip,
        checkOutLocationOk: v.locationOk, checkOutNetworkOk: v.networkOk,
        checkOutFaceOk: v.faceOk, checkOutFaceDistance: v.faceDistance, checkOutPassed: v.passed,
        checkOutSource: 'SELF', outsideSince: null, backgroundedAt: null,
        ...(v.faceOk && policy.keepCheckInSelfie && selfie ? { checkOutSelfie: selfie } : {}),
      },
      select: RECORD_PUBLIC_SELECT,
    });

    logAction(userId, 'UPDATE', 'AttendanceRecord', record.id, { action: 'check_out', passed: v.passed, faceVerified: v.faceOk ?? undefined });
    sseManager.broadcastAll(orgId, SSEEvent.ATTENDANCE_UPDATED, { userId, type: 'check_out' });
    res.json(record);
  } catch (err) { next(err); }
}

/** GET /hr/attendance/me?month=YYYY-MM — every session of the month, each tagged with the
 *  calendar `day` it belongs to in the policy timezone (the client groups by it). */
export async function myAttendance(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const userId = req.user!.id;
    const { policy } = await policyForUser(orgId, userId);
    const q = req.query.month as string;
    const month = /^\d{4}-\d{2}$/.test(q || '') ? q : todayKeyFor(policy).slice(0, 7);
    const [y, m] = month.split('-').map(Number);
    const fromKey = dateKey(new Date(Date.UTC(y, m - 1, 1))), toKey = dateKey(new Date(Date.UTC(y, m, 0)));
    const records = await recordsForDays(orgId, userId, policy, fromKey, toKey, RECORD_PUBLIC_SELECT);
    records.sort((a, b) => (a.day === b.day ? (b.checkInAt?.getTime() ?? 0) - (a.checkInAt?.getTime() ?? 0) : a.day < b.day ? 1 : -1));
    res.json(records);
  } catch (err) { next(err); }
}

/** GET /hr/attendance/me/today — today's sessions (policy timezone) plus the open session from any day. */
export async function myToday(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const userId = req.user!.id;
    const { policy } = await policyForUser(orgId, userId);
    const today = todayKeyFor(policy);
    // A forgotten session from an earlier day must not make today look "checked in"
    const stale = await prisma.attendanceRecord.findFirst({ where: { orgId, userId, checkInAt: { not: null }, checkOutAt: null }, orderBy: { checkInAt: 'desc' }, select: OPEN_SELECT });
    if (stale) await closeIfStale(stale, policy);
    const [sessions, open] = await Promise.all([
      recordsForDays(orgId, userId, policy, today, today, RECORD_PUBLIC_SELECT),
      prisma.attendanceRecord.findFirst({ where: { orgId, userId, checkInAt: { not: null }, checkOutAt: null }, orderBy: { checkInAt: 'desc' }, select: RECORD_PUBLIC_SELECT }),
    ]);
    const list = [...sessions];
    if (open && !list.some(s => s.id === open.id)) list.push({ ...open, day: recordDayKey(open, policy) });
    list.sort((a, b) => (b.checkInAt?.getTime() ?? 0) - (a.checkInAt?.getTime() ?? 0));
    res.json({ date: today, timezone: policy.timezone, shiftStart: policy.shiftStart, shiftEnd: policy.shiftEnd, sessions: list, openSession: open ? { ...open, day: recordDayKey(open, policy) } : null });
  } catch (err) { next(err); }
}

/** GET /hr/attendance/today — manager view of every active employee's sessions + live status today */
export async function todayStatus(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const now = new Date();
    const users = await prisma.user.findMany({ where: { orgId, isActive: true }, select: { id: true, name: true, role: true, avatarUrl: true } });
    const [policies, records] = await Promise.all([
      policiesForOrg(orgId, users.map(u => u.id)),
      // Wide enough for any timezone's "today" and an overnight shift; open sessions from any day.
      prisma.attendanceRecord.findMany({
        where: { orgId, OR: [{ checkInAt: { gte: new Date(now.getTime() - 40 * 3_600_000) } }, { checkInAt: { not: null }, checkOutAt: null }] },
        orderBy: { checkInAt: 'asc' }, select: RECORD_PUBLIC_SELECT,
      }),
    ]);
    const byUser = new Map<string, typeof records>();
    for (const r of records) {
      const policy = policies.get(r.userId);
      if (!policy) continue;
      const isOpen = !!r.checkInAt && !r.checkOutAt;
      if (!isOpen && recordDayKey(r, policy) !== todayKeyFor(policy, now)) continue;
      const list = byUser.get(r.userId) || [];
      list.push(r);
      byUser.set(r.userId, list);
    }
    const rows = users.map(u => {
      const sessions = byUser.get(u.id) || [];
      const last = sessions[sessions.length - 1] || null;
      return {
        user: u,
        sessions,
        // Kept for any caller still expecting a single "today's record" —
        // the most recent session, same shape as before this feature.
        record: last,
        isCheckedInNow: sessions.some(s => s.checkInAt && !s.checkOutAt),
        totalMinutes: sumWorkedMinutes(sessions),
      };
    });
    res.json(rows);
  } catch (err) { next(err); }
}

/** GET /hr/attendance?userId=&from=&to= — manager report, date range */
export async function listAttendance(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const { userId, from, to } = req.query as Record<string, string>;
    const where: any = { orgId };
    if (userId) where.userId = userId;
    const valid = (v?: string) => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
    if (valid(from) || valid(to)) {
      where.date = {};
      if (valid(from)) where.date.gte = keyToDate(from);
      if (valid(to)) where.date.lte = keyToDate(to);
    }
    const records = await prisma.attendanceRecord.findMany({
      where,
      select: { ...RECORD_PUBLIC_SELECT, user: { select: { id: true, name: true, avatarUrl: true } } },
      orderBy: [{ date: 'desc' }, { checkInAt: 'desc' }],
      take: 500,
    });
    res.json(records);
  } catch (err) { next(err); }
}

const ManualEntrySchema = z.object({
  userId: z.string(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), // informational; the day is derived from checkInAt
  checkInAt: z.string().datetime(),
  /** Required unless the session is today and still running */
  checkOutAt: z.string().datetime().nullable().optional(),
  notes: z.string().max(500).optional(),
  reason: z.string().trim().min(1, 'A reason is required').max(500),
});

/** POST /hr/attendance/manual — manager adds a session for an employee, bypassing geofence/IP checks.
 *  Always a new MANUAL session next to whatever the employee logged; mandatory
 *  reason, audited, the day recomputed (ATT-19). See utils/attendanceSessions.ts. */
export async function manualEntry(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const data = ManualEntrySchema.parse(req.body);
    const record = await createManualSession(req.user!.orgId, req.user!.id, {
      userId: data.userId, checkInAt: new Date(data.checkInAt), checkOutAt: data.checkOutAt ? new Date(data.checkOutAt) : null,
      notes: data.notes ?? null, reason: data.reason,
    });
    res.json(record);
  } catch (err) { next(err); }
}

/** GET /hr/attendance/records/:id/selfie?which=in|out — the stored check-in/out photo (managers, or the owner). */
export async function recordSelfie(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const rec = await prisma.attendanceRecord.findFirst({ where: { id: req.params.id, orgId: req.user!.orgId }, select: { userId: true, checkInSelfie: true, checkOutSelfie: true } });
    if (!rec || (rec.userId !== req.user!.id && !isHrManager(req.user!.role))) throw new AppError(404, 'Record not found');
    const selfie = req.query.which === 'out' ? rec.checkOutSelfie : rec.checkInSelfie;
    if (!selfie) throw new AppError(404, 'No photo stored for this session');
    res.set('Cache-Control', 'private, max-age=300');
    res.json({ selfie });
  } catch (err) { next(err); }
}

// ─── Office Locations (admin) ────────────────────────────────────────────────

const OfficeLocationSchema = z.object({
  name: z.string().min(1),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  radiusMeters: z.number().int().min(10).max(50000).default(150),
  allowedIps: z.string().optional().nullable(),
  isActive: z.boolean().optional(),
});

export async function listOfficeLocations(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const locations = await prisma.officeLocation.findMany({ where: { orgId: req.user!.orgId }, orderBy: { createdAt: 'asc' } });
    res.json(locations);
  } catch (err) { next(err); }
}

// Returns the caller's public IP exactly as check-in/check-out will see it —
// reuses requestIp so "populate automatically" in the Allowed IPs field
// can never disagree with what actually gets verified at check-in time.
export async function myIp(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const ip = requestIp(req);
    res.json({ ip });
  } catch (err) { next(err); }
}

// GET /hr/attendance/my-host — best-effort reverse-DNS of the caller's
// current public IP, for the "Use my DNS name" button. `verified` is true
// only when the discovered name forward-resolves back to the same IP
// (otherwise putting it in the allowlist would never match at check-in).
// A null host is the normal case for ISP dynamic IPs — the UI then guides
// the admin to a DDNS hostname instead.
export async function myHost(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const ip = requestIp(req);
    const ptr = await detectPtrHostname(ip);
    res.json({ ip, host: ptr?.host ?? null, verified: ptr?.verified ?? false });
  } catch (err) { next(err); }
}

const CheckHostSchema = z.object({ host: z.string().min(1).max(253).regex(/^[a-z0-9.-]+$/i, 'Hostname only — letters, digits, dots, hyphens') });

// GET /hr/attendance/check-host?host=office.myco.ddns.net — verifies a typed
// DDNS hostname: what it resolves to right now, and whether that matches the
// caller's current public IP. Lets the admin confirm their DDNS setup from
// the office before saving, instead of discovering a typo at check-in time.
export async function checkHost(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { host } = CheckHostSchema.parse({ host: req.query.host });
    const ip = requestIp(req);
    const result = await checkHostnameAgainstIp(host, ip);
    res.json({ ...result, yourIp: ip });
  } catch (err) { next(err); }
}

export async function createOfficeLocation(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const data = OfficeLocationSchema.parse(req.body);
    const location = await prisma.officeLocation.create({ data: { ...data, orgId: req.user!.orgId } });
    res.status(201).json(location);
  } catch (err) { next(err); }
}

export async function updateOfficeLocation(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const data = OfficeLocationSchema.partial().parse(req.body);
    const existing = await prisma.officeLocation.findFirst({ where: { id: req.params.id, orgId: req.user!.orgId } });
    if (!existing) throw new AppError(404, 'Office location not found');
    const location = await prisma.officeLocation.update({ where: { id: req.params.id }, data });
    res.json(location);
  } catch (err) { next(err); }
}

export async function deleteOfficeLocation(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    await prisma.officeLocation.deleteMany({ where: { id: req.params.id, orgId: req.user!.orgId } });
    res.json({ message: 'Office location deleted' });
  } catch (err) { next(err); }
}


// ─── Attendance policy (per org) ─────────────────────────────────────────────

/** GET /hr/attendance/policy — any staff role; also tells the caller whether they're enrolled. */
export async function getPolicy(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const [policy, enrollment, lastRequest] = await Promise.all([
      getOrCreateAttendancePolicy(req.user!.orgId),
      prisma.faceEnrollment.findUnique({ where: { userId: req.user!.id }, select: { samples: true, enrolledAt: true, updatedAt: true, referenceSelfie: true } }),
      /* The most recent re-enrolment request drives the Face ID card: PENDING
         hides the Re-enrol button, REJECTED surfaces the reason. Only the
         latest matters — older decided rows are history for the audit trail,
         not state the employee acts on. */
      prisma.faceReenrollmentRequest.findFirst({
        where: { userId: req.user!.id },
        orderBy: { createdAt: 'desc' },
        select: { id: true, status: true, samples: true, rejectionReason: true, createdAt: true, decidedAt: true },
      }),
    ]);
    const checkInRule = parseRule(policy.checkInRule, DEFAULT_CHECK_IN_RULE);
    const checkOutRule = parseRule(policy.checkOutRule, DEFAULT_CHECK_OUT_RULE);
    res.json({
      ...policy, checkInRule, checkOutRule,
      /** Convenience for the client: is a face ever needed (enrolment prompts)? */
      faceVerificationRequired: checkInRule.face || checkOutRule.face,
      myEnrollment: enrollment,
      /** Latest re-enrolment request, or null if the user has never raised one. */
      myFaceRequest: lastRequest,
    });
  } catch (err) { next(err); }
}

const PolicySchema = z.object({
  checkInRule: RuleSchema.optional(),
  checkOutRule: RuleSchema.optional(),
  faceMatchThreshold: z.number().min(0.3).max(0.8).optional(),
  keepCheckInSelfie: z.boolean().optional(),
  autoCheckoutOnLeave: z.boolean().optional(),
  autoCheckoutAfterMinutes: z.number().int().min(1).max(240).optional(),
  heartbeatTimeoutMinutes: z.number().int().min(0).max(24 * 60).optional(),
  shareLiveLocation: z.boolean().optional(),
  locationRetentionDays: z.number().int().min(1).max(365).optional(),
  nudgeAfterMinutes: z.number().int().min(0).max(24 * 60).optional(),
  nudgeRepeatMinutes: z.number().int().min(5).max(24 * 60).optional(),
  autoCloseAfterHours: z.number().int().min(0).max(48).optional(),
  selfieRetentionDays: z.number().int().min(1).max(3650).optional(),
});

const HeartbeatSchema = z.object({
  /** Optional on a 'background' ping — the app may be paused before a fix arrives */
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
  /** GPS accuracy radius in metres, from the Geolocation API */
  accuracy: z.number().min(0).nullable().optional(),
  /** 'background' = the Android app is being paused (screen locked / app switched); the
   *  silent-session timeout is suspended until a foreground ping arrives (ATT-7). */
  state: z.enum(['foreground', 'background']).optional(),
});

/** POST /hr/attendance/heartbeat — location ping while checked in; may auto check-out (see attendanceAutoCheckout.ts). */
export async function heartbeat(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { lat, lng, accuracy, state } = HeartbeatSchema.parse(req.body);
    const coords = lat != null && lng != null && !isNullIsland(lat, lng) ? { lat, lng } : null;
    if (!coords && state !== 'background') throw new AppError(400, 'lat and lng are required');
    res.json(await recordHeartbeat(req.user!.orgId, req.user!.id, coords?.lat ?? null, coords?.lng ?? null, accuracy ?? undefined, state ?? 'foreground'));
  } catch (err) { next(err); }
}

/** PATCH /hr/attendance/policy — managers. */
export async function updatePolicy(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const data = PolicySchema.parse(req.body);
    const policy = await prisma.attendancePolicy.upsert({
      where: { orgId: req.user!.orgId },
      create: { orgId: req.user!.orgId, ...data },
      update: data,
    });
    logAction(req.user!.id, 'UPDATE', 'AttendancePolicy', policy.id, data);
    const checkInRule = parseRule(policy.checkInRule, DEFAULT_CHECK_IN_RULE);
    const checkOutRule = parseRule(policy.checkOutRule, DEFAULT_CHECK_OUT_RULE);
    res.json({ ...policy, checkInRule, checkOutRule, faceVerificationRequired: checkInRule.face || checkOutRule.face });
  } catch (err) { next(err); }
}

// ─── Face enrolment ──────────────────────────────────────────────────────────

const EnrolSchema = z.object({
  descriptors: z.array(DescriptorSchema).min(1).max(MAX_ENROLLMENT_SAMPLES),
  referenceSelfie: SelfieSchema.optional(),
});

/**
 * POST /hr/attendance/face/enrol — first-time enrolment only.
 *
 * This used to upsert, which made it the bypass route for the approval
 * workflow: an already-enrolled employee could replace their face by calling
 * it again, review or no review. It now refuses when an enrolment exists and
 * points at the request flow, so approval cannot be skipped from the API any
 * more than from the UI.
 */
export async function enrolFace(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { descriptors, referenceSelfie } = EnrolSchema.parse(req.body);
    descriptors.forEach(assertPlausibleDescriptor);
    const orgId = req.user!.orgId;
    const userId = req.user!.id;

    const existing = await prisma.faceEnrollment.findUnique({ where: { userId }, select: { id: true } });
    if (existing) {
      throw new AppError(409, 'Your face is already enrolled. Submit a re-enrolment request for approval instead.');
    }

    const enrollment = await prisma.faceEnrollment.create({
      data: { orgId, userId, descriptors, samples: descriptors.length, referenceSelfie: referenceSelfie ?? null },
      select: { samples: true, enrolledAt: true, updatedAt: true, referenceSelfie: true },
    });
    logAction(userId, 'CREATE', 'FaceEnrollment', userId, { samples: descriptors.length });
    res.json(enrollment);
  } catch (err) { next(err); }
}

// ─── Face re-enrolment requests ──────────────────────────────────────────────

const ReenrolSchema = z.object({
  descriptors: z.array(DescriptorSchema).min(1).max(MAX_ENROLLMENT_SAMPLES),
  /** One image per descriptor — the reviewer compares these with the current face. */
  sampleImages: z.array(SelfieSchema).min(1).max(MAX_ENROLLMENT_SAMPLES),
});

/** Shape returned to the employee and to reviewers in list views (no images). */
const REQUEST_SUMMARY = {
  id: true, userId: true, status: true, samples: true, rejectionReason: true,
  createdAt: true, decidedAt: true,
  user: { select: { id: true, name: true, email: true, role: true, avatarUrl: true } },
  decider: { select: { id: true, name: true } },
} as const;

/**
 * POST /hr/attendance/face/reenrol — employee submits a replacement face for
 * approval. The live enrolment is not touched; see FaceReenrollmentRequest.
 */
export async function requestFaceReenrolment(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { descriptors, sampleImages } = ReenrolSchema.parse(req.body);
    descriptors.forEach(assertPlausibleDescriptor);
    const orgId = req.user!.orgId;
    const userId = req.user!.id;

    const current = await prisma.faceEnrollment.findUnique({
      where: { userId },
      select: { referenceSelfie: true },
    });
    /* Nothing to replace — the plain enrolment route handles that case, and
       routing it here would create a request with no "before" to compare. */
    if (!current) throw new AppError(400, 'You have no enrolled face yet — enrol first.');

    try {
      const created = await prisma.faceReenrollmentRequest.create({
        data: {
          orgId, userId,
          descriptors,
          samples: descriptors.length,
          sampleImages,
          previousSelfie: current.referenceSelfie,
          status: 'PENDING',
          activePendingUserId: userId,
        },
        select: REQUEST_SUMMARY,
      });
      logAction(userId, 'CREATE', 'FaceReenrollmentRequest', created.id, { samples: descriptors.length });
      res.status(201).json(created);
    } catch (err: any) {
      /* Unique violation on active_pending_user_id — a second submission
         raced the first, or the employee double-clicked. Either way there is
         already a request waiting, which is exactly the end state they
         wanted, so report it as a conflict rather than a failure. */
      if (err?.code === 'P2002') throw new AppError(409, 'You already have a re-enrolment request awaiting approval.');
      throw err;
    }
  } catch (err) { next(err); }
}

/** GET /hr/attendance/face/requests?status=PENDING — Super Admin review queue. */
export async function listFaceRequests(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status.toUpperCase() : 'PENDING';
    if (!['PENDING', 'APPROVED', 'REJECTED', 'ALL'].includes(status)) throw new AppError(400, 'Invalid status filter');
    const rows = await prisma.faceReenrollmentRequest.findMany({
      where: { orgId: req.user!.orgId, ...(status === 'ALL' ? {} : { status }) },
      select: REQUEST_SUMMARY,
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: 200,
    });
    const pendingCount = await prisma.faceReenrollmentRequest.count({ where: { orgId: req.user!.orgId, status: 'PENDING' } });
    res.json({ data: rows, pendingCount });
  } catch (err) { next(err); }
}

/**
 * GET /hr/attendance/face/requests/:id — full detail including every
 * submitted image plus the currently active face, which is what makes the
 * review a visual comparison rather than an act of faith.
 */
export async function getFaceRequest(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const request = await prisma.faceReenrollmentRequest.findFirst({
      where: { id: req.params.id, orgId: req.user!.orgId },
      select: {
        ...REQUEST_SUMMARY,
        sampleImages: true,
        previousSelfie: true,
        user: {
          select: {
            id: true, name: true, email: true, role: true, avatarUrl: true,
            faceEnrollment: { select: { referenceSelfie: true, samples: true, enrolledAt: true } },
            employee: { select: { employeeCode: true, designation: true, department: { select: { name: true } } } },
          },
        },
      },
    });
    if (!request) throw new AppError(404, 'Request not found');
    res.json(request);
  } catch (err) { next(err); }
}

const DecisionSchema = z.object({ reason: z.string().trim().max(500).optional() });

/**
 * POST /hr/attendance/face/requests/:id/approve|reject — Super Admin decision.
 *
 * Approval swaps the enrolment and closes the request inside one transaction:
 * a half-applied decision would either leave the employee matching against a
 * face nobody approved, or leave an approved request whose face never went
 * live. The `updateMany ... where status PENDING` is a compare-and-set — if a
 * second reviewer decided the same request a moment earlier it matches zero
 * rows, and we stop instead of overwriting their decision.
 */
async function decideFaceRequest(req: AuthRequest, res: Response, next: NextFunction, approve: boolean) {
  try {
    const { reason } = DecisionSchema.parse(req.body ?? {});
    const orgId = req.user!.orgId;
    const reviewerId = req.user!.id;
    const now = new Date();

    const result = await prisma.$transaction(async tx => {
      const request = await tx.faceReenrollmentRequest.findFirst({
        where: { id: req.params.id, orgId },
      });
      if (!request) throw new AppError(404, 'Request not found');
      if (request.status !== 'PENDING') throw new AppError(409, `This request was already ${request.status.toLowerCase()}.`);

      const claimed = await tx.faceReenrollmentRequest.updateMany({
        where: { id: request.id, orgId, status: 'PENDING' },
        data: {
          status: approve ? 'APPROVED' : 'REJECTED',
          decidedBy: reviewerId,
          decidedAt: now,
          rejectionReason: approve ? null : (reason || null),
          // Releases the one-pending-per-user slot so the employee can submit again.
          activePendingUserId: null,
        },
      });
      if (claimed.count === 0) throw new AppError(409, 'This request was just decided by someone else.');

      if (approve) {
        const images = Array.isArray(request.sampleImages) ? (request.sampleImages as string[]) : [];
        await tx.faceEnrollment.upsert({
          where: { userId: request.userId },
          create: {
            orgId, userId: request.userId,
            descriptors: request.descriptors as any,
            samples: request.samples,
            referenceSelfie: images[0] ?? null,
          },
          update: {
            descriptors: request.descriptors as any,
            samples: request.samples,
            referenceSelfie: images[0] ?? null,
            enrolledAt: now,
          },
        });
      }

      return tx.faceReenrollmentRequest.findUnique({ where: { id: request.id }, select: REQUEST_SUMMARY });
    });

    logAction(reviewerId, 'UPDATE', 'FaceReenrollmentRequest', req.params.id, { decision: approve ? 'APPROVED' : 'REJECTED', reason: reason || null });
    res.json(result);
  } catch (err) { next(err); }
}

export const approveFaceRequest = (req: AuthRequest, res: Response, next: NextFunction) => decideFaceRequest(req, res, next, true);
export const rejectFaceRequest = (req: AuthRequest, res: Response, next: NextFunction) => decideFaceRequest(req, res, next, false);

/** GET /hr/attendance/face — managers: who in the org is enrolled. */
export async function listEnrollments(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const rows = await prisma.faceEnrollment.findMany({
      where: { orgId: req.user!.orgId },
      select: { userId: true, samples: true, enrolledAt: true, user: { select: { name: true, email: true, role: true } } },
      orderBy: { enrolledAt: 'desc' },
    });
    res.json(rows);
  } catch (err) { next(err); }
}

/** DELETE /hr/attendance/face/:userId — managers reset someone's enrolment (they enrol again next check-in). */
export async function deleteUserFace(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const target = await prisma.user.findFirst({ where: { id: req.params.userId, orgId: req.user!.orgId }, select: { id: true } });
    if (!target) throw new AppError(404, 'User not found');
    await prisma.$transaction([
      prisma.faceEnrollment.deleteMany({ where: { userId: target.id } }),
      /* A pending request proposes a replacement for an enrolment that no
         longer exists, so leaving it open would block the user's fresh
         enrolment behind a review of a face with nothing to compare against.
         Closed as rejected rather than deleted, to keep the decision trail. */
      prisma.faceReenrollmentRequest.updateMany({
        where: { userId: target.id, status: 'PENDING' },
        data: {
          status: 'REJECTED', decidedBy: req.user!.id, decidedAt: new Date(),
          rejectionReason: 'Enrolment was reset by an administrator — please enrol again.',
          activePendingUserId: null,
        },
      }),
    ]);
    logAction(req.user!.id, 'DELETE', 'FaceEnrollment', target.id, { resetBy: req.user!.id });
    res.json({ ok: true });
  } catch (err) { next(err); }
}


// ─── Live location (managers) ────────────────────────────────────────────────

const STALE_AFTER_MS = 3 * 60_000;

/** GET /hr/attendance/live — every open session's last known position, plus offices for the map. */
export async function liveLocations(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const policy = await getOrCreateAttendancePolicy(orgId);
    if (!policy.shareLiveLocation) throw new AppError(403, 'Live location sharing is switched off for your organisation — enable it under HR Settings → Attendance.');
    const [sessions, offices] = await Promise.all([
      prisma.attendanceRecord.findMany({
        where: { orgId, checkInAt: { not: null }, checkOutAt: null },
        select: { ...RECORD_PUBLIC_SELECT, user: { select: { id: true, name: true, role: true, avatarUrl: true, department: true } } },
        orderBy: { checkInAt: 'asc' },
      }),
      prisma.officeLocation.findMany({ where: { orgId, isActive: true }, select: { id: true, name: true, latitude: true, longitude: true, radiusMeters: true } }),
    ]);
    const now = Date.now();
    res.json({
      generatedAt: new Date(),
      offices,
      people: sessions.map(s => {
        // 0,0 is the "no location" placeholder older face-only clients sent — never plot it
        const seen = s.lastSeenLat != null && s.lastSeenLng != null && !isNullIsland(s.lastSeenLat, s.lastSeenLng);
        const atIn = s.checkInLat != null && s.checkInLng != null && !isNullIsland(s.checkInLat, s.checkInLng);
        const lat = seen ? s.lastSeenLat : atIn ? s.checkInLat : null;
        const lng = seen ? s.lastSeenLng : atIn ? s.checkInLng : null;
        const seenAt = s.lastSeenAt ?? s.checkInAt;
        const nearest = lat != null && lng != null && offices.length
          ? offices.reduce((best, o) => { const d = distanceMeters(lat, lng, o.latitude, o.longitude); return d < best.d ? { d, name: o.name } : best; }, { d: Infinity, name: '' })
          : null;
        return {
          user: s.user,
          recordId: s.id,
          checkInAt: s.checkInAt,
          lat, lng,
          seenAt,
          /** true = last fix older than 3 min (app closed / no signal) */
          stale: seenAt ? now - new Date(seenAt).getTime() > STALE_AFTER_MS : true,
          inside: s.lastSeenInside ?? s.checkInLocationOk,
          nearestOffice: nearest && Number.isFinite(nearest.d) ? { name: nearest.name, distanceMeters: Math.round(nearest.d) } : null,
          outsideSince: s.outsideSince,
          /** The app reported it went to the background (screen locked) — no pings until it's reopened */
          backgroundedAt: s.backgroundedAt,
        };
      }),
    });
  } catch (err) { next(err); }
}

/** GET /hr/attendance/trail/:userId?date=YYYY-MM-DD — one person's pings and sessions for a day. */
export async function locationTrail(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const policy = await getOrCreateAttendancePolicy(orgId);
    if (!policy.shareLiveLocation) throw new AppError(403, 'Live location sharing is switched off for your organisation.');
    const user = await prisma.user.findFirst({ where: { id: req.params.userId, orgId }, select: { id: true, name: true } });
    if (!user) throw new AppError(404, 'User not found');
    const { policy: dayPolicy } = await policyForUser(orgId, user.id);
    const dateStr = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : todayKeyFor(dayPolicy);
    // The day in the employee's timezone, extended to the next morning for overnight shifts
    const from = zonedDayStart(dateStr, dayPolicy.timezone);
    const to = new Date(zonedDayStart(addDaysKey(dateStr, 1), dayPolicy.timezone).getTime() + 12 * 3_600_000);
    const [pings, sessions] = await Promise.all([
      prisma.attendanceLocationPing.findMany({ where: { orgId, userId: user.id, at: { gte: from, lt: to } }, orderBy: { at: 'asc' }, select: { at: true, lat: true, lng: true, accuracy: true, inside: true } }),
      recordsForDays(orgId, user.id, dayPolicy, dateStr, dateStr, RECORD_PUBLIC_SELECT),
    ]);
    res.json({ user, date: dateStr, pings, sessions });
  } catch (err) { next(err); }
}

/** POST /hr/attendance/locate/:userId — asks that person's open app to send a ping right now (SSE). */
export async function requestLocate(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const policy = await getOrCreateAttendancePolicy(orgId);
    if (!policy.shareLiveLocation) throw new AppError(403, 'Live location sharing is switched off for your organisation.');
    const target = await prisma.user.findFirst({ where: { id: req.params.userId, orgId }, select: { id: true } });
    if (!target) throw new AppError(404, 'User not found');
    const connected = sseManager.isUserConnected(orgId, target.id);
    if (connected) {
      sseManager.sendToUsers(orgId, [target.id], SSEEvent.ATTENDANCE_LOCATE, { requestedBy: req.user!.id, at: new Date() });
    } else {
      // App isn't open anywhere — a push notification is the only way to reach the device.
      // The service worker relays it to any background tab, or the person taps to open the app.
      await sendPushToUser(target.id, {
        title: 'Attendance — location requested',
        body: 'Your manager asked for your current location. Tap to open the app and update it.',
        url: '/hr/attendance',
        tag: 'attendance-location', type: 'attendance:locate',
      });
    }
    logAction(req.user!.id, 'READ', 'AttendanceRecord', target.id, { action: 'locate_request', via: connected ? 'sse' : 'push' });
    res.json({ requested: true, via: connected ? 'sse' : 'push' });
  } catch (err) { next(err); }
}
