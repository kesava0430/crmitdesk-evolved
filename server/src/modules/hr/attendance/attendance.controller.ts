import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../../../utils/prisma';
import { AuthRequest } from '../../../middleware/authenticate';
import { AppError } from '../../../middleware/errorHandler';
import { verifyAgainstOffices, extractClientIp } from '../../../utils/attendanceVerification';
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

/** POST /hr/attendance/check-in */
export async function checkIn(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { lat, lng } = CheckSchema.parse(req.body);
    const orgId = req.user!.orgId;
    const userId = req.user!.id;
    const date = todayDateOnly();

    const existing = await prisma.attendanceRecord.findUnique({ where: { userId_date: { userId, date } } });
    if (existing?.checkInAt) throw new AppError(400, 'Already checked in today');

    const offices = await prisma.officeLocation.findMany({ where: { orgId, isActive: true } });
    if (offices.length === 0) {
      throw new AppError(400, 'No office location is configured yet — ask an admin to set one up in HR Settings.');
    }

    const ip = extractClientIp(req.headers as Record<string, unknown>, req.socket.remoteAddress);
    const result = verifyAgainstOffices(offices, lat, lng, ip);

    if (!result.locationOk || !result.networkOk) {
      const reasons: string[] = [];
      if (!result.locationOk) {
        reasons.push(result.nearestDistanceMeters != null
          ? `you're about ${result.nearestDistanceMeters}m from the office`
          : "we couldn't confirm your location");
      }
      if (!result.networkOk) reasons.push("you don't appear to be on the office network");
      throw new AppError(403, `Check-in blocked — ${reasons.join(' and ')}. Ask a manager to add a manual entry if this is a legitimate exception.`);
    }

    const record = await prisma.attendanceRecord.upsert({
      where: { userId_date: { userId, date } },
      create: {
        orgId, userId, date,
        checkInAt: new Date(), checkInLat: lat, checkInLng: lng, checkInIp: ip,
        checkInLocationOk: result.locationOk, checkInNetworkOk: result.networkOk,
        source: 'SELF',
      },
      update: {
        checkInAt: new Date(), checkInLat: lat, checkInLng: lng, checkInIp: ip,
        checkInLocationOk: result.locationOk, checkInNetworkOk: result.networkOk,
      },
    });

    logAction(userId, 'CREATE', 'AttendanceRecord', record.id, { action: 'check_in' });
    sseManager.broadcastAll(orgId, SSEEvent.ATTENDANCE_UPDATED, { userId, type: 'check_in' });
    res.json(record);
  } catch (err) { next(err); }
}

/** POST /hr/attendance/check-out */
export async function checkOut(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { lat, lng } = CheckSchema.parse(req.body);
    const orgId = req.user!.orgId;
    const userId = req.user!.id;
    const date = todayDateOnly();

    const existing = await prisma.attendanceRecord.findUnique({ where: { userId_date: { userId, date } } });
    if (!existing?.checkInAt) throw new AppError(400, "You haven't checked in today yet");
    if (existing.checkOutAt) throw new AppError(400, 'Already checked out today');

    const offices = await prisma.officeLocation.findMany({ where: { orgId, isActive: true } });
    const ip = extractClientIp(req.headers as Record<string, unknown>, req.socket.remoteAddress);
    const result = verifyAgainstOffices(offices, lat, lng, ip);

    // Checkout is intentionally NOT blocked by a failed verification — an
    // employee who legitimately leaves the office (client visit, end of
    // day from home) should still be able to log a checkout time. The
    // verification flags are still recorded for a manager to see.
    const record = await prisma.attendanceRecord.update({
      where: { userId_date: { userId, date } },
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

/** GET /hr/attendance/me?month=YYYY-MM */
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
      orderBy: { date: 'desc' },
    });
    res.json(records);
  } catch (err) { next(err); }
}

/** GET /hr/attendance/today — manager view of every active employee's status today */
export async function todayStatus(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const date = todayDateOnly();

    const [users, records] = await Promise.all([
      prisma.user.findMany({ where: { orgId, isActive: true }, select: { id: true, name: true, role: true, avatarUrl: true } }),
      prisma.attendanceRecord.findMany({ where: { orgId, date } }),
    ]);
    const byUser = new Map(records.map(r => [r.userId, r]));
    const rows = users.map(u => ({ user: u, record: byUser.get(u.id) || null }));
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
      orderBy: { date: 'desc' },
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

/** POST /hr/attendance/manual — manager creates/edits an entry, bypassing geofence/IP checks */
export async function manualEntry(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const data = ManualEntrySchema.parse(req.body);
    const orgId = req.user!.orgId;
    const target = await prisma.user.findFirst({ where: { id: data.userId, orgId } });
    if (!target) throw new AppError(404, 'User not found');

    const [y, m, d] = data.date.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));

    // Only touch checkInAt/checkOutAt if the request actually included that
    // key — distinguishes "not mentioned, leave as-is" (key absent) from
    // "explicitly clearing it" (key present with null), so editing just the
    // notes on an existing manual entry doesn't wipe its times.
    const updateData: Record<string, unknown> = { notes: data.notes, source: 'MANUAL' };
    if ('checkInAt' in req.body) updateData.checkInAt = data.checkInAt ? new Date(data.checkInAt) : null;
    if ('checkOutAt' in req.body) updateData.checkOutAt = data.checkOutAt ? new Date(data.checkOutAt) : null;

    const record = await prisma.attendanceRecord.upsert({
      where: { userId_date: { userId: data.userId, date } },
      create: {
        orgId, userId: data.userId, date,
        checkInAt: data.checkInAt ? new Date(data.checkInAt) : undefined,
        checkOutAt: data.checkOutAt ? new Date(data.checkOutAt) : undefined,
        notes: data.notes, source: 'MANUAL',
      },
      update: updateData,
    });

    logAction(req.user!.id, 'UPDATE', 'AttendanceRecord', record.id, { action: 'manual_entry', targetUserId: data.userId });
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
