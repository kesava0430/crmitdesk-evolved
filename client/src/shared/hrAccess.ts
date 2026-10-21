/**
 * Who manages HR — client mirror of server/src/utils/hrAccess.ts.
 *
 * The server is the source of truth: GET /permissions/me returns `hr`, the
 * areas this user manages org-wide (legacy manager roles, the built-in HR
 * Manager role, or a custom role holding the matching HR permission at ALL
 * scope). Until that answer arrives, the legacy manager roles are assumed, so
 * existing managers never see HR screens flicker away on load.
 */
import { useAuth } from '../contexts/AuthContext';
import { useMyPermissions } from '../api/work';
import { inGroup, MANAGERS } from './permissions';

export type HrArea = 'people' | 'org' | 'leave' | 'attendance' | 'payroll';
export const HR_AREAS: HrArea[] = ['people', 'org', 'leave', 'attendance', 'payroll'];
export type HrAccess = Record<HrArea, boolean> & { any: boolean; loading: boolean };

/** Pure: combine the legacy role with the server's answer. */
export function hrAccessFrom(role: string | undefined | null, server?: Partial<Record<HrArea, boolean>> | null): Record<HrArea, boolean> {
  const legacy = inGroup(role, MANAGERS);
  const out = {} as Record<HrArea, boolean>;
  for (const a of HR_AREAS) out[a] = legacy || !!server?.[a];
  return out;
}

export function useHrAccess(): HrAccess {
  const { user } = useAuth();
  const isOrgUser = !!user && user.role !== 'PLATFORM_ADMIN';
  const { data, isLoading } = useMyPermissions(isOrgUser);
  const areas = hrAccessFrom(user?.role, data?.hr);
  return { ...areas, any: Object.values(areas).some(Boolean), loading: isOrgUser && !data && isLoading };
}
