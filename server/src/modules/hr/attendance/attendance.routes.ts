import { Router } from 'express';
import { authenticate, requireRole, ALL_USERS, MANAGERS, ADMIN } from '../../../middleware/authenticate';
import * as c from './attendance.controller';
import * as a from './attendanceAdmin.controller';

const router = Router();
router.use(authenticate);

// Self-service — every staff role, including EMPLOYEE, marks their own attendance.
router.post('/check-in',  requireRole(...ALL_USERS), c.checkIn);
router.post('/check-out', requireRole(...ALL_USERS), c.checkOut);
router.get('/me',         requireRole(...ALL_USERS), c.myAttendance);
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
router.patch('/policy',          requireRole(...MANAGERS),  c.updatePolicy);
router.post('/face/enrol',       requireRole(...ALL_USERS), c.enrolFace);
router.post('/face/reenrol',     requireRole(...ALL_USERS), c.requestFaceReenrolment);
router.get('/face',              requireRole(...MANAGERS),  c.listEnrollments);

// Re-enrolment review — Super Admin only, not the MANAGERS group the rest of
// this router uses. Kept above the parameterised '/face/:userId' so that
// adding a GET or POST there later cannot start shadowing these.
router.get('/face/requests',             requireRole(...ADMIN), c.listFaceRequests);
router.get('/face/requests/:id',         requireRole(...ADMIN), c.getFaceRequest);
router.post('/face/requests/:id/approve', requireRole(...ADMIN), c.approveFaceRequest);
router.post('/face/requests/:id/reject',  requireRole(...ADMIN), c.rejectFaceRequest);

router.delete('/face/:userId',   requireRole(...MANAGERS),  c.deleteUserFace);

// Policy engine: groups, holidays, register, corrections (see attendanceAdmin.controller.ts)
router.get('/policy-groups',          requireRole(...MANAGERS),  a.listGroups);
router.post('/policy-groups',         requireRole(...MANAGERS),  a.saveGroup);
router.put('/policy-groups/:id',      requireRole(...MANAGERS),  a.saveGroup);
router.delete('/policy-groups/:id',   requireRole(...MANAGERS),  a.deleteGroup);
router.get('/my-policy',              requireRole(...ALL_USERS), a.myPolicy);
router.get('/holidays',               requireRole(...ALL_USERS), a.listHolidays);
router.post('/holidays',              requireRole(...MANAGERS),  a.saveHoliday);
router.post('/holidays/bulk',         requireRole(...MANAGERS),  a.bulkHolidays);
router.put('/holidays/:id',           requireRole(...MANAGERS),  a.saveHoliday);
router.delete('/holidays/:id',        requireRole(...MANAGERS),  a.deleteHoliday);
router.get('/register',               requireRole(...ALL_USERS), a.register);
router.get('/summary',                requireRole(...ALL_USERS), a.summary);
router.post('/days',                  requireRole(...MANAGERS),  a.markDay);
router.delete('/days/:userId/:date',  requireRole(...MANAGERS),  a.resetDay);
router.get('/audit',                  requireRole(...ALL_USERS), a.auditHistory);

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
