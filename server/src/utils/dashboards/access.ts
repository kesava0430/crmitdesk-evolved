/**
 * Who may see and change a dashboard — pure, so the rules are unit-tested.
 *
 *  - PRIVATE: the owner only. Not even an admin lists someone's private
 *    dashboards (they hold no data, but what a person tracks is theirs).
 *  - ORG: everyone in the organisation can view it.
 *  - ROLES: people whose Role row (roleIds) or legacy role (legacyRoles)
 *    is listed can view it. Super Admins see every shared dashboard.
 *  - Editing, sharing and deleting: the owner; for a shared dashboard also
 *    anyone who can view it AND holds `core.dashboard.manage` (seeded into
 *    the manager roles; Super Admin always).
 *  - Anyone who can view a dashboard may duplicate it into their own copy.
 *
 * Viewing a dashboard never grants data: every widget re-runs as the viewer.
 */
export const VISIBILITIES = ['PRIVATE', 'ORG', 'ROLES'] as const;
export type Visibility = typeof VISIBILITIES[number];

export interface DashboardShareInfo {
  orgId: string;
  ownerId: string;
  visibility: string;
  roleIds: string[];
  legacyRoles: string[];
}

export interface DashboardViewer {
  id: string;
  orgId: string;
  /** UserRole on the JWT. */
  role: string;
  /** User.roleId (Role row), if any. */
  roleId: string | null;
  /** Holds core.dashboard.manage at any scope (or is Super Admin). */
  canManage: boolean;
}

export interface DashboardAccess {
  view: boolean;
  edit: boolean;
  share: boolean;
  delete: boolean;
  duplicate: boolean;
  isOwner: boolean;
}

const NONE: DashboardAccess = { view: false, edit: false, share: false, delete: false, duplicate: false, isOwner: false };

export function isAdmin(v: Pick<DashboardViewer, 'role'>): boolean {
  return v.role === 'SUPER_ADMIN';
}

export function sharedWith(v: DashboardViewer, d: DashboardShareInfo): boolean {
  if (d.visibility === 'ORG') return true;
  if (d.visibility === 'ROLES') {
    if (isAdmin(v)) return true;
    return (!!v.roleId && d.roleIds.includes(v.roleId)) || d.legacyRoles.includes(v.role);
  }
  return false;
}

export function dashboardAccess(v: DashboardViewer, d: DashboardShareInfo): DashboardAccess {
  if (!v.orgId || v.orgId !== d.orgId) return NONE;
  if (d.ownerId === v.id) return { view: true, edit: true, share: true, delete: true, duplicate: true, isOwner: true };
  if (!sharedWith(v, d)) return NONE;
  const manage = v.canManage || isAdmin(v);
  return { view: true, edit: manage, share: manage, delete: manage, duplicate: true, isOwner: false };
}

/** Prisma where for "dashboards this viewer can see" (mirrors dashboardAccess().view). */
export function visibleWhere(v: DashboardViewer): Record<string, unknown> {
  const or: Array<Record<string, unknown>> = [{ ownerId: v.id }, { visibility: 'ORG' }];
  if (isAdmin(v)) or.push({ visibility: 'ROLES' });
  else {
    or.push({ visibility: 'ROLES', legacyRoles: { has: v.role } });
    if (v.roleId) or.push({ visibility: 'ROLES', roleIds: { has: v.roleId } });
  }
  return { orgId: v.orgId, OR: or };
}
