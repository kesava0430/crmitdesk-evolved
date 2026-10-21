import { Router } from 'express';
import { authenticate, requireRole, ALL_USERS } from '../../../middleware/authenticate';
// HR-manager role set lives in one place (utils/hrAccess.ts)
import { requireHrManager } from '../../../utils/hrAccess';
import * as c from './payroll.controller';
import * as cfg from './payrollConfig.controller';
import * as tpl from './payslipTemplates.controller';
import * as rev from './payrollRevision.controller';
import * as loans from './loans.controller';

const router = Router();
router.use(authenticate);

// Salary structures — managers only (sensitive compensation data).
router.get('/structures',        requireHrManager('payroll'), c.listStructures);
router.post('/structures',       requireHrManager('payroll'), c.upsertStructure);
router.delete('/structures/:id', requireHrManager('payroll'), c.deactivateStructure);

// Salary components, cycles, employee salaries, preview — managers only.
router.get('/components',            requireHrManager('payroll'), cfg.listComponents);
router.post('/components',           requireHrManager('payroll'), cfg.createComponent);
router.patch('/components/reorder',  requireHrManager('payroll'), cfg.reorderComponents);
router.patch('/components/:id',      requireHrManager('payroll'), cfg.updateComponent);
router.delete('/components/:id',     requireHrManager('payroll'), cfg.deleteComponent);
router.get('/cycles',                requireHrManager('payroll'), cfg.listCycles);
router.post('/cycles',               requireHrManager('payroll'), cfg.saveCycle);
router.put('/cycles/:id',            requireHrManager('payroll'), cfg.saveCycle);
router.get('/employee-salaries',     requireHrManager('payroll'), cfg.listEmployeeSalaries);
router.get('/employee-salaries/:userId', requireHrManager('payroll'), cfg.getEmployeeSalary);
router.post('/employee-salaries',    requireHrManager('payroll'), cfg.upsertEmployeeSalary);
router.delete('/employee-salaries/:id', requireHrManager('payroll'), cfg.deactivateEmployeeSalary);
router.post('/preview',              requireHrManager('payroll'), cfg.previewPayslip);

// Payroll runs — managers only. Draft → review/adjust → finalise → paid.
router.get('/runs',                  requireHrManager('payroll'), c.listRuns);
router.post('/runs',                 requireHrManager('payroll'), c.runPayroll);
router.get('/runs/:id',              requireHrManager('payroll'), c.getRun);
router.post('/runs/:id/recalculate', requireHrManager('payroll'), rev.recalculateRun); // legacy shape for older app builds
router.post('/runs/:id/rerun',       requireHrManager('payroll'), rev.rerunRun);
router.post('/runs/:id/reopen',      requireHrManager('payroll'), rev.reopenRun);
router.get('/runs/:id/history',      requireHrManager('payroll'), rev.runHistory);
router.get('/runs/:id/settlement',   requireHrManager('payroll'), rev.runSettlement);
router.get('/runs/:id/payslips/:payslipId/compare', requireHrManager('payroll'), rev.comparePayslip);
router.patch('/runs/:id/payslips/:payslipId', requireHrManager('payroll'), c.adjustDraftPayslip);
router.post('/runs/:id/finalize',    requireHrManager('payroll'), rev.finalizeRun);
router.delete('/runs/:id',           requireHrManager('payroll'), c.discardRun);
router.patch('/runs/:id/mark-paid',  requireHrManager('payroll'), c.markRunPaid);

// Loans & salary advances — managers manage; an employee reads their own.
router.get('/loans/mine',               requireRole(...ALL_USERS), loans.myLoans);
router.get('/loans',                    requireHrManager('payroll'), loans.listLoans);
router.post('/loans',                   requireHrManager('payroll'), loans.createLoan);
router.get('/loans/:id',                requireRole(...ALL_USERS), loans.getLoan); // owner check inside
router.patch('/loans/:id',              requireHrManager('payroll'), loans.updateLoan);
router.post('/loans/:id/skip',          requireHrManager('payroll'), loans.skipMonth);
router.delete('/loans/:id/skip/:entryId', requireHrManager('payroll'), loans.unskipMonth);
router.post('/loans/:id/repayment',     requireHrManager('payroll'), loans.recordRepayment);
router.post('/loans/:id/close',         requireHrManager('payroll'), loans.closeLoan);
router.post('/loans/:id/cancel',        requireHrManager('payroll'), loans.cancelLoan);

// Payslips — an employee can see their own; managers can see everyone's.
router.get('/payslips',                requireRole(...ALL_USERS), c.listPayslips);
router.get('/payslips/:id',            requireRole(...ALL_USERS), c.getPayslip);
router.patch('/payslips/:id/mark-paid', requireHrManager('payroll'), c.markPayslipPaid);

// Payslip letterhead template — everyone can read (needed to render their
// own payslip print view), only managers can design/edit it.
router.get('/template', requireRole(...ALL_USERS), c.getTemplate);
router.put('/template',  requireHrManager('payroll'), c.saveTemplate);

// Payslip templates (phase 4): many per org, layouts, field visibility, assignment.
router.get('/templates',                 requireHrManager('payroll'), tpl.listTemplates);
router.post('/templates',                requireHrManager('payroll'), tpl.createTemplate);
router.post('/templates/preview',        requireHrManager('payroll'), tpl.previewDraftTemplate);
router.get('/templates/:id/preview',     requireHrManager('payroll'), tpl.previewTemplate);
router.post('/templates/:id/duplicate',  requireHrManager('payroll'), tpl.duplicateTemplate);
router.put('/templates/:id',             requireHrManager('payroll'), tpl.updateTemplate);
router.delete('/templates/:id',          requireHrManager('payroll'), tpl.deleteTemplate);

// Rendered payslips: HTML for the in-app print view, server-side PDF, bulk PDF per run, e-mail with PDF attached.
router.get('/payslips/:id/html',   requireRole(...ALL_USERS), tpl.payslipHtml);
router.get('/payslips/:id/pdf',    requireRole(...ALL_USERS), tpl.payslipPdf);
router.post('/payslips/:id/email', requireHrManager('payroll'), tpl.emailPayslip);
router.get('/runs/:id/pdf',        requireHrManager('payroll'), tpl.runPdf);
router.post('/runs/:id/email',     requireHrManager('payroll'), tpl.emailRun);

export { router as payrollRouter };
