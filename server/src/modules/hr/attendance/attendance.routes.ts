import { Router } from 'express';
import { authenticate, requireRole, ALL_USERS, MANAGERS } from '../../../middleware/authenticate';
import * as c from './attendance.controller';

const router = Router();
router.use(authenticate);

// Self-service — every staff role, including EMPLOYEE, marks their own attendance.
router.post('/check-in',  requireRole(...ALL_USERS), c.checkIn);
router.post('/check-out', requireRole(...ALL_USERS), c.checkOut);
router.get('/me',         requireRole(...ALL_USERS), c.myAttendance);
router.post('/heartbeat', requireRole(...ALL_USERS), c.heartbeat);

// Face verification — policy is readable by everyone (the check-in UI needs
// it), editable by managers; enrolment is self-service, reset is self or manager.
router.get('/policy',            requireRole(...ALL_USERS), c.getPolicy);
router.patch('/policy',          requireRole(...MANAGERS),  c.updatePolicy);
router.post('/face/enrol',       requireRole(...ALL_USERS), c.enrolFace);
router.delete('/face/me',        requireRole(...ALL_USERS), c.deleteMyFace);
router.get('/face',              requireRole(...MANAGERS),  c.listEnrollments);
router.delete('/face/:userId',   requireRole(...MANAGERS),  c.deleteUserFace);

// Manager views
router.get('/today',      requireRole(...MANAGERS), c.todayStatus);
router.get('/live',           requireRole(...MANAGERS), c.liveLocations);
router.get('/trail/:userId',  requireRole(...MANAGERS), c.locationTrail);
router.post('/locate/:userId', requireRole(...MANAGERS), c.requestLocate);
router.get('/',           requireRole(...MANAGERS), c.listAttendance);
router.post('/manual',    requireRole(...MANAGERS), c.manualEntry);

// Office locations (admin config)
router.get('/my-ip',                   requireRole(...MANAGERS), c.myIp);
router.get('/my-host',                 requireRole(...MANAGERS), c.myHost);
router.get('/check-host',              requireRole(...MANAGERS), c.checkHost);
router.get('/office-locations',        requireRole(...MANAGERS), c.listOfficeLocations);
router.post('/office-locations',       requireRole(...MANAGERS), c.createOfficeLocation);
router.patch('/office-locations/:id',  requireRole(...MANAGERS), c.updateOfficeLocation);
router.delete('/office-locations/:id', requireRole(...MANAGERS), c.deleteOfficeLocation);

export { router as attendanceRouter };
