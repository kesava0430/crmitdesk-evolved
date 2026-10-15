/**
 * TICKET — "No option to update the subject of a ticket".
 *
 * The subject is now edited in place on the ticket header (PATCH
 * /itdesk/tickets/:id with { title }). These pin the validation every
 * create/update goes through, and that the header editor stays wired to it.
 *
 *     npm run test:unit
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeTicketTitle, TICKET_TITLE_MAX } from '../../src/modules/itdesk/tickets/ticketTitle';

const status = (fn: () => unknown) => {
  try { fn(); return 'ok'; } catch (e: any) { return `${e.statusCode}: ${e.message}`; }
};

test('subject is trimmed', () => {
  assert.equal(normalizeTicketTitle('  VPN drops every hour  '), 'VPN drops every hour');
});

test('no title sent leaves it alone (partial update)', () => {
  assert.equal(normalizeTicketTitle(undefined, 'Old'), undefined);
});

test('empty / whitespace-only / non-string subjects are rejected with 400', () => {
  assert.match(status(() => normalizeTicketTitle('')), /^400: Subject cannot be empty/);
  assert.match(status(() => normalizeTicketTitle('   ')), /^400: Subject cannot be empty/);
  assert.match(status(() => normalizeTicketTitle(42)), /^400: Subject must be text/);
});

test('1–200 characters', () => {
  assert.equal(normalizeTicketTitle('x'), 'x');
  assert.equal(normalizeTicketTitle('x'.repeat(TICKET_TITLE_MAX)), 'x'.repeat(TICKET_TITLE_MAX));
  assert.match(status(() => normalizeTicketTitle('x'.repeat(TICKET_TITLE_MAX + 1))), /^400: Subject must be 200 characters or fewer/);
});

test('a legacy over-long subject can be re-saved unchanged, but not changed to another long one', () => {
  const legacy = 'y'.repeat(260);
  assert.equal(normalizeTicketTitle(legacy, legacy), legacy);
  assert.equal(normalizeTicketTitle(` ${legacy} `, legacy), legacy);
  assert.match(status(() => normalizeTicketTitle(legacy + 'z', legacy)), /^400/);
  assert.equal(normalizeTicketTitle('Short now', legacy), 'Short now');
});

test('update() validates the title against the existing ticket and audits the old subject', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/modules/itdesk/tickets/tickets.controller.ts'), 'utf8');
  assert.match(src, /normalizeTicketTitle\(data\.title, existing\.title\)/);
  assert.match(src, /previousTitle: existing\.title/);
  // Org scoping of the lookup the validation depends on.
  assert.match(src, /findFirst\(\{ where: \{ id: req\.params\.id, orgId \} \}\)/);
});

test('ticket header has the inline subject editor, gated like the server route', () => {
  const page = fs.readFileSync(path.join(__dirname, '../../../client/src/modules/itdesk/tickets/TicketsPage.tsx'), 'utf8');
  assert.match(page, /function EditableTicketTitle/);
  assert.match(page, /label="Edit subject"/);
  assert.match(page, /canEditTickets = can\.editTickets\(role\)/);
  assert.match(page, /const TITLE_MAX = 200/);
  const routes = fs.readFileSync(path.join(__dirname, '../../src/modules/itdesk/tickets/tickets.routes.ts'), 'utf8');
  assert.match(routes, /patch\('\/:id',\s+requireRole\(\.\.\.IT_STAFF\)/);
});
