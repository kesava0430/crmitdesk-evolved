import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../utils/prisma';
import { AuthRequest } from '../../middleware/authenticate';
import { AppError } from '../../middleware/errorHandler';
import { logAction } from '../../utils/auditLog';
import { parsePagination, paginate } from '../../utils/pagination';
import { FIELD_TYPES, slugify, validateRecordData, recordTitle } from './customModules.service';

const ModuleSchema = z.object({
  name: z.string().min(1).max(80),
  icon: z.string().max(40).optional(),
  description: z.string().max(500).optional(),
});

const FieldSchema = z.object({
  label: z.string().min(1).max(80),
  fieldKey: z.string().min(1).max(50).regex(/^[a-z0-9_]+$/, 'Only lowercase letters, numbers, underscores').optional(),
  fieldType: z.enum(FIELD_TYPES),
  options: z.array(z.string()).optional(),
  required: z.boolean().default(false),
  isPrimary: z.boolean().default(false),
  position: z.number().int().default(0),
});

// ─── Modules (admin) ────────────────────────────────────────────────────────

export async function listModules(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const modules = await prisma.customModule.findMany({
      where: { orgId: req.user!.orgId },
      include: { _count: { select: { fields: true, records: true } }, syncConfig: { select: { isActive: true, lastSyncAt: true, lastStatus: true } } },
      orderBy: { createdAt: 'asc' },
    });
    res.json(modules);
  } catch (err) { next(err); }
}

export async function createModule(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const data = ModuleSchema.parse(req.body);
    let slug = slugify(data.name);
    let suffix = 0;
    // slug must be unique per org — append -2, -3, ... on collision rather
    // than erroring, since two orgs (or two admins) independently naming a
    // module "Warranty Claims" shouldn't require them to pick a slug by hand.
    while (await prisma.customModule.findFirst({ where: { orgId, slug: suffix ? `${slug}-${suffix}` : slug } })) {
      suffix += 1;
    }
    if (suffix) slug = `${slug}-${suffix}`;

    const module_ = await prisma.customModule.create({
      data: { orgId, name: data.name, slug, icon: data.icon || 'Layers', description: data.description, createdBy: req.user!.id },
    });
    logAction(req.user!.id, 'CREATE', 'CustomModule', module_.id, { name: module_.name });
    res.status(201).json(module_);
  } catch (err) { next(err); }
}

export async function getModule(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const module_ = await prisma.customModule.findFirst({
      where: { id: req.params.id, orgId: req.user!.orgId },
      include: { fields: { orderBy: { position: 'asc' } }, syncConfig: true, _count: { select: { records: true } } },
    });
    if (!module_) throw new AppError(404, 'Custom module not found');
    res.json(module_);
  } catch (err) { next(err); }
}

export async function updateModule(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const data = ModuleSchema.partial().extend({ isActive: z.boolean().optional() }).parse(req.body);
    const existing = await prisma.customModule.findFirst({ where: { id: req.params.id, orgId: req.user!.orgId } });
    if (!existing) throw new AppError(404, 'Custom module not found');
    const module_ = await prisma.customModule.update({ where: { id: req.params.id }, data });
    res.json(module_);
  } catch (err) { next(err); }
}

export async function deleteModule(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    await prisma.customModule.deleteMany({ where: { id: req.params.id, orgId: req.user!.orgId } });
    logAction(req.user!.id, 'DELETE', 'CustomModule', req.params.id);
    res.json({ message: 'Module deleted' });
  } catch (err) { next(err); }
}

// ─── Fields (schema builder) ──────────────────────────────────────────────────

async function assertModuleInOrg(moduleId: string, orgId: string) {
  const module_ = await prisma.customModule.findFirst({ where: { id: moduleId, orgId } });
  if (!module_) throw new AppError(404, 'Custom module not found');
  return module_;
}

export async function addField(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const module_ = await assertModuleInOrg(req.params.id, orgId);
    const data = FieldSchema.parse(req.body);
    const fieldKey = data.fieldKey || slugify(data.label).replace(/-/g, '_');

    const existing = await prisma.customModuleField.findUnique({ where: { moduleId_fieldKey: { moduleId: module_.id, fieldKey } } });
    if (existing) throw new AppError(400, `A field with key "${fieldKey}" already exists on this module`);

    if (data.isPrimary) {
      await prisma.customModuleField.updateMany({ where: { moduleId: module_.id, isPrimary: true }, data: { isPrimary: false } });
    }

    const field = await prisma.customModuleField.create({
      data: { moduleId: module_.id, label: data.label, fieldKey, fieldType: data.fieldType, options: data.options, required: data.required, isPrimary: data.isPrimary, position: data.position },
    });
    res.status(201).json(field);
  } catch (err) { next(err); }
}

export async function updateField(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const module_ = await assertModuleInOrg(req.params.id, orgId);
    const data = FieldSchema.partial().omit({ fieldKey: true }).parse(req.body);
    const field = await prisma.customModuleField.findFirst({ where: { id: req.params.fieldId, moduleId: module_.id } });
    if (!field) throw new AppError(404, 'Field not found');

    if (data.isPrimary) {
      await prisma.customModuleField.updateMany({ where: { moduleId: module_.id, isPrimary: true, id: { not: field.id } }, data: { isPrimary: false } });
    }

    const updated = await prisma.customModuleField.update({ where: { id: field.id }, data });
    res.json(updated);
  } catch (err) { next(err); }
}

export async function removeField(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const module_ = await assertModuleInOrg(req.params.id, req.user!.orgId);
    await prisma.customModuleField.deleteMany({ where: { id: req.params.fieldId, moduleId: module_.id } });
    res.json({ message: 'Field deleted' });
  } catch (err) { next(err); }
}

// ─── Records ───────────────────────────────────────────────────────────────────

export async function listRecords(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const module_ = await assertModuleInOrg(req.params.id, orgId);
    const fields = await prisma.customModuleField.findMany({ where: { moduleId: module_.id }, orderBy: { position: 'asc' } });
    const pag = parsePagination(req);
    const [records, total] = await Promise.all([
      prisma.customModuleRecord.findMany({ where: { moduleId: module_.id, orgId }, orderBy: { createdAt: 'desc' }, take: pag.limit, skip: pag.skip }),
      prisma.customModuleRecord.count({ where: { moduleId: module_.id, orgId } }),
    ]);
    const withTitle = records.map(r => ({ ...r, title: recordTitle(fields, r.data as Record<string, unknown>, r.id) }));
    res.json(paginate(withTitle, total, pag));
  } catch (err) { next(err); }
}

export async function getRecord(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const module_ = await assertModuleInOrg(req.params.id, req.user!.orgId);
    const record = await prisma.customModuleRecord.findFirst({ where: { id: req.params.recordId, moduleId: module_.id } });
    if (!record) throw new AppError(404, 'Record not found');
    res.json(record);
  } catch (err) { next(err); }
}

export async function createRecord(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const module_ = await assertModuleInOrg(req.params.id, orgId);
    const fields = await prisma.customModuleField.findMany({ where: { moduleId: module_.id } });
    const data = validateRecordData(fields, req.body?.data ?? req.body ?? {});
    const record = await prisma.customModuleRecord.create({
      data: { moduleId: module_.id, orgId, data: data as Prisma.InputJsonValue, source: 'MANUAL', createdBy: req.user!.id },
    });
    logAction(req.user!.id, 'CREATE', module_.name, record.id, { moduleId: module_.id });
    res.status(201).json(record);
  } catch (err) { next(err); }
}

export async function updateRecord(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const module_ = await assertModuleInOrg(req.params.id, orgId);
    const existing = await prisma.customModuleRecord.findFirst({ where: { id: req.params.recordId, moduleId: module_.id } });
    if (!existing) throw new AppError(404, 'Record not found');
    const fields = await prisma.customModuleField.findMany({ where: { moduleId: module_.id } });
    const partialData = validateRecordData(fields, req.body?.data ?? req.body ?? {}, { partial: true });
    const record = await prisma.customModuleRecord.update({
      where: { id: existing.id },
      data: { data: { ...(existing.data as object), ...partialData } as Prisma.InputJsonValue },
    });
    res.json(record);
  } catch (err) { next(err); }
}

export async function removeRecord(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const module_ = await assertModuleInOrg(req.params.id, req.user!.orgId);
    await prisma.customModuleRecord.deleteMany({ where: { id: req.params.recordId, moduleId: module_.id } });
    res.json({ message: 'Record deleted' });
  } catch (err) { next(err); }
}
