# Changelog

Recent changes and enhancements to the CRM & IT Desk platform, newest first. This file is written for anyone picking up the project — what changed, why, and what (if anything) you need to do before it works.

## Action required

Before testing or deploying anything below, run the pending migration:

```bash
cd server
npx prisma migrate dev --name add_schedules_and_whatsapp
```

This adds the `schedules` table and the `phone` / `notify_number` columns described below. Nothing in this changelog works until it's applied.

---

## Custom licensing, per-seat checkout, and payment-state enforcement

**Action required:** run the migration and regenerate the client — `cd server && npx prisma migrate dev && npx prisma generate`. In the Stripe dashboard, add `invoice.paid`, `invoice.payment_failed` and `customer.subscription.created` to the webhook endpoint's events. `STRIPE_PRO_PRICE_ID` / `STRIPE_ENTERPRISE_PRICE_ID` are now optional (yearly and custom licences are priced dynamically with `price_data`); if set they must be flat monthly Prices.

**Single source of truth for the plan.** `Organization.plan` is gone — every reader now goes through `Subscription` (the platform-admin console mirrored the two, and older code paths could drift). `Subscription` gains `interval`, `features[]`, `amountCents`, `graceUntil` and `lastPaymentFailedAt`.

**Payment state is honoured.** `utils/licensing.ts` now exposes `getEffectiveLicense(orgId)` and every gate (seats, `requireFeature`, hosted-storage quota) reads through it. `active`/`trialing` → full entitlements; `past_due` → full entitlements until `graceUntil` (set by `invoice.payment_failed`, default 7 days via `LICENSE_GRACE_PERIOD_DAYS`), then Free-plan entitlements; `canceled`/`unpaid` → Free immediately; an `active` row whose `currentPeriodEnd` is stale past the grace window → Free. Consistent with the grandfathering rules in the licensing spec, nothing existing is removed — the org simply can't add beyond Free limits until it pays. `GET /api/billing/entitlements` (any signed-in user) exposes this; the app shell shows a grace/lapsed strip and the Billing page shows the detail.

**Custom licence (self-serve).** New **Billing → Build your licence** page (`/billing/custom`): pick billable seats, monthly/yearly, and any of the gated modules (advanced AI, workflow automation, customer portal, advanced analytics, custom branding, hosted storage). Price = per-seat base (`LICENSE_BASE_SEAT_PRICE_CENTS`, default $8) + per-seat add-on per module, 10% off at 51+ seats / 20% at 201+, yearly = 10 months (`LICENSE_YEARLY_MONTHS_CHARGED`). Module prices live in `server/src/utils/pricing.ts`. Checkout creates a per-seat Stripe subscription (`quantity = seats`), and the webhook writes `plan = CUSTOM`, `seats`, `features`, `interval` onto the row; seat changes made in the Stripe portal sync back via `customer.subscription.updated`. A CUSTOM licence with `hosted_storage` gets `LICENSE_CUSTOM_STORAGE_GB` (default 10 GB). The platform-admin licence editor can also set plan `CUSTOM` and `features` directly for negotiated deals.

**Who sets the prices: the platform operator.** New **Platform Admin → Pricing** panel (`GET/PUT/DELETE /api/platform/pricing`, PLATFORM_ADMIN only) edits the Pro/Enterprise monthly price, the custom-licence base seat price, every module's per-seat add-on (and whether it's for sale), hosted-storage GB, yearly months charged, volume tiers, seat bounds and the grace period. Stored as JSON on `PlatformSettings.pricing`, layered over the code/env defaults in `utils/pricing.ts`, and live for every org within 30 seconds. A customer org's SUPER_ADMIN only buys at these prices.

**Yearly billing for Pro / Enterprise.** The Billing page has a monthly/yearly toggle; `POST /api/billing/checkout` accepts `interval`.

New endpoints: `GET /api/billing/pricing`, `GET /api/billing/entitlements`, `POST /api/billing/quote`, `POST /api/billing/custom-checkout`. New e2e spec: `tests/e2e/custom-license.spec.ts`.

---

## AI Command — whitelisted action execution

The AI command bar (`Ctrl/Cmd+K` or the "AI" button in the topbar) could previously only parse a request into a prefilled create/update form for five entity types — the user still had to open and submit that form themselves. It can now, for a fixed whitelist of actions, actually perform the action after the user confirms.

**How it works:** the model never runs arbitrary code or queries — it can only select one action by name from an explicit server-side registry, and every handler re-validates the caller's role and org scope itself before doing anything, regardless of what the model proposed. Nothing executes without an explicit "Confirm & Run" click.

**Actions available today** (`server/src/utils/ai-actions.ts`):
- Move a deal to a different pipeline stage
- Change a ticket's status
- Schedule a WhatsApp reminder on a ticket or deal
- Send a WhatsApp message immediately
- Add a note/comment to a ticket, deal, or contact
- Score a lead
- Toggle a workflow rule on/off

**New endpoints:** `POST /api/ai/actions/plan` (parses the command, proposes an action — no mutation) and `POST /api/ai/actions/execute` (re-checks role/org/schema, runs it, writes to the audit log tagged `viaAI: true` with the original command text).

**Existing behavior is untouched:** if the command matches one of the original 5 create/update intents (ticket/contact/lead/deal/article), the command bar behaves exactly as before. The new action registry is only tried as a fallback when that legacy parser doesn't recognize the request.

**Files:** `server/src/utils/ai-actions.ts` (new), `server/src/utils/ai.ts` (`planAiAction`), `server/src/modules/ai/ai.controller.ts` / `ai.routes.ts`, `client/src/api/ai.ts`, `client/src/shared/components/AiCommandBar.tsx`, `tests/e2e/ai-actions.spec.ts` (new).

## Fix — Workflow rule editor: action row layout

The action-type dropdown in the workflow rule editor (Workflows → New/Edit Rule → Actions) was rendering almost full-width and squeezing the action's own parameter fields (recipient dropdown, message box) down to an unusable sliver. Root cause: the shared `.ui-input` CSS class sets `width: 100%`, which — combined with `flex-shrink-0` inside the row's flex layout — let the type select claim nearly the whole row. Fixed by giving the action-type select and the two condition selects (field/operator) explicit fixed widths, so the parameter editor's `flex-1` sibling gets its fair share of space. (`client/src/modules/workflows/WorkflowsPage.tsx`)

## Schedules & WhatsApp notifications (Deals + Tickets)

Deals and tickets can now have WhatsApp reminders scheduled against them — one-time or recurring (daily/weekly) — and workflow automation rules can send a WhatsApp message as an action, in addition to the existing set of actions (assign, set priority/status, email, webhook, note).

**Recipient is configurable per reminder/rule:** the deal's linked contact, the assigned rep/agent, a custom phone number, or the org's default WhatsApp number — matching how the feature was scoped (both the recipient and whether it's schedule-driven or event-driven are configurable, not fixed).

**New data:**
- `Schedule` model — one-time or recurring reminders tied to a ticket or deal
- `User.phone` — needed to resolve the "assigned rep/agent" recipient option
- `WhatsAppConfig.notifyNumber` — the org's default outbound number

**New backend:** `server/src/utils/whatsapp.ts` (Twilio send), `server/src/utils/notification-recipient.ts` (shared recipient resolution used by both the poller and the workflow action), `server/src/modules/schedules/*` (CRUD API), `server/src/utils/scheduler.ts` (60-second poller that sends due reminders and re-schedules recurring ones), a new `SEND_WHATSAPP` case in the workflow engine.

**New frontend:** a "WhatsApp Reminders" panel on both the ticket and deal detail views (schedule, view status, cancel), a notification-number field in Inbox → WhatsApp settings, a `SEND_WHATSAPP` action option in the Workflows rule editor, and a Phone field on the Create/Edit User form.

**Tests:** `tests/e2e/schedules.spec.ts` (new) — schedule/cancel a reminder on a ticket and a deal (including the custom-number recipient path), create/verify/delete a workflow rule using `SEND_WHATSAPP`. `tests/global-setup.ts` extended to clean up `Schedule` rows and the new workflow-rule fixture between runs.

---

## Test suite stabilization (33 → 0 failing e2e tests)

A prior pass took the Playwright suite from 33 failures down to 0, mostly root-caused to test data never being cleaned up between runs rather than actual app bugs:

- **`tests/global-setup.ts`** — added a health-check poll before cleanup (dev servers weren't always up yet when the first test fired), and broadened cleanup to cover custom fields and all four template types (Record/Reply/Email/Quote), which previously had *no* cleanup at all despite unique-constraint fields — a single leftover row from any earlier failed run could break every subsequent run's create step on that name.
- **`playwright.config.ts`** — enabled 1 local retry (2 in CI) to absorb dev-stack cold-start flake without masking real bugs.
- **RBAC fix** — AI Builder and AI Studio sidebar links were visible to roles that shouldn't have access; restricted to `SUPER_ADMIN` / `IT_MANAGER` / `CRM_MANAGER`.
- **Branding save fix** — an empty `supportEmail`/`logoUrl`/`faviconUrl` string was failing `z.string().email()` validation even though the field was meant to be optional (zod's `.optional()` only skips `undefined`, not `''`); fixed with an empty-string-to-undefined preprocessor, since applied to every new form schema written since (schedules, WhatsApp notify number, user phone).
- **Retry-safety fixes** — a couple of specs used hardcoded fixture names/emails that collided with themselves on Playwright's automatic retry; switched to per-invocation unique values.
- Various heading-assertion timeout bumps and locator-scoping fixes for strict-mode violations caused by accumulated test data.

## `recordTemplate` migration

Added the `RecordTemplate` model and ran the initial Prisma migration (`add_record_template`) to fix a runtime error where `recordTemplate` wasn't recognized on the generated Prisma client.
