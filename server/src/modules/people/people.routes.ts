import { Router } from 'express';
import { Response, NextFunction } from 'express';
import { authenticate, requireRole, ALL_USERS, MANAGERS, AuthRequest } from '../../middleware/authenticate';
import { AppError } from '../../middleware/errorHandler';
import * as c from './people.controller';

/* Widening POST/PATCH to ALL_USERS below must not open them to API keys,
   which ride on their creator's user id (and so on that admin's cached
   permission context) and could never add people before. */
const noApiKeys = (req: AuthRequest, _res: Response, next: NextFunction) => {
  if (req.user?.role === 'API') return next(new AppError(403, 'API keys cannot add or edit people'));
  next();
};

const router = Router();
router.use(authenticate);

// Reading the directory is open to every role — scopedWhere() narrows it to
// what the caller may actually see, so an EMPLOYEE gets themselves and a
// manager gets their reports, without either being blocked at the route.
router.get('/',        requireRole(...ALL_USERS), c.list);
router.get('/stats',   requireRole(...ALL_USERS), c.stats);

// Self-service: an employee's own contact details. Literal paths registered
// before /:id so 'me' is never read as an id.
router.get('/me',      requireRole(...ALL_USERS), c.getSelf);
router.patch('/me',    requireRole(...ALL_USERS), noApiKeys, c.updateSelf);

// Adding and editing people: the route admits every role and the permission
// engine inside the handler decides (hr.employee.create / hr.employee.update,
// scoped, plus core.user.* for anything touching a login). That is what lets
// an HR Manager — a custom role on the EMPLOYEE enum — add and edit staff,
// while an IT agent or employee still gets a 403.
router.post('/',                  requireRole(...ALL_USERS), noApiKeys, c.create);
router.get('/:id',                requireRole(...ALL_USERS), c.getOne);
router.patch('/:id',              requireRole(...ALL_USERS), noApiKeys, c.update);
router.post('/:id/grant-login',   requireRole(...MANAGERS), c.grantLogin);
router.post('/:id/revoke-login',  requireRole(...MANAGERS), c.revokeLogin);
router.post('/:id/role',          requireRole(...MANAGERS), c.assignRole);
router.post('/repair-unlinked',   requireRole(...MANAGERS), c.repairUnlinked);

export { router as peopleRouter };
