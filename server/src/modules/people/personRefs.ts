import { prisma } from '../../utils/prisma';
import { AppError } from '../../middleware/errorHandler';
import { createsReportingLoop } from './personRules';

/**
 * Tenancy checks for the ids a person record points at.
 *
 * The employee endpoints used to write departmentId / locationId / managerId
 * straight through, so a crafted request could attach a person to another
 * organisation's department or manager (the foreign keys are happy — they
 * only know the row exists). Every add/edit path now runs this first.
 */
export async function assertOrgRefs(
  orgId: string,
  refs: {
    departmentId?: string | null;
    locationId?: string | null;
    managerId?: string | null;
    dottedLineManagerId?: string | null;
  },
  /** The person being edited — used for the self-manager and loop checks. */
  employeeId?: string
): Promise<void> {
  const checks: Array<Promise<void>> = [];

  if (refs.departmentId) {
    checks.push(
      prisma.department.count({ where: { id: refs.departmentId, orgId } }).then(n => {
        if (!n) throw new AppError(400, 'That department is not in your organization');
      })
    );
  }
  if (refs.locationId) {
    checks.push(
      prisma.location.count({ where: { id: refs.locationId, orgId } }).then(n => {
        if (!n) throw new AppError(400, 'That location is not in your organization');
      })
    );
  }
  for (const key of ['managerId', 'dottedLineManagerId'] as const) {
    const ref = refs[key];
    if (!ref) continue;
    checks.push(
      prisma.employee.count({ where: { id: ref, orgId } }).then(n => {
        if (!n) throw new AppError(400, 'That manager is not in your organization');
      })
    );
  }
  await Promise.all(checks);

  // A cycle in the reporting line would make resolveReports() and the org
  // chart both wrong, so it is rejected here rather than defended against in
  // every read path.
  if (employeeId && refs.managerId) {
    const loop = await createsReportingLoop(employeeId, refs.managerId, async id => {
      const row = await prisma.employee.findFirst({ where: { id, orgId }, select: { managerId: true } });
      return row?.managerId ?? null;
    });
    if (loop) {
      throw new AppError(
        400,
        refs.managerId === employeeId
          ? 'A person cannot report to themselves'
          : 'That change would create a reporting loop'
      );
    }
  }
}

/** Employee IDs are unique per organization; a clash is a 409 with a useful message. */
export async function assertEmployeeCodeFree(orgId: string, code: string, exceptEmployeeId?: string) {
  const clash = await prisma.employee.findFirst({
    where: { orgId, employeeCode: code, ...(exceptEmployeeId ? { id: { not: exceptEmployeeId } } : {}) },
    select: { displayName: true },
  });
  if (clash) throw new AppError(409, `Employee ID ${code} is already used by ${clash.displayName}`);
}
