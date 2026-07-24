import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { AppError } from './errorHandler';

export interface AuthRequest extends Request {
  user?: { id: string; role: string; email: string; orgId: string };
}

// ─── Role Constants ────────────────────────────────────────────────────────────

export const R = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  IT_MANAGER:  'IT_MANAGER',
  CRM_MANAGER: 'CRM_MANAGER',
  IT_AGENT:    'IT_AGENT',
  SALES_REP:   'SALES_REP',
  EMPLOYEE:    'EMPLOYEE',
} as const;

/** Org owner only */
export const ADMIN        = [R.SUPER_ADMIN] as const;
/** All three manager-level roles */
export const MANAGERS     = [R.SUPER_ADMIN, R.IT_MANAGER, R.CRM_MANAGER] as const;
/** IT-side managers */
export const IT_MANAGERS  = [R.SUPER_ADMIN, R.IT_MANAGER] as const;
/** CRM-side managers */
export const CRM_MANAGERS = [R.SUPER_ADMIN, R.CRM_MANAGER] as const;
/** IT workers: agents + their managers */
export const IT_STAFF     = [R.SUPER_ADMIN, R.IT_MANAGER, R.IT_AGENT] as const;
/** CRM workers: reps + their managers */
export const CRM_STAFF    = [R.SUPER_ADMIN, R.CRM_MANAGER, R.SALES_REP] as const;
/** Every role except EMPLOYEE */
export const ALL_STAFF    = [R.SUPER_ADMIN, R.IT_MANAGER, R.CRM_MANAGER, R.IT_AGENT, R.SALES_REP] as const;
/** Every authenticated role */
export const ALL_USERS    = [R.SUPER_ADMIN, R.IT_MANAGER, R.CRM_MANAGER, R.IT_AGENT, R.SALES_REP, R.EMPLOYEE] as const;

// ─── Middleware ────────────────────────────────────────────────────────────────

export function authenticate(req: AuthRequest, _res: Response, next: NextFunction) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) throw new AppError(401, 'Authentication required');
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as {
      id: string; role: string; email: string; orgId: string;
    };
    req.user = payload;
    next();
  } catch {
    throw new AppError(401, 'Invalid or expired token');
  }
}

export function requireRole(...roles: string[]) {
  return (req: AuthRequest, _res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      throw new AppError(403, 'Insufficient permissions');
    }
    next();
  };
}
