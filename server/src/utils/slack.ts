import https from 'https';
import { URL } from 'url';
import { prisma } from './prisma';

// ─── Low-level Slack webhook POST ─────────────────────────────────────────────

export async function postToSlack(webhookUrl: string, payload: object): Promise<void> {
  const body = JSON.stringify(payload);
  const parsed = new URL(webhookUrl);

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: parsed.hostname,
        path: parsed.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode === 200 && data === 'ok') resolve();
          else reject(new Error(`Slack webhook error ${res.statusCode}: ${data}`));
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Severity color map ───────────────────────────────────────────────────────

const PRIORITY_COLOR: Record<string, string> = {
  CRITICAL: '#e53e3e',
  HIGH:     '#dd6b20',
  MEDIUM:   '#d69e2e',
  LOW:      '#48bb78',
};

// ─── Named alert senders ──────────────────────────────────────────────────────

export async function slackNewTicket(orgId: string, ticket: {
  id: string; title: string; priority: string; requester?: { name: string } | null;
}) {
  const cfg = await prisma.slackConfig.findUnique({ where: { orgId } });
  if (!cfg || !cfg.notifyOnNewTicket) return;

  const isCritical = ticket.priority === 'CRITICAL';
  if (isCritical && !cfg.notifyOnCritical) return;
  if (!isCritical && !cfg.notifyOnNewTicket) return;

  await postToSlack(cfg.webhookUrl, {
    text: `🎫 New ${ticket.priority} ticket`,
    attachments: [{
      color: PRIORITY_COLOR[ticket.priority] ?? '#718096',
      fields: [
        { title: 'Title', value: ticket.title, short: false },
        { title: 'Priority', value: ticket.priority, short: true },
        { title: 'From', value: ticket.requester?.name ?? 'Unknown', short: true },
      ],
      footer: 'CRM & IT Desk',
      ts: Math.floor(Date.now() / 1000).toString(),
    }],
  }).catch((err) => console.error('[slack] newTicket send error:', err.message));
}

export async function slackSlaBreached(orgId: string, ticket: {
  id: string; title: string; priority: string; slaDueAt: Date | null;
}) {
  const cfg = await prisma.slackConfig.findUnique({ where: { orgId } });
  if (!cfg || !cfg.notifyOnSlaBreached) return;

  await postToSlack(cfg.webhookUrl, {
    text: `⏰ SLA breached`,
    attachments: [{
      color: '#e53e3e',
      fields: [
        { title: 'Ticket', value: ticket.title, short: false },
        { title: 'Priority', value: ticket.priority, short: true },
        { title: 'Due was', value: ticket.slaDueAt?.toISOString() ?? 'N/A', short: true },
      ],
      footer: 'CRM & IT Desk',
      ts: Math.floor(Date.now() / 1000).toString(),
    }],
  }).catch((err) => console.error('[slack] slaBreached send error:', err.message));
}

export async function slackDealWon(orgId: string, deal: {
  title: string; value: number | string; assignee?: { name: string } | null;
}) {
  const cfg = await prisma.slackConfig.findUnique({ where: { orgId } });
  if (!cfg || !cfg.notifyOnDealWon) return;

  await postToSlack(cfg.webhookUrl, {
    text: `🏆 Deal won: *${deal.title}*`,
    attachments: [{
      color: '#48bb78',
      fields: [
        { title: 'Deal', value: deal.title, short: false },
        { title: 'Value', value: `$${Number(deal.value).toLocaleString()}`, short: true },
        { title: 'Closed by', value: deal.assignee?.name ?? 'Unknown', short: true },
      ],
      footer: 'CRM & IT Desk',
      ts: Math.floor(Date.now() / 1000).toString(),
    }],
  }).catch((err) => console.error('[slack] dealWon send error:', err.message));
}

export async function slackNewLead(orgId: string, lead: {
  id: string; contact?: { name: string; email?: string | null } | null; source?: string | null;
}) {
  const cfg = await prisma.slackConfig.findUnique({ where: { orgId } });
  if (!cfg || !cfg.notifyOnNewLead) return;

  await postToSlack(cfg.webhookUrl, {
    text: `🎯 New lead captured`,
    attachments: [{
      color: '#667eea',
      fields: [
        { title: 'Name', value: lead.contact?.name ?? 'Unknown', short: true },
        { title: 'Email', value: lead.contact?.email ?? '—', short: true },
        { title: 'Source', value: lead.source ?? '—', short: true },
      ],
      footer: 'CRM & IT Desk',
      ts: Math.floor(Date.now() / 1000).toString(),
    }],
  }).catch((err) => console.error('[slack] newLead send error:', err.message));
}
