/**
 * FIX — saving a salary component with a bad formula answered 500.
 *
 * assertValidFormula() let the formula parser's plain Error escape, which the
 * error handler reports as "Internal server error". It now raises a 400 that
 * names the problem, so the Salary components / employee salary forms can
 * show it (tests/e2e/payroll-config.spec.ts expects 400).
 *
 *     npm run test:unit
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertValidFormula } from '../../src/utils/payrollEngine';

const comps = [{ code: 'BASIC' }, { code: 'HRA' }];
const status = (f: string) => { try { assertValidFormula(f, comps); return 'ok'; } catch (e: any) { return `${e.statusCode}: ${e.message}`; } };

test('unknown names → 400 naming them', () => {
  assert.equal(status('NOPE * 2'), '400: Invalid formula — Unknown name(s): NOPE');
});

test('syntax errors → 400', () => {
  assert.match(status('BASIC * * 2'), /^400: Invalid formula — /);
  assert.match(status('   '), /^400: Invalid formula — Formula is empty/);
});

test('valid formulas still pass', () => {
  assert.equal(status('BASIC * 0.1'), 'ok');
  assert.equal(status('if(WORKING_DAYS > 0, HRA / WORKING_DAYS * LOP_DAYS, 0)'), 'ok');
});
