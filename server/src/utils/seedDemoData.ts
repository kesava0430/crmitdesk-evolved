/**
 * Seeds (or re-seeds) the public demo/showcase organization ("TechCorp
 * Solutions", slug "techcorp"). Re-runnable: deletes the existing org
 * (cascade) plus any orphaned seed users, then recreates everything.
 *
 * This is the single source of truth for demo data — used by:
 *   - prisma/seed.ts (the `npm run db:seed` / `prisma db seed` CLI command)
 *   - POST /api/demo/reset (the nightly automated reset, see modules/demo)
 *
 * Uses the app's shared Prisma client (utils/prisma.ts) rather than creating
 * its own, since this now also runs in-process inside the live server.
 */

import { UserRole, LeadStatus, DealStatus, TicketPriority, TicketStatus, ArticleStatus, ActivityType } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { prisma } from './prisma';

async function hash(plain: string) {
  return bcrypt.hash(plain, 10);
}

function daysFromNow(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d;
}
function daysAgo(n: number): Date {
  return daysFromNow(-n);
}

export const DEMO_ORG_SLUG = 'techcorp';
export const DEMO_SEED_EMAILS = [
  'admin@crmitdesk.com',
  'crm@crmitdesk.com',
  'sales@crmitdesk.com',
  'itmanager@crmitdesk.com',
  'itagent@crmitdesk.com',
];
// The account the "Try Demo" button (POST /api/auth/demo-login) logs in as —
// Super Admin so nothing in the product looks locked during a walkthrough.
export const DEMO_LOGIN_EMAIL = process.env.DEMO_LOGIN_EMAIL || 'admin@crmitdesk.com';

export async function seedDemoOrg() {
  console.log('Starting seed...');

  // Reset: delete existing org (cascade removes all related data) + orphaned seed users
  const existing = await prisma.organization.findUnique({ where: { slug: DEMO_ORG_SLUG } });
  if (existing) {
    console.log('Existing org found - deleting and re-seeding...');
    await prisma.organization.delete({ where: { id: existing.id } });
    await prisma.user.deleteMany({ where: { email: { in: DEMO_SEED_EMAILS } } });
    console.log('Cleared.');
  }

  // 1. ORGANISATION
  // Enterprise, not Pro: this org is the showcase/demo login (see the
  // printed credentials at the end of this script) — it should have every
  // currently-gated feature unlocked (custom branding, full 50GB hosted
  // storage quota, effectively-unlimited seats) so nothing looks paywalled
  // when demoing to a prospective customer, locally or in production.
  const org = await prisma.organization.create({
    data: { name: 'TechCorp Solutions', slug: DEMO_ORG_SLUG, plan: 'ENTERPRISE' },
  });
  console.log('Org created:', org.name);

  // 2. USERS
  const [admin, crmMgr, salesRep, itMgr, itAgent] = await Promise.all([
    prisma.user.create({ data: { orgId: org.id, name: 'Alex Admin', email: 'admin@crmitdesk.com', passwordHash: await hash('Admin@123'), role: UserRole.SUPER_ADMIN, department: 'Operations' } }),
    prisma.user.create({ data: { orgId: org.id, name: 'Carla Chen', email: 'crm@crmitdesk.com', passwordHash: await hash('Admin@123'), role: UserRole.CRM_MANAGER, department: 'Sales' } }),
    prisma.user.create({ data: { orgId: org.id, name: 'Sam Sales', email: 'sales@crmitdesk.com', passwordHash: await hash('Admin@123'), role: UserRole.SALES_REP, department: 'Sales' } }),
    prisma.user.create({ data: { orgId: org.id, name: 'Ivy IT', email: 'itmanager@crmitdesk.com', passwordHash: await hash('Admin@123'), role: UserRole.IT_MANAGER, department: 'IT' } }),
    prisma.user.create({ data: { orgId: org.id, name: 'Dave Desk', email: 'itagent@crmitdesk.com', passwordHash: await hash('Admin@123'), role: UserRole.IT_AGENT, department: 'IT' } }),
  ]);
  console.log('Users created (5)');

  // 3. ORG BRANDING
  await prisma.orgBranding.create({ data: { orgId: org.id, primaryColor: '#4F46E5', supportEmail: 'support@techcorp.io', portalTitle: 'TechCorp Support', portalWelcome: 'Welcome! Submit and track your IT requests here.' } });

  // 4. SUBSCRIPTION
  await prisma.subscription.create({ data: { orgId: org.id, plan: 'ENTERPRISE', status: 'active', seats: 999, currentPeriodEnd: daysFromNow(30) } });

  // 5. TAGS
  const [tagVip, tagHot, tagEnterprise] = await Promise.all([
    prisma.tag.create({ data: { orgId: org.id, name: 'VIP', color: '#F59E0B', module: 'CRM' } }),
    prisma.tag.create({ data: { orgId: org.id, name: 'Hot Lead', color: '#EF4444', module: 'CRM' } }),
    prisma.tag.create({ data: { orgId: org.id, name: 'Enterprise', color: '#6366F1', module: 'CRM' } }),
    prisma.tag.create({ data: { orgId: org.id, name: 'Urgent', color: '#DC2626', module: 'ITDESK' } }),
    prisma.tag.create({ data: { orgId: org.id, name: 'Billing', color: '#10B981', module: 'CRM' } }),
  ]);
  console.log('Tags created');

  // 6. ACCOUNTS
  const [acmeAccount, globexAccount, initechAccount] = await Promise.all([
    prisma.account.create({ data: { orgId: org.id, name: 'Acme Corporation', industry: 'Manufacturing', website: 'https://acme.example.com', phone: '+1-555-0100', address: '123 Main St, Springfield, IL', ownerId: crmMgr.id } }),
    prisma.account.create({ data: { orgId: org.id, name: 'Globex Industries', industry: 'Technology', website: 'https://globex.example.com', phone: '+1-555-0200', address: '456 Silicon Ave, San Francisco, CA', ownerId: salesRep.id } }),
    prisma.account.create({ data: { orgId: org.id, name: 'Initech Ltd', industry: 'Finance', website: 'https://initech.example.com', phone: '+1-555-0300', address: '789 Wall St, New York, NY', ownerId: crmMgr.id } }),
  ]);
  console.log('Accounts created (3)');

  // 7. CONTACTS
  const contacts = await Promise.all([
    prisma.contact.create({ data: { orgId: org.id, ownerId: crmMgr.id, name: 'Alice Whitman', email: 'alice@acme.example.com', phone: '+1-555-1001', jobTitle: 'CTO', accountId: acmeAccount.id, source: 'Referral' } }),
    prisma.contact.create({ data: { orgId: org.id, ownerId: crmMgr.id, name: 'Bob Lumbly', email: 'bob@acme.example.com', phone: '+1-555-1002', jobTitle: 'Procurement Manager', accountId: acmeAccount.id, source: 'Cold Email' } }),
    prisma.contact.create({ data: { orgId: org.id, ownerId: salesRep.id, name: 'Carol Simmons', email: 'carol@globex.example.com', phone: '+1-555-2001', jobTitle: 'VP Engineering', accountId: globexAccount.id, source: 'Conference' } }),
    prisma.contact.create({ data: { orgId: org.id, ownerId: salesRep.id, name: 'Daniel Park', email: 'daniel@globex.example.com', phone: '+1-555-2002', jobTitle: 'IT Director', accountId: globexAccount.id, source: 'LinkedIn' } }),
    prisma.contact.create({ data: { orgId: org.id, ownerId: crmMgr.id, name: 'Eva Martinez', email: 'eva@initech.example.com', phone: '+1-555-3001', jobTitle: 'CFO', accountId: initechAccount.id, source: 'Referral' } }),
    prisma.contact.create({ data: { orgId: org.id, ownerId: crmMgr.id, name: 'Frank Torres', email: 'frank@initech.example.com', phone: '+1-555-3002', jobTitle: 'Operations Lead', accountId: initechAccount.id, source: 'Website' } }),
    prisma.contact.create({ data: { orgId: org.id, ownerId: salesRep.id, name: 'Grace Kim', email: 'grace@startup.example.com', phone: '+1-555-4001', jobTitle: 'Founder', source: 'Inbound' } }),
    prisma.contact.create({ data: { orgId: org.id, ownerId: salesRep.id, name: 'Henry Brown', email: 'henry@corp.example.com', phone: '+1-555-5001', jobTitle: 'Purchasing Director', source: 'Cold Call' } }),
  ]);

  await Promise.all([
    prisma.contactTag.create({ data: { contactId: contacts[0].id, tagId: tagVip.id } }),
    prisma.contactTag.create({ data: { contactId: contacts[0].id, tagId: tagEnterprise.id } }),
    prisma.contactTag.create({ data: { contactId: contacts[2].id, tagId: tagEnterprise.id } }),
    prisma.contactTag.create({ data: { contactId: contacts[4].id, tagId: tagVip.id } }),
  ]);
  console.log('Contacts created (8)');

  // 8. PIPELINE + DEALS
  const pipeline = await prisma.pipeline.create({
    data: { orgId: org.id, name: 'Standard Sales Pipeline', isDefault: true, stages: ['Prospecting', 'Qualification', 'Proposal', 'Negotiation', 'Closed Won', 'Closed Lost'] },
  });

  const deals = await Promise.all([
    prisma.deal.create({ data: { orgId: org.id, pipelineId: pipeline.id, title: 'Acme ERP Implementation', value: 85000, stage: 'Proposal', probability: 60, contactId: contacts[0].id, accountId: acmeAccount.id, assignedTo: salesRep.id, status: DealStatus.OPEN, closeDate: daysFromNow(45) } }),
    prisma.deal.create({ data: { orgId: org.id, pipelineId: pipeline.id, title: 'Acme Cloud Migration', value: 42000, stage: 'Negotiation', probability: 80, contactId: contacts[1].id, accountId: acmeAccount.id, assignedTo: crmMgr.id, status: DealStatus.OPEN, closeDate: daysFromNow(20) } }),
    prisma.deal.create({ data: { orgId: org.id, pipelineId: pipeline.id, title: 'Globex Platform Licence', value: 120000, stage: 'Closed Won', probability: 100, contactId: contacts[2].id, accountId: globexAccount.id, assignedTo: salesRep.id, status: DealStatus.WON, closeDate: daysAgo(10) } }),
    prisma.deal.create({ data: { orgId: org.id, pipelineId: pipeline.id, title: 'Globex Support Contract', value: 24000, stage: 'Qualification', probability: 40, contactId: contacts[3].id, accountId: globexAccount.id, assignedTo: salesRep.id, status: DealStatus.OPEN, closeDate: daysFromNow(60) } }),
    prisma.deal.create({ data: { orgId: org.id, pipelineId: pipeline.id, title: 'Initech Analytics Suite', value: 67000, stage: 'Prospecting', probability: 20, contactId: contacts[4].id, accountId: initechAccount.id, assignedTo: crmMgr.id, status: DealStatus.OPEN, closeDate: daysFromNow(90) } }),
    prisma.deal.create({ data: { orgId: org.id, pipelineId: pipeline.id, title: 'Initech Data Warehouse', value: 150000, stage: 'Closed Lost', probability: 0, contactId: contacts[5].id, accountId: initechAccount.id, assignedTo: salesRep.id, status: DealStatus.LOST, closeDate: daysAgo(5) } }),
    prisma.deal.create({ data: { orgId: org.id, pipelineId: pipeline.id, title: 'Grace Kim Startup Bundle', value: 9500, stage: 'Proposal', probability: 55, contactId: contacts[6].id, assignedTo: salesRep.id, status: DealStatus.OPEN, closeDate: daysFromNow(30) } }),
    prisma.deal.create({ data: { orgId: org.id, pipelineId: pipeline.id, title: 'Henry Brown Enterprise Seat', value: 18000, stage: 'Negotiation', probability: 75, contactId: contacts[7].id, assignedTo: crmMgr.id, status: DealStatus.OPEN, closeDate: daysFromNow(15) } }),
  ]);

  await Promise.all([
    prisma.dealHistory.create({ data: { dealId: deals[0].id, fromStage: 'Prospecting', toStage: 'Qualification', changedBy: salesRep.id, changedAt: daysAgo(20) } }),
    prisma.dealHistory.create({ data: { dealId: deals[0].id, fromStage: 'Qualification', toStage: 'Proposal', changedBy: salesRep.id, changedAt: daysAgo(10) } }),
    prisma.dealHistory.create({ data: { dealId: deals[2].id, fromStage: 'Negotiation', toStage: 'Closed Won', changedBy: salesRep.id, changedAt: daysAgo(10) } }),
    prisma.dealTag.create({ data: { dealId: deals[0].id, tagId: tagEnterprise.id } }),
    prisma.dealTag.create({ data: { dealId: deals[2].id, tagId: tagVip.id } }),
    prisma.dealTag.create({ data: { dealId: deals[4].id, tagId: tagHot.id } }),
  ]);
  console.log('Pipeline + Deals created (8)');

  // 9. LEADS
  await Promise.all([
    prisma.lead.create({ data: { orgId: org.id, contactId: contacts[0].id, source: 'Website', status: LeadStatus.QUALIFIED, assignedTo: salesRep.id, dealId: deals[0].id, notes: 'Very interested in ERP module. Requested full demo.', aiScore: 87, aiScoreReason: 'Senior decision-maker, enterprise account, explicit product interest' } }),
    prisma.lead.create({ data: { orgId: org.id, contactId: contacts[2].id, source: 'Conference', status: LeadStatus.CONTACTED, assignedTo: crmMgr.id, notes: 'Met at TechSummit 2024. Wants follow-up call next week.', aiScore: 72, aiScoreReason: 'Engaged at event, large company, VP-level contact' } }),
    prisma.lead.create({ data: { orgId: org.id, contactId: contacts[4].id, source: 'Referral', status: LeadStatus.QUALIFIED, assignedTo: crmMgr.id, notes: 'Referred by Acme. Budget confirmed at $60K+.', aiScore: 91, aiScoreReason: 'Referral source, confirmed budget, C-level contact' } }),
    prisma.lead.create({ data: { orgId: org.id, contactId: contacts[6].id, source: 'Inbound', status: LeadStatus.NEW, assignedTo: salesRep.id, notes: 'Submitted contact form asking about startup pricing.', aiScore: 54, aiScoreReason: 'Inbound interest, small company, early stage' } }),
    prisma.lead.create({ data: { orgId: org.id, contactId: contacts[7].id, source: 'Cold Call', status: LeadStatus.CONTACTED, assignedTo: salesRep.id, notes: 'Cold called, mild interest. Requested brochure.', aiScore: 38, aiScoreReason: 'Cold outreach, vague interest' } }),
    prisma.lead.create({ data: { orgId: org.id, contactId: contacts[1].id, source: 'Cold Email', status: LeadStatus.UNQUALIFIED, assignedTo: salesRep.id, notes: 'Replied but budget is below minimum.', aiScore: 15, aiScoreReason: 'Budget constraint, no immediate need' } }),
    prisma.lead.create({ data: { orgId: org.id, contactId: contacts[3].id, source: 'LinkedIn', status: LeadStatus.CONVERTED, assignedTo: crmMgr.id, dealId: deals[3].id, convertedAt: daysAgo(15), notes: 'Converted after 3 meetings. Now a deal.', aiScore: 80, aiScoreReason: 'IT Director, multiple touchpoints, clear need' } }),
  ]);
  console.log('Leads created (7)');

  // 10. ACTIVITIES
  await Promise.all([
    prisma.activity.create({ data: { orgId: org.id, type: ActivityType.CALL, title: 'Discovery call with Alice', body: 'Discussed ERP needs and integration requirements.', contactId: contacts[0].id, dealId: deals[0].id, createdBy: salesRep.id, dueAt: daysAgo(8), done: true } }),
    prisma.activity.create({ data: { orgId: org.id, type: ActivityType.MEETING, title: 'Product demo - Acme ERP', body: 'Full platform demo. Alice requested proposal by Friday.', contactId: contacts[0].id, dealId: deals[0].id, createdBy: salesRep.id, dueAt: daysAgo(3), done: true } }),
    prisma.activity.create({ data: { orgId: org.id, type: ActivityType.EMAIL, title: 'Sent proposal to Acme', body: 'Emailed 12-page proposal PDF. Awaiting response.', contactId: contacts[1].id, dealId: deals[1].id, createdBy: crmMgr.id, dueAt: daysAgo(1), done: true } }),
    prisma.activity.create({ data: { orgId: org.id, type: ActivityType.CALL, title: 'Negotiation call - Globex', body: 'Agreed on 5% discount for 3-year commitment.', contactId: contacts[2].id, dealId: deals[2].id, createdBy: salesRep.id, dueAt: daysAgo(12), done: true } }),
    prisma.activity.create({ data: { orgId: org.id, type: ActivityType.TASK, title: 'Follow up with Eva re: Analytics', body: 'Send ROI calculator and case studies.', contactId: contacts[4].id, dealId: deals[4].id, createdBy: crmMgr.id, dueAt: daysFromNow(2), done: false } }),
    prisma.activity.create({ data: { orgId: org.id, type: ActivityType.MEETING, title: 'Quarterly business review - Initech', body: 'Present YTD value and roadmap for next year.', contactId: contacts[5].id, createdBy: admin.id, dueAt: daysFromNow(7), done: false } }),
  ]);
  console.log('Activities created (6)');

  // 11. SLA POLICIES + CATEGORIES
  const [slaStandard, slaPremium, slaCritical] = await Promise.all([
    prisma.slaPolicy.create({ data: { orgId: org.id, name: 'Standard SLA', responseHours: 8, resolutionHours: 48 } }),
    prisma.slaPolicy.create({ data: { orgId: org.id, name: 'Premium SLA', responseHours: 4, resolutionHours: 24 } }),
    prisma.slaPolicy.create({ data: { orgId: org.id, name: 'Critical Response SLA', responseHours: 1, resolutionHours: 4 } }),
  ]);

  const [catHardware, catSoftware, catNetwork, catAccess, catBilling] = await Promise.all([
    prisma.category.create({ data: { orgId: org.id, name: 'Hardware', slaPolicyId: slaStandard.id } }),
    prisma.category.create({ data: { orgId: org.id, name: 'Software', slaPolicyId: slaStandard.id } }),
    prisma.category.create({ data: { orgId: org.id, name: 'Network & Connectivity', slaPolicyId: slaPremium.id } }),
    prisma.category.create({ data: { orgId: org.id, name: 'Access & Permissions', slaPolicyId: slaPremium.id } }),
    prisma.category.create({ data: { orgId: org.id, name: 'Billing & Accounts', slaPolicyId: slaCritical.id } }),
  ]);

  await Promise.all([
    prisma.category.create({ data: { orgId: org.id, name: 'Laptop & Desktop', parentId: catHardware.id, slaPolicyId: slaStandard.id } }),
    prisma.category.create({ data: { orgId: org.id, name: 'Printers & Peripherals', parentId: catHardware.id, slaPolicyId: slaStandard.id } }),
    prisma.category.create({ data: { orgId: org.id, name: 'Microsoft 365', parentId: catSoftware.id, slaPolicyId: slaStandard.id } }),
    prisma.category.create({ data: { orgId: org.id, name: 'VPN & Remote Access', parentId: catNetwork.id, slaPolicyId: slaPremium.id } }),
  ]);
  console.log('SLA + Categories created');

  // 12. TICKETS
  const tickets = await Promise.all([
    prisma.ticket.create({ data: { orgId: org.id, title: 'Laptop not turning on after Windows update', body: 'My Dell XPS 15 stopped booting after last nights Windows update. Blue screen error code 0x0000007E.', categoryId: catHardware.id, priority: TicketPriority.HIGH, status: TicketStatus.IN_PROGRESS, requesterId: admin.id, assignedTo: itAgent.id, sentiment: 'NEGATIVE', slaDueAt: daysFromNow(1), createdAt: daysAgo(2) } }),
    prisma.ticket.create({ data: { orgId: org.id, title: 'Cannot connect to company VPN', body: 'Getting Authentication failed when connecting to VPN from home. Tried restarting router. Blocking my work completely.', categoryId: catNetwork.id, priority: TicketPriority.CRITICAL, status: TicketStatus.OPEN, requesterId: salesRep.id, assignedTo: itAgent.id, sentiment: 'NEGATIVE', slaDueAt: daysFromNow(0), createdAt: daysAgo(1) } }),
    prisma.ticket.create({ data: { orgId: org.id, title: 'Need access to Salesforce sandbox', body: 'Please grant me read/write access to the Salesforce sandbox for testing the new integration. Manager has approved.', categoryId: catAccess.id, priority: TicketPriority.MEDIUM, status: TicketStatus.PENDING, requesterId: crmMgr.id, assignedTo: itMgr.id, sentiment: 'NEUTRAL', slaDueAt: daysFromNow(3), createdAt: daysAgo(3) } }),
    prisma.ticket.create({ data: { orgId: org.id, title: 'Printer on 3rd floor offline', body: 'The HP LaserJet on the 3rd floor has been showing offline since Monday. Multiple users affected.', categoryId: catHardware.id, priority: TicketPriority.MEDIUM, status: TicketStatus.RESOLVED, requesterId: admin.id, assignedTo: itAgent.id, sentiment: 'NEUTRAL', resolvedAt: daysAgo(1), slaDueAt: daysAgo(2), createdAt: daysAgo(5) } }),
    prisma.ticket.create({ data: { orgId: org.id, title: 'Microsoft Teams crashes on startup', body: 'Teams crashes immediately after launching on MacBook Pro M2. Tried reinstalling. Version 1.6.00.26474.', categoryId: catSoftware.id, priority: TicketPriority.HIGH, status: TicketStatus.IN_PROGRESS, requesterId: itMgr.id, assignedTo: itAgent.id, sentiment: 'NEGATIVE', slaDueAt: daysFromNow(2), createdAt: daysAgo(1) } }),
    prisma.ticket.create({ data: { orgId: org.id, title: 'New employee laptop setup request', body: 'New hire starting Monday (Sarah Johnson). Please prepare a Dell Latitude 5540 with standard software and AD account.', categoryId: catHardware.id, priority: TicketPriority.LOW, status: TicketStatus.OPEN, requesterId: admin.id, assignedTo: itMgr.id, sentiment: 'POSITIVE', slaDueAt: daysFromNow(5), createdAt: daysAgo(1) } }),
    prisma.ticket.create({ data: { orgId: org.id, title: 'Invoice discrepancy in billing portal', body: 'Our November invoice shows $4,500 but we were quoted $3,900. Please review and issue a corrected invoice urgently.', categoryId: catBilling.id, priority: TicketPriority.CRITICAL, status: TicketStatus.OPEN, requesterId: crmMgr.id, assignedTo: admin.id, sentiment: 'NEGATIVE', slaDueAt: daysFromNow(1), createdAt: daysAgo(0) } }),
    prisma.ticket.create({ data: { orgId: org.id, title: 'Slow internet in conference room B', body: 'WiFi speed in Conference Room B is under 2 Mbps. Video calls keep dropping. Other areas are fine.', categoryId: catNetwork.id, priority: TicketPriority.MEDIUM, status: TicketStatus.CLOSED, requesterId: salesRep.id, assignedTo: itAgent.id, sentiment: 'NEGATIVE', resolvedAt: daysAgo(3), closedAt: daysAgo(2), slaDueAt: daysAgo(5), createdAt: daysAgo(7) } }),
    prisma.ticket.create({ data: { orgId: org.id, title: 'Password reset for admin portal', body: 'Locked out of the admin portal after too many failed attempts. Need password reset for j.robinson@techcorp.io', categoryId: catAccess.id, priority: TicketPriority.HIGH, status: TicketStatus.RESOLVED, requesterId: admin.id, assignedTo: itMgr.id, sentiment: 'NEUTRAL', resolvedAt: daysAgo(1), slaDueAt: daysAgo(0), createdAt: daysAgo(2) } }),
    prisma.ticket.create({ data: { orgId: org.id, title: 'Adobe Creative Cloud licence request', body: 'Marketing team needs 3 additional Adobe CC licences for new designers. PO number: PO-2024-0891.', categoryId: catSoftware.id, priority: TicketPriority.LOW, status: TicketStatus.OPEN, requesterId: crmMgr.id, assignedTo: itMgr.id, sentiment: 'POSITIVE', slaDueAt: daysFromNow(7), createdAt: daysAgo(1) } }),
  ]);

  await Promise.all([
    prisma.ticketHistory.create({ data: { ticketId: tickets[0].id, fromStatus: TicketStatus.OPEN, toStatus: TicketStatus.IN_PROGRESS, changedBy: itAgent.id } }),
    prisma.ticketHistory.create({ data: { ticketId: tickets[3].id, fromStatus: TicketStatus.OPEN, toStatus: TicketStatus.IN_PROGRESS, changedBy: itAgent.id, changedAt: daysAgo(3) } }),
    prisma.ticketHistory.create({ data: { ticketId: tickets[3].id, fromStatus: TicketStatus.IN_PROGRESS, toStatus: TicketStatus.RESOLVED, changedBy: itAgent.id, changedAt: daysAgo(1) } }),
    prisma.ticketHistory.create({ data: { ticketId: tickets[7].id, fromStatus: TicketStatus.OPEN, toStatus: TicketStatus.RESOLVED, changedBy: itAgent.id, changedAt: daysAgo(3) } }),
    prisma.ticketHistory.create({ data: { ticketId: tickets[7].id, fromStatus: TicketStatus.RESOLVED, toStatus: TicketStatus.CLOSED, changedBy: admin.id, changedAt: daysAgo(2) } }),
  ]);
  console.log('Tickets created (10)');

  // 13. COMMENTS
  await Promise.all([
    prisma.comment.create({ data: { authorId: itAgent.id, entityType: 'TICKET', entityId: tickets[0].id, body: 'Remotely connected. Update KB5031455 causes boot issues. Rolling it back now.', createdAt: daysAgo(1) } }),
    prisma.comment.create({ data: { authorId: admin.id, entityType: 'TICKET', entityId: tickets[0].id, body: 'Please resolve ASAP - I have a board presentation today.', createdAt: daysAgo(0) } }),
    prisma.comment.create({ data: { authorId: itAgent.id, entityType: 'TICKET', entityId: tickets[1].id, body: 'VPN server logs show certificate mismatch. Pushing updated config now.', createdAt: daysAgo(0) } }),
    prisma.comment.create({ data: { authorId: itMgr.id, entityType: 'TICKET', entityId: tickets[2].id, body: 'Access request submitted to Salesforce admin. Pending security team approval.', createdAt: daysAgo(2) } }),
    prisma.comment.create({ data: { authorId: itAgent.id, entityType: 'TICKET', entityId: tickets[3].id, body: 'Printer IP had changed after network reconfiguration. Updated mappings on all affected machines. Resolved.', createdAt: daysAgo(1) } }),
    prisma.comment.create({ data: { authorId: salesRep.id, entityType: 'DEAL', entityId: deals[0].id, body: 'Alice loved the demo. Presenting to the board next week. Very positive signals.', createdAt: daysAgo(3) } }),
    prisma.comment.create({ data: { authorId: crmMgr.id, entityType: 'DEAL', entityId: deals[1].id, body: 'Bob asked for 10% discount. I countered with 7% plus free onboarding. Following up Monday.', createdAt: daysAgo(1) } }),
    prisma.comment.create({ data: { authorId: salesRep.id, entityType: 'DEAL', entityId: deals[2].id, body: 'Contract signed and countersigned! Sending kick-off invite now.', createdAt: daysAgo(10) } }),
  ]);
  console.log('Comments created');

  // 14. TIME ENTRIES
  await Promise.all([
    prisma.timeEntry.create({ data: { orgId: org.id, ticketId: tickets[0].id, userId: itAgent.id, description: 'Remote diagnosis and Windows update rollback', minutes: 45, loggedAt: daysAgo(1) } }),
    prisma.timeEntry.create({ data: { orgId: org.id, ticketId: tickets[1].id, userId: itAgent.id, description: 'VPN certificate renewal and config push', minutes: 30, loggedAt: daysAgo(0) } }),
    prisma.timeEntry.create({ data: { orgId: org.id, ticketId: tickets[3].id, userId: itAgent.id, description: 'Printer IP reconfiguration and machine mapping update', minutes: 60, loggedAt: daysAgo(1) } }),
    prisma.timeEntry.create({ data: { orgId: org.id, ticketId: tickets[4].id, userId: itAgent.id, description: 'Teams reinstall, cache clear, profile reset', minutes: 90, loggedAt: daysAgo(0) } }),
    prisma.timeEntry.create({ data: { orgId: org.id, ticketId: tickets[8].id, userId: itMgr.id, description: 'Admin portal password reset and account audit', minutes: 15, loggedAt: daysAgo(1) } }),
  ]);
  console.log('Time entries created');

  // 15. ASSETS
  const assets = await Promise.all([
    prisma.asset.create({ data: { orgId: org.id, name: 'Dell XPS 15 - Alex', type: 'Laptop', serialNumber: 'SN-DXPS15-001', assignedTo: admin.id, status: 'active', purchaseDate: daysAgo(365) } }),
    prisma.asset.create({ data: { orgId: org.id, name: 'Dell Latitude 5540 - Sam', type: 'Laptop', serialNumber: 'SN-DL554-002', assignedTo: salesRep.id, status: 'active', purchaseDate: daysAgo(180) } }),
    prisma.asset.create({ data: { orgId: org.id, name: 'MacBook Pro M2 - Ivy', type: 'Laptop', serialNumber: 'SN-MBPM2-003', assignedTo: itMgr.id, status: 'active', purchaseDate: daysAgo(90) } }),
    prisma.asset.create({ data: { orgId: org.id, name: 'HP LaserJet - 3rd Floor', type: 'Printer', serialNumber: 'SN-HPLJ-101', status: 'maintenance', purchaseDate: daysAgo(730) } }),
    prisma.asset.create({ data: { orgId: org.id, name: 'Cisco IP Phone - Reception', type: 'Phone', serialNumber: 'SN-CIP-201', status: 'active', purchaseDate: daysAgo(400) } }),
    prisma.asset.create({ data: { orgId: org.id, name: 'Dell Monitor 27 - Dave', type: 'Monitor', serialNumber: 'SN-DM27-301', assignedTo: itAgent.id, status: 'active', purchaseDate: daysAgo(200) } }),
    prisma.asset.create({ data: { orgId: org.id, name: 'iPad Air - Conference Room A', type: 'Tablet', serialNumber: 'SN-IPAD-401', status: 'active', purchaseDate: daysAgo(120) } }),
    prisma.asset.create({ data: { orgId: org.id, name: 'Logitech Webcam - Carla', type: 'Peripheral', serialNumber: 'SN-LWC-501', assignedTo: crmMgr.id, status: 'active', purchaseDate: daysAgo(60) } }),
    prisma.asset.create({ data: { orgId: org.id, name: 'Spare Lenovo ThinkPad', type: 'Laptop', serialNumber: 'SN-LTP-601', status: 'in_storage', purchaseDate: daysAgo(500) } }),
    prisma.asset.create({ data: { orgId: org.id, name: 'Network Switch - Floor 3', type: 'Network Equipment', serialNumber: 'SN-NSW-701', status: 'active', purchaseDate: daysAgo(800) } }),
  ]);

  await Promise.all([
    prisma.ticketAsset.create({ data: { ticketId: tickets[0].id, assetId: assets[0].id } }),
    prisma.ticketAsset.create({ data: { ticketId: tickets[3].id, assetId: assets[3].id } }),
    prisma.ticketAsset.create({ data: { ticketId: tickets[4].id, assetId: assets[2].id } }),
    prisma.ticketAsset.create({ data: { ticketId: tickets[7].id, assetId: assets[9].id } }),
  ]);
  console.log('Assets created (10)');

  // 16. CSAT
  await Promise.all([
    prisma.csatResponse.create({ data: { orgId: org.id, ticketId: tickets[3].id, rating: 5, comment: 'Dave fixed it super quickly. Really impressed!' } }),
    prisma.csatResponse.create({ data: { orgId: org.id, ticketId: tickets[7].id, rating: 4, comment: 'Took a day but the issue was fully resolved.' } }),
    prisma.csatResponse.create({ data: { orgId: org.id, ticketId: tickets[8].id, rating: 5, comment: 'Password reset done in 10 minutes. Excellent service.' } }),
  ]);
  console.log('CSAT responses created');

  // 17. KNOWLEDGE ARTICLES
  await Promise.all([
    prisma.knowledgeArticle.create({ data: { orgId: org.id, authorId: itMgr.id, title: 'How to connect to the company VPN', body: 'Steps:\n1. Open Cisco AnyConnect\n2. Enter server: vpn.techcorp.io\n3. Sign in with company credentials\n4. Complete MFA prompt\n\nTroubleshooting: Reset password at portal.techcorp.io if authentication fails.', categoryId: catNetwork.id, status: ArticleStatus.PUBLISHED, publishedAt: daysAgo(30) } }),
    prisma.knowledgeArticle.create({ data: { orgId: org.id, authorId: itMgr.id, title: 'Setting up Microsoft 365 on a new device', body: 'Windows: Go to office.com, sign in, click Install Office, run installer.\nmacOS: Visit office.com, click Install Office > Office 365 apps, open the .pkg file.', categoryId: catSoftware.id, status: ArticleStatus.PUBLISHED, publishedAt: daysAgo(60) } }),
    prisma.knowledgeArticle.create({ data: { orgId: org.id, authorId: itAgent.id, title: 'Common printer issues and fixes', body: 'Printer offline: Go to Settings > Printers, right-click, Use Printer Online.\nPaper jam: Turn off printer, pull jammed paper in direction of travel only.', categoryId: catHardware.id, status: ArticleStatus.PUBLISHED, publishedAt: daysAgo(20) } }),
    prisma.knowledgeArticle.create({ data: { orgId: org.id, authorId: itMgr.id, title: 'Requesting access to a new application', body: 'Log a ticket under Access & Permissions with system name, business justification, and manager approval. Allow 2 business days.', categoryId: catAccess.id, status: ArticleStatus.PUBLISHED, publishedAt: daysAgo(45) } }),
    prisma.knowledgeArticle.create({ data: { orgId: org.id, authorId: itAgent.id, title: 'Windows 11 upgrade guide (DRAFT)', body: 'This article is pending IT review. Do not distribute.', categoryId: catSoftware.id, status: ArticleStatus.DRAFT, publishedAt: null } }),
    prisma.knowledgeArticle.create({ data: { orgId: org.id, authorId: admin.id, title: 'Billing and invoice FAQs', body: 'Get invoices at billing.techcorp.io. Invoices include taxes. To dispute: open a ticket under Billing & Accounts with the invoice number.', categoryId: catBilling.id, status: ArticleStatus.PUBLISHED, publishedAt: daysAgo(10) } }),
  ]);
  console.log('Knowledge articles created (6)');

  // 18. WORKFLOW RULES
  await Promise.all([
    prisma.workflowRule.create({ data: { orgId: org.id, name: 'Auto-assign Critical Tickets to IT Manager', description: 'When a critical ticket is created, assign it to the IT manager.', trigger: 'TICKET_CREATED', conditions: [{ field: 'priority', operator: 'equals', value: 'CRITICAL' }], actions: [{ type: 'ASSIGN', params: { userId: itMgr.id } }], isActive: true, runCount: 3 } }),
    prisma.workflowRule.create({ data: { orgId: org.id, name: 'Notify agent on SLA breach', description: 'Send a notification when SLA is about to breach.', trigger: 'SLA_BREACH', conditions: [], actions: [{ type: 'NOTIFY', params: { message: 'SLA breach warning - please update the ticket immediately' } }], isActive: true, runCount: 7 } }),
    prisma.workflowRule.create({ data: { orgId: org.id, name: 'Tag conference leads as Enterprise', description: 'When a lead comes from Conference, tag as Enterprise.', trigger: 'LEAD_CREATED', conditions: [{ field: 'source', operator: 'equals', value: 'Conference' }], actions: [{ type: 'TAG', params: { tag: 'Enterprise' } }], isActive: true, runCount: 2 } }),
    prisma.workflowRule.create({ data: { orgId: org.id, name: 'Create onboarding ticket on Deal Won', description: 'Auto-create an IT onboarding ticket when a deal is marked Won.', trigger: 'DEAL_STAGE_CHANGED', conditions: [{ field: 'stage', operator: 'equals', value: 'Closed Won' }], actions: [{ type: 'CREATE_TICKET', params: { title: 'Onboarding - new customer', priority: 'MEDIUM' } }], isActive: false, runCount: 1 } }),
  ]);
  console.log('Workflow rules created (4)');

  // 19. PORTAL USERS
  await Promise.all([
    prisma.portalUser.create({ data: { orgId: org.id, name: 'Alice Whitman', email: 'alice.portal@acme.example.com', isActive: true, lastLoginAt: daysAgo(1) } }),
    prisma.portalUser.create({ data: { orgId: org.id, name: 'Carol Simmons', email: 'carol.portal@globex.example.com', isActive: true, lastLoginAt: daysAgo(3) } }),
    prisma.portalUser.create({ data: { orgId: org.id, name: 'Bob Lumbly', email: 'bob.portal@acme.example.com', isActive: true, lastLoginAt: null } }),
    prisma.portalUser.create({ data: { orgId: org.id, name: 'John Doe', email: 'john.doe@startup.example.com', isActive: false, lastLoginAt: null } }),
  ]);
  console.log('Portal users created (4)');

  // 20. CAMPAIGNS
  await Promise.all([
    prisma.campaign.create({ data: { orgId: org.id, name: 'Q4 Product Launch Announcement', subject: 'Introducing CRMITDesk 2.0 - More Power, Less Effort', body: 'Dear {{name}},\n\nWe are thrilled to announce CRMITDesk 2.0 with AI-powered routing, unified inbox, and advanced analytics. Upgrade today for 20% off the first 3 months.\n\nBest,\nThe TechCorp Team', targetType: 'LEADS', status: 'SENT', sentAt: daysAgo(7), sentCount: 245 } }),
    prisma.campaign.create({ data: { orgId: org.id, name: 'Enterprise Feature Spotlight', subject: 'Your enterprise needs custom AI automations', body: 'Hi {{name}},\n\nAs an enterprise customer you now have access to our AI Feature Builder...', targetType: 'CONTACTS', status: 'SENT', sentAt: daysAgo(2), sentCount: 89 } }),
    prisma.campaign.create({ data: { orgId: org.id, name: 'Re-engagement - Inactive Leads', subject: 'We miss you! Here is what is new at TechCorp', body: 'Hello {{name}},\n\nIt has been a while since we last connected...', targetType: 'LEADS', status: 'DRAFT', sentCount: 0 } }),
  ]);
  console.log('Campaigns created (3)');

  // 21. CHANGE REQUESTS
  await Promise.all([
    prisma.changeRequest.create({ data: { orgId: org.id, title: 'Upgrade office network switches to 10Gbps', description: 'Replace all floor-level network switches with 10Gbps models to support growing video collaboration workload. Maintenance window: Saturday 02:00-06:00.', type: 'NORMAL', priority: 'HIGH', status: 'APPROVED', requestedBy: itMgr.id, assignedTo: itAgent.id, plannedStart: daysFromNow(5), plannedEnd: daysFromNow(6), approvedBy: admin.id, approvedAt: daysAgo(2) } }),
    prisma.changeRequest.create({ data: { orgId: org.id, title: 'Deploy Windows 11 to all endpoints', description: 'Phased rollout of Windows 11 across all 87 company endpoints. Phase 1: IT (10 machines). Phase 2: Sales. Phase 3: All remaining.', type: 'STANDARD', priority: 'MEDIUM', status: 'SUBMITTED', requestedBy: itAgent.id, assignedTo: itMgr.id, plannedStart: daysFromNow(14), plannedEnd: daysFromNow(45) } }),
    prisma.changeRequest.create({ data: { orgId: org.id, title: 'Emergency patch - critical OpenSSL vulnerability', description: 'CVE-2024-XXXX affects all systems running OpenSSL below 3.1.4. Immediate patching required across all Linux servers.', type: 'EMERGENCY', priority: 'CRITICAL', status: 'IMPLEMENTING', requestedBy: itMgr.id, assignedTo: itAgent.id, plannedStart: daysAgo(1), plannedEnd: daysFromNow(1), approvedBy: admin.id, approvedAt: daysAgo(1) } }),
    prisma.changeRequest.create({ data: { orgId: org.id, title: 'Migrate file server to SharePoint Online', description: 'Move 2TB of shared drive content to SharePoint Online to eliminate on-prem server costs.', type: 'NORMAL', priority: 'MEDIUM', status: 'DRAFT', requestedBy: crmMgr.id, plannedStart: daysFromNow(30), plannedEnd: daysFromNow(60) } }),
  ]);
  console.log('Change requests created (4)');

  // 22. CUSTOM FIELDS
  await Promise.all([
    prisma.customField.create({ data: { orgId: org.id, entityType: 'TICKET', label: 'Affected Users Count', fieldKey: 'affected_users_count', fieldType: 'NUMBER', position: 1 } }),
    prisma.customField.create({ data: { orgId: org.id, entityType: 'TICKET', label: 'Business Impact', fieldKey: 'business_impact', fieldType: 'SELECT', options: ['Low', 'Medium', 'High', 'Critical'], position: 2 } }),
    prisma.customField.create({ data: { orgId: org.id, entityType: 'CONTACT', label: 'LinkedIn Profile', fieldKey: 'linkedin_profile', fieldType: 'TEXT', position: 1 } }),
    prisma.customField.create({ data: { orgId: org.id, entityType: 'DEAL', label: 'Contract Type', fieldKey: 'contract_type', fieldType: 'SELECT', options: ['Annual', 'Multi-year', 'Monthly', 'One-time'], position: 1 } }),
    prisma.customField.create({ data: { orgId: org.id, entityType: 'LEAD', label: 'Company Size', fieldKey: 'company_size', fieldType: 'SELECT', options: ['1-10', '11-50', '51-200', '201-1000', '1000+'], position: 1 } }),
  ]);
  console.log('Custom fields created (5)');

  // 23. QUOTES
  await Promise.all([
    prisma.quote.create({ data: { orgId: org.id, dealId: deals[0].id, title: 'Q-2024-001 - Acme ERP Implementation', status: 'SENT', notes: 'Valid for 30 days. Prices exclude applicable taxes. Implementation: 12 weeks.', validUntil: daysFromNow(30), createdBy: salesRep.id, lines: { create: [{ description: 'CRMITDesk Enterprise Licence (50 seats)', quantity: 50, unitPrice: 120, discount: 0 }, { description: 'Implementation & Onboarding Services', quantity: 1, unitPrice: 8000, discount: 5 }, { description: 'Data Migration (up to 500K records)', quantity: 1, unitPrice: 3500, discount: 0 }, { description: 'Training Sessions (4 x 2h)', quantity: 4, unitPrice: 500, discount: 0 }] } } }),
    prisma.quote.create({ data: { orgId: org.id, dealId: deals[2].id, title: 'Q-2024-002 - Globex Platform Licence', status: 'ACCEPTED', notes: 'Accepted by Carol Simmons. Kick-off: 1 Dec 2024.', validUntil: daysAgo(5), createdBy: salesRep.id, lines: { create: [{ description: 'CRMITDesk Enterprise Licence (100 seats)', quantity: 100, unitPrice: 110, discount: 10 }, { description: 'Priority Support 24/7 (3-year term)', quantity: 3, unitPrice: 8000, discount: 0 }, { description: 'Custom Integrations (3 systems)', quantity: 3, unitPrice: 4000, discount: 5 }] } } }),
  ]);
  console.log('Quotes created (2)');

  // 24. CONVERSATIONS + MESSAGES
  const [convAlice, convBob] = await Promise.all([
    prisma.conversation.create({ data: { orgId: org.id, channel: 'EMAIL', contactName: 'Alice Whitman', contactEmail: 'alice@acme.example.com', subject: 'Re: Proposal - Acme ERP Implementation', status: 'OPEN', assignedTo: salesRep.id, lastMessageAt: daysAgo(1), unreadCount: 1 } }),
    prisma.conversation.create({ data: { orgId: org.id, channel: 'EMAIL', contactName: 'Bob Lumbly', contactEmail: 'bob@acme.example.com', subject: 'Invoice query - November billing', status: 'OPEN', assignedTo: admin.id, lastMessageAt: daysAgo(0), unreadCount: 2 } }),
    prisma.conversation.create({ data: { orgId: org.id, channel: 'WHATSAPP', contactName: 'Carol Simmons', contactPhone: '+1-555-2001', status: 'RESOLVED', assignedTo: salesRep.id, lastMessageAt: daysAgo(5), unreadCount: 0 } }),
  ]);

  await Promise.all([
    prisma.message.create({ data: { conversationId: convAlice.id, direction: 'INBOUND', fromAddress: 'alice@acme.example.com', toAddress: 'support@techcorp.io', body: 'Hi Sam, I reviewed the proposal with our board. We have a few questions before signing. Can we schedule a call this week?', sentAt: daysAgo(2) } }),
    prisma.message.create({ data: { conversationId: convAlice.id, direction: 'OUTBOUND', fromAddress: 'sales@crmitdesk.com', toAddress: 'alice@acme.example.com', body: 'Hi Alice, I have availability Thursday 2pm or Friday 10am. Which works for you?', sentAt: daysAgo(1) } }),
    prisma.message.create({ data: { conversationId: convAlice.id, direction: 'INBOUND', fromAddress: 'alice@acme.example.com', toAddress: 'support@techcorp.io', body: 'Thursday 2pm works. I will send a calendar invite.', sentAt: daysAgo(1) } }),
    prisma.message.create({ data: { conversationId: convBob.id, direction: 'INBOUND', fromAddress: 'bob@acme.example.com', toAddress: 'support@techcorp.io', body: 'Hello, our November invoice shows $4,500 but we were quoted $3,900. This needs to be corrected immediately.', sentAt: daysAgo(0) } }),
    prisma.message.create({ data: { conversationId: convBob.id, direction: 'OUTBOUND', fromAddress: 'admin@crmitdesk.com', toAddress: 'bob@acme.example.com', body: 'Hi Bob, I apologise for the discrepancy. Looking into this now and will get back to you within the hour.', sentAt: daysAgo(0) } }),
  ]);
  console.log('Conversations + messages created');

  // 25. NOTIFICATIONS
  await Promise.all([
    prisma.notification.create({ data: { orgId: org.id, userId: itAgent.id, type: 'ASSIGNMENT', title: 'Ticket assigned to you', body: 'Laptop not turning on - assigned to Dave Desk', entityType: 'TICKET', entityId: tickets[0].id } }),
    prisma.notification.create({ data: { orgId: org.id, userId: itAgent.id, type: 'ASSIGNMENT', title: 'Critical ticket assigned', body: 'Cannot connect to company VPN - CRITICAL priority', entityType: 'TICKET', entityId: tickets[1].id } }),
    prisma.notification.create({ data: { orgId: org.id, userId: salesRep.id, type: 'COMMENT', title: 'New comment on Acme ERP deal', body: 'Carla Chen commented on Acme Cloud Migration', entityType: 'DEAL', entityId: deals[0].id } }),
    prisma.notification.create({ data: { orgId: org.id, userId: admin.id, type: 'STATUS_CHANGE', title: 'Ticket resolved', body: 'Printer on 3rd floor - marked as Resolved', entityType: 'TICKET', entityId: tickets[3].id, readAt: daysAgo(1) } }),
    prisma.notification.create({ data: { orgId: org.id, userId: itMgr.id, type: 'SLA_WARNING', title: 'SLA breach warning', body: 'VPN ticket is approaching SLA deadline', entityType: 'TICKET', entityId: tickets[1].id } }),
    prisma.notification.create({ data: { orgId: org.id, userId: salesRep.id, type: 'STATUS_CHANGE', title: 'Deal won - Globex!', body: 'Globex Platform Licence moved to Closed Won', entityType: 'DEAL', entityId: deals[2].id, readAt: daysAgo(10) } }),
  ]);
  console.log('Notifications created');

  // 26. AUDIT LOGS
  await Promise.all([
    prisma.auditLog.create({ data: { userId: admin.id, action: 'USER_CREATED', entityType: 'User', entityId: salesRep.id, changes: { name: 'Sam Sales', role: 'SALES_REP' }, createdAt: daysAgo(30) } }),
    prisma.auditLog.create({ data: { userId: salesRep.id, action: 'DEAL_CREATED', entityType: 'Deal', entityId: deals[0].id, changes: { title: 'Acme ERP Implementation', value: 85000 }, createdAt: daysAgo(20) } }),
    prisma.auditLog.create({ data: { userId: itAgent.id, action: 'TICKET_UPDATED', entityType: 'Ticket', entityId: tickets[0].id, changes: { status: { from: 'OPEN', to: 'IN_PROGRESS' } }, createdAt: daysAgo(1) } }),
    prisma.auditLog.create({ data: { userId: salesRep.id, action: 'DEAL_STAGE_CHANGED', entityType: 'Deal', entityId: deals[2].id, changes: { stage: { from: 'Negotiation', to: 'Closed Won' } }, createdAt: daysAgo(10) } }),
    prisma.auditLog.create({ data: { userId: admin.id, action: 'USER_ROLE_CHANGED', entityType: 'User', entityId: itAgent.id, changes: { role: { from: 'EMPLOYEE', to: 'IT_AGENT' } }, createdAt: daysAgo(60) } }),
  ]);
  console.log('Audit logs created');

  // 27. AI CUSTOM RULES
  await Promise.all([
    prisma.aICustomRule.create({ data: { orgId: org.id, name: 'Auto-Tag Billing Tickets', description: 'Tag any ticket mentioning invoices or billing.', trigger: 'TICKET_CREATED', action: 'TAG', customPrompt: 'Analyse the ticket. If it mentions billing, invoice, payment, or charges, return tag "billing".', isActive: true, runCount: 12, lastRunAt: daysAgo(1) } }),
    prisma.aICustomRule.create({ data: { orgId: org.id, name: 'Smart Lead Follow-up', description: 'Generate a personalised follow-up email when a lead is scored above 70.', trigger: 'LEAD_SCORED', action: 'EMAIL', customPrompt: 'Generate a warm professional follow-up email for {{contact_name}} from {{company}}. Score: {{score}}. Under 150 words.', isActive: true, runCount: 5, lastRunAt: daysAgo(3) } }),
    prisma.aICustomRule.create({ data: { orgId: org.id, name: 'SLA Breach Summary', description: 'Summarise the ticket and suggest resolution steps when SLA is about to breach.', trigger: 'TICKET_CREATED', action: 'SUMMARIZE', customPrompt: 'Summarise this IT support ticket in 2 sentences and suggest the 3 most likely resolution steps.', isActive: true, runCount: 8, lastRunAt: daysAgo(0) } }),
    prisma.aICustomRule.create({ data: { orgId: org.id, name: 'Deal Stage Notification', description: 'Notify sales team when a deal moves to Negotiation.', trigger: 'DEAL_STAGE_CHANGED', action: 'NOTIFY', customPrompt: 'Deal "{{deal_title}}" (${{value}}) moved to {{new_stage}}. Write a 1-sentence update for the team.', isActive: false, runCount: 0 } }),
  ]);
  console.log('AI custom rules created (4)');

  // Summary
  console.log('\nSeed complete!');
  console.log('  Users (all password Admin@123):');
  console.log('    admin@crmitdesk.com       -> Super Admin');
  console.log('    crm@crmitdesk.com         -> CRM Manager');
  console.log('    sales@crmitdesk.com       -> Sales Rep');
  console.log('    itmanager@crmitdesk.com   -> IT Manager');
  console.log('    itagent@crmitdesk.com     -> IT Agent');
  console.log('  Plan: ENTERPRISE (every feature gate unlocked, 999 seats, 50GB hosted storage quota)');
  console.log('  Data: 8 contacts, 7 leads, 8 deals, 10 tickets, 10 assets, 6 articles');
  console.log('  Plus: workflows, campaigns, change requests, quotes, AI rules, inbox, CSAT');

  return org;
}
