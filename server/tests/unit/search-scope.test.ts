/**
 * FIX — global search ignored page permissions.
 *
 * /search returned contacts, deals, leads and invoices to every staff role,
 * so an IT agent could find (and read titles / values of) records whose pages
 * answer 403 for them. Each record type now follows its own route's role list,
 * plus the org's product areas as before.
 *
 *     npm run test:unit
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { searchableTypes } from '../../src/modules/core/search/search.controller';

const sorted = (a: string[]) => [...a].sort();

test('IT agents find tickets, articles and assets — no CRM records or invoices', () => {
  assert.deepEqual(sorted(searchableTypes('IT_AGENT', [])), ['article', 'asset', 'ticket']);
});

test('sales reps find CRM records, invoices, tickets and articles — no assets', () => {
  assert.deepEqual(sorted(searchableTypes('SALES_REP', [])), ['article', 'contact', 'deal', 'invoice', 'lead', 'ticket']);
});

test('Super Admin finds everything; switched-off areas are never searched', () => {
  assert.equal(searchableTypes('SUPER_ADMIN', []).length, 7);
  assert.deepEqual(sorted(searchableTypes('SUPER_ADMIN', ['crm', 'sales_docs'])), ['article', 'asset', 'ticket']);
});

test('employees (not on the route) and API keys', () => {
  assert.deepEqual(searchableTypes('EMPLOYEE', []), []);
  assert.equal(searchableTypes('API', []).length, 7);
});
