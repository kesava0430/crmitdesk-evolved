import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { authenticate, requireRole, ALL_USERS, ADMIN } from '../../../middleware/authenticate';
// HR-manager role set lives in one place (utils/hrAccess.ts); aliased so the route table reads as before.
import { requireHrManager } from '../../../utils/hrAccess';
import * as c from './attendance.controller';
import * as a from './attendanceAdmin.controller';

const router = Router();
router.use(authenticate);

// Self-service — every staff role, including EMPLOYEE, marks their own attendance.
router.post('/check-in',  requireRole(...ALL_USERS), c.checkIn);
router.post('/check-out', requireRole(...ALL_USERS), c.checkOut);
router.get('/me',         requireRole(...ALL_USERS), c.myAttendance);
router.get('/me/today',   requireRole(...ALL_USERS), c.myToday);
router.post('/heartbeat', requireRole(...ALL_USERS), c.heartbeat);

// Face verification — policy is readable by everyone (the check-in UI needs
// it), editable by managers.
//
// Enrolment is asymmetric by design: the FIRST enrolment is self-service,
// because there is nothing yet to protect, but REPLACING an enrolled face
// goes through Super Admin review. There is deliberately no self-service
// delete — removing your own face would otherwise be a one-line way to drop
// back to the unreviewed first-enrolment path. Managers keep a reset route
// for the genuine cases (a bad enrolment, someone who cannot match).
router.get('/policy',            requireRole(...ALL_USERS), c.getPolicy);
router.patch('/policy',          requireHrManager('attendance'),  c.updatePolicy);
router.post('/face/enrol',       requireRole(...ALL_USERS), c.enrolFace);
// Liveness challenges (utils/liveness). Failed checks are capped at 5 per 10
// minutes in the challenge service itself (DB-backed, survives restarts);
// this limiter only stops a client from minting challenges in a loop.
const challengeLimiter = rateLimit({
  windowMs: 10 * 60_000, max: 30, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => (req as any).user?.id ?? req.ip ?? 'anon',
  message: { error: 'Too many face checks in a short time — wait a few minutes and try again.' },
});
router.post('/face/challenge',             requireRole(...ALL_USERS), challengeLimiter, c.createFaceChallenge);
router.post('/face/challenge/:id/abandon', requireRole(...ALL_USERS), c.abandonFaceChallenge);
router.get('/face/attempts',               requireHrManager('attendance'),  c.listFaceAttempts);
router.get('/face/attempts/:id',           requireHrManager('attendance'),  c.getFaceAttempt);
router.post('/face/reenrol',     requireRole(...ALL_USERS), c.requestFaceReenrolment);
router.get('/face',              requireHrManager('attendance'),  c.listEnrollments);

// Re-enrolment review — Super Admin only, not the MANAGERS group the rest of
// this router uses. Kept above the parameterised '/face/:userId' so that
// adding a GET or POST there later cannot start shadowing these.
router.get('/face/requests',             requireRole(...ADMIN), c.listFaceRequests);
router.get('/face/requests/:id',         requireRole(...ADMIN), c.getFaceRequest);
router.post('/face/requests/:id/approve', requireRole(...ADMIN), c.approveFaceRequest);
router.post('/face/requests/:id/reject',  requireRole(...ADMIN), c.rejectFaceRequest);

router.delete('/face/:userId',   requireHrManager('attendance'),  c.deleteUserFace);

// Policy engine: groups, holidays, register, corrections (see attendanceAdmin.controller.ts)
router.get('/policy-groups',          requireHrManager('attendance'),  a.listGroups);
router.post('/policy-groups',         requireHrManager('attendance'),  a.saveGroup);
router.put('/policy-groups/:id',      requireHrManager('attendance'),  a.saveGroup);
router.delete('/policy-groups/:id',   requireHrManager('attendance'),  a.deleteGroup);
router.get('/my-policy',              requireRole(...ALL_USERS), a.myPolicy);
router.get('/holidays',               requireRole(...ALL_USERS), a.listHolidays);
router.post('/holidays',              requireHrManager('attendance'),  a.saveHoliday);
router.post('/holidays/bulk',         requireHrManager('attendance'),  a.bulkHolidays);
router.put('/holidays/:id',           requireHrManager('attendance'),  a.saveHoliday);
router.delete('/holidays/:id',        requireHrManager('attendance'),  a.deleteHoliday);
router.get('/register',               requireRole(...ALL_USERS), a.register);
router.get('/summary',                requireRole(...ALL_USERS), a.summary);
router.get('/day',                    requireRole(...ALL_USERS), a.dayDetail);
router.get('/optional-holidays',      requireRole(...ALL_USERS), a.listOptionalHolidays);
router.post('/optional-holidays/:id', requireRole(...ALL_USERS), a.setOptionalHoliday);
router.delete('/optional-holidays/:id', requireRole(...ALL_USERS), a.setOptionalHoliday);
router.get('/records/:id/selfie',     requireRole(...ALL_USERS), c.recordSelfie);
router.post('/days',                  requireHrManager('attendance'),  a.markDay);
// Bulk edit: a handful per minute per person is plenty for a human; this stops
// a stuck client or script from hammering the heaviest write in the module.
const bulkLimiter = rateLimit({
  windowMs: 60_000, max: 20, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => (req as any).user?.id ?? req.ip ?? 'anon',
  message: { error: 'Too many bulk edits in a short time — wait a minute and try again.' },
});
router.post('/days/bulk',             requireHrManager('attendance'),  bulkLimiter, a.bulkDays);
router.delete('/days/:userId/:date',  requireHrManager('attendance'),  a.resetDay);
router.get('/audit',                  requireRole(...ALL_USERS), a.auditHistory);

// Manager views
router.get('/today',      requireHrManager('attendance'), c.todayStatus);
router.get('/live',           requireHrManager('attendance'), c.liveLocations);
router.get('/trail/:userId',  requireHrManager('attendance'), c.locationTrail);
router.post('/locate/:userId', requireHrManager('attendance'), c.requestLocate);
router.get('/',           requireHrManager('attendance'), c.listAttendance);
router.post('/manual',    requireHrManager('attendance'), c.manualEntry);

// Office locations (admin config)
router.get('/my-ip',                   requireHrManager('attendance'), c.myIp);
router.get('/my-host',                 requireHrManager('attendance'), c.myHost);
router.get('/check-host',              requireHrManager('attendance'), c.checkHost);
router.get('/office-locations',        requireHrManager('attendance'), c.listOfficeLocations);
router.post('/office-locations',       requireHrManager('attendance'), c.createOfficeLocation);
router.patch('/office-locations/:id',  requireHrManager('attendance'), c.updateOfficeLocation);
router.delete('/office-locations/:id', requireHrManager('attendance'), c.deleteOfficeLocation);

export { router as attendanceRouter };
