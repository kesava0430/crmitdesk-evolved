/**
 * FIX — Org Branding "Save" did nothing for orgs with an unset branding field.
 *
 * BrandingPage seeds its form from GET /branding, where unset columns are
 * null, and posts the form back as-is; the schema rejected null
 * ("companyName: expected string, received null"), so the save 400'd and the
 * page showed no change (repo e2e branding.spec.ts). null now means "not
 * provided", like ''.
 *
 *     npm run test:unit
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { BrandingSchema } from '../../src/modules/branding/branding.controller';

test('a GET /branding row with null columns posts back cleanly', () => {
  const row = { id: 'b1', orgId: 'o1', logoUrl: null, faviconUrl: null, companyName: null, primaryColor: '#3b82f6', supportEmail: null, portalTitle: 'Support Portal', portalWelcome: null, createdAt: '2026-01-01' };
  const parsed = JSON.parse(JSON.stringify(BrandingSchema.parse(row))); // undefined = leave the column as is
  assert.deepEqual(parsed, { primaryColor: '#3b82f6', portalTitle: 'Support Portal' });
});

test('real values and validation still apply', () => {
  assert.equal(BrandingSchema.parse({ companyName: 'Acme', logoUrl: 'https://x.example/l.png' }).companyName, 'Acme');
  assert.throws(() => BrandingSchema.parse({ logoUrl: 'not a url' }));
  assert.throws(() => BrandingSchema.parse({ primaryColor: 'blue' }));
  assert.equal(BrandingSchema.parse({ primaryColor: null }).primaryColor, '#2563eb');
});
