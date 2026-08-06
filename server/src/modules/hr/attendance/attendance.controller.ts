import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../../../utils/prisma';
import { AuthRequest } from '../../../middleware/authenticate';
import { AppError } from '../../../middleware/errorHandler';
import { verifyAgainstOffices, extractClientIp, sumWorkedMinutes } from '../../../utils/attendanceVerification';
import { sseManager, SSEEvent } from '../../../utils/sse';
import { logAction } from '../../../utils/auditLog';

function todayDateOnly(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

const CheckSchema = z.object({
  lat: z.number(),
  lng: z.number(),
});

/** POST /hr/attendance/check-in — starts a new session; a day can have several. */
export async function checkIn(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { lat, lng } = CheckSchema.parse(req.body);
    const orgId = req.user!.orgId;
    const userId = req.user!.id;
    const date = todayDateOnly();

    // Block only if there's already an OPEN session today (checked in, not
    // yet checked out) — a completed earlier session (lunch break, a
    // finished half-shift) no longer blocks a new check-in the way a single
    // check-in/out pair per day used to.
    const openSession = await prisma.attendanceRecord.findFirst({
      where: { userId, date, checkInAt: { not: null }, checkOutAt: null },
    });
    if (openSession) throw new AppError(400, "You're already checked in — check out first before starting a new session.");

    const offices = await prisma.officeLocation.findMany({ where: { orgId, isActive: true } });
    if (offices.length === 0) {
      throw new AppError(400, 'No office location is configured yet — ask an admin to set one up in HR Settings.');
    }

    const ip = extractClientIp(req.headers as Record<string, unknown>, req.socket.remoteAddress);
    const result = verifyAgainstOffices(offices, lat, lng, ip);

    // verifyAgainstOffices() now requires BOTH signals once an office has an
    // IP allowlist configured (GPS alone used to be enough even for those
    // offices) — so a failure here can be a location miss, a network miss,
    // or both, and each has to be checked independently rather than
    // assuming location must be the culprit whenever passed is false.
    if (!result.passed) {
      const reasons: string[] = [];
      if (!result.locationOk) {
        reasons.push(result.nearestDistanceMeters != null
          ? `you're about ${result.nearestDistanceMeters}m from the office`
          : "we couldn't confirm your location");
      }
      if (result.networkStatus === 'not_matched') reasons.push("you don't appear to be on the office network");
      throw new AppError(403, `Check-in blocked — ${reasons.join(' and ')}. Ask a manager to add a manual entry if this is a legitimate exception.`);
    }

    const record = await prisma.attendanceRecord.create({
      data: {
        orgId, userId, date,
        checkInAt: new Date(), checkInLat: lat, checkInLng: lng, checkInIp: ip,
        checkInLocationOk: result.locationOk, checkInNetworkOk: result.networkOk,
        source: 'SELF',
      },
    });

    logAction(userId, 'CREATE', 'AttendanceRecord', record.id, { action: 'check_in' });
    sseManager.broadcastAll(orgId, SSEEvent.ATTENDANCE_UPDATED, { userId, type: 'check_in' });
    res.json(record);
  } catch (err) { next(err); }
}

/** POST /hr/attendance/check-out — closes the currently-open session. */
export async function checkOut(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { lat, lng } = CheckSchema.parse(req.body);
    const orgId = req.user!.orgId;
    const userId = req.user!.id;
    const date = todayDateOnly();

    const openSession = await prisma.attendanceRecord.findFirst({
      where: { userId, date, checkInAt: { not: null }, checkOutAt: null },
      orderBy: { checkInAt: 'desc' },
    });
    if (!openSession) throw new AppError(400, "You haven't checked in yet — nothing to check out of.");

    const offices = await prisma.officeLocation.findMany({ where: { orgId, isActive: true } });
    const ip = extractClientIp(req.headers as Record<string, unknown>, req.socket.remoteAddress);
    const result = verifyAgainstOffices(offices, lat, lng, ip);

    // Checkout is intentionally NOT blocked by a failed verification — an
    // employee who legitimately leaves the office (client visit, end of
    // day from home) should still be able to log a checkout time. The
    // verification flags are still recorded for a manager to see.
    const record = await prisma.attendanceRecord.update({
      where: { id: openSession.id },
      data: {
        checkOutAt: new Date(), checkOutLat: lat, checkOutLng: lng, checkOutIp: ip,
        checkOutLocationOk: result.locationOk, checkOutNetworkOk: result.networkOk,
      },
    });

    logAction(userId, 'UPDATE', 'AttendanceRecord', record.id, { action: 'check_out' });
    sseManager.broadcastAll(orgId, SSEEvent.ATTENDANCE_UPDATED, { userId, type: 'check_out' });
    res.json(record);
  } catch (err) { next(err); }
}

/** GET /hr/attendance/me?month=YYYY-MM — every session, grouped client-side by date. */
export async function myAttendance(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const userId = req.user!.id;
    const month = (req.query.month as string) || new Date().toISOString().slice(0, 7);
    const [y, m] = month.split('-').map(Number);
    const from = new Date(Date.UTC(y, m - 1, 1));
    const to = new Date(Date.UTC(y, m, 1));

    const records = await prisma.attendanceRecord.findMany({
      where: { orgId, userId, date: { gte: from, lt: to } },
      orderBy: [{ date: 'desc' }, { checkInAt: 'desc' }],
    });
    res.json(records);
  } catch (err) { next(err); }
}

/** GET /hr/attendance/today — manager view of every active employee's sessions + live status today */
export async function todayStatus(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const date = todayDateOnly();

    const [users, records] = await Promise.all([
      prisma.user.findMany({ where: { orgId, isActive: true }, select: { id: true, name: true, role: true, avatarUrl: true } }),
      prisma.attendanceRecord.findMany({ where: { orgId, date }, orderBy: { checkInAt: 'asc' } }),
    ]);
    const byUser = new Map<string, typeof records>();
    for (const r of records) {
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
        isCheckedInNow: !!(last && last.checkInAt && !last.checkOutAt),
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
    if (from || to) {
      where.date = {};
      if (from) where.date.gte = new Date(from);
      if (to) where.date.lte = new Date(to);
    }
    const records = await prisma.attendanceRecord.findMany({
      where,
      include: { user: { select: { id: true, name: true, avatarUrl: true } } },
      orderBy: [{ date: 'desc' }, { checkInAt: 'desc' }],
      take: 500,
    });
    res.json(records);
  } catch (err) { next(err); }
}

const ManualEntrySchema = z.object({
  userId: z.string(),
  date: z.string(), // YYYY-MM-DD
  checkInAt: z.string().nullable().optional(),
  checkOutAt: z.string().nullable().optional(),
  notes: z.string().optional(),
});

/** POST /hr/attendance/manual — manager adds a session for an employee, bypassing geofence/IP checks.
 *  Always creates a new session row rather than upserting one-per-day — a
 *  day can have several sessions now, so there's no longer a single slot to
 *  overwrite; use this to add a missed/forgotten session alongside whatever
 *  the employee already logged themselves. */
export async function manualEntry(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const data = ManualEntrySchema.parse(req.body);
    const orgId = req.user!.orgId;
    const target = await prisma.user.findFirst({ where: { id: data.userId, orgId } });
    if (!target) throw new AppError(404, 'User not found');

    const [y, m, d] = data.date.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));

    const record = await prisma.attendanceRecord.create({
      data: {
        orgId, userId: data.userId, date,
        checkInAt: data.checkInAt ? new Date(data.checkInAt) : undefined,
        checkOutAt: data.checkOutAt ? new Date(data.checkOutAt) : undefined,
        notes: data.notes, source: 'MANUAL',
      },
    });

    logAction(req.user!.id, 'CREATE', 'AttendanceRecord', record.id, { action: 'manual_entry', targetUserId: data.userId });
    sseManager.broadcastAll(orgId, SSEEvent.ATTENDANCE_UPDATED, { userId: data.userId, type: 'manual' });
    res.json(record);
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
