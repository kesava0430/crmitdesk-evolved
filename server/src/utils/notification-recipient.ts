import { prisma } from './prisma';

/**
 * Shared "who gets this WhatsApp message" resolution, used by both the
 * Schedule poller and the workflow engine's SEND_WHATSAPP action so the
 * four recipient options behave identically everywhere they're offered.
 */
export type RecipientType = 'CONTACT' | 'ASSIGNEE' | 'CUSTOM_NUMBER' | 'ORG_DEFAULT';

export async function resolveRecipientPhone(opts: {
  orgId: string;
  entityType: 'TICKET' | 'DEAL';
  entityId: string;
  recipientType: RecipientType;
  customNumber?: string | null;
}): Promise<string> {
  const { orgId, entityType, entityId, recipientType, customNumber } = opts;

  switch (recipientType) {
    case 'CUSTOM_NUMBER': {
      if (!customNumber) throw new Error('No custom phone number was provided.');
      return customNumber;
    }

    case 'ORG_DEFAULT': {
      const waConfig = await prisma.whatsAppConfig.findUnique({ where: { orgId } });
      const number = waConfig?.notifyNumber || waConfig?.phoneNumber;
      if (!number) throw new Error('No WhatsApp account connected for this organization. Go to Inbox → Settings.');
      return number;
    }

    case 'CONTACT': {
      // Tickets link to a requester (internal User) and optionally a
      // PortalUser, but never a CRM Contact — only Deals do. Kept as a
      // runtime check (rather than only a client-side restriction) so a
      // stale/tampered request can't silently no-op.
      if (entityType !== 'DEAL') {
        throw new Error('Only deals have a linked contact to notify — tickets don\'t. Choose a different recipient.');
      }
      const deal = await prisma.deal.findFirst({
        where: { id: entityId, orgId },
        select: { contact: { select: { phone: true } } },
      });
      if (!deal?.contact?.phone) {
        throw new Error('This deal has no linked contact with a phone number on file.');
      }
      return deal.contact.phone;
    }

    case 'ASSIGNEE': {
      let assignedTo: string | null = null;
      if (entityType === 'TICKET') {
        const ticket = await prisma.ticket.findFirst({ where: { id: entityId, orgId }, select: { assignedTo: true } });
        assignedTo = ticket?.assignedTo ?? null;
      } else {
        const deal = await prisma.deal.findFirst({ where: { id: entityId, orgId }, select: { assignedTo: true } });
        assignedTo = deal?.assignedTo ?? null;
      }
      if (!assignedTo) throw new Error('This record has no assigned user to notify.');

      const user = await prisma.user.findUnique({ where: { id: assignedTo }, select: { phone: true } });
      if (!user?.phone) throw new Error('The assigned user has no phone number on file.');
      return user.phone;
    }

    default:
      throw new Error(`Unknown recipient type: ${recipientType}`);
  }
}
