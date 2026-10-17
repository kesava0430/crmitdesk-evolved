import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../../utils/prisma';
import { AuthRequest } from '../../middleware/authenticate';
import { AppError } from '../../middleware/errorHandler';
import { logAction } from '../../utils/auditLog';
import { assertSeatForTransition, withSeatLock, getEffectiveLicense } from '../../utils/licensing';
import { permissionModule, fieldResourceModule, isRoleAreaOff, roleDescriptionFor } from '../../utils/modules';
import {
  getPermCtx,
  assertCan,
  invalidatePermCtx,
  invalidateAllPermCtx,
  seedPermissionCatalog,
  PERMISSION_CATALOG,
  SCOPE_SHAPES,
} from '../../utils/permissions';

/**
 * Admin surface for roles, permissions and field visibility (§61, §66, §119).
 *
 * Two guard rails run through this file:
 *
 *  1. **No privilege escalation.** A caller can never create or edit a role
 *     more senior than their own (Role.rank), nor grant a permission they do
 *     not themselves hold. Without that, "manage roles" silently equals
 *     "become a super admin".
 *  2. **System roles stay assignable.** The six built-in roles can be edited
 *     but not deleted or re-keyed, because JWTs and the e2e suite carry those
 *     key strings.
 */

const roleInclude = {
  permissions: { select: { permissionKey: true, scope: true } },
  fieldPermissions: { select: { id: true, resource: true, field: true, access: true } },
  _count: { select: { users: true } },
};

/** Roles visible to this org: its own, plus the global system templates. */
function roleWhere(orgId: string) {
  return { OR: [{ orgId }, { orgId: null }] };
}

/** Modules switched off for the org (Platform Admin → Areas). */
async function blockedFor(orgId: string): Promise<string[]> {
  return (await getEffectiveLicense(orgId)).blockedModules as string[];
}

export async function listRoles(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const ctx = await getPermCtx(req.user!);
    assertCan(ctx, 'core.role.read');
    const [all, blocked] = await Promise.all([
      prisma.role.findMany({
        where: roleWhere(req.user!.orgId),
        include: roleInclude,
        orderBy: [{ rank: 'asc' }, { name: 'asc' }],
      }),
      blockedFor(req.user!.orgId),
    ]);
    // Only what the org has (Platform Admin → Areas): permissions and field
    // rules of switched-off modules aren't shown (they're kept, and come back
    // with the area), and a role FOR a switched-off area is flagged `areaOff`
    // — listed only while someone still holds it, never offered for assigning.
    // People still on the legacy enum (no Role row linked) hold a role too —
    // count them on the matching built-in role, so an area-off role someone
    // still has is listed (as "area off — N users") rather than vanishing.
    const legacyCounts = new Map<string, number>();
    for (const g of await prisma.user.groupBy({ by: ['role'], where: { orgId: req.user!.orgId, roleId: null, isActive: true }, _count: { _all: true } })) {
      legacyCounts.set(g.role, g._count._all);
    }
    const cloned = new Set(all.filter(r => r.orgId).map(r => r.key));
    const holders = (r: (typeof all)[number]) => (r._count?.users ?? 0)
      + (r.isSystem && r.legacyRole && (r.orgId || !cloned.has(r.key)) ? legacyCounts.get(r.legacyRole) ?? 0 : 0);
    const rows = all
      .map(r => ({
        ...r,
        _count: { ...r._count, users: holders(r) },
        description: roleDescriptionFor(r, blocked),
        permissions: r.permissions.filter(p => !blocked.includes(permissionModule(p.permissionKey) ?? '')),
        fieldPermissions: r.fieldPermissions.filter(f => !blocked.includes(fieldResourceModule(f.resource) ?? '')),
        areaOff: isRoleAreaOff(r, blocked),
      }))
      .filter(r => !r.areaOff || (r._count?.users ?? 0) > 0);
    res.json({ data: rows, total: rows.length });
  } catch (err) {
    next(err);
  }
}

/** The permission catalog, grouped for the role editor UI. */
export async function listPermissions(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const ctx = await getPermCtx(req.user!);
    assertCan(ctx, 'core.role.read');

    const grouped: Record<string, Array<{ key: string; resource: string; action: string; label: string; isSensitive: boolean; scopable: boolean }>> = {};
    const blocked = await blockedFor(req.user!.orgId);
    for (const p of PERMISSION_CATALOG) {
      // Only modules the org has (Platform Admin → Areas).
      if (blocked.includes(permissionModule(p.key) ?? '')) continue;
      (grouped[p.module] ??= []).push({
        key: p.key,
        resource: p.resource,
        action: p.action,
        label: p.label,
        isSensitive: !!p.isSensitive,
        // Only resources with a known ownership shape can express anything
        // narrower than ALL; the UI greys out the scope picker for the rest
        // rather than offering a setting that would silently do nothing.
        scopable: !!SCOPE_SHAPES[p.resource],
      });
    }

    res.json({ data: grouped, scopes: ['NONE', 'OWN', 'TEAM', 'DEPARTMENT', 'ALL'] });
  } catch (err) {
    next(err);
  }
}

const RoleSchema = z.object({
  key: z.string().min(2).max(50).regex(/^[A-Z0-9_]+$/, 'Use uppercase letters, digits and underscores'),
  name: z.string().min(1).max(100),
  description: z.string().optional().nullable(),
  /**
   * Which built-in role this one's *route* access mirrors.
   *
   * Permissions decide what data a role can touch, but requireRole() on each
   * route still reads the legacy enum — so a custom role needs to say which
   * of the six it behaves like at the routing layer. Without it a
   * "Regional Sales Head" would be granted crm.deal.read and then be turned
   * away at the CRM route by the enum check, which looks like the permission
   * system is broken.
   */
  legacyRole: z.enum(['SUPER_ADMIN', 'CRM_MANAGER', 'SALES_REP', 'IT_MANAGER', 'IT_AGENT', 'EMPLOYEE']).optional(),
  rank: z.number().int().min(0).max(999).optional(),
  isActive: z.boolean().optional(),
  permissions: z
    .array(z.object({ permissionKey: z.string(), scope: z.enum(['NONE', 'OWN', 'TEAM', 'DEPARTMENT', 'ALL']) }))
    .optional(),
});

/** Throws unless the caller outranks (or equals) the target rank and holds every granted permission. */
async function assertNoEscalation(
  req: AuthRequest,
  targetRank: number,
  permissions?: Array<{ permissionKey: string; scope: string }>
): Promise<void> {
  const ctx = await getPermCtx(req.user!);

  const callerRole = ctx.roleId
    ? await prisma.role.findUnique({ where: { id: ctx.roleId }, select: { rank: true } })
    : null;
  // A caller still on the legacy enum is treated as rank 0 only if they are a
  // SUPER_ADMIN; everyone else gets the default 100 so they cannot mint a
  // role above themselves.
  const callerRank = callerRole?.rank ?? (ctx.role === 'SUPER_ADMIN' ? 0 : 100);

  if (targetRank < callerRank) {
    throw new AppError(403, 'You cannot create or edit a role more senior than your own');
  }

  for (const p of permissions ?? []) {
    if (p.scope === 'NONE') continue;
    const own = ctx.grants.get(p.permissionKey);
    if (!own || own === 'NONE') {
      throw new AppError(403, `You cannot grant "${p.permissionKey}" because you do not hold it yourself`);
    }
  }
}

/** Refuses permissions and route-access roles of areas switched off for the org. */
async function assertAreasOn(orgId: string, permissions?: Array<{ permissionKey: string; scope: string }>, legacyRole?: string) {
  const blocked = await blockedFor(orgId);
  const bad = (permissions ?? []).find(p => p.scope !== 'NONE' && blocked.includes(permissionModule(p.permissionKey) ?? ''));
  if (bad) throw new AppError(400, `"${bad.permissionKey}" belongs to an area that isn\u2019t enabled for your organisation.`);
  if (legacyRole && isRoleAreaOff({ legacyRole }, blocked)) throw new AppError(400, 'That access level belongs to an area that isn\u2019t enabled for your organisation.');
}

export async function createRole(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const ctx = await getPermCtx(req.user!);
    assertCan(ctx, 'core.role.create');

    const orgId = req.user!.orgId;
    const data = RoleSchema.parse(req.body);
    await assertNoEscalation(req, data.rank ?? 100, data.permissions);
    await assertAreasOn(orgId, data.permissions, data.legacyRole);

    const clash = await prisma.role.findFirst({ where: { orgId, key: data.key } });
    if (clash) throw new AppError(409, 'A role with that key already exists');

    const role = await prisma.role.create({
      data: {
        orgId,
        key: data.key,
        name: data.name,
        description: data.description ?? null,
        // Defaults to the most restrictive option — too little route access is
        // visible and fixable; too much is a security hole.
        legacyRole: data.legacyRole ?? 'EMPLOYEE',
        rank: data.rank ?? 100,
        isSystem: false,
        permissions: data.permissions?.length
          ? {
              create: data.permissions
                .filter(p => p.scope !== 'NONE')
                .map(p => ({ permissionKey: p.permissionKey, scope: p.scope })),
            }
          : undefined,
      },
      include: roleInclude,
    });

    logAction(req.user!.id, 'CREATE', 'ROLE', role.id, { key: role.key, name: role.name });
    res.status(201).json(role);
  } catch (err) {
    next(err);
  }
}

export async function updateRole(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const ctx = await getPermCtx(req.user!);
    assertCan(ctx, 'core.role.update');

    const orgId = req.user!.orgId;
    const existing = await prisma.role.findFirst({ where: { id: req.params.id, ...roleWhere(orgId) } });
    if (!existing) throw new AppError(404, 'Role not found');

    const data = RoleSchema.partial().parse(req.body);
    await assertNoEscalation(req, data.rank ?? existing.rank, data.permissions);
    const blocked = await blockedFor(orgId);
    if (isRoleAreaOff(existing, blocked)) throw new AppError(400, 'This role belongs to an area that isn\u2019t enabled for your organisation, so it can\u2019t be edited.');
    await assertAreasOn(orgId, data.permissions, data.legacyRole);

    if (data.key && data.key !== existing.key && existing.isSystem) {
      throw new AppError(400, 'A built-in role cannot be re-keyed');
    }

    // A global system template edited by an org is cloned into that org first,
    // so one tenant's changes can never leak into another's.
    let targetId = existing.id;
    if (existing.orgId === null) {
      const clone = await prisma.role.create({
        data: {
          orgId,
          key: existing.key,
          name: existing.name,
          description: existing.description,
          isSystem: existing.isSystem,
          legacyRole: existing.legacyRole,
          rank: existing.rank,
        },
      });
      const src = await prisma.rolePermission.findMany({ where: { roleId: existing.id } });
      if (src.length) {
        await prisma.rolePermission.createMany({
          data: src.map(p => ({ roleId: clone.id, permissionKey: p.permissionKey, scope: p.scope })),
          skipDuplicates: true,
        });
      }
      targetId = clone.id;
    }

    if (data.permissions) {
      // Grants of switched-off modules aren't shown in the editor, so they're
      // not in this list either — keep them, so they come back with the area.
      const kept = (await prisma.rolePermission.findMany({ where: { roleId: targetId } }))
        .filter(p => blocked.includes(permissionModule(p.permissionKey) ?? ''));
      await prisma.rolePermission.deleteMany({ where: { roleId: targetId } });
      const rows = [
        ...data.permissions.filter(p => p.scope !== 'NONE'),
        ...kept.map(p => ({ permissionKey: p.permissionKey, scope: p.scope as any })),
      ];
      if (rows.length) {
        await prisma.rolePermission.createMany({
          data: rows.map(p => ({ roleId: targetId, permissionKey: p.permissionKey, scope: p.scope })),
          skipDuplicates: true,
        });
      }
    }

    const role = await prisma.role.update({
      where: { id: targetId },
      data: {
        ...(data.name ? { name: data.name } : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
        ...(data.rank !== undefined ? { rank: data.rank } : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
        // Built-in roles keep their mapping — changing SUPER_ADMIN's base
        // access level would be a foot-gun with no legitimate use.
        ...(data.legacyRole !== undefined && !existing.isSystem ? { legacyRole: data.legacyRole } : {}),
      },
      include: roleInclude,
    });

    invalidateAllPermCtx();
    logAction(req.user!.id, 'UPDATE', 'ROLE', role.id, { fields: Object.keys(data) });
    res.json(role);
  } catch (err) {
    next(err);
  }
}

export async function deleteRole(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const ctx = await getPermCtx(req.user!);
    assertCan(ctx, 'core.role.delete');

    const existing = await prisma.role.findFirst({
      where: { id: req.params.id, orgId: req.user!.orgId },
      include: { _count: { select: { users: true } } },
    });
    if (!existing) throw new AppError(404, 'Role not found');
    if (existing.isSystem) throw new AppError(400, 'Built-in roles cannot be deleted');
    if (existing._count.users > 0) {
      throw new AppError(400, `${existing._count.users} user(s) still have this role. Reassign them first.`);
    }

    await prisma.role.delete({ where: { id: existing.id } });
    invalidateAllPermCtx();
    res.json({ message: 'Role deleted' });
  } catch (err) {
    next(err);
  }
}

// ─── Field permissions ────────────────────────────────────────────────────────

const FieldPermSchema = z.object({
  resource: z.string().min(1),
  field: z.string().min(1),
  access: z.enum(['HIDDEN', 'MASKED', 'READ', 'WRITE']),
});

export async function setFieldPermission(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const ctx = await getPermCtx(req.user!);
    assertCan(ctx, 'core.role.update');

    const role = await prisma.role.findFirst({ where: { id: req.params.id, ...roleWhere(req.user!.orgId) } });
    if (!role) throw new AppError(404, 'Role not found');
    if (role.orgId === null) {
      throw new AppError(400, 'Edit this role first — global templates cannot hold org-specific field rules');
    }

    const data = FieldPermSchema.parse(req.body);
    if ((await blockedFor(req.user!.orgId)).includes(fieldResourceModule(data.resource) ?? '')) {
      throw new AppError(400, `"${data.resource}" belongs to an area that isn\u2019t enabled for your organisation.`);
    }
    const row = await prisma.fieldPermission.upsert({
      where: { roleId_resource_field: { roleId: role.id, resource: data.resource, field: data.field } },
      update: { access: data.access },
      create: { roleId: role.id, orgId: req.user!.orgId, ...data },
    });

    invalidateAllPermCtx();
    logAction(req.user!.id, 'UPDATE', 'FIELD_PERMISSION', row.id, data);
    res.json(row);
  } catch (err) {
    next(err);
  }
}

export async function deleteFieldPermission(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const ctx = await getPermCtx(req.user!);
    assertCan(ctx, 'core.role.update');
    const row = await prisma.fieldPermission.findFirst({
      where: { id: req.params.fieldPermissionId, role: { ...roleWhere(req.user!.orgId) } },
    });
    if (!row) throw new AppError(404, 'Field permission not found');
    await prisma.fieldPermission.delete({ where: { id: row.id } });
    invalidateAllPermCtx();
    res.json({ message: 'Field permission removed' });
  } catch (err) {
    next(err);
  }
}

// ─── Assignment ───────────────────────────────────────────────────────────────

const AssignSchema = z.object({ userId: z.string().min(1), roleId: z.string().nullable() });

/**
 * Assigns a Role to a user.
 *
 * Also keeps the legacy `User.role` enum in step when the target role maps to
 * one, because JWT minting, requireRole() and the entire e2e suite still read
 * that column. Dropping it would be a much larger, riskier change than this
 * one needs to be.
 */
export async function assignRole(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const ctx = await getPermCtx(req.user!);
    assertCan(ctx, 'core.user.update');

    const orgId = req.user!.orgId;
    const { userId, roleId } = AssignSchema.parse(req.body);

    const user = await prisma.user.findFirst({ where: { id: userId, orgId } });
    if (!user) throw new AppError(404, 'User not found');

    let legacy: string | undefined;
    if (roleId) {
      const role = await prisma.role.findFirst({ where: { id: roleId, ...roleWhere(orgId) } });
      if (!role) throw new AppError(404, 'Role not found');
      await assertNoEscalation(req, role.rank);
      // A role for a switched-off area can't be newly given to anyone.
      if (role.id !== user.roleId && isRoleAreaOff(role, await blockedFor(orgId))) {
        throw new AppError(400, `${role.name} belongs to an area that isn\u2019t enabled for your organisation.`);
      }
      const LEGACY_ENUM = ['SUPER_ADMIN', 'IT_MANAGER', 'CRM_MANAGER', 'IT_AGENT', 'SALES_REP', 'EMPLOYEE'];
      if (role.legacyRole && LEGACY_ENUM.includes(role.legacyRole)) legacy = role.legacyRole;
    }

    // Rewriting User.role from the role's legacyRole can turn an EMPLOYEE into
    // a billable seat — same seat check as every other path (LIC-2).
    const updated = await withSeatLock(orgId, async tx => {
      if (legacy) {
        await assertSeatForTransition(orgId, { wasActive: user.isActive, wasRole: user.role, willBeActive: user.isActive, willBeRole: legacy }, tx);
      }
      return tx.user.update({
        where: { id: userId },
        data: { roleId, ...(legacy ? { role: legacy as any } : {}) },
        select: { id: true, name: true, email: true, role: true, roleId: true },
      });
    });

    invalidatePermCtx(userId);
    logAction(req.user!.id, 'UPDATE', 'USER', userId, { roleId, legacyRole: legacy });
    res.json(updated);
  } catch (err) {
    next(err);
  }
}

/** The caller's own effective permissions — the client uses this to hide UI it can't use. */
export async function myPermissions(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const ctx = await getPermCtx(req.user!);
    res.json({
      role: ctx.role,
      roleKey: ctx.roleKey,
      roleId: ctx.roleId,
      employeeId: ctx.employeeId,
      departmentId: ctx.departmentId,
      directReports: ctx.reportEmployeeIds.length,
      permissions: Object.fromEntries(ctx.grants),
      fieldRules: Object.fromEntries(ctx.fieldRules),
    });
  } catch (err) {
    next(err);
  }
}

/** Re-seeds the catalog and built-in roles. Idempotent; never narrows an existing grant. */
export async function reseed(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const ctx = await getPermCtx(req.user!);
    assertCan(ctx, 'core.role.create');
    await seedPermissionCatalog(req.user!.orgId);
    const roles = await prisma.role.count({ where: roleWhere(req.user!.orgId) });
    res.json({ message: 'Permission catalog and built-in roles are up to date', roles });
  } catch (err) {
    next(err);
  }
}
