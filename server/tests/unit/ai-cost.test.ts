import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { searchNeedsAi, pickRelevant, DEFAULT_SMART_FEATURES, DETERMINISTIC_FEATURES, tierFor } from '../../src/utils/ai';
import { costOf, groqPriceFor } from '../../src/utils/aiGateway';
import { actionMenuForPrompt } from '../../src/utils/ai-actions';

/** Every `feature: '…'` label actually used by a call site in utils/ai.ts. */
function usedFeatureLabels(): Set<string> {
  const src = fs.readFileSync(path.join(__dirname, '../../src/utils/ai.ts'), 'utf8');
  return new Set([...src.matchAll(/feature: '([a-zA-Z.]+)'/g)].map(m => m[1]));
}

test('search: names and numbers skip the AI interpreter', () => {
  for (const q of ['acme', 'INV-0042', 'priya sharma', 'ab', 'john@acme.com']) {
    assert.equal(searchNeedsAi(q), false, q);
  }
});

test('search: sentence-like queries use the AI interpreter', () => {
  for (const q of ['open tickets vpn', 'deals won', 'critical tickets', 'printer not printing on floor two', 'overdue invoices']) {
    assert.equal(searchNeedsAi(q), true, q);
  }
});

test('tier routing: only long-form/high-stakes features use the large model', () => {
  assert.deepEqual([...DEFAULT_SMART_FEATURES].sort(), ['meeting.notes', 'solution.builder', 'ticket.kbArticle']);
  assert.equal(tierFor('ticket.reply', 'x'), 'FAST');
  assert.equal(tierFor('invoice.reminder', 'x'), 'FAST');
  assert.equal(tierFor('command.plan', 'x'), 'FAST');
  assert.equal(tierFor('ticket.kbArticle', 'x'), 'SMART');
});

test('routing and cache lists only name features that exist', () => {
  const used = usedFeatureLabels();
  for (const f of DEFAULT_SMART_FEATURES) assert.ok(used.has(f), `SMART list names unknown feature ${f}`);
  for (const f of DETERMINISTIC_FEATURES) assert.ok(used.has(f), `cache list names unknown feature ${f}`);
});

test('cost: cached prompt tokens are billed at half the input price', () => {
  const price = { inputCostPer1k: 0.1, outputCostPer1k: 0.4 };
  assert.equal(costOf(price, 1000, 0), 0.1);
  assert.ok(Math.abs(costOf(price, 1000, 0, 1000) - 0.05) < 1e-12);
  assert.ok(Math.abs(costOf(price, 2000, 1000, 1000) - (0.1 + 0.05 + 0.4)) < 1e-12);
  // A bogus cached count can't exceed the prompt or go negative.
  assert.ok(Math.abs(costOf(price, 1000, 0, 5000) - 0.05) < 1e-12);
  assert.equal(costOf(price, 1000, 0, -10), 0.1);
});

test('cost: Groq models are priced by default, env still overrides', () => {
  delete process.env.GROQ_INPUT_COST_PER_1K; delete process.env.GROQ_OUTPUT_COST_PER_1K;
  assert.deepEqual(groqPriceFor('openai/gpt-oss-20b'), { inputCostPer1k: 0.000075, outputCostPer1k: 0.0003 });
  assert.deepEqual(groqPriceFor('openai/gpt-oss-120b'), { inputCostPer1k: 0.00015, outputCostPer1k: 0.0006 });
  assert.deepEqual(groqPriceFor('some/unknown'), { inputCostPer1k: 0, outputCostPer1k: 0 });
  process.env.GROQ_INPUT_COST_PER_1K = '0.001';
  assert.equal(groqPriceFor('openai/gpt-oss-20b').inputCostPer1k, 0.001);
  delete process.env.GROQ_INPUT_COST_PER_1K;
});

test('planner context: keeps named records plus the newest few', () => {
  const deals = Array.from({ length: 25 }, (_, i) => ({ id: `d${i}`, title: `Deal ${i}` }));
  deals[20] = { id: 'kia', title: 'Kia EV6 fleet' };
  const out = pickRelevant(deals, d => d.title, 'move the kia fleet deal to won', 5);
  assert.equal(out[0].id, 'kia');
  assert.equal(out.length, 6);
  assert.deepEqual(out.slice(1).map(d => d.id), ['d0', 'd1', 'd2', 'd3', 'd4']);
});

test('planner context: matches people by first name, small lists pass through', () => {
  const users = [{ name: 'Priya Sharma' }, { name: 'Ravi Kumar' }, { name: 'Anil Rao' }];
  assert.equal(pickRelevant(users, u => u.name, "approve priya's leave", 0)[0].name, 'Priya Sharma');
  assert.equal(pickRelevant(users, u => u.name, 'anything', 5).length, 3);
  // Generic words ("ticket", "the") never count as a match.
  const tickets = [{ title: 'The ticket printer' }, { title: 'VPN down' }];
  assert.deepEqual(pickRelevant(tickets, t => t.title, 'close the ticket', 0), []);
});

test('planner menu: filtered to the caller role', () => {
  const all = actionMenuForPrompt();
  const agent = actionMenuForPrompt('IT_AGENT');
  assert.ok(agent.length > 0 && agent.length < all.length);
  assert.ok(agent.every(a => all.some(b => b.name === a.name)));
  assert.equal(actionMenuForPrompt('SUPER_ADMIN').length, all.length);
});
