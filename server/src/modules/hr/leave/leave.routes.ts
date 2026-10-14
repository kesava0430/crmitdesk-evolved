import { Router } from 'express';
import { authenticate, requireRole, ALL_USERS } from '../../../middleware/authenticate';
// HR-manager role set lives in one place (utils/hrAccess.ts)
import { HR_MANAGERS as MANAGERS } from '../../../utils/hrAccess';
import * as c from './leave.controller';
import * as w from './wfh.controller';

const router = Router();
router.use(authenticate);

// Leave types — readable by everyone (needed for the "apply" dropdown), writable by managers only.
router.get('/types',          requireRole(...ALL_USERS), c.listLeaveTypes);
router.post('/types',         requireRole(...MANAGERS),  c.createLeaveType);
router.patch('/types/:id',    requireRole(...MANAGERS),  c.updateLeaveType);
router.delete('/types/:id',   requireRole(...MANAGERS),  c.deleteLeaveType);

router.get('/balance',        requireRole(...ALL_USERS), c.myBalance);
router.post('/balances/adjust', requireRole(...MANAGERS), c.adjustBalance);

// Admin leave control
router.post('/requests/on-behalf',        requireRole(...MANAGERS), c.applyOnBehalf);
router.patch('/requests/:id',             requireRole(...MANAGERS), c.modifyRequest);
router.post('/requests/:id/admin-cancel', requireRole(...MANAGERS), c.adminCancel);
router.post('/convert',                   requireRole(...MANAGERS), c.convertAttendanceToLeave);

router.get('/requests',           requireRole(...ALL_USERS), c.listRequests);
router.post('/requests',          requireRole(...ALL_USERS), c.createRequest);
router.post('/requests/:id/cancel',  requireRole(...ALL_USERS), c.cancelRequest);
router.patch('/requests/:id/approve', requireRole(...MANAGERS), c.approveRequest);
router.patch('/requests/:id/reject',  requireRole(...MANAGERS), c.rejectRequest);

// Work from home — requests are leave requests of a WFH type (approve / reject /
// modify / cancel above); these add the request form, usage and recurring WFH.
router.get('/wfh/me',          requireRole(...ALL_USERS), w.wfhSummary);
router.post('/wfh/requests',   requireRole(...ALL_USERS), w.requestWfh);
router.get('/wfh/schedules',             requireRole(...MANAGERS), w.listSchedules);
router.post('/wfh/schedules',            requireRole(...MANAGERS), w.createSchedule);
router.patch('/wfh/schedules/:id',       requireRole(...MANAGERS), w.updateSchedule);
router.delete('/wfh/schedules/:id',      requireRole(...MANAGERS), w.deleteSchedule);
router.post('/wfh/schedules/:id/exceptions',                requireRole(...MANAGERS), w.addException);
router.delete('/wfh/schedules/:id/exceptions/:exceptionId', requireRole(...MANAGERS), w.removeException);

export { router as leaveRouter };
