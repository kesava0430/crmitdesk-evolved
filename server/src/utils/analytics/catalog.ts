/**
 * The dataset catalog — every table the analytics layer can aggregate, with
 * real column names from schema.prisma (@map / @@map). Adding a dataset is a
 * data change here; the compiler, catalog endpoint, AI prompt and tests pick
 * it up automatically.
 *
 * Conventions
 *  - The main table is always alias `t`; join aliases start with `j`.
 *  - TIMESTAMP columns are typed 'datetime' (stored UTC, bucketed in the org's
 *    zone); DATE columns are 'date'.
 *  - Money is a `numeric` in the org currency (Organization.currency — the
 *    product's single-currency rule, see schema.prisma). Payslips and
 *    approvals carry their own currency column; rows in another currency
 *    raise a warning rather than being silently summed (DatasetDef.currencySql).
 *  - Each dataset names the permission key the existing engine already
 *    knows (utils/permissions.ts PERMISSION_CATALOG) and the SCOPE_SHAPES
 *    resource for record scoping; scopeColumns maps the Prisma field names
 *    scopedWhere() emits to SQL columns.
 */
import { ALL_STAFF } from '../../middleware/authenticate';
import type { DatasetDef, FieldDef } from './types';

// ─── Field helpers ──────────────────────────────────────────────────────────

const dt = (key: string, label: string, col: string, extra: Partial<FieldDef> = {}): FieldDef =>
  ({ key, label, type: 'datetime', sql: `t.${col}`, groupable: true, filterable: true, ...extra });
/** A TIMESTAMP column that holds a calendar date picked in a form (saved as UTC midnight):
 *  read as its UTC date, so a due date never shifts a day in a zone behind UTC. */
const dayOf = (key: string, label: string, col: string, extra: Partial<FieldDef> = {}): FieldDef =>
  ({ key, label, type: 'date', sql: `(t.${col})::date`, groupable: true, filterable: true, permField: snake2camel(col), ...extra });
const dateCol = (key: string, label: string, sql: string, extra: Partial<FieldDef> = {}): FieldDef =>
  ({ key, label, type: 'date', sql, groupable: true, filterable: true, ...extra });
const en = (key: string, label: string, col: string, values: string[], extra: Partial<FieldDef> = {}): FieldDef =>
  ({ key, label, type: 'enum', sql: `t.${col}`, values, groupable: true, filterable: true, ...extra });
const str = (key: string, label: string, sql: string, groupable = true, extra: Partial<FieldDef> = {}): FieldDef =>
  ({ key, label, type: 'string', sql, groupable, filterable: true, ...extra });
const num = (key: string, label: string, sql: string, extra: Partial<FieldDef> = {}): FieldDef =>
  ({ key, label, type: 'number', sql, filterable: true, ...extra });
const money = (key: string, label: string, sql: string, extra: Partial<FieldDef> = {}): FieldDef =>
  ({ key, label, type: 'money', sql, filterable: true, ...extra });
const bool = (key: string, label: string, sql: string, extra: Partial<FieldDef> = {}): FieldDef =>
  ({ key, label, type: 'boolean', sql, groupable: true, filterable: true, ...extra });
const rel = (key: string, label: string, idSql: string, labelSql: string, joins: string[], extra: Partial<FieldDef> = {}): FieldDef =>
  ({ key, label, type: 'relation', sql: idSql, labelSql, joins, groupable: true, filterable: true, ...extra });

/** A relation to a User through column `col`, joined as `alias`. */
const userRel = (key: string, label: string, col: string, joinKey: string, alias: string, unassigned = 'Unassigned', extra: Partial<FieldDef> = {}) =>
  rel(key, label, `t.${col}`, `COALESCE(${alias}.name, '${unassigned}')`, [joinKey], { isUser: true, permField: snake2camel(col), ...extra });

const deptRel = (sqlId = 't.department_id', joinKey = 'dept', alias = 'jd') =>
  rel('department', 'Department', sqlId, `COALESCE(${alias}.name, 'No department')`, [joinKey], { permField: 'departmentId' });

function snake2camel(s: string) { return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase()); }

const NOW_UTC = `(now() AT TIME ZONE 'UTC')`;

// Joins used by the HR datasets keyed by user_id: the person's employee record and department.
const HR_PERSON_JOINS = {
  usr: 'LEFT JOIN users ju ON ju.id = t.user_id',
  emp: 'LEFT JOIN employees je ON je.user_id = t.user_id AND je.org_id = t.org_id',
  edept: 'LEFT JOIN departments jed ON jed.id = je.department_id',
};
const HR_PERSON_REQUIRES = { edept: ['emp'] };
const hrPerson = (): FieldDef[] => [
  rel('employee', 'Employee', 't.user_id', `COALESCE(je.display_name, ju.name, 'Unknown')`, ['usr', 'emp'], { isUser: true, permField: 'userId', listDefault: true }),
  rel('department', 'Department', 'je.department_id', `COALESCE(jed.name, 'No department')`, ['emp', 'edept'], { permField: 'departmentId' }),
];

// ─── CRM ────────────────────────────────────────────────────────────────────

const LEADS: DatasetDef = {
  key: 'leads', label: 'Leads', singular: 'lead', area: 'crm', module: 'crm', table: 'leads',
  description: 'Sales leads: where they came from, status, owner, and when they were created or converted.',
  permission: 'crm.lead.read', scopeResource: 'lead', scopeColumns: { assignedTo: 't.assigned_to' }, fieldResource: 'lead',
  joins: { assignee: 'LEFT JOIN users ja ON ja.id = t.assigned_to', dept: 'LEFT JOIN departments jd ON jd.id = t.department_id', contact: 'LEFT JOIN contacts jc ON jc.id = t.contact_id' },
  defaultDate: 'createdAt',
  fields: [
    dt('createdAt', 'Created', 'created_at'),
    dt('convertedAt', 'Converted', 'converted_at'),
    en('status', 'Status', 'status', ['NEW', 'CONTACTED', 'QUALIFIED', 'UNQUALIFIED', 'CONVERTED'], { listDefault: true }),
    str('source', 'Source', `COALESCE(t.source, 'Unknown')`, true, { listDefault: true }),
    userRel('assignee', 'Assigned to', 'assigned_to', 'assignee', 'ja', 'Unassigned', { listDefault: true }),
    deptRel(),
    rel('contact', 'Contact', 't.contact_id', `COALESCE(jc.name, 'No contact')`, ['contact'], { permField: 'contactId', listDefault: true }),
    num('aiScore', 'AI score', 't.ai_score', { aggregations: ['avg', 'min', 'max'] }),
    bool('isConverted', 'Converted', `(t.status = 'CONVERTED')`, { permField: 'status' }),
  ],
  examples: ['How many leads did we get each week?', 'Leads by source this month'],
};

const DEALS: DatasetDef = {
  key: 'deals', label: 'Deals', singular: 'deal', area: 'crm', module: 'crm', table: 'deals',
  description: 'Sales pipeline deals: value, stage, probability, status (open/won/lost), owner and close date.',
  permission: 'crm.deal.read', scopeResource: 'deal', scopeColumns: { assignedTo: 't.assigned_to' }, fieldResource: 'deal',
  joins: {
    assignee: 'LEFT JOIN users ja ON ja.id = t.assigned_to', dept: 'LEFT JOIN departments jd ON jd.id = t.department_id',
    account: 'LEFT JOIN accounts jac ON jac.id = t.account_id', pipeline: 'LEFT JOIN pipelines jp ON jp.id = t.pipeline_id',
  },
  defaultDate: 'createdAt',
  fields: [
    str('title', 'Title', 't.title', false, { listDefault: true }),
    dt('createdAt', 'Created', 'created_at'),
    dayOf('closeDate', 'Expected close date', 'close_date'),
    dt('updatedAt', 'Last updated', 'updated_at'),
    money('value', 'Deal value', 't.value', { listDefault: true }),
    money('weightedValue', 'Weighted value (value × probability)', '(t.value * t.probability / 100.0)', { permField: 'value' }),
    num('probability', 'Probability', 't.probability', { unit: '%', aggregations: ['avg', 'min', 'max'] }),
    str('stage', 'Stage', 't.stage', true, { listDefault: true }),
    en('status', 'Status', 'status', ['OPEN', 'WON', 'LOST'], { listDefault: true }),
    userRel('assignee', 'Owner', 'assigned_to', 'assignee', 'ja', 'Unassigned', { listDefault: true }),
    deptRel(),
    rel('account', 'Account', 't.account_id', `COALESCE(jac.name, 'No account')`, ['account'], { permField: 'accountId' }),
    rel('pipeline', 'Pipeline', 't.pipeline_id', `COALESCE(jp.name, 'Default')`, ['pipeline'], { permField: 'pipelineId' }),
  ],
  examples: ['Total value of won deals this quarter', 'Open pipeline by stage'],
};

const CONTACTS: DatasetDef = {
  key: 'contacts', label: 'Contacts', singular: 'contact', area: 'crm', module: 'crm', table: 'contacts',
  description: 'People in the CRM: source, owner, company and when they were added.',
  permission: 'crm.contact.read', scopeResource: 'contact', scopeColumns: { ownerId: 't.owner_id' }, fieldResource: 'contact',
  joins: { owner: 'LEFT JOIN users jo ON jo.id = t.owner_id', account: 'LEFT JOIN accounts jac ON jac.id = t.account_id' },
  defaultDate: 'createdAt',
  fields: [
    str('name', 'Name', 't.name', false, { listDefault: true }),
    dt('createdAt', 'Created', 'created_at'),
    str('source', 'Source', `COALESCE(t.source, 'Unknown')`, true, { listDefault: true }),
    str('jobTitle', 'Job title', `COALESCE(t.job_title, 'Unknown')`),
    userRel('owner', 'Owner', 'owner_id', 'owner', 'jo', 'Unknown', { listDefault: true }),
    rel('account', 'Account', 't.account_id', `COALESCE(jac.name, 'No account')`, ['account'], { permField: 'accountId', listDefault: true }),
  ],
};

const ACCOUNTS: DatasetDef = {
  key: 'accounts', label: 'Accounts (companies)', singular: 'account', area: 'crm', module: 'crm', table: 'accounts',
  description: 'Companies in the CRM: industry, owner and when they were added.',
  permission: 'crm.account.read', scopeResource: 'account', scopeColumns: { ownerId: 't.owner_id' }, fieldResource: 'account',
  joins: { owner: 'LEFT JOIN users jo ON jo.id = t.owner_id' },
  defaultDate: 'createdAt',
  fields: [
    str('name', 'Name', 't.name', false, { listDefault: true }),
    dt('createdAt', 'Created', 'created_at'),
    str('industry', 'Industry', `COALESCE(t.industry, 'Unknown')`, true, { listDefault: true }),
    userRel('owner', 'Owner', 'owner_id', 'owner', 'jo', 'Unknown', { listDefault: true }),
  ],
};

const ACTIVITIES: DatasetDef = {
  key: 'activities', label: 'CRM activities', singular: 'activity', area: 'crm', module: 'crm', table: 'activities',
  description: 'Calls, emails, meetings and tasks logged against leads, deals and contacts.',
  permission: 'crm.activity.read', scopeResource: 'activity', scopeColumns: { createdBy: 't.created_by' }, fieldResource: 'activity',
  joins: { creator: 'LEFT JOIN users jcr ON jcr.id = t.created_by' },
  defaultDate: 'createdAt',
  fields: [
    str('title', 'Title', 't.title', false, { listDefault: true }),
    en('type', 'Type', 'type', ['CALL', 'EMAIL', 'MEETING', 'TASK'], { listDefault: true }),
    bool('done', 'Done', 't.done', { listDefault: true }),
    dt('createdAt', 'Created', 'created_at'),
    dt('dueAt', 'Due', 'due_at', { listDefault: true }),
    bool('isOverdue', 'Overdue', `(NOT t.done AND t.due_at IS NOT NULL AND t.due_at < ${NOW_UTC})`, { permField: 'dueAt' }),
    userRel('createdBy', 'Logged by', 'created_by', 'creator', 'jcr', 'Unknown', { listDefault: true }),
  ],
};

const QUOTE_TOTAL = `(SELECT COALESCE(SUM(l.quantity * l.unit_price * (1 - l.discount / 100.0)), 0) FROM quote_lines l WHERE l.quote_id = t.id)`;
const QUOTES: DatasetDef = {
  key: 'quotes', label: 'Quotes', singular: 'quote', area: 'crm', module: 'sales_docs', table: 'quotes',
  description: 'Sales quotes: status, total (sum of lines after discounts), creator and validity.',
  permission: 'crm.quote.read', scopeResource: 'quote', scopeColumns: { createdBy: 't.created_by' }, fieldResource: 'quote',
  joins: { creator: 'LEFT JOIN users jcr ON jcr.id = t.created_by', deal: 'LEFT JOIN deals jdl ON jdl.id = t.deal_id' },
  defaultDate: 'createdAt',
  fields: [
    str('title', 'Title', 't.title', false, { listDefault: true }),
    en('status', 'Status', 'status', ['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED'], { listDefault: true }),
    money('total', 'Total', QUOTE_TOTAL, { listDefault: true }),
    dt('createdAt', 'Created', 'created_at'),
    dayOf('validUntil', 'Valid until', 'valid_until'),
    userRel('createdBy', 'Created by', 'created_by', 'creator', 'jcr', 'Unknown', { listDefault: true }),
    rel('deal', 'Deal', 't.deal_id', `COALESCE(jdl.title, 'No deal')`, ['deal'], { permField: 'dealId' }),
  ],
};

const INVOICE_SUBTOTAL = `(SELECT COALESCE(SUM(l.quantity * l.unit_price * (1 - l.discount / 100.0)), 0) FROM invoice_lines l WHERE l.invoice_id = t.id)`;
// Past due = the whole due date has passed (due dates are calendar dates saved as UTC midnight).
const INVOICE_OVERDUE = `(t.status = 'OVERDUE' OR (t.status = 'SENT' AND t.due_date IS NOT NULL AND t.due_date + interval '1 day' <= ${NOW_UTC}))`;
const INVOICES: DatasetDef = {
  key: 'invoices', label: 'Invoices', singular: 'invoice', area: 'crm', module: 'sales_docs', table: 'invoices',
  description: 'Invoices: number, status, total incl. tax (same formula as the Invoices page), issue/due/paid dates. "Overdue" = status OVERDUE, or SENT and past its due date.',
  permission: 'crm.invoice.read', scopeResource: 'invoice', scopeColumns: { createdBy: 't.created_by' }, fieldResource: 'invoice',
  joins: { creator: 'LEFT JOIN users jcr ON jcr.id = t.created_by', deal: 'LEFT JOIN deals jdl ON jdl.id = t.deal_id' },
  defaultDate: 'issueDate',
  fields: [
    str('invoiceNumber', 'Invoice #', 't.invoice_number', false, { listDefault: true }),
    str('title', 'Title', 't.title', false, { listDefault: true }),
    en('status', 'Status', 'status', ['DRAFT', 'SENT', 'PAID', 'OVERDUE', 'VOID'], { listDefault: true }),
    money('total', 'Total (incl. tax)', `(${INVOICE_SUBTOTAL} * (1 + t.tax_rate / 100.0))`, { listDefault: true }),
    money('subtotal', 'Subtotal (before tax)', INVOICE_SUBTOTAL),
    dt('issueDate', 'Issue date', 'issue_date'),
    dayOf('dueDate', 'Due date', 'due_date', { listDefault: true }),
    dt('paidAt', 'Paid', 'paid_at'),
    dt('createdAt', 'Created', 'created_at'),
    bool('isOverdue', 'Overdue', INVOICE_OVERDUE, { permField: 'status' }),
    num('daysOverdue', 'Days overdue', `(CASE WHEN ${INVOICE_OVERDUE} THEN FLOOR(EXTRACT(EPOCH FROM (${NOW_UTC} - t.due_date)) / 86400) END)`, { unit: 'days', permField: 'dueDate', aggregations: ['avg', 'min', 'max'] }),
    userRel('createdBy', 'Created by', 'created_by', 'creator', 'jcr', 'Unknown'),
    rel('deal', 'Deal', 't.deal_id', `COALESCE(jdl.title, 'No deal')`, ['deal'], { permField: 'dealId' }),
  ],
  examples: ['Overdue invoices over 50,000', 'Invoiced amount per month this year'],
};

const CAMPAIGNS: DatasetDef = {
  key: 'campaigns', label: 'Email campaigns', singular: 'campaign', area: 'crm', module: 'campaigns', table: 'campaigns',
  description: 'Email campaigns to leads or contacts: status, recipients sent, when sent.',
  permission: 'crm.campaign.read', scopeResource: 'campaign', fieldResource: 'campaign',
  defaultDate: 'createdAt',
  fields: [
    str('name', 'Name', 't.name', false, { listDefault: true }),
    str('status', 'Status', 't.status', true, { listDefault: true }),
    en('targetType', 'Audience', 'target_type', ['LEADS', 'CONTACTS']),
    num('sentCount', 'Emails sent', 't.sent_count', { listDefault: true }),
    dt('sentAt', 'Sent', 'sent_at'),
    dt('createdAt', 'Created', 'created_at'),
  ],
};

// ─── IT Desk ────────────────────────────────────────────────────────────────

const TICKET_OPEN = `(t.status IN ('OPEN', 'IN_PROGRESS', 'PENDING'))`;
const TICKETS: DatasetDef = {
  key: 'tickets', label: 'Tickets', singular: 'ticket', area: 'itdesk', module: 'itdesk', table: 'tickets',
  description: 'Help-desk tickets: status, priority, category, assignee, requester, SLA, created/resolved/closed times.',
  permission: 'itdesk.ticket.read', scopeResource: 'ticket', scopeColumns: { assignedTo: 't.assigned_to' }, fieldResource: 'ticket',
  joins: {
    assignee: 'LEFT JOIN users ja ON ja.id = t.assigned_to', requester: 'LEFT JOIN users jr ON jr.id = t.requester_id',
    dept: 'LEFT JOIN departments jd ON jd.id = t.department_id', category: 'LEFT JOIN categories jcat ON jcat.id = t.category_id',
  },
  defaultDate: 'createdAt',
  fields: [
    str('title', 'Title', 't.title', false, { listDefault: true }),
    en('status', 'Status', 'status', ['OPEN', 'IN_PROGRESS', 'PENDING', 'RESOLVED', 'CLOSED'], { listDefault: true }),
    en('priority', 'Priority', 'priority', ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'], { listDefault: true }),
    rel('category', 'Category', 't.category_id', `COALESCE(jcat.name, 'Uncategorised')`, ['category'], { permField: 'categoryId' }),
    userRel('assignee', 'Assignee (agent)', 'assigned_to', 'assignee', 'ja', 'Unassigned', { listDefault: true }),
    userRel('requester', 'Requester', 'requester_id', 'requester', 'jr', 'Unknown'),
    deptRel(),
    dt('createdAt', 'Created', 'created_at', { listDefault: true }),
    dt('resolvedAt', 'Resolved', 'resolved_at'),
    dt('closedAt', 'Closed', 'closed_at'),
    dt('slaDueAt', 'SLA due', 'sla_due_at'),
    en('sentiment', 'Sentiment', 'sentiment', ['POSITIVE', 'NEUTRAL', 'NEGATIVE', 'FRUSTRATED']),
    bool('isOpen', 'Open (not resolved/closed)', TICKET_OPEN, { permField: 'status' }),
    bool('slaBreached', 'SLA breached', `(t.sla_due_at IS NOT NULL AND COALESCE(t.resolved_at, ${NOW_UTC}) > t.sla_due_at)`, { permField: 'slaDueAt' }),
    num('resolutionHours', 'Resolution time (hours)', `(EXTRACT(EPOCH FROM (t.resolved_at - t.created_at)) / 3600.0)`, { unit: 'hours', permField: 'resolvedAt', aggregations: ['avg', 'min', 'max'] }),
    bool('fromPortal', 'Raised in customer portal', '(t.portal_user_id IS NOT NULL)', { permField: 'portalUserId' }),
  ],
  examples: ['Top 5 agents by tickets resolved this month', 'Open tickets by priority'],
};

const ASSETS: DatasetDef = {
  key: 'assets', label: 'IT assets', singular: 'asset', area: 'itdesk', module: 'assets', table: 'assets',
  description: 'IT asset inventory: type, status, who it is assigned to, purchase date.',
  permission: 'itdesk.asset.read', scopeResource: 'asset', scopeColumns: { assignedTo: 't.assigned_to' }, fieldResource: 'asset',
  joins: { assignee: 'LEFT JOIN users ja ON ja.id = t.assigned_to' },
  defaultDate: 'createdAt',
  fields: [
    str('name', 'Name', 't.name', false, { listDefault: true }),
    str('type', 'Type', 't.type', true, { listDefault: true }),
    str('status', 'Status', 't.status', true, { listDefault: true }),
    userRel('assignee', 'Assigned to', 'assigned_to', 'assignee', 'ja', 'Unassigned', { listDefault: true }),
    dayOf('purchaseDate', 'Purchase date', 'purchase_date'),
    dt('createdAt', 'Added', 'created_at'),
  ],
};

const CHANGES: DatasetDef = {
  key: 'change_requests', label: 'Change requests', singular: 'change request', area: 'itdesk', module: 'itdesk', table: 'change_requests',
  description: 'IT change requests: type, priority, status, requester, assignee, planned window, approval.',
  permission: 'itdesk.change.read', scopeResource: 'change', scopeColumns: { assignedTo: 't.assigned_to' }, fieldResource: 'change',
  joins: { assignee: 'LEFT JOIN users ja ON ja.id = t.assigned_to', requester: 'LEFT JOIN users jr ON jr.id = t.requested_by' },
  defaultDate: 'createdAt',
  fields: [
    str('title', 'Title', 't.title', false, { listDefault: true }),
    str('type', 'Type', 't.type', true, { listDefault: true }),
    str('priority', 'Priority', 't.priority', true),
    str('status', 'Status', 't.status', true, { listDefault: true }),
    userRel('requestedBy', 'Requested by', 'requested_by', 'requester', 'jr', 'Unknown'),
    userRel('assignee', 'Assigned to', 'assigned_to', 'assignee', 'ja', 'Unassigned', { listDefault: true }),
    dt('plannedStart', 'Planned start', 'planned_start'),
    dt('approvedAt', 'Approved', 'approved_at'),
    dt('createdAt', 'Created', 'created_at'),
  ],
};

const ARTICLES: DatasetDef = {
  key: 'kb_articles', label: 'Knowledge-base articles', singular: 'article', area: 'itdesk', module: 'knowledge_base', table: 'knowledge_articles',
  description: 'Help articles: status (draft/published/archived), category, author, publish date.',
  permission: 'itdesk.article.read', scopeResource: 'article', fieldResource: 'article',
  joins: { author: 'LEFT JOIN users jau ON jau.id = t.author_id', category: 'LEFT JOIN categories jcat ON jcat.id = t.category_id' },
  defaultDate: 'createdAt',
  fields: [
    str('title', 'Title', 't.title', false, { listDefault: true }),
    en('status', 'Status', 'status', ['DRAFT', 'PUBLISHED', 'ARCHIVED'], { listDefault: true }),
    rel('category', 'Category', 't.category_id', `COALESCE(jcat.name, 'Uncategorised')`, ['category'], { permField: 'categoryId' }),
    userRel('author', 'Author', 'author_id', 'author', 'jau', 'Unknown', { listDefault: true }),
    dt('publishedAt', 'Published', 'published_at'),
    dt('createdAt', 'Created', 'created_at'),
  ],
};

const CSAT: DatasetDef = {
  key: 'csat', label: 'CSAT survey responses', singular: 'CSAT response', area: 'itdesk', module: 'itdesk', table: 'csat_responses',
  description: 'Customer-satisfaction ratings (1–5) on resolved tickets, with the ticket’s agent and priority.',
  // A rating belongs to its ticket: scoped exactly like the ticket (by the ticket's assignee).
  permission: 'itdesk.ticket.read', scopeResource: 'ticket', scopeColumns: { assignedTo: 'jt.assigned_to' }, fieldResource: 'ticket',
  joins: { ticket: 'INNER JOIN tickets jt ON jt.id = t.ticket_id', agent: 'LEFT JOIN users ja ON ja.id = jt.assigned_to' },
  joinRequires: { agent: ['ticket'] },
  alwaysJoins: ['ticket'],
  defaultDate: 'submittedAt',
  fields: [
    num('rating', 'Rating (1–5)', 't.rating', { aggregations: ['avg', 'min', 'max'], listDefault: true }),
    bool('satisfied', 'Satisfied (rating 4–5)', '(t.rating >= 4)', { permField: 'rating' }),
    dt('submittedAt', 'Submitted', 'submitted_at', { listDefault: true }),
    rel('agent', 'Agent', 'jt.assigned_to', `COALESCE(ja.name, 'Unassigned')`, ['ticket', 'agent'], { isUser: true, permField: 'assignedTo', listDefault: true }),
    { key: 'priority', label: 'Ticket priority', type: 'enum', sql: 'jt.priority', joins: ['ticket'], values: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'], groupable: true, filterable: true, permField: 'priority' },
  ],
};

// ─── HR ─────────────────────────────────────────────────────────────────────

const EMPLOYEES: DatasetDef = {
  key: 'employees', label: 'Employees', singular: 'employee', area: 'hr', module: 'hr_core', table: 'employees',
  description: 'Employee records: department, location, manager, designation, employment type/status, work mode, joining and exit dates. No pay or personal data.',
  permission: 'hr.employee.read', scopeResource: 'employee', fieldResource: 'employee',
  scopeColumns: { userId: 't.user_id', id: 't.id', departmentId: 't.department_id' },
  joins: { dept: 'LEFT JOIN departments jd ON jd.id = t.department_id', loc: 'LEFT JOIN locations jl ON jl.id = t.location_id', mgr: 'LEFT JOIN employees jm ON jm.id = t.manager_id' },
  defaultDate: 'joiningDate',
  fields: [
    rel('employee', 'Employee', 't.id', 't.display_name', [], { permField: 'displayName', listDefault: true, groupable: false }),
    str('employeeCode', 'Employee code', 't.employee_code', false),
    deptRel(),
    rel('location', 'Location', 't.location_id', `COALESCE(jl.name, 'No location')`, ['loc'], { permField: 'locationId' }),
    rel('manager', 'Manager', 't.manager_id', `COALESCE(jm.display_name, 'No manager')`, ['mgr'], { permField: 'managerId' }),
    str('designation', 'Designation', `COALESCE(t.designation, 'Unknown')`, true, { listDefault: true }),
    en('employmentType', 'Employment type', 'employment_type', ['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN', 'CONSULTANT', 'TEMPORARY']),
    en('employmentStatus', 'Employment status', 'employment_status', ['PROBATION', 'ACTIVE', 'ON_LEAVE', 'NOTICE_PERIOD', 'SUSPENDED', 'EXITED'], { listDefault: true }),
    en('workMode', 'Work mode', 'work_mode', ['ONSITE', 'REMOTE', 'HYBRID']),
    dateCol('joiningDate', 'Joining date', 't.joining_date', { listDefault: true }),
    dateCol('lastWorkingDate', 'Last working date', 't.last_working_date'),
    num('tenureYears', 'Tenure (years)', `(EXTRACT(EPOCH FROM (COALESCE(t.last_working_date, CURRENT_DATE)::timestamp - t.joining_date::timestamp)) / 31557600.0)`, { unit: 'years', permField: 'joiningDate', aggregations: ['avg', 'min', 'max'] }),
  ],
  examples: ['Headcount by department', 'People who joined this year'],
};

const ATTENDANCE: DatasetDef = {
  key: 'attendance', label: 'Attendance days', singular: 'attendance day', area: 'hr', module: 'attendance', table: 'attendance_days',
  description: 'One row per employee per day from the attendance register: status (present, late, half day, absent, leave, WFH, holiday, week off, LOP), worked/late/overtime minutes.',
  permission: 'hr.attendance.read', scopeResource: 'attendance', scopeColumns: { userId: 't.user_id' }, fieldResource: 'attendance',
  joins: HR_PERSON_JOINS, joinRequires: HR_PERSON_REQUIRES,
  defaultDate: 'date',
  fields: [
    dateCol('date', 'Date', 't.date', { listDefault: true }),
    ...hrPerson(),
    en('status', 'Status', 'status', ['PRESENT', 'LATE', 'HALF_DAY', 'ABSENT', 'LEAVE', 'UNPAID_LEAVE', 'WFH', 'HOLIDAY', 'WEEK_OFF', 'LOP'], { listDefault: true }),
    num('workedHours', 'Hours worked', '(t.worked_minutes / 60.0)', { unit: 'hours', permField: 'workedMinutes' }),
    num('lateMinutes', 'Minutes late', 't.late_minutes', { unit: 'minutes' }),
    num('earlyMinutes', 'Minutes left early', 't.early_minutes', { unit: 'minutes' }),
    num('overtimeHours', 'Overtime hours', '(t.overtime_minutes / 60.0)', { unit: 'hours', permField: 'overtimeMinutes' }),
    num('paidFraction', 'Paid fraction of the day', 't.paid_fraction'),
    en('source', 'Source', 'source', ['COMPUTED', 'MANUAL']),
  ],
  examples: ['Who was absent yesterday?', 'Late arrivals per week by department'],
};

const CHECKINS: DatasetDef = {
  key: 'attendance_sessions', label: 'Check-in sessions', singular: 'check-in', area: 'hr', module: 'attendance', table: 'attendance_records',
  description: 'Individual check-in / check-out sessions: time in, time out, office or WFH, how the session was closed.',
  permission: 'hr.attendance.read', scopeResource: 'attendance', scopeColumns: { userId: 't.user_id' }, fieldResource: 'attendance',
  joins: HR_PERSON_JOINS, joinRequires: HR_PERSON_REQUIRES,
  defaultDate: 'checkInAt',
  fields: [
    dateCol('date', 'Date', 't.date'),
    ...hrPerson(),
    dt('checkInAt', 'Checked in', 'check_in_at', { listDefault: true }),
    dt('checkOutAt', 'Checked out', 'check_out_at', { listDefault: true }),
    en('mode', 'Mode', 'mode', ['OFFICE', 'WFH'], { listDefault: true }),
    str('checkOutSource', 'Closed by', `COALESCE(t.check_out_source, 'Still open')`),
    num('sessionHours', 'Session length (hours)', `(EXTRACT(EPOCH FROM (t.check_out_at - t.check_in_at)) / 3600.0)`, { unit: 'hours', permField: 'checkOutAt' }),
  ],
};

const LEAVE_BASE = (wfh: boolean): Omit<DatasetDef, 'key' | 'label' | 'singular' | 'description' | 'module'> => ({
  area: 'hr', table: 'leave_requests',
  permission: 'hr.leave.read', scopeResource: 'leave', scopeColumns: { userId: 't.user_id' }, fieldResource: 'leave',
  joins: { ...HR_PERSON_JOINS, ltype: 'INNER JOIN leave_types jlt ON jlt.id = t.leave_type_id' },
  joinRequires: HR_PERSON_REQUIRES,
  alwaysJoins: ['ltype'],
  baseWhere: () => (wfh ? 'jlt.is_wfh = TRUE' : 'jlt.is_wfh = FALSE'),
  defaultDate: 'startDate',
  fields: [
    ...hrPerson(),
    rel('leaveType', wfh ? 'WFH type' : 'Leave type', 't.leave_type_id', 'jlt.name', ['ltype'], { permField: 'leaveTypeId', listDefault: true }),
    en('status', 'Status', 'status', ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'], { listDefault: true }),
    dateCol('startDate', 'Start date', 't.start_date', { listDefault: true }),
    dateCol('endDate', 'End date', 't.end_date', { listDefault: true }),
    dt('createdAt', 'Requested', 'created_at'),
    num('days', 'Days', 't.days', { unit: 'days', listDefault: true }),
    bool('halfDay', 'Half day', 't.half_day'),
    ...(wfh ? [] : [bool('isPaid', 'Paid leave type', 'jlt.is_paid', { joins: ['ltype'], permField: 'leaveTypeId' })]),
  ],
});

const LEAVE: DatasetDef = {
  key: 'leave_requests', label: 'Leave requests', singular: 'leave request', module: 'hr_core',
  description: 'Leave applications (not work-from-home): type, status, dates and number of days.',
  ...LEAVE_BASE(false),
  examples: ['Approved leave days per month by leave type', 'Pending leave requests'],
};

const WFH: DatasetDef = {
  key: 'wfh_requests', label: 'Work-from-home requests', singular: 'WFH request', module: 'attendance',
  description: 'Work-from-home requests (leave types marked WFH): status, dates, days. Days actually worked from home are attendance days with status WFH.',
  ...LEAVE_BASE(true),
};

const PAYSLIP_PERIOD = 'COALESCE(t.period_start, make_date(t.year, t.month, 1))';
const PAYSLIPS: DatasetDef = {
  key: 'payslips', label: 'Payslips', singular: 'payslip', area: 'hr', module: 'payroll', table: 'payslips',
  description: 'One payslip per employee per payroll run: gross pay, deductions, net pay, employer contributions and cost, paid/LOP days. Payroll cost = gross pay + employer contributions. Draft payslips belong to runs not yet finalised.',
  permission: 'hr.payslip.read', scopeResource: 'payslip', scopeColumns: { userId: 't.user_id' }, fieldResource: 'payslip',
  joins: HR_PERSON_JOINS, joinRequires: HR_PERSON_REQUIRES,
  defaultDate: 'period',
  currencySql: 't.currency',
  fields: [
    dateCol('period', 'Pay period (start)', PAYSLIP_PERIOD, { permField: 'periodStart', listDefault: true }),
    ...hrPerson(),
    en('status', 'Status', 'status', ['DRAFT', 'GENERATED', 'PAID'], { listDefault: true }),
    money('basic', 'Basic pay', 't.basic'),
    money('grossPay', 'Gross pay', 't.gross_pay', { listDefault: true }),
    money('totalDeductions', 'Total deductions', 't.total_deductions'),
    money('netPay', 'Net pay', 't.net_pay', { listDefault: true }),
    money('pf', 'Provident fund', 't.pf'),
    // Employer-side figures reveal pay as much as gross does — they follow gross pay's field rule.
    money('employerContributions', 'Employer contributions', 'COALESCE(t.employer_contributions, 0)', { permField: 'grossPay' }),
    money('employerCost', 'Payroll cost (gross + employer contributions)', '(t.gross_pay + COALESCE(t.employer_contributions, 0))', { permField: 'grossPay' }),
    num('paidDays', 'Paid days', 't.paid_days', { unit: 'days' }),
    num('lopDays', 'Loss-of-pay days', 't.lop_days', { unit: 'days' }),
    num('overtimeHours', 'Overtime hours', 't.overtime_hours', { unit: 'hours' }),
    dt('paidAt', 'Paid', 'paid_at'),
  ],
  examples: ['Total payroll cost last 3 months by department', 'Net pay per month'],
};

const PAYROLL_RUNS: DatasetDef = {
  key: 'payroll_runs', label: 'Payroll runs', singular: 'payroll run', area: 'hr', module: 'payroll', table: 'payroll_runs',
  description: 'Payroll runs (one per pay period): status (draft/processed/paid), number of payslips and the run’s total gross pay.',
  permission: 'hr.payslip.read', fieldResource: 'payslip', requireAllScope: true,
  joins: { runner: 'LEFT JOIN users jrb ON jrb.id = t.run_by' },
  defaultDate: 'period',
  fields: [
    dateCol('period', 'Pay period (start)', 'COALESCE(t.period_start, make_date(t.year, t.month, 1))', { permField: 'periodStart', listDefault: true }),
    en('status', 'Status', 'status', ['DRAFT', 'PROCESSED', 'PAID'], { listDefault: true }),
    en('attendanceMode', 'Paid days from', 'attendance_mode', ['ATTENDANCE', 'CALENDAR']),
    num('payslipCount', 'Payslips', '(SELECT COUNT(*) FROM payslips p WHERE p.payroll_run_id = t.id)', { listDefault: true }),
    money('totalGross', 'Total gross pay', '(SELECT COALESCE(SUM(p.gross_pay), 0) FROM payslips p WHERE p.payroll_run_id = t.id)', { permField: 'payslip.grossPay', listDefault: true }),
    dt('runAt', 'Run', 'run_at'),
    userRel('runBy', 'Run by', 'run_by', 'runner', 'jrb', 'Unknown'),
  ],
};

const LOAN_RECOVERED = `(SELECT COALESCE(SUM(e.amount), 0) FROM loan_ledger_entries e WHERE e.loan_id = t.id AND e.type IN ('RECOVERY', 'REPAYMENT', 'WAIVER'))`;
const LOANS: DatasetDef = {
  key: 'loans', label: 'Employee loans & advances', singular: 'loan', area: 'hr', module: 'payroll', table: 'employee_loans',
  description: 'Loans and salary advances to employees: principal, total repayable, EMI, outstanding balance (repayable minus recoveries, repayments and waivers), status.',
  permission: 'hr.salary.read', scopeResource: 'salary', scopeColumns: { userId: 't.user_id' }, fieldResource: 'loan',
  joins: HR_PERSON_JOINS, joinRequires: HR_PERSON_REQUIRES,
  defaultDate: 'disbursedOn',
  fields: [
    ...hrPerson(),
    str('name', 'Name', 't.name', false, { listDefault: true }),
    en('type', 'Type', 'type', ['LOAN', 'ADVANCE'], { listDefault: true }),
    en('status', 'Status', 'status', ['ACTIVE', 'CLOSED', 'CANCELLED'], { listDefault: true }),
    money('principal', 'Principal', 't.principal', { listDefault: true }),
    money('totalRepayable', 'Total repayable', 't.total_repayable'),
    money('emiAmount', 'EMI', 't.emi_amount'),
    money('outstanding', 'Outstanding balance', `GREATEST(0, t.total_repayable - ${LOAN_RECOVERED})`, { permField: 'totalRepayable', listDefault: true }),
    num('instalments', 'Instalments', 't.instalments'),
    dateCol('disbursedOn', 'Disbursed on', 't.disbursed_on'),
  ],
};

// ─── Shared ─────────────────────────────────────────────────────────────────

const TASK_DONE = `t.status IN ('DONE', 'CANCELLED')`;
const TASKS: DatasetDef = {
  key: 'tasks', label: 'Tasks', singular: 'task', area: null, module: null, table: 'tasks',
  description: 'Tasks (My Work): status, priority, assignee, due and completion dates, where they came from.',
  permission: 'core.task.read', scopeResource: 'task', fieldResource: 'task',
  scopeColumns: { assigneeUserId: 't.assignee_user_id', assigneeEmployeeId: 't.assignee_employee_id' },
  joins: { assignee: 'LEFT JOIN users ja ON ja.id = t.assignee_user_id', aemp: 'LEFT JOIN employees jae ON jae.id = t.assignee_employee_id', creator: 'LEFT JOIN users jcr ON jcr.id = t.created_by' },
  defaultDate: 'createdAt',
  fields: [
    str('title', 'Title', 't.title', false, { listDefault: true }),
    en('status', 'Status', 'status', ['OPEN', 'IN_PROGRESS', 'BLOCKED', 'DONE', 'CANCELLED'], { listDefault: true }),
    en('priority', 'Priority', 'priority', ['LOW', 'MEDIUM', 'HIGH', 'URGENT'], { listDefault: true }),
    en('source', 'Source', 'source', ['MANUAL', 'WORKFLOW', 'AI', 'ONBOARDING', 'OFFBOARDING', 'APPROVAL', 'RECURRENCE', 'SERVICE_REQUEST']),
    rel('assignee', 'Assignee', 't.assignee_user_id', `COALESCE(ja.name, jae.display_name, 'Unassigned')`, ['assignee', 'aemp'], { isUser: true, permField: 'assigneeUserId', listDefault: true }),
    userRel('createdBy', 'Created by', 'created_by', 'creator', 'jcr', 'Unknown'),
    dt('createdAt', 'Created', 'created_at'),
    dt('dueAt', 'Due', 'due_at', { listDefault: true }),
    dt('completedAt', 'Completed', 'completed_at'),
    bool('isOverdue', 'Overdue', `(NOT (${TASK_DONE}) AND t.due_at IS NOT NULL AND t.due_at < ${NOW_UTC})`, { permField: 'dueAt' }),
  ],
};

const APPROVALS: DatasetDef = {
  key: 'approvals', label: 'Approval requests', singular: 'approval request', area: null, module: null, table: 'approval_requests',
  description: 'Approval requests (leave, expenses, deals, custom): status, what they are for, requester, amount, decision time.',
  permission: 'core.approval.read', scopeResource: 'approval', scopeColumns: { requestedBy: 't.requested_by' }, fieldResource: 'approval',
  joins: { requester: 'LEFT JOIN users jr ON jr.id = t.requested_by' },
  defaultDate: 'createdAt',
  currencySql: 't.currency',
  fields: [
    str('title', 'Title', 't.title', false, { listDefault: true }),
    en('status', 'Status', 'status', ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'SKIPPED'], { listDefault: true }),
    str('entityType', 'For', 't.entity_type', true, { listDefault: true }),
    userRel('requestedBy', 'Requested by', 'requested_by', 'requester', 'jr', 'Unknown', { listDefault: true }),
    money('amount', 'Amount', 't.amount'),
    dt('createdAt', 'Requested', 'created_at'),
    dt('decidedAt', 'Decided', 'decided_at'),
    num('hoursToDecide', 'Hours to decision', `(EXTRACT(EPOCH FROM (t.decided_at - t.created_at)) / 3600.0)`, { unit: 'hours', permField: 'decidedAt', aggregations: ['avg', 'min', 'max'] }),
  ],
};

export const STATIC_DATASETS: DatasetDef[] = [
  LEADS, DEALS, CONTACTS, ACCOUNTS, ACTIVITIES, QUOTES, INVOICES, CAMPAIGNS,
  TICKETS, ASSETS, CHANGES, ARTICLES, CSAT,
  EMPLOYEES, ATTENDANCE, CHECKINS, LEAVE, WFH, PAYSLIPS, PAYROLL_RUNS, LOANS,
  TASKS, APPROVALS,
];

// ─── Custom modules ─────────────────────────────────────────────────────────

export interface CustomModuleInput {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  stages?: unknown;
  fields: Array<{ fieldKey: string; label: string; fieldType: string; options?: unknown }>;
}

/** Field keys become SQL string literals (data->>'key'), so only plain identifiers are accepted. */
const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const NUM_RE = `'^\\s*-?[0-9]+(\\.[0-9]+)?\\s*$'`;
const DATE_RE = `'^[0-9]{4}-[0-9]{2}-[0-9]{2}'`;

export function customDatasetKey(slug: string): string {
  return `custom_${slug.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40)}`;
}

/**
 * A dataset for one custom module: its records' JSON `data` exposed through
 * safe casts (a value that isn't a number simply counts as empty rather than
 * failing the whole query). Record access mirrors the custom-module routes:
 * any staff role, org-wide (customModules.routes.ts — ALL_STAFF).
 */
export function customModuleDataset(m: CustomModuleInput): DatasetDef {
  const fields: FieldDef[] = [
    dt('createdAt', 'Created', 'created_at'),
    dt('updatedAt', 'Last updated', 'updated_at'),
    str('source', 'Source', 't.source', true),
  ];
  const stages = Array.isArray(m.stages) ? (m.stages as any[]).map(s => String(s?.key ?? '')).filter(k => k && k.length < 80) : [];
  if (stages.length) fields.push(en('stage', 'Stage', 'stage', stages, { listDefault: true }));
  for (const f of m.fields) {
    if (!SAFE_KEY.test(f.fieldKey)) continue;
    const raw = `(t.data->>'${f.fieldKey}')`;
    const key = `f_${f.fieldKey}`;
    const label = String(f.label || f.fieldKey).slice(0, 80);
    switch (f.fieldType) {
      case 'NUMBER':
        fields.push(num(key, label, `(CASE WHEN ${raw} ~ ${NUM_RE} THEN ${raw}::numeric END)`, { permField: f.fieldKey, listDefault: true })); break;
      case 'CURRENCY':
        fields.push(money(key, label, `(CASE WHEN ${raw} ~ ${NUM_RE} THEN ${raw}::numeric END)`, { permField: f.fieldKey, listDefault: true })); break;
      case 'DATE':
        fields.push(dateCol(key, label, `(CASE WHEN ${raw} ~ ${DATE_RE} THEN substring(${raw}, 1, 10)::date END)`, { permField: f.fieldKey })); break;
      case 'BOOLEAN':
        fields.push(bool(key, label, `(CASE lower(${raw}) WHEN 'true' THEN TRUE WHEN 'false' THEN FALSE END)`, { permField: f.fieldKey })); break;
      case 'DROPDOWN': {
        const opts = Array.isArray(f.options) ? (f.options as unknown[]).map(String).filter(o => o.length < 120).slice(0, 100) : [];
        fields.push(opts.length
          ? { key, label, type: 'enum', sql: raw, values: opts, groupable: true, filterable: true, permField: f.fieldKey, listDefault: true }
          : str(key, label, raw, true, { permField: f.fieldKey, listDefault: true }));
        break;
      }
      case 'RELATION': break; // ids of other records — not meaningful to aggregate
      default:
        fields.push(str(key, label, raw, true, { permField: f.fieldKey, listDefault: fields.length < 6 }));
    }
  }
  return {
    key: customDatasetKey(m.slug), label: m.name.slice(0, 80), singular: 'record', area: null, module: null, table: 'custom_module_records',
    description: (m.description || `Records of the custom module "${m.name}".`).slice(0, 300),
    roles: ALL_STAFF,
    baseWhere: p => `t.module_id = ${p.add(m.id)}`,
    defaultDate: 'createdAt',
    fields,
  };
}
