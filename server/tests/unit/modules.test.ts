/**
 * Product areas / modules switched per org by the platform operator
 * (utils/modules.ts, utils/licensing.ts evaluateLicense, utils/pricing.ts
 * mergePlanFeatures). All pure.
 *
 *     npm run test:unit
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateLicense, applyModuleRules, featureNotIncludedMessage, type SubRow } from '../../src/utils/licensing';
import { mergePricing, DEFAULT_PRICING } from '../../src/utils/pricing';
import { LEGACY_FEATURE_KEYS, FEATURE_KEYS, type FeatureKey } from '../../src/utils/stripe';
import {
  applyAreaChanges, moduleForRoute, MODULE_CATALOGUE, AREAS, areaModuleKeys, disabledAreas, WORKFLOW_TRIGGER_MODULE,
} from '../../src/utils/modules';
import { isActionAvailable, actionBlockedReason, AI_ACTIONS } from '../../src/utils/ai-actions';

const NOW = new Date('2026-10-16T12:00:00Z');
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);
const AREA_KEYS: FeatureKey[] = ['crm', 'sales_docs', 'itdesk', 'assets', 'knowledge_base'];

function sub(over: Partial<SubRow> = {}): SubRow {
  return {
    orgId: 'org1', plan: 'PRO', status: 'active', seats: 25, features: [], interval: 'month',
    currentPeriodEnd: days(20), graceUntil: null, cancelAtPeriodEnd: false, storageQuotaOverrideGb: null,
    stripeSubscriptionId: 'sub_1', ...over,
  };
}
const legacyOnly = (fs: readonly string[]) => fs.filter(f => (LEGACY_FEATURE_KEYS as readonly string[]).includes(f)).sort();

// What every plan granted (legacy keys) before the catalogue existed — frozen here on purpose.
const BEFORE: Record<string, string[]> = {
  FREE: ['api_access', 'attendance', 'campaigns', 'custom_modules', 'hr_core', 'payroll'],
  PRO: ['advanced_analytics', 'ai_advanced', 'api_access', 'attendance', 'campaigns', 'custom_modules', 'customer_portal', 'hr_core', 'payroll', 'workflow_automation'],
  ENTERPRISE: ['advanced_analytics', 'ai_advanced', 'api_access', 'attendance', 'campaigns', 'custom_branding', 'custom_modules', 'customer_portal', 'directory_sync', 'hr_core', 'payroll', 'sso', 'workflow_automation'],
};

// ─── Backward compatibility ──────────────────────────────────────────────────

test('new area keys change nothing for existing orgs: every plan, every payment state', () => {
  for (const plan of ['FREE', 'PRO', 'ENTERPRISE'] as const) {
    for (const status of ['active', 'past_due', 'canceled']) {
      const lic = evaluateLicense(sub({ plan, status, lastPaymentFailedAt: days(-1), stripeSubscriptionId: plan === 'FREE' ? null : 'sub_1' }), NOW);
      const expected = lic.effectivePlan === 'FREE' ? BEFORE.FREE : BEFORE[plan];
      assert.deepEqual(legacyOnly(lic.features), expected, `${plan}/${status}`);
      for (const k of AREA_KEYS) assert.ok(lic.features.includes(k), `${plan}/${status} keeps ${k}`);
      assert.deepEqual(lic.disabledFeatures, []);
      assert.deepEqual(lic.blockedModules, [], `${plan}/${status} has no module blocked`);
    }
  }
  // A CUSTOM licence keeps CRM / IT Desk via its base areas.
  const custom = evaluateLicense(sub({ plan: 'CUSTOM', features: ['workflow_automation'] }), NOW);
  for (const k of AREA_KEYS) assert.ok(custom.features.includes(k));
});

test('a saved plan mapping that predates the new keys treats them as included', () => {
  // Exactly what an operator saved before this release: legacy keys only, no planFeaturesKeys.
  const saved = mergePricing({ planFeatures: {
    FREE: ['hr_core', 'attendance'], PRO: ['hr_core', 'ai_advanced'], ENTERPRISE: ['sso'], CUSTOM: [],
  } });
  for (const p of ['FREE', 'PRO', 'ENTERPRISE', 'CUSTOM'] as const) {
    for (const k of AREA_KEYS) assert.ok(saved.planFeatures[p].includes(k), `${p} includes ${k}`);
  }
  assert.deepEqual(legacyOnly(saved.planFeatures.FREE), ['attendance', 'hr_core'], 'legacy keys still follow the saved list exactly');
  assert.ok(!saved.planFeatures.PRO.includes('payroll'));
  const lic = evaluateLicense(sub({ plan: 'FREE', stripeSubscriptionId: null }), NOW, saved);
  assert.ok(lic.features.includes('crm') && lic.features.includes('itdesk'));
  assert.deepEqual(lic.blockedModules, [], 'payroll missing from the plan is upgrade-locked, not blocked (as before)');
});

test('a mapping saved with planFeaturesKeys can exclude a new key', () => {
  const cfg = mergePricing({ planFeatures: { FREE: ['hr_core'] }, planFeaturesKeys: [...FEATURE_KEYS] });
  assert.deepEqual(cfg.planFeatures.FREE, ['hr_core']);
  assert.ok(cfg.planFeatures.PRO.includes('crm'), 'plans not in the override keep defaults');
  const lic = evaluateLicense(sub({ plan: 'FREE', stripeSubscriptionId: null }), NOW, cfg);
  assert.ok(!lic.features.includes('crm'));
  assert.ok(lic.blockedModules.includes('crm') && lic.blockedModules.includes('itdesk'), 'a new area key missing from the plan blocks the module');
});

test('defaults: every plan includes every area key', () => {
  for (const p of ['FREE', 'PRO', 'ENTERPRISE', 'CUSTOM'] as const) {
    for (const k of AREA_KEYS) assert.ok(DEFAULT_PRICING.planFeatures[p].includes(k));
  }
});

// ─── Effective = (plan ∪ extra) − disabled ───────────────────────────────────

test('disabled features come off in every payment state; extras still add', () => {
  const over = { disabledFeatures: ['payroll', 'not_a_key'], extraFeatures: ['sso'] };
  for (const status of ['active', 'past_due', 'canceled']) {
    const lic = evaluateLicense(sub({ ...over, status, lastPaymentFailedAt: days(-1) }), NOW);
    assert.ok(!lic.features.includes('payroll'), status);
    assert.ok(lic.features.includes('sso'), `${status}: extraFeatures still apply`);
    assert.deepEqual(lic.disabledFeatures, ['payroll']);
    assert.ok(lic.blockedModules.includes('payroll'));
  }
});

test('disabled wins over a forced-on extra feature', () => {
  const lic = evaluateLicense(sub({ plan: 'FREE', stripeSubscriptionId: null, extraFeatures: ['customer_portal'], disabledFeatures: ['customer_portal'] }), NOW);
  assert.ok(!lic.features.includes('customer_portal'));
});

test('force-enable a plan-lacking module on FREE', () => {
  const lic = evaluateLicense(sub({ plan: 'FREE', stripeSubscriptionId: null, extraFeatures: ['customer_portal'] }), NOW);
  assert.ok(lic.features.includes('customer_portal'));
  assert.ok(!lic.blockedModules.includes('customer_portal'));
});

test('area off takes every sub-module with it, even paid ones', () => {
  const lic = evaluateLicense(sub({ disabledFeatures: ['itdesk'] }), NOW);
  for (const k of areaModuleKeys('itdesk')) {
    assert.ok(!lic.features.includes(k), k);
    assert.ok(lic.blockedModules.includes(k), k);
  }
  assert.ok(lic.features.includes('crm') && lic.features.includes('hr_core'));
  const hrOff = evaluateLicense(sub({ disabledFeatures: ['hr_core'] }), NOW);
  assert.ok(!hrOff.features.includes('attendance') && !hrOff.features.includes('payroll'));
});

test('area on is ANDed with the plan: the portal still needs a plan that has it', () => {
  const free = evaluateLicense(sub({ plan: 'FREE', stripeSubscriptionId: null }), NOW);
  assert.ok(!free.features.includes('customer_portal'));
  assert.ok(!free.blockedModules.includes('customer_portal'), 'not blocked — just not in the plan (lock, not hidden)');
});

test('applyModuleRules is pure and ignores legacy keys missing from the plan', () => {
  const r = applyModuleRules(['crm', 'itdesk', 'sales_docs', 'assets', 'knowledge_base'], []);
  assert.deepEqual(r.blockedModules, []);
  assert.ok(!r.features.includes('hr_core'));
});

// ─── Area switching ──────────────────────────────────────────────────────────

test('applyAreaChanges: off / on / sub-modules / last area', () => {
  let d = applyAreaChanges([], { areas: { itdesk: false } });
  assert.deepEqual(disabledAreas(d), ['itdesk']);
  d = applyAreaChanges(d, { modules: { payroll: false } });
  assert.ok(d.includes('payroll'));
  d = applyAreaChanges([...d, 'assets'], { areas: { itdesk: true } });
  assert.ok(!d.includes('itdesk') && !d.includes('assets'), 'area on brings back all its sub-modules');
  assert.ok(d.includes('payroll'), 'other areas untouched');
  d = applyAreaChanges(['hr_core', 'attendance'], { modules: { attendance: true } });
  assert.ok(!d.includes('hr_core') && !d.includes('attendance'), 'switching a sub-module on switches its area on');
  assert.throws(() => applyAreaChanges(['hr_core', 'crm'], { areas: { itdesk: false } }), /at least one area/);
  assert.deepEqual(applyAreaChanges(['sso'], { areas: { crm: false } }).sort(), ['crm', 'sso'], 'non-catalogue keys kept');
});

test('catalogue: every module is a feature key in an area; routes resolve', () => {
  for (const m of MODULE_CATALOGUE) {
    assert.ok((FEATURE_KEYS as readonly string[]).includes(m.key), m.key);
    assert.ok(AREAS.some(a => a.key === m.area));
  }
  for (const a of AREAS) assert.ok(areaModuleKeys(a.key).includes(a.root));
  assert.equal(moduleForRoute('/itdesk/tickets/abc')?.key, 'itdesk');
  assert.equal(moduleForRoute('/itdesk/assets')?.key, 'assets');
  assert.equal(moduleForRoute('/hr/payroll/payslips/1/print')?.key, 'payroll');
  assert.equal(moduleForRoute('/dashboard'), undefined);
  assert.equal(moduleForRoute('/crmx'), undefined);
  for (const k of Object.values(WORKFLOW_TRIGGER_MODULE)) assert.ok(MODULE_CATALOGUE.some(m => m.key === k));
});

// ─── Messages and AI ─────────────────────────────────────────────────────────

test('402 wording distinguishes switched-off from not-in-plan', () => {
  const off = evaluateLicense(sub({ disabledFeatures: ['itdesk'] }), NOW);
  assert.match(featureNotIncludedMessage(off, 'itdesk'), /switched off by your service provider/);
  assert.match(featureNotIncludedMessage(off, 'assets'), /IT Desk area, which isn't enabled/);
  const free = evaluateLicense(sub({ plan: 'FREE', stripeSubscriptionId: null }), NOW);
  assert.match(featureNotIncludedMessage(free, 'customer_portal'), /isn't included in your Free plan/);
});

test('AI actions on a switched-off area are not offered or runnable', () => {
  assert.ok(!isActionAvailable('CREATE_TICKET', ['itdesk']));
  assert.ok(isActionAvailable('CREATE_LEAD', ['itdesk']));
  assert.ok(isActionAvailable('ADD_NOTE', ['itdesk']), 'multi-type action stays while CRM is on');
  assert.ok(!isActionAvailable('ADD_NOTE', ['itdesk', 'crm']));
  assert.ok(actionBlockedReason('ADD_NOTE', { entityType: 'TICKET' }, ['itdesk']));
  assert.equal(actionBlockedReason('ADD_NOTE', { entityType: 'DEAL' }, ['itdesk']), null);
  assert.ok(isActionAvailable('TOGGLE_WORKFLOW_RULE', ['itdesk', 'crm', 'hr_core']), 'shared actions are not area switched');
  const names = AI_ACTIONS.map(a => a.name);
  assert.ok(names.includes('CREATE_TICKET') && names.includes('MANUAL_ATTENDANCE_ENTRY'));
});
