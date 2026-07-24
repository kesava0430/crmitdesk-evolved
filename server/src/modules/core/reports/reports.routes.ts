import { Router } from 'express';
import { authenticate, requireRole,
         IT_MANAGERS, CRM_MANAGERS } from '../../../middleware/authenticate';
import { ticketReports, crmReports } from './reports.controller';

export const reportsRouter = Router();
reportsRouter.use(authenticate);

reportsRouter.get('/tickets', requireRole(...IT_MANAGERS),  ticketReports);
reportsRouter.get('/crm',     requireRole(...CRM_MANAGERS), crmReports);
