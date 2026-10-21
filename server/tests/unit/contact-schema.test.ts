/**
 * FIX — PATCH /crm/contacts/:id rejected null fields.
 *
 * A contact fetched from the API has null for unset columns; sending it back
 * (AI actions, API integrations) failed the whole update with "source:
 * expected string, received null". null now means "not provided"; '' still
 * clears a field as before.
 *
 *     npm run test:unit
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ContactSchema } from '../../src/modules/crm/contacts/contacts.controller';

test('a fetched contact with null fields round-trips', () => {
  const parsed = ContactSchema.partial().parse({ id: 'c1', name: 'Jane', email: null, phone: null, jobTitle: 'CTO', accountId: null, source: null, dateOfBirth: null, createdAt: '2026-01-01' });
  assert.equal(parsed.jobTitle, 'CTO');
  assert.equal(parsed.source, undefined);
  assert.equal(parsed.accountId, undefined);
});

test('blank values and validation still behave', () => {
  assert.equal(ContactSchema.partial().parse({ source: '' }).source, '');
  assert.throws(() => ContactSchema.partial().parse({ email: 'not-an-email' }));
  assert.throws(() => ContactSchema.parse({ name: '' }));
});
