#!/usr/bin/env node
/**
 * CI gate: fail on HIGH/CRITICAL advisories in production dependencies,
 * except advisories listed below with an expiry date.
 *
 * Why an allowlist at all: some advisories have no fix inside the major
 * version we use (e.g. zod 3.x), and the upgrade is a planned piece of work.
 * Without this, one new advisory blocks every deploy — including security
 * fixes. Each entry MUST say why the risk is acceptable meanwhile and MUST
 * expire; an expired entry fails the build again so it can't be forgotten.
 */
import { execSync } from 'node:child_process';

const ALLOW = [
  {
    id: 'GHSA-mrhx-c7xc-m3w5', // zod <4.6.6: memory exhaustion validating oversized constrained collections
    until: '2026-11-30',
    why: 'No zod 3.x fix; zod 4 + openai upgrade planned. Request bodies are capped (1 MB, 3 MB for payslip templates), bounding collection sizes.',
  },
];

let raw;
try { raw = execSync('npm audit --omit=dev --json', { encoding: 'utf8', maxBuffer: 64 << 20 }); }
catch (e) { raw = e.stdout; } // npm audit exits non-zero when it finds anything
const report = JSON.parse(raw);
const today = new Date().toISOString().slice(0, 10);
const allowed = new Map(ALLOW.filter(a => a.until >= today).map(a => [a.id, a]));
for (const a of ALLOW) if (a.until < today) console.log(`::warning::Audit allowlist entry ${a.id} expired on ${a.until} — it now fails the build.`);

// Walk "via" chains down to concrete advisories, so a package that is only
// vulnerable through an allowed advisory (e.g. openai → zod) is allowed too.
const vulns = report.vulnerabilities || {};
const advisoriesOf = (name, seen = new Set()) => {
  if (seen.has(name)) return [];
  seen.add(name);
  return (vulns[name]?.via || []).flatMap(v => typeof v === 'string' ? advisoriesOf(v, seen) : [v]);
};

const blocking = [];
for (const [name, v] of Object.entries(vulns)) {
  if (!['high', 'critical'].includes(v.severity)) continue;
  const advs = advisoriesOf(name).filter(a => ['high', 'critical'].includes(a.severity));
  const notAllowed = advs.filter(a => !allowed.has(String(a.url || '').split('/').pop()));
  if (notAllowed.length || !advs.length) blocking.push(`${name} (${v.severity}): ${notAllowed.map(a => a.url).join(' ') || 'see npm audit'}`);
  else console.log(`allowed until ${allowed.get(String(advs[0].url).split('/').pop()).until}: ${name} — ${advs.map(a => a.url).join(' ')}`);
}

if (blocking.length) {
  console.error('High/critical advisories in production dependencies:\n  ' + blocking.join('\n  '));
  process.exit(1);
}
console.log('Production dependency audit passed.');
