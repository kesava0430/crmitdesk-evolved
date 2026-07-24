import nodemailer from 'nodemailer';

interface MailOptions {
  to: string;
  subject: string;
  html: string;
}

// Lazy transporter — only created when SMTP is configured
function getTransporter() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

export async function sendMail(opts: MailOptions): Promise<void> {
  const transporter = getTransporter();
  if (!transporter) {
    console.log(`[Email skipped — no SMTP] To: ${opts.to} | ${opts.subject}`);
    return;
  }
  try {
    const from = process.env.SMTP_FROM || `"CRM & IT Desk" <${process.env.SMTP_USER}>`;
    await transporter.sendMail({ from, ...opts });
    console.log(`[Email sent] To: ${opts.to} | ${opts.subject}`);
  } catch (err) {
    console.error('[Email error]', err);
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
