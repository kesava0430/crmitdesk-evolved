import { Router } from 'express';
import { authenticate, requireRole, ALL_USERS } from '../../../middleware/authenticate';
import { requireHrManager } from '../../../utils/hrAccess';
import * as c from './orgStructure.controller';

const router = Router();
router.use(authenticate);

// Departments
router.get('/departments',            requireRole(...ALL_USERS), c.listDepartments);
router.get('/departments/tree',       requireRole(...ALL_USERS), c.departmentTree);
router.post('/departments',           requireHrManager('org'),  c.createDepartment);
router.patch('/departments/:id',      requireHrManager('org'),  c.updateDepartment);
router.delete('/departments/:id',     requireHrManager('org'),  c.deleteDepartment);

// Teams
router.get('/teams',                          requireRole(...ALL_USERS), c.listTeams);
router.post('/teams',                         requireHrManager('org'),  c.createTeam);
router.patch('/teams/:id',                    requireHrManager('org'),  c.updateTeam);
router.delete('/teams/:id',                   requireHrManager('org'),  c.deleteTeam);
router.post('/teams/:id/members',             requireHrManager('org'),  c.addTeamMember);
router.delete('/teams/:id/members/:employeeId', requireHrManager('org'), c.removeTeamMember);

// Locations
router.get('/locations',          requireRole(...ALL_USERS), c.listLocations);
router.post('/locations',         requireHrManager('org'),  c.createLocation);
router.patch('/locations/:id',    requireHrManager('org'),  c.updateLocation);
router.delete('/locations/:id',   requireHrManager('org'),  c.deleteLocation);

export { router as orgStructureRouter };
