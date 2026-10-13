// ─── Who manages HR (attendance, leave, payroll) ─────────────────────────────
//
// One place for the role set that may see everyone's attendance, correct days,
// approve leave and run payroll. It used to be the generic MANAGERS constant
// plus three hand-copied MANAGER_ROLES arrays in the controllers; changing who
// counts as an HR manager now means editing this list only. The values are
// exactly what those copies held, so nobody gains or loses access today.
import { R } from '../middleware/authenticate';

export const HR_MANAGERS = [R.SUPER_ADMIN, R.IT_MANAGER, R.CRM_MANAGER] as const;

export function isHrManager(role: string | undefined | null): boolean {
  return !!role && (HR_MANAGERS as readonly string[]).includes(role);
}
