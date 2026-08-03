import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../../utils/prisma';
import { AuthRequest } from '../../middleware/authenticate';
import { AppError } from '../../middleware/errorHandler';

const ENTITY_TYPES = ['TICKET', 'CONTACT', 'DEAL', 'LEAD'] as const;
// NOTE: 'TEXTAREA' added — the admin UI (CustomFieldsPage.tsx) has offered a
// "Long Text" (TEXTAREA) option since it was built, but this enum never
// included it, so creating a TEXTAREA field always failed Zod validation.
// 'REFERENCE' — a field whose value is another record's id rather than a
// plain string; currently always points at a Contact (see
// CustomFieldsFormFields.tsx's contact picker and CustomFieldsDisplay.tsx's
// name lookup). Stored the same way as every other field type — a plain
// string in CustomFieldValue.value — so no schema change was needed, only
// how the client renders/resolves it.
const FIELD_TYPES  = ['TEXT', 'NUMBER', 'DATE', 'SELECT', 'BOOLEAN', 'TEXTAREA', 'REFERENCE'] as const;

// Maps entityType -> the Prisma model used to verify an entityId actually
// belongs to the caller's org before reading/writing custom field values.
// Mirrors the assertEntityInOrg pattern used in comments.controller.ts.
const ENTITY_MODEL: Record<string, { findFirst: (args: any) => Promise<any> }> = {
  TICKET:  prisma.ticket,
  CONTACT: prisma.contact,
  DEAL:    prisma.deal,
  LEAD:    prisma.lead,
};

async function findEntityInOrg(entityId: string, orgId: string) {
  for (const model of Object.values(ENTITY_MODEL)) {
    const record = await model.findFirst({ where: { id: entityId, orgId }, select: { id: true } });
    if (record) return true;
  }
  return false;
}

const FieldSchema = z.object({
  entityType: z.enum(ENTITY_TYPES),
  label:      z.string().min(1).max(100),
  fieldKey:   z.string().min(1).max(50).regex(/^[a-z0-9_]+$/, 'Only lowercase letters, numbers, underscores'),
  fieldType:  z.enum(FIELD_TYPES),
  options:    z.array(z.string()).optional(),
  required:   z.boolean().default(false),
  position:   z.number().int().default(0),
});

// ─── Field definitions (admin) ────────────────────────────────────────────────

export async function listFields(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { entityType } = req.query as { entityType?: string };
    const where: any = { orgId: req.user!.orgId };
    if (entityType) where.entityType = entityType;
    const fields = await prisma.customField.findMany({
      where, orderBy: [{ entityType: 'asc' }, { position: 'asc' }],
    });
    res.json({ data: fields });
  } catch (err) { next(err); }
}

export async function createField(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const data = FieldSchema.parse(req.body);
    const field = await prisma.customField.create({
      data: { ...data, orgId, options: data.options ? data.options : undefined },
    });
    res.status(201).json(field);
  } catch (err) { next(err); }
}

export async function updateField(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const data = FieldSchema.partial().omit({ entityType: true, fieldKey: true }).parse(req.body);
    const field = await prisma.customField.findFirst({
      where: { id: req.params.id, orgId: req.user!.orgId },
    });
    if (!field) throw new AppError(404, 'Custom field not found');
    const updated = await prisma.customField.update({
      where: { id: req.params.id },
      data: { ...data, options: data.options ?? undefined },
    });
    res.json(updated);
  } catch (err) { next(err); }
}

export async function deleteField(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    await prisma.customField.deleteMany({ where: { id: req.params.id, orgId: req.user!.orgId } });
    res.json({ message: 'Field deleted' });
  } catch (err) { next(err); }
}

// ─── Field values (per entity) ────────────────────────────────────────────────

export async function getValues(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { entityId } = req.params;
    const orgId = req.user!.orgId;
    // entityId is polymorphic (ticket/contact/deal/lead) — verify it belongs
    // to *some* record in the caller's org before returning anything, so a
    // user can't probe another org's entities by guessing/enumerating ids.
    const inOrg = await findEntityInOrg(entityId, orgId);
    if (!inOrg) throw new AppError(404, 'Not found');

    const values = await prisma.customFieldValue.findMany({
      where: { entityId, field: { orgId } },
      include: { field: true },
    });
    res.json({ data: values });
  } catch (err) { next(err); }
}

export async function setValues(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { entityId } = req.params;
    const orgId = req.user!.orgId;
    const { values } = z.object({
      values: z.array(z.object({ customFieldId: z.string(), value: z.string().nullable() })),
    }).parse(req.body);

    const inOrg = await findEntityInOrg(entityId, orgId);
    if (!inOrg) throw new AppError(404, 'Not found');

    // Verify every referenced field definition belongs to the caller's org
    // before writing — otherwise a user could attach values to another
    // org's field definitions (or to arbitrary customFieldIds).
    const fieldIds = values.map(v => v.customFieldId);
    const ownedFields = await prisma.customField.findMany({
      where: { id: { in: fieldIds }, orgId },
      select: { id: true },
    });
    const ownedIds = new Set(ownedFields.map(f => f.id));
    const filtered = values.filter(v => ownedIds.has(v.customFieldId));

    await Promise.all(filtered.map(v =>
      prisma.customFieldValue.upsert({
        where: { customFieldId_entityId: { customFieldId: v.customFieldId, entityId } },
        create: { customFieldId: v.customFieldId, entityId, value: v.value },
        update: { value: v.value },
      })
    ));

    res.json({ message: 'Values saved' });
  } catch (err) { next(err); }
}
