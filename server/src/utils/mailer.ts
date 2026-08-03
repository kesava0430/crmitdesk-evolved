import nodemailer from 'nodemailer';
import { prisma } from './prisma';
import { decryptSecretOrPlain } from './crypto';

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
}

// Render's free web-service tier blocks all outbound SMTP traffic (ports 25,
// 465, 587) — confirmed by the ETIMEDOUT/CONN errors nodemailer throws there
// regardless of which SMTP host you point it at. Resend's HTTP API runs over
// plain HTTPS (443), so it isn't affected. When RESEND_API_KEY is set, it's
// used instead of SMTP entirely; SMTP remains as the fallback for local dev
// or a paid Render plan where outbound SMTP isn't blocked.
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_ADDRESS = process.env.RESEND_FROM || process.env.SMTP_FROM || 'CRM & IT Desk <onboarding@resend.dev>';

async function sendViaResend(opts: MailOptions): Promise<void> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: FROM_ADDRESS, to: opts.to, subject: opts.subject, html: opts.html }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend API ${res.status}: ${body}`);
  }
}

// Lazy transporter — only created when SMTP is configured
function getTransporter() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
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
async function getOrgMailer(orgId: string): Promise<{ transport: nodemailer.Transporter; from: string } | null> {
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

export async function sendMail(opts: MailOptions): Promise<void> {
  if (opts.orgId) {
    try {
      const orgMailer = await getOrgMailer(opts.orgId);
      if (orgMailer) {
        await orgMailer.transport.sendMail({ from: orgMailer.from, to: opts.to, subject: opts.subject, html: opts.html });
        console.log(`[Email sent via org SMTP] To: ${opts.to} | ${opts.subject}`);
        return;
      }
    } catch (err) {
      console.error('[Email error — org SMTP, falling back to platform mailer]', err);
      // fall through to the platform mailer below rather than giving up —
      // a misconfigured org SMTP account shouldn't mean the customer never
      // gets a critical link (portal login, ticket resolution, ...).
    }
  }

  if (RESEND_API_KEY) {
    try {
      await sendViaResend(opts);
      console.log(`[Email sent via Resend] To: ${opts.to} | ${opts.subject}`);
    } catch (err) {
      console.error('[Email error — Resend]', err);
    }
    return;
  }

  const transporter = getTransporter();
  if (!transporter) {
    console.log(`[Email skipped — no RESEND_API_KEY or SMTP configured] To: ${opts.to} | ${opts.subject}`);
    return;
  }
  try {
    await transporter.sendMail({ from: FROM_ADDRESS, ...opts });
    console.log(`[Email sent via SMTP] To: ${opts.to} | ${opts.subject}`);
  } catch (err) {
    console.error('[Email error — SMTP]', err);
  }
}

// ─── Reusable HTML templates ─────────────────────────────────────────────────

const base = (content: string, color = '#4f46e5') => `
  <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#111">
    ${content}
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:32px 0"/>
    <p style="font-size:12px;color:#9ca3af">CRM & IT Desk — you're receiving this because you're a member of your organization.</p>
  </div>
`;

const highlight = (text: string, color = '#4f46e5') => `
  <div style="background:#f5f3ff;border-left:4px solid ${color};padding:12px 16px;margin:16px 0;border-radius:4px">
    ${text}
  </div>
`;

const btn = (href: string, label: string, color = '#4f46e5') =>
  `<a href="${href}" style="display:inline-block;background:${color};color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;margin:16px 0">${label}</a>`;

export const emailTemplates = {
  invite: (to: string, orgName: string, role: string, link: string) => ({
    to,
    subject: `You've been invited to join ${orgName}`,
    html: base(`
      <h2 style="color:#4f46e5">You're invited!</h2>
      <p>You've been invited to join <strong>${orgName}</strong> as a <strong>${role.replace(/_/g, ' ')}</strong>.</p>
      <p>Click below to set up your account. This link expires in 7 days.</p>
      ${btn(link, 'Accept Invitation')}
      <p style="color:#6b7280;font-size:13px">Or copy this link: <code>${link}</code></p>
    `),
  }),

  ticketCreated: (ticket: { title: string }, requesterName: string, assigneeEmail: string) => ({
    to: assigneeEmail,
    subject: `[Ticket] New: ${ticket.title}`,
    html: base(`
      <h2 style="color:#2563eb">New Ticket Submitted</h2>
      <p><strong>${requesterName}</strong> submitted a new support ticket:</p>
      ${highlight(`<strong>${ticket.title}</strong>`, '#2563eb')}
      <p>Log in to view and respond to this ticket.</p>
    `, '#2563eb'),
  }),

  ticketAssigned: (ticket: { title: string }, assigneeName: string, assigneeEmail: string) => ({
    to: assigneeEmail,
    subject: `[Ticket] Assigned to you: ${ticket.title}`,
    html: base(`
      <h2 style="color:#2563eb">Ticket Assigned to You</h2>
      <p>Hi <strong>${assigneeName}</strong>, a ticket has been assigned to you:</p>
      ${highlight(`<strong>${ticket.title}</strong>`, '#2563eb')}
      <p>Log in to view and start working on it.</p>
    `, '#2563eb'),
  }),

  ticketResolved: (ticket: { title: string }, requesterName: string, requesterEmail: string) => ({
    to: requesterEmail,
    subject: `[Ticket] Resolved: ${ticket.title}`,
    html: base(`
      <h2 style="color:#16a34a">Your Ticket Has Been Resolved</h2>
      <p>Hi <strong>${requesterName}</strong>, your ticket has been resolved:</p>
      ${highlight(`<strong>${ticket.title}</strong>`, '#16a34a')}
      <p>If you need further help, please submit a new ticket.</p>
    `, '#16a34a'),
  }),

  ticketStatusChanged: (ticket: { title: string }, status: string, requesterName: string, requesterEmail: string) => ({
    to: requesterEmail,
    subject: `[Ticket] Status update: ${ticket.title}`,
    html: base(`
      <h2 style="color:#d97706">Ticket Status Updated</h2>
      <p>Hi <strong>${requesterName}</strong>, your ticket status has changed to <strong>${status.replace(/_/g, ' ')}</strong>:</p>
      ${highlight(`<strong>${ticket.title}</strong>`, '#d97706')}
    `, '#d97706'),
  }),

  csatSurvey: (ticket: { id: string; title: string }, requesterName: string, requesterEmail: string) => {
    const base_url = process.env.APP_URL || 'http://localhost:5173';
    const link = `${base_url}/api/csat/submit/${ticket.id}`;
    return {
      to: requesterEmail,
      subject: `How did we do? Rate your support experience`,
      html: base(`
        <h2 style="color:#4f46e5">How was your experience?</h2>
        <p>Hi <strong>${requesterName}</strong>, we recently resolved your ticket:</p>
        ${highlight(`<strong>${ticket.title}</strong>`, '#4f46e5')}
        <p>We'd love your feedback! Click a star below to rate your experience:</p>
        <div style="text-align:center;margin:24px 0;font-size:36px">
          ${[1,2,3,4,5].map(r => `<a href="${link}?rating=${r}&via=email" style="text-decoration:none;margin:0 4px">⭐</a>`).join('')}
        </div>
        <p style="color:#6b7280;font-size:12px">You can also <a href="${link}">submit feedback with a comment</a>.</p>
      `),
    };
  },

  orgSignupRequest: (adminEmail: string, req: { organizationName: string; name: string; email: string }, approveLink: string) => ({
    to: adminEmail,
    subject: `New org signup request: ${req.organizationName}`,
    html: base(`
      <h2 style="color:#4f46e5">New Organization Signup Request</h2>
      <p>Someone just requested a new workspace:</p>
      ${highlight(`
        <strong>${req.organizationName}</strong><br/>
        ${req.name} &lt;${req.email}&gt;
      `)}
      <p>Nothing has been created yet — review and approve (or reject) below.</p>
      ${btn(approveLink, 'Review request')}
      <p style="color:#6b7280;font-size:13px">Or copy this link: <code>${approveLink}</code></p>
    `),
  }),

  orgSignupApproved: (requesterEmail: string, requesterName: string, orgName: string, loginLink: string) => ({
    to: requesterEmail,
    subject: `You're approved — ${orgName} is ready`,
    html: base(`
      <h2 style="color:#16a34a">You're approved!</h2>
      <p>Hi <strong>${requesterName}</strong>, your workspace <strong>${orgName}</strong> has been approved.</p>
      <p>You can log in now with the email and password you signed up with.</p>
      ${btn(loginLink, 'Log in', '#16a34a')}
    `, '#16a34a'),
  }),

  dealStageChanged: (deal: { title: string; stage: string }, assigneeName: string, assigneeEmail: string) => ({
    to: assigneeEmail,
    subject: `[CRM] Deal moved to ${deal.stage}: ${deal.title}`,
    html: base(`
      <h2 style="color:#7c3aed">Deal Stage Updated</h2>
      <p>Hi <strong>${assigneeName}</strong>, a deal you own has moved stages:</p>
      ${highlight(`<strong>${deal.title}</strong><br/><span style="color:#7c3aed">→ ${deal.stage}</span>`, '#7c3aed')}
    `, '#7c3aed'),
  }),
};
