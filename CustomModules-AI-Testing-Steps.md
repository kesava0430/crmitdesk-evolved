# Testing: custom modules in nav + expanded AI actions

Covers the three changes just made:

1. Custom modules appear as their own left-nav entries with a records page
2. New AI registry actions for building/filling custom modules
3. New AI registry actions for assigning tickets and changing lead status

Written for the real deployment (Netlify frontend + Render backend), since the AI features need a live API key and the nav needs real module data.

---

## 0. Prerequisites — check these before anything else

**Build check (most important).** These changes were written without a compiler available, so the first real validation is the Render deploy log:

- Push the changes and watch the Render deploy for `crm-itdesk-server`. Confirm `tsc` completes with no errors.
- Watch the Netlify build too — the client changes (new page, shared component, nav injection) are where a type error is most likely to surface.
- A TS error here is expected-ish and easy to fix; don't proceed to functional testing until both builds are green.

**AI configuration.** The AI Command Bar needs a key on the Render service:

| Variable | Notes |
|---|---|
| `GROQ_API_KEY` | Preferred — the code checks this first (`utils/ai.ts` `getClient()`), uses `llama-3.1-8b-instant` |
| `OPENAI_API_KEY` | Fallback if no Groq key, uses `gpt-4o-mini` |

If neither is set, every AI command returns "AI not configured" and sections 3-5 below can't be tested at all. Check Render → Environment before spending time debugging.

**Test account roles.** You'll need to log in as more than one role to check gating properly:

- A `SUPER_ADMIN` or `CRM_MANAGER` — can create modules/fields (`CRM_MANAGERS`)
- An `IT_AGENT` or `SALES_REP` — staff who can add records but not build modules (`ALL_STAFF`)
- An `EMPLOYEE` — should be blocked from module record actions entirely

---

## 1. Custom modules in the left nav

1. Log in as `SUPER_ADMIN`/`CRM_MANAGER`. Go to **Admin → Custom Modules**.
2. Create a module, e.g. "Vendor Contracts".
3. **Before adding any fields**, look at the sidebar — the module should **not** appear yet (a fieldless module is deliberately hidden; it has nothing to show).
4. Add a field (e.g. "Vendor Name", Text, tick "Use as record title"). Refresh.
5. The sidebar should now show a **Modules** section at the bottom with a "Vendor Contracts" entry.
6. Click it — lands on `/modules/vendor-contracts`, showing the module name as the page title and an empty records table.
7. Click **Add Record**, fill the field, save. The record appears in the table.
8. Click **Manage fields & sync** (top right) — should jump to the builder page with *this* module already selected (not whichever one is first). This is the `?module=<id>` deep link.
9. Create a second module with fields, confirm both appear in the nav.
10. Delete one module from the builder, refresh — its nav entry disappears.

### Role checks for the nav

- Log in as an `IT_AGENT` or `SALES_REP`: they should **see** the Modules nav entries and be able to view/add/edit records, but **not** see the "Manage fields & sync" button, and **not** see "Custom Modules" under Admin.
- Log in as an `EMPLOYEE`: the records API is `ALL_STAFF`-gated server-side, so expect the page to fail its data load. Worth confirming what they actually see — if it's an ugly error rather than a clean "no access", that's a UX gap worth fixing (not a security hole; the API still rejects them).

### Edge cases

- Visit `/modules/not-a-real-slug` directly → should show a clean "Module not found" empty state, not a crash.
- Deactivate a module (if the UI exposes it) → nav entry should disappear.
- A module with 6+ fields → the records table caps visible columns at 5; the rest still show in the edit modal.

---

## 2. Custom module records — regression check

The records table/form was **extracted into a shared component** and is now used in two places. Confirm the original still works:

1. Go back to **Admin → Custom Modules → Records tab**.
2. Add, edit, and delete a record there. All three should behave exactly as before.
3. Confirm the record you added from `/modules/:slug` in section 1 shows up here too (same data, same table).

This is the change most likely to have broken something silently, since it touched working code.

---

## 3. AI: build a custom module by instruction

Open the AI Command Bar with **Cmd+K / Ctrl+K** (or the Ask AI button). Logged in as `SUPER_ADMIN`/`CRM_MANAGER`:

1. Type: **"Create a module called Warranty Claims"**
   - Expect a confirm card labelled *Create a custom module*, with the name in the params.
   - Click **Confirm & Run** → success message. Check Custom Modules — the module exists.
2. Type: **"Add a Claim Amount currency field to Warranty Claims"**
   - Expect *Add a field to a custom module*, with `moduleId` resolved to the real module (not a made-up id) and `fieldType: CURRENCY`.
   - Confirm → check the Fields tab, the field is there with key `claim_amount`.
3. Add a couple more fields the same way — try a dropdown: **"Add a Status dropdown field to Warranty Claims with options Open, Approved, Rejected"**. Confirm the options save correctly.
4. Type: **"Add a Warranty Claims record with claim amount 5000 and status Open"**
   - Expect *Create a custom module record* with a `data` object keyed by the real fieldKeys.
   - Confirm → the record appears in the module's records table and in its nav page.

### What to watch for

- **Invented IDs or field keys.** The planner is given the org's real modules and their fieldKeys as context and told never to invent one. If it does anyway, the server-side handler rejects it (404 / validation error) — that's the safety boundary working, but note it, since it means the prompt needs tightening.
- **Low confidence.** If the confidence score is under 40%, the command bar won't even show the action card. Rephrasing usually fixes it; consistently low scores on reasonable phrasings are worth reporting.
- **Validation errors.** Try deliberately bad input: **"Add a Warranty Claims record with claim amount abc"** → should fail cleanly with a "must be a number" message from `validateRecordData`, not a 500.

### Role gating for AI module actions

- As an `IT_AGENT` or `SALES_REP`, try **"Create a module called Test"** → the card should render with an amber **"Your role isn't permitted to run this action"** banner and no Confirm button.
- Same role, try **"Add a Warranty Claims record..."** → this one *should* be allowed (`ALL_STAFF`).
- Critical check: if a non-permitted role somehow gets a Confirm button, click it anyway — the server re-checks the role independently and must return 403. The UI check is convenience; the server check is the real one.

---

## 4. AI: assign a ticket

Logged in as `IT_MANAGER`/`IT_AGENT`, with at least one open ticket and one other IT-role user in the org:

1. Type: **"Assign the VPN ticket to <name of an IT staff member>"**
   - Expect *Assign a ticket*, with `assigneeId` resolved from the assignable-users context.
   - Confirm → ticket is assigned to that person **and** moved to `IN_PROGRESS` (this action does both, matching the existing assign endpoint).
2. Try assigning to someone who is **not** IT staff (a `SALES_REP`, say) → they aren't in the context list, so the planner should either pick nobody (low confidence) or the server should 404 on the lookup. Either is acceptable; a successful assign to a non-IT user is not.
3. As a `SALES_REP` or `CRM_MANAGER`, try an assign command → should be role-blocked (`IT_STAFF` only).

---

## 5. AI: change a lead status

Logged in as `CRM_MANAGER`/`SALES_REP`, with at least one lead:

1. Type: **"Mark the <lead name> lead as qualified"**
   - Expect *Change lead status* with `status: QUALIFIED`.
   - Confirm → the lead's status updates on the Leads page.
2. **Verify workflows still fire.** If you have a workflow rule with a `LEAD_STATUS_CHANGED` trigger, confirm it runs (check its action's effect — an email, a note, whatever it does). This action calls `runWorkflows` the same way the normal update endpoint does; if automations don't fire, that's a real bug.
3. **Guardrail check:** type **"Convert the <lead name> lead"** or **"mark it as converted"** → should be refused with a message explaining conversion creates a deal and must be done from the Convert action. This is deliberate — converting is one-way and shouldn't happen from a fuzzy natural-language match.
4. Try changing the status of an already-converted lead → should be refused.
5. As an `IT_AGENT`, try a lead status command → role-blocked (`CRM_STAFF` only).

---

## 6. Regression check on existing AI actions

The planner's prompt and context changed for everyone, so re-test a couple of the pre-existing actions to make sure adding new ones didn't degrade matching:

- **"Move the <deal name> deal to Proposal"** → *Move deal stage*
- **"Mark the <ticket title> ticket as resolved"** → *Change ticket status*
- **"Add a note on the <deal name> deal saying we followed up"** → *Add a note*
- **"Score the <lead name> lead"** → *Score a lead* (this one runs without confirmation by design)

If any of these now match the *wrong* action (e.g. a status change getting routed to the new assign action), the action descriptions need disambiguating — note which command misfired and to what.

---

## 7. Audit trail

Every AI-executed action writes an audit entry. After running several of the above:

1. Go to **Admin → Audit Log**.
2. Confirm you see entries with entity types like `AI:CREATE_CUSTOM_MODULE`, `AI:ASSIGN_TICKET`, `AI:UPDATE_LEAD_STATUS`.
3. Each should record `viaAI: true`, the original command text, and the resolved params — this is the trail for "who told the AI to do that, and what did it actually run".

---

## Known limitations (not bugs)

- **The AI can only do what's in the registry.** Ten actions currently. Anything else — creating quotes, invoices, assets, change requests, HR records; editing module fields; configuring sync — returns "couldn't understand" or falls back to the legacy 5-entity create flow. Extending it means adding registry entries, not retraining anything.
- **Module sync config can't be set by AI.** Deliberate for now: it involves credentials and an external URL, which is a poor fit for a fuzzy natural-language command.
- **Nav modules need a page refresh** to appear after being created via AI (the sidebar's module list is fetched on load and isn't invalidated by the AI execute path).
- **Only one icon.** `CustomModule.icon` is always "Layers" since the create form has no picker; the nav supports several icons already, so adding a picker is a small change if wanted.
