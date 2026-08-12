import { Router } from 'express';
import { authenticate, requireRole, ALL_USERS, MANAGERS } from '../../../middleware/authenticate';
import * as c from './payroll.controller';

const router = Router();
router.use(authenticate);

// Salary structures — managers only (sensitive compensation data).
router.get('/structures',        requireRole(...MANAGERS), c.listStructures);
router.post('/structures',       requireRole(...MANAGERS), c.upsertStructure);
router.delete('/structures/:id', requireRole(...MANAGERS), c.deactivateStructure);

// Payroll runs — managers only.
router.get('/runs',                  requireRole(...MANAGERS), c.listRuns);
router.post('/runs',                 requireRole(...MANAGERS), c.runPayroll);
router.get('/runs/:id',              requireRole(...MANAGERS), c.getRun);
router.patch('/runs/:id/mark-paid',  requireRole(...MANAGERS), c.markRunPaid);

// Payslips — an employee can see their own; managers can see everyone's.
router.get('/payslips',                requireRole(...ALL_USERS), c.listPayslips);
router.get('/payslips/:id',            requireRole(...ALL_USERS), c.getPayslip);
router.patch('/payslips/:id/mark-paid', requireRole(...MANAGERS), c.markPayslipPaid);

// Payslip letterhead template — everyone can read (needed to render their
// own payslip print view), only managers can design/edit it.
router.get('/template', requireRole(...ALL_USERS), c.getTemplate);
router.put('/template',  requireRole(...MANAGERS), c.saveTemplate);

export { router as payrollRouter };
