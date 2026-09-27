# Accounts and payments

Status, September 27, 2026: **built and tested in isolation; not yet connected to a live Supabase project or Lemon Squeezy store.** Accepted scope (Aidan, September 27): a student signs up and pays on the website; the desktop app signs in and shows whether the account has bought the app. Price: $10 one-time, which still conflicts with the $5 license in [decisions](decisions.md#pricing-and-ai-access-resolution--september-26). Sign-in is by email, no passwords.

## What exists

| Piece | Where | What it does |
| --- | --- | --- |
| Schema | `supabase/migrations/20260927120000_accounts_and_entitlements.sql` | `entitlements` (one row per account that bought the app) and `lemon_events` (webhook deliveries already applied). Row-level security: a student reads only their own entitlement; only the service role writes. |
| Webhook | `api/lemon-webhook.ts` → `POST /api/lemon-webhook` on Vercel | Verifies Lemon Squeezy's `X-Signature` (HMAC-SHA256 of the raw body), then records `order_created` (paid) and `order_refunded`. Idempotent; test-mode orders never replace a real purchase; a refund can't be undone by a late retry; an order without an account id is recorded as unlinked, never matched by email. Returns 500 on a Supabase failure so Lemon Squeezy retries. |
| Website | `apps/web/account/`, `apps/web/assets/account.js` | Email magic-link sign-in (Supabase Auth, PKCE), purchase status, **Buy for $10** (the Pricing button leads here). Checkout carries the account id as `checkout[custom][user_id]`. After checkout it waits up to ~30 s for the webhook. |
| Desktop | `apps/desktop/src/account.ts`, `AccountSection.tsx` on Data & AI, bridge `window.magic.account` | Sign in with the 6-digit code from the same email; status paid / not bought / refunded / test only / unknown; Buy opens the website; sign out. Refresh token in the encrypted vault, access token in memory only, nothing token-like in the renderer. A confirmed purchase counts for 14 days offline. **Nothing in the app is locked by it yet.** Delete local data also signs out (it clears the vault). |
| Tests | `tests/lemon-webhook.test.ts`, `tests/desktop-account.test.ts` | Against in-memory stand-ins for Supabase; no live service was used. |

## Data this adds, and where it goes

Supabase stores the account's **email address** (Supabase Auth) and, after a purchase, the Lemon Squeezy order id, customer id, variant id, amount, currency, date, test-mode flag and paid/refunded status. It never receives coursework, course names, grades, UW identifiers or anything read from UW. Lemon Squeezy, as merchant of record, holds the buyer's name, email, address and payment details; the webhook ignores those fields. Signing in sends only the email to Supabase. This is a new hosted destination; see [AI and privacy](ai-and-privacy.md#accounts-and-payments).

## Setup

Keys go into Vercel and your local environment, never into Git or chat.

**Supabase**

1. Create a project. In **SQL Editor**, run the migration file above.
2. **Authentication → URL Configuration**: Site URL `https://magic-uw-omega.vercel.app` (the current domain); Redirect URLs `https://magic-uw-omega.vercel.app/account/` and, for local testing, `http://localhost:4179/account/`.
3. **Authentication → Emails → Magic Link**: keep the link and add `Or enter this code in the app: {{ .Token }}` so the desktop app can sign in with the code.
4. Before real students: **Authentication → Emails → SMTP Settings** with a mail provider. Supabase's built-in sender is rate-limited and meant for testing.

**Lemon Squeezy** (test mode works before the store is approved)

1. Create the product "My Magic UW app", single payment, $10. Set its post-purchase redirect / button link to `https://magic-uw-omega.vercel.app/account/?paid=1`.
2. Copy the product's checkout link (`https://<store>.lemonsqueezy.com/buy/<id>`) and its **variant ID**.
3. **Settings → Webhooks → +**: URL `https://magic-uw-omega.vercel.app/api/lemon-webhook`, events `order_created` and `order_refunded`, and a signing secret (for example `openssl rand -hex 32`).

**Vercel** (Settings → Environment Variables, then redeploy: the page config is written at build time)

| Variable | Value | Exposure |
| --- | --- | --- |
| `SUPABASE_URL` | Project URL | public |
| `SUPABASE_ANON_KEY` | publishable (anon) key; the build refuses a secret key | public |
| `LEMONSQUEEZY_CHECKOUT_URL` | checkout link | public |
| `SUPABASE_SERVICE_ROLE_KEY` | secret key; mark Sensitive | webhook only |
| `LEMONSQUEEZY_WEBHOOK_SECRET` | the signing secret | webhook only |
| `LEMONSQUEEZY_VARIANT_ID` | variant id (optional; limits which product counts) | webhook only |

**Desktop app** (development runs; packaging later bakes these in): `MAGIC_SUPABASE_URL`, `MAGIC_SUPABASE_ANON_KEY`, `MAGIC_ACCOUNT_URL=https://magic-uw-omega.vercel.app/account/`. Without them the Account section is hidden.

**Check the whole path in test mode:** sign in on the website → Buy → pay with Lemon Squeezy's test card → the account page shows "Test purchase only" → in the app, sign in with the code → the same status appears. Then refund the test order and confirm both show "Refunded".

## Known limits and open decisions

- No download exists yet, so a real purchase is effectively a pre-order; the account page says so. Keep Lemon Squeezy in test mode until the team decides to sell.
- The app shows status only. Deciding what an unpaid install can do, and enforcing it, is a separate decision.
- Price conflict ($10 site and product vs $5 recorded) needs Ben and Aidan to agree.
- Hobby-plan hosting on Vercel is for non-commercial use; taking payments needs a paid plan.
- When the permanent domain replaces `magic-uw-omega.vercel.app`, update the Supabase URLs, the Lemon Squeezy redirect and webhook, and `MAGIC_ACCOUNT_URL`.
- Not yet exercised against live Supabase and Lemon Squeezy: the tests use stand-ins, and the desktop section was checked in the renderer preview with a stand-in bridge.
