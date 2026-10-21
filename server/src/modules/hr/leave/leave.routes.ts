import { Router } from 'express';
import { authenticate, requireRole, ALL_USERS } from '../../../middleware/authenticate';
// HR-manager role set lives in one place (utils/hrAccess.ts)
import { requireHrManager } from '../../../utils/hrAccess';
import * as c from './leave.controller';
import * as w from './wfh.controller';

const router = Router();
router.use(authenticate);

// Leave types — readable by everyone (needed for the "apply" dropdown), writable by managers only.
router.get('/types',          requireRole(...ALL_USERS), c.listLeaveTypes);
router.post('/types',         requireHrManager('leave'),  c.createLeaveType);
router.patch('/types/:id',    requireHrManager('leave'),  c.updateLeaveType);
router.delete('/types/:id',   requireHrManager('leave'),  c.deleteLeaveType);

router.get('/balance',        requireRole(...ALL_USERS), c.myBalance);
router.post('/balances/adjust', requireHrManager('leave'), c.adjustBalance);

// Admin leave control
router.post('/requests/on-behalf',        requireHrManager('leave'), c.applyOnBehalf);
router.patch('/requests/:id',             requireHrManager('leave'), c.modifyRequest);
router.post('/requests/:id/admin-cancel', requireHrManager('leave'), c.adminCancel);
router.post('/convert',                   requireHrManager('leave'), c.convertAttendanceToLeave);

router.get('/requests',           requireRole(...ALL_USERS), c.listRequests);
router.post('/requests',          requireRole(...ALL_USERS), c.createRequest);
router.post('/requests/:id/cancel',  requireRole(...ALL_USERS), c.cancelRequest);
router.patch('/requests/:id/approve', requireHrManager('leave'), c.approveRequest);
router.patch('/requests/:id/reject',  requireHrManager('leave'), c.rejectRequest);

// Work from home — requests are leave requests of a WFH type (approve / reject /
// modify / cancel above); these add the request form, usage and recurring WFH.
router.get('/wfh/me',          requireRole(...ALL_USERS), w.wfhSummary);
router.post('/wfh/requests',   requireRole(...ALL_USERS), w.requestWfh);
router.get('/wfh/schedules',             requireHrManager('leave'), w.listSchedules);
router.post('/wfh/schedules',            requireHrManager('leave'), w.createSchedule);
router.patch('/wfh/schedules/:id',       requireHrManager('leave'), w.updateSchedule);
router.delete('/wfh/schedules/:id',      requireHrManager('leave'), w.deleteSchedule);
router.post('/wfh/schedules/:id/exceptions',                requireHrManager('leave'), w.addException);
router.delete('/wfh/schedules/:id/exceptions/:exceptionId', requireHrManager('leave'), w.removeException);

export { router as leaveRouter };
