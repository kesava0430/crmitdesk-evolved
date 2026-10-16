import { Router } from 'express';
import { authenticate, requireRole,
         IT_MANAGERS, CRM_MANAGERS } from '../../../middleware/authenticate';
import { requireFeature, requireModuleAtMount as requireModule } from '../../../utils/licensing';
import { ticketReports, crmReports } from './reports.controller';

export const reportsRouter = Router();
reportsRouter.use(authenticate);

const advancedAnalytics = requireFeature('advanced_analytics');
// Each report is also off while its area is switched off (Platform Admin → Areas).
reportsRouter.get('/tickets', requireRole(...IT_MANAGERS),  advancedAnalytics, requireModule('itdesk'), ticketReports);
reportsRouter.get('/crm',     requireRole(...CRM_MANAGERS), advancedAnalytics, requireModule('crm'), crmReports);
