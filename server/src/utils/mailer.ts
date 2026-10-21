import nodemailer from 'nodemailer';
import { prisma } from './prisma';
import { decryptSecretOrPlain } from './crypto';
import { recordUsage } from './usageTracking';
import { assertPlatformSendQuota, PlatformQuotaExceededError } from './licensing';
import { getPlatformMailConfig, type PlatformMailConfig } from './platformSettings';
import { enqueueJob, registerJobHandler } from './jobQueue';
import { demoOrgMailBlocked } from './demoOrgs';

interface MailOptions {
  to: string;
  subject: string;
  html: string;
  // When set, sendMail() tries the org's own connected EmailAccount first
  // (Inbox → Settings) so customer-facing mail — portal login links, ticket
  // notifications, invites, campaigns — comes from the org's own address and
  // display name instead of a shared platform sender. Falls back to the
  // platform Resend/SMTP mailer below if the org has no EmailAccount
  // connected, or if sending through it fails for any reason.
  orgId?: string;
  /** Base64 so the payload survives the job-queue JSON round trip on retry. */
  attachments?: { filename: string; contentBase64: string; contentType?: string }[];
  /** Account-access mail (invites, password reset/changed, signup approval):
   *  never held back by the platform send quota — nobody gets locked out of
   *  their account because their org sent a lot of campaign mail. */
  essential?: boolean;
}

const nodemailerAttachments = (opts: MailOptions) => opts.attachments?.map(a => ({ filename: a.filename, content: Buffer.from(a.contentBase64, 'base64'), contentType: a.contentType }));

// Render's free web-service tier blocks all outbound SMTP traffic (ports 25,
// 465, 587) — confirmed by the ETIMEDOUT/CONN errors nodemailer throws there
// regardless of which SMTP host you point it at. Resend's HTTP API runs over
// plain HTTPS (443), so it isn't affected. When a Resend key is configured
// (Platform Admin console, falling back to RESEND_API_KEY), it's used
// instead of SMTP entirely; SMTP remains as the fallback for local dev or a
// paid Render plan where outbound SMTP isn't blocked. Both are resolved
// live per-send via getPlatformMailConfig() rather than read once at import
// time, so a Platform Admin console edit takes effect immediately.
const DEFAULT_FROM_ADDRESS = 'CRM & IT Desk <onboarding@resend.dev>';

async function sendViaResend(opts: MailOptions, apiKey: string, from: string, replyTo?: string): Promise<void> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from, to: opts.to, subject: opts.subject, html: opts.html,
      ...(replyTo ? { reply_to: replyTo } : {}),
      ...(opts.attachments?.length ? { attachments: opts.attachments.map(a => ({ filename: a.filename, content: a.contentBase64 })) } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend API ${res.status}: ${body}`);
  }
}

// Lazy transporter — only created when SMTP is configured
function buildPlatformTransporter(cfg: PlatformMailConfig) {
  if (!cfg.smtpHost || !cfg.smtpUser || !cfg.smtpPass) return null;
  return nodemailer.createTransport({
    host: cfg.smtpHost,
    port: cfg.smtpPort || 587,
    secure: cfg.smtpPort === 465,
    auth: { user: cfg.smtpUser, pass: cfg.smtpPass },
    // Nodemailer's defaults (2min connection, 10min socket) mean a blocked or
    // slow-to-respond SMTP host hangs the *caller* for that long on every
    // `await sendMail(...)` — e.g. register()/approve-org-signup silently not
    // finishing when the network path to smtpout.secureserver.net is slow.
    // Fail fast instead; email delivery isn't worth blocking a request over.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 10_000,
  });
}

/**
 * Builds a transporter + branded "From" header from the org's own connected
 * EmailAccount (Inbox → Settings), or null if the org hasn't connected one.
 * Shared by sendMail() below and by workflow-engine.ts's SEND_EMAIL action,
 * which used to duplicate this exact lookup inline.
 */
async function getOrgMailer(orgId: string): Promise<{ transport: ReturnType<typeof nodemailer.createTransport>; from: string } | null> {
  const [emailAccount, org, branding] = await Promise.all([
    prisma.emailAccount.findUnique({ where: { orgId } }),
    prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } }),
    prisma.orgBranding.findUnique({ where: { orgId }, select: { companyName: true } }),
  ]);
  if (!emailAccount) return null;

  const transport = nodemailer.createTransport({
    host: emailAccount.smtpHost,
    port: emailAccount.smtpPort,
    secure: emailAccount.smtpPort === 465,
    // decryptSecretOrPlain, not the raw column — EmailAccount.password is
    // stored encrypted (see inbox.controller.ts's encryptSecret on save).
    // The previous inline copy of this lookup (workflow-engine.ts's
    // SEND_EMAIL case) used the raw encrypted value directly, which meant
    // SMTP auth was silently failing with the ciphertext as the password
    // any time an org had actually connected their own email account.
    auth: { user: emailAccount.email, pass: decryptSecretOrPlain(emailAccount.password) },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 10_000,
  });
  const fromName = (branding?.companyName || org?.name || '').replace(/"/g, '');
  const from = fromName ? `"${fromName}" <${emailAccount.email}>` : emailAccount.email;
  return { transport, from };
}

interface MailBranding {
  companyName: string;
  logoUrl: string | null;
  primaryColor: string;
  replyTo: string | null;
}

/**
 * White-label Tier 1 (see the White-Label Sending & Licensing Plan doc):
 * when mail goes out through the *platform's* shared Resend/SMTP account
 * rather than the org's own connected mailbox, it still shouldn't look like
 * it came from "CRM & IT Desk" — it should look like it came from the org.
 * Reads OrgBranding (already used on the customer portal) and reuses it here.
 */
async function getMailBranding(orgId: string): Promise<MailBranding | null> {
  const [branding, org] = await Promise.all([
    prisma.orgBranding.findUnique({ where: { orgId }, select: { companyName: true, logoUrl: true, primaryColor: true, supportEmail: true } }),
    prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } }),
  ]);
  const companyName = (branding?.companyName || org?.name || '').trim();
  if (!companyName && !branding?.logoUrl) return null; // nothing to brand with
  return {
    companyName,
    logoUrl: branding?.logoUrl || null,
    primaryColor: branding?.primaryColor || '#4f46e5',
    replyTo: branding?.supportEmail || null,
  };
}

/** Keeps the platform's verified sending address, swaps only the display name. */
function brandedFromAddress(companyName: string, fromAddress: string): string {
  const match = fromAddress.match(/<([^>]+)>/);
  const emailPart = match ? match[1] : fromAddress;
  const safeName = companyName.replace(/"/g, '');
  return safeName ? `"${safeName}" <${emailPart}>` : fromAddress;
}

/** Prepends a small logo/company-name header banner in the org's own color, above the existing template content. */
function withBrandHeader(html: string, branding: MailBranding): string {
  const mark = branding.logoUrl
    ? `<img src="${escHtml(branding.logoUrl)}" alt="${escHtml(branding.companyName)}" style="height:32px;max-width:200px;object-fit:contain" />`
    : `<span style="font-weight:700;font-size:18px;color:${safeColor(branding.primaryColor)}">${escHtml(branding.companyName)}</span>`;
  return `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto 4px;padding-bottom:12px;border-bottom:3px solid ${safeColor(branding.primaryColor)}">${mark}</div>${html}`;
}

/**
 * Does the actual delivery work, with no swallowing on final failure — a
 * Resend/SMTP error here is thrown to the caller. Split out from sendMail()
 * below so both the "try it right now" path and the job-queue retry path
 * (registerJobHandler('send_email', ...) at the bottom of this file) share
 * one implementation instead of duplicating the branding/fallback logic.
 */
async function performSendMail(opts: MailOptions): Promise<void> {
  // Public demo orgs are driven by anonymous visitors — see utils/demoOrgs.ts.
  if (await demoOrgMailBlocked(opts.orgId, opts.to)) {
    console.log(`[Email suppressed — demo org, external recipient] org ${opts.orgId} | ${opts.subject}`);
    return;
  }
  if (opts.orgId) {
    try {
      const orgMailer = await getOrgMailer(opts.orgId);
      if (orgMailer) {
        await orgMailer.transport.sendMail({ from: orgMailer.from, to: opts.to, subject: opts.subject, html: opts.html, attachments: nodemailerAttachments(opts) });
        console.log(`[Email sent via org SMTP] To: ${opts.to} | ${opts.subject}`);
        recordUsage(opts.orgId, 'EMAIL_SEND', 'OWN');
        return;
      }
    } catch (err) {
      console.error('[Email error — org SMTP, falling back to platform mailer]', err);
      // fall through to the platform mailer below rather than giving up —
      // a misconfigured org SMTP account shouldn't mean the customer never
      // gets a critical link (portal login, ticket resolution, ...).
    }
  }

  // Platform fallback = our Resend/SMTP account: bounded by the org's monthly
  // allowance (LIC-18). Throws PlatformQuotaExceededError, which sendMail()
  // logs instead of retrying. Mail without an org (platform notices) and
  // account-access mail are never limited.
  if (opts.orgId && !opts.essential) await assertPlatformSendQuota(opts.orgId, 'email');

  // Tier 1 white-label: still sending through the platform's own domain/
  // account below, but dressed as the org wherever we have branding for it.
  const [branding, cfg] = await Promise.all([
    opts.orgId ? getMailBranding(opts.orgId).catch(() => null) : Promise.resolve(null),
    getPlatformMailConfig(),
  ]);
  const platformFromAddress = cfg.resendFrom || cfg.smtpFrom || DEFAULT_FROM_ADDRESS;
  const from = branding ? brandedFromAddress(branding.companyName, platformFromAddress) : platformFromAddress;
  const html = branding ? withBrandHeader(opts.html, branding) : opts.html;
  const replyTo = branding?.replyTo || undefined;

  if (cfg.resendApiKey) {
    // No try/catch here — a Resend failure propagates to the caller
    // (sendMail() below, or the job-queue retry handler), which is what
    // decides whether to queue a retry or record the final failure.
    await sendViaResend({ ...opts, html }, cfg.resendApiKey, from, replyTo);
    console.log(`[Email sent via Resend]${branding ? ` (branded as "${branding.companyName}")` : ''} To: ${opts.to} | ${opts.subject}`);
    if (opts.orgId) recordUsage(opts.orgId, 'EMAIL_SEND', 'PLATFORM');
    return;
  }

  const transporter = buildPlatformTransporter(cfg);
  if (!transporter) {
    // Not a failure — nothing is configured, so there's nothing a retry
    // would accomplish either. Same as before: log and no-op.
    console.log(`[Email skipped — no Resend key or SMTP configured] To: ${opts.to} | ${opts.subject}`);
    return;
  }
  await transporter.sendMail({ from, replyTo, to: opts.to, subject: opts.subject, html, attachments: nodemailerAttachments(opts) });
  console.log(`[Email sent via SMTP]${branding ? ` (branded as "${branding.companyName}")` : ''} To: ${opts.to} | ${opts.subject}`);
  if (opts.orgId) recordUsage(opts.orgId, 'EMAIL_SEND', 'PLATFORM');
}

/**
 * Public entry point every caller in the app already uses. Tries delivery
 * immediately (same as before); on failure, instead of just logging and
 * dropping the message, queues a retry with exponential backoff — see
 * jobQueue.ts. Still never throws, so every existing `await sendMail(...)`
 * call site keeps working exactly as it did.
 */
export async function sendMail(opts: MailOptions): Promise<void> {
  try {
    await performSendMail(opts);
  } catch (err) {
    if (err instanceof PlatformQuotaExceededError) {
      // Retrying can't help until next month (or until the org connects its own mailbox).
      console.warn(`[Email not sent — platform quota] org ${opts.orgId} To: ${opts.to} | ${opts.subject}: ${err.message}`);
      return;
    }
    console.error('[Email error — queuing retry]', err);
    await enqueueJob('send_email', opts, { orgId: opts.orgId ?? null });
  }
}

registerJobHandler('send_email', async (payload: MailOptions) => {
  try {
    await performSendMail(payload);
  } catch (err) {
    if (err instanceof PlatformQuotaExceededError) {
      console.warn(`[Email retry dropped — platform quota] org ${payload.orgId}: ${err.message}`);
      return;
    }
    throw err;
  }
});

// ─── Reusable HTML templates ─────────────────────────────────────────────────

const base = (content: string, color = '#4f46e5') => `
  <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#111">
    ${content}
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:32px 0"/>
    <p style="font-size:12px;color:#9ca3af">CRM & IT Desk — you're receiving this because you're a member of your organization.</p>
  </div>
`;

/**
 * Every value interpolated into email HTML goes through this. Ticket titles
 * arrive from inbound email and web forms, org-signup names from an
 * anonymous public form, requester names from an email's From header — left
 * raw, any of them could put links, images or fake buttons into a mail sent
 * under the org's (or the platform's) own name.
 */
export const escHtml = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** Brand colours are validated on save (#rrggbb); legacy rows fall back rather than land raw in a style attribute. */
const safeColor = (c: string) => (/^#[0-9a-fA-F]{3,8}$/.test(c) ? c : '#4f46e5');

const highlight = (text: string, color = '#4f46e5') => `
  <div style="background:#f5f3ff;border-left:4px solid ${color};padding:12px 16px;margin:16px 0;border-radius:4px">
    ${text}
  </div>
`;

const btn = (href: string, label: string, color = '#4f46e5') =>
  `<a href="${escHtml(href)}" style="display:inline-block;background:${color};color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;margin:16px 0">${label}</a>`;

export const emailTemplates = {
  invite: (to: string, orgName: string, role: string, link: string) => ({
    essential: true,
    to,
    subject: `You've been invited to join ${orgName}`,
    html: base(`
      <h2 style="color:#4f46e5">You're invited!</h2>
      <p>You've been invited to join <strong>${escHtml(orgName)}</strong> as a <strong>${escHtml(role.replace(/_/g, ' '))}</strong>.</p>
      <p>Click below to set up your account. This link expires in 7 days.</p>
      ${btn(link, 'Accept Invitation')}
      <p style="color:#6b7280;font-size:13px">Or copy this link: <code>${escHtml(link)}</code></p>
    `),
  }),

  ticketCreated: (ticket: { title: string }, requesterName: string, assigneeEmail: string) => ({
    to: assigneeEmail,
    subject: `[Ticket] New: ${ticket.title}`,
    html: base(`
      <h2 style="color:#2563eb">New Ticket Submitted</h2>
      <p><strong>${escHtml(requesterName)}</strong> submitted a new support ticket:</p>
      ${highlight(`<strong>${escHtml(ticket.title)}</strong>`, '#2563eb')}
      <p>Log in to view and respond to this ticket.</p>
    `, '#2563eb'),
  }),

  ticketAssigned: (ticket: { title: string }, assigneeName: string, assigneeEmail: string) => ({
    to: assigneeEmail,
    subject: `[Ticket] Assigned to you: ${ticket.title}`,
    html: base(`
      <h2 style="color:#2563eb">Ticket Assigned to You</h2>
      <p>Hi <strong>${escHtml(assigneeName)}</strong>, a ticket has been assigned to you:</p>
      ${highlight(`<strong>${escHtml(ticket.title)}</strong>`, '#2563eb')}
      <p>Log in to view and start working on it.</p>
    `, '#2563eb'),
  }),

  ticketResolved: (ticket: { title: string }, requesterName: string, requesterEmail: string) => ({
    to: requesterEmail,
    subject: `[Ticket] Resolved: ${ticket.title}`,
    html: base(`
      <h2 style="color:#16a34a">Your Ticket Has Been Resolved</h2>
      <p>Hi <strong>${escHtml(requesterName)}</strong>, your ticket has been resolved:</p>
      ${highlight(`<strong>${escHtml(ticket.title)}</strong>`, '#16a34a')}
      <p>If you need further help, please submit a new ticket.</p>
    `, '#16a34a'),
  }),

  ticketStatusChanged: (ticket: { title: string }, status: string, requesterName: string, requesterEmail: string) => ({
    to: requesterEmail,
    subject: `[Ticket] Status update: ${ticket.title}`,
    html: base(`
      <h2 style="color:#d97706">Ticket Status Updated</h2>
      <p>Hi <strong>${escHtml(requesterName)}</strong>, your ticket status has changed to <strong>${escHtml(status.replace(/_/g, ' '))}</strong>:</p>
      ${highlight(`<strong>${escHtml(ticket.title)}</strong>`, '#d97706')}
    `, '#d97706'),
  }),

  csatSurvey: (ticket: { id: string; title: string }, requesterName: string, requesterEmail: string) => {
    const base_url = process.env.APP_URL || 'http://localhost:5173';
    const link = escHtml(`${base_url}/api/csat/submit/${encodeURIComponent(ticket.id)}`);
    return {
      to: requesterEmail,
      subject: `How did we do? Rate your support experience`,
      html: base(`
        <h2 style="color:#4f46e5">How was your experience?</h2>
        <p>Hi <strong>${escHtml(requesterName)}</strong>, we recently resolved your ticket:</p>
        ${highlight(`<strong>${escHtml(ticket.title)}</strong>`, '#4f46e5')}
        <p>We'd love your feedback! Click a star below to rate your experience:</p>
        <div style="text-align:center;margin:24px 0;font-size:36px">
          ${[1,2,3,4,5].map(r => `<a href="${link}?rating=${r}&via=email" style="text-decoration:none;margin:0 4px">⭐</a>`).join('')}
        </div>
        <p style="color:#6b7280;font-size:12px">You can also <a href="${link}">submit feedback with a comment</a>.</p>
      `),
    };
  },

  orgSignupRequest: (adminEmail: string, req: { organizationName: string; name: string; email: string }, approveLink: string) => ({
    essential: true,
    to: adminEmail,
    subject: `New org signup request: ${req.organizationName}`,
    html: base(`
      <h2 style="color:#4f46e5">New Organization Signup Request</h2>
      <p>Someone just requested a new workspace:</p>
      ${highlight(`
        <strong>${escHtml(req.organizationName)}</strong><br/>
        ${escHtml(req.name)} &lt;${escHtml(req.email)}&gt;
      `)}
      <p>Nothing has been created yet — review and approve (or reject) below.</p>
      ${btn(approveLink, 'Review request')}
      <p style="color:#6b7280;font-size:13px">Or copy this link: <code>${escHtml(approveLink)}</code></p>
    `),
  }),

  orgSignupApproved: (requesterEmail: string, requesterName: string, orgName: string, loginLink: string) => ({
    essential: true,
    to: requesterEmail,
    subject: `You're approved — ${orgName} is ready`,
    html: base(`
      <h2 style="color:#16a34a">You're approved!</h2>
      <p>Hi <strong>${escHtml(requesterName)}</strong>, your workspace <strong>${escHtml(orgName)}</strong> has been approved.</p>
      <p>You can log in now with the email and password you signed up with.</p>
      ${btn(loginLink, 'Log in', '#16a34a')}
    `, '#16a34a'),
  }),

  passwordReset: (to: string, name: string, resetLink: string) => ({
    essential: true,
    to,
    subject: 'Reset your password',
    html: base(`
      <h2 style="color:#4f46e5">Reset your password</h2>
      <p>Hi <strong>${escHtml(name)}</strong>, we received a request to reset your password. This link expires in 30 minutes.</p>
      ${btn(resetLink, 'Reset password')}
      <p style="color:#6b7280;font-size:13px">Or copy this link: <code>${escHtml(resetLink)}</code></p>
      <p style="color:#6b7280;font-size:13px">If you didn't request this, you can safely ignore this email — your password won't change.</p>
    `),
  }),

  passwordChanged: (to: string, name: string) => ({
    essential: true,
    to,
    subject: 'Your password was changed',
    html: base(`
      <h2 style="color:#4f46e5">Password changed</h2>
      <p>Hi <strong>${escHtml(name)}</strong>, your password was just changed. If this wasn't you, contact your workspace admin immediately.</p>
    `),
  }),

  leaveRequested: (to: string, managerName: string, requesterName: string, leaveTypeName: string, startDate: string, endDate: string, days: number) => ({
    to,
    subject: `Leave request from ${requesterName}`,
    html: base(`
      <h2 style="color:#4f46e5">New leave request</h2>
      <p>Hi <strong>${escHtml(managerName)}</strong>, <strong>${escHtml(requesterName)}</strong> has requested time off.</p>
      ${highlight(`
        <strong>${escHtml(leaveTypeName)}</strong><br/>
        ${escHtml(startDate)} &rarr; ${escHtml(endDate)} (${days} day${days === 1 ? '' : 's'})
      `)}
      <p>Review it from the Leave page in the app.</p>
    `),
  }),

  leaveDecision: (to: string, requesterName: string, leaveTypeName: string, startDate: string, endDate: string, approved: boolean, reason?: string) => ({
    to,
    subject: `Your leave request was ${approved ? 'approved' : 'rejected'}`,
    html: base(`
      <h2 style="color:${approved ? '#16a34a' : '#dc2626'}">Leave request ${approved ? 'approved' : 'rejected'}</h2>
      <p>Hi <strong>${escHtml(requesterName)}</strong>, your <strong>${escHtml(leaveTypeName)}</strong> request for ${escHtml(startDate)} &rarr; ${escHtml(endDate)} was ${approved ? 'approved' : 'rejected'}.</p>
      ${reason ? `<p style="color:#6b7280;font-size:13px">Reason: ${escHtml(reason)}</p>` : ''}
    `, approved ? '#16a34a' : '#dc2626'),
  }),

  wfhRequested: (to: string, managerName: string, requesterName: string, when: string, days: number, reason?: string | null) => ({
    to,
    subject: `Work-from-home request from ${requesterName}`,
    html: base(`
      <h2 style="color:#4f46e5">New work-from-home request</h2>
      <p>Hi <strong>${escHtml(managerName)}</strong>, <strong>${escHtml(requesterName)}</strong> would like to work from home.</p>
      ${highlight(`${escHtml(when)} (${days} day${days === 1 ? '' : 's'})${reason ? `<br/><span style="color:#6b7280">${escHtml(reason)}</span>` : ''}`)}
      <p>Approve or reject it from Leave &rarr; Approvals in the app.</p>
    `),
  }),

  wfhDecision: (to: string, requesterName: string, when: string, approved: boolean, reason?: string) => ({
    to,
    subject: `Your work-from-home request was ${approved ? 'approved' : 'rejected'}`,
    html: base(`
      <h2 style="color:${approved ? '#16a34a' : '#dc2626'}">Work from home ${approved ? 'approved' : 'rejected'}</h2>
      <p>Hi <strong>${escHtml(requesterName)}</strong>, your work-from-home request for ${escHtml(when)} was ${approved ? 'approved' : 'rejected'}.</p>
      ${approved ? '<p style="color:#6b7280;font-size:13px">Check in from the Attendance page as usual — the office location check is skipped on WFH days.</p>' : ''}
      ${reason ? `<p style="color:#6b7280;font-size:13px">Reason: ${escHtml(reason)}</p>` : ''}
    `, approved ? '#16a34a' : '#dc2626'),
  }),

  dealStageChanged: (deal: { title: string; stage: string }, assigneeName: string, assigneeEmail: string) => ({
    to: assigneeEmail,
    subject: `[CRM] Deal moved to ${deal.stage}: ${deal.title}`,
    html: base(`
      <h2 style="color:#7c3aed">Deal Stage Updated</h2>
      <p>Hi <strong>${escHtml(assigneeName)}</strong>, a deal you own has moved stages:</p>
      ${highlight(`<strong>${escHtml(deal.title)}</strong><br/><span style="color:#7c3aed">→ ${escHtml(deal.stage)}</span>`, '#7c3aed')}
    `, '#7c3aed'),
  }),
};
