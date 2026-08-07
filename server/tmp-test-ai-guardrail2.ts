// Standalone verification script for the AI Command Bar entity-classification
// guardrail (server/src/utils/ai.ts). Run with:
//   npx ts-node test-ai-command-guardrail.ts
// from inside the server/ directory (so the relative import below resolves
// and picks up its tsconfig). Does NOT touch the network or DB — it imports
// the real, shipped guardEntityClassification/sanitizeNlCommandFields
// functions and feeds them synthetic "what the LLM returned" inputs,
// including a reproduction of the exact reported bug (a ticket-creation
// command misclassified as `contact`), to prove the guardrail catches and
// corrects it, while leaving legitimate/ambiguous cases untouched.

import { guardEntityClassification, guardAgainstEchoedSample, sanitizeNlCommandFields, type NlCommandResult } from './src/utils/ai';

let pass = 0;
let fail = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  OK   ${label}`); }
  else {
    fail++;
    console.log(`  FAIL ${label}`);
    console.log(`       expected: ${JSON.stringify(expected)}`);
    console.log(`       actual:   ${JSON.stringify(actual)}`);
  }
}

function mk(entity: NlCommandResult['entity'], fields: Record<string, any>, confidence = 80): NlCommandResult {
  return { intent: 'create', entity, fields, confidence, explanation: 'stub' };
}

console.log('\n=== 1. The exact reported bug: ticket command misclassified as contact ===');
{
  const command = 'Create a new ticket about VPN issues';
  // Simulates a bad LLM response that (pre-fix) is exactly what was reported:
  // a ticket-intent command coming back as entity: "contact".
  const badLlmOutput = mk('contact', { name: 'VPN issues' }, 62);
  const result = guardEntityClassification(command, badLlmOutput);
  check('entity corrected to ticket', result.entity, 'ticket');
  check('confidence downgraded (was 62, capped at 55)', result.confidence, 55);
  check('explanation mentions the correction', result.explanation.includes('corrected to "ticket"'), true);
}

console.log('\n=== 2. Reverse case: contact command misclassified as ticket ===');
{
  const command = 'Add a contact named Jane Smith from Acme Corp';
  const badLlmOutput = mk('ticket', { title: 'Jane Smith' }, 58);
  const result = guardEntityClassification(command, badLlmOutput);
  check('entity corrected to contact', result.entity, 'contact');
}

console.log('\n=== 3. Correct classification is left alone (no confidence tampering) ===');
{
  const command = 'Create a new ticket about VPN issues';
  const goodLlmOutput = mk('ticket', { title: 'VPN issues', priority: 'MEDIUM' }, 90);
  const result = guardEntityClassification(command, goodLlmOutput);
  check('entity unchanged', result.entity, 'ticket');
  check('confidence NOT downgraded', result.confidence, 90);
  check('explanation NOT rewritten', result.explanation, 'stub');
}

console.log('\n=== 4. Genuinely ambiguous command (no keyword hits) — trust the model ===');
{
  const command = 'Follow up with them about the thing we discussed';
  const llmOutput = mk('lead', { name: 'them' }, 45);
  const result = guardEntityClassification(command, llmOutput);
  check('entity left as model said (no keyword evidence to override with)', result.entity, 'lead');
  check('confidence untouched', result.confidence, 45);
}

console.log('\n=== 5. Command matches 2+ entities — genuinely ambiguous, trust the model ===');
{
  // Contains both "ticket" and "deal" wording - guardrail should not
  // arbitrarily pick one when there's more than one keyword match.
  const command = 'Create a ticket to follow up on the deal with Acme';
  const llmOutput = mk('deal', { title: 'Acme deal' }, 70);
  const result = guardEntityClassification(command, llmOutput);
  check('entity left as model said (multiple keyword matches)', result.entity, 'deal');
}

console.log('\n=== 6. Lead / Deal / Article — correct classification confirmed for each ===');
{
  const leadCmd = 'New lead from LinkedIn named John Doe';
  const leadOut = mk('lead', { name: 'John Doe', source: 'LinkedIn' }, 88);
  check('lead stays lead', guardEntityClassification(leadCmd, leadOut).entity, 'lead');

  const dealCmd = 'Create a deal with Acme Corp worth $50,000';
  const dealOut = mk('deal', { title: 'Acme Corp deal', value: 50000 }, 88);
  check('deal stays deal', guardEntityClassification(dealCmd, dealOut).entity, 'deal');

  const articleCmd = 'Write a knowledge base article about password resets';
  const articleOut = mk('article', { title: 'Password resets' }, 85);
  check('article stays article', guardEntityClassification(articleCmd, articleOut).entity, 'article');
}

console.log('\n=== 7. Misclassified lead/deal/article also get corrected ===');
{
  const leadCmd = 'New lead from LinkedIn named John Doe';
  const badOut = mk('contact', { name: 'John Doe' }, 60);
  check('lead command wrongly tagged contact -> corrected to lead', guardEntityClassification(leadCmd, badOut).entity, 'lead');

  const articleCmd = 'Publish a how-to guide for VPN setup';
  // Contains both "how-to guide" (article) and "VPN" (ticket) — 2 matches,
  // so this is intentionally ambiguous and should NOT be corrected.
  const ambiguousOut = mk('ticket', { title: 'VPN setup' }, 55);
  check('article/ticket ambiguous wording -> left as model said', guardEntityClassification(articleCmd, ambiguousOut).entity, 'ticket');
}

console.log('\n=== 8. Field sanitization strips fields not valid for the entity ===');
{
  // Simulates exactly the kind of context leakage that caused the original
  // bug: a Contacts-shaped field (`company`) riding along on a ticket.
  const dirty = { title: 'VPN issues', priority: 'HIGH', company: 'Acme Corp', email: 'leaked@example.com' };
  const clean = sanitizeNlCommandFields('ticket', dirty);
  check('only ticket-valid fields survive', clean, { title: 'VPN issues', priority: 'HIGH' });
}

console.log('\n=== 9. Field sanitization on unknown entity returns empty object ===');
{
  check('unknown entity -> no fields forwarded', sanitizeNlCommandFields('unknown', { title: 'x' }), {});
}

console.log('\n=== 10. The NEW reported bug: model echoes prompt sample values verbatim ===');
{
  // User asks about something completely unrelated to VPN, but the model
  // (as reported) returns the prompt's own ticket sample instead of reading
  // the real command.
  const command = 'Create a ticket, my email client keeps crashing on launch';
  const echoedOutput = mk('ticket', { title: 'VPN issues', priority: 'MEDIUM' }, 85);
  const result = guardAgainstEchoedSample(command, echoedOutput);
  check('echoed sample rejected -> fields cleared', result.fields, {});
  check('echoed sample rejected -> confidence forced to 0', result.confidence, 0);
  check('explanation explains the rejection', result.explanation.includes('placeholder sample values'), true);
}

console.log('\n=== 11. Same sample values are legitimate when the command actually says them ===');
{
  const command = 'Create a ticket about VPN issues, priority medium';
  const genuineOutput = mk('ticket', { title: 'VPN issues', priority: 'MEDIUM' }, 90);
  const result = guardAgainstEchoedSample(command, genuineOutput);
  check('genuine VPN command is NOT rejected', result.fields, { title: 'VPN issues', priority: 'MEDIUM' });
  check('confidence untouched', result.confidence, 90);
}

console.log('\n=== 12. Echoed contact/lead/deal samples also caught ===');
{
  const contactCmd = 'Add a contact, her name is Priya Nair, works at Globex';
  const echoedContact = mk('contact', { name: 'Jane Smith', company: 'Acme Corp' }, 80);
  check('echoed contact sample rejected', guardAgainstEchoedSample(contactCmd, echoedContact).fields, {});

  const leadCmd = 'New lead named Priya Nair from our website contact form';
  const echoedLead = mk('lead', { name: 'John Doe', source: 'LinkedIn' }, 80);
  check('echoed lead sample rejected', guardAgainstEchoedSample(leadCmd, echoedLead).fields, {});

  const dealCmd = 'Create a deal with Globex worth $12,000';
  const echoedDeal = mk('deal', { title: 'Acme Corp deal', value: 50000 }, 80);
  check('echoed deal sample rejected', guardAgainstEchoedSample(dealCmd, echoedDeal).fields, {});
}

console.log('\n=== 13. Partial field overlap (not an exact sample match) is left alone ===');
{
  // Title matches the sample but priority differs — not an exact echo, so
  // this should be trusted (the model may have legitimately extracted a
  // different priority even if the title text happens to coincide).
  const command = 'Create a critical ticket, my VPN keeps dropping every 5 minutes';
  const partial = mk('ticket', { title: 'VPN issues', priority: 'CRITICAL' }, 85);
  const result = guardAgainstEchoedSample(command, partial);
  check('command genuinely mentions VPN, so left alone regardless', result.fields, { title: 'VPN issues', priority: 'CRITICAL' });
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
