-- Accounts and payment status for My Magic UW.
-- Supabase Auth owns the accounts (auth.users: email only; sign-in by emailed link or code).
-- This schema records whether an account has paid for the app. It never holds coursework,
-- course names, grades or anything read from UW systems; those stay on the student's computer.

-- One row per account that has bought the app. Written only by the Lemon Squeezy webhook,
-- which uses the service role; a signed-in student can read their own row and nothing else.
create table public.entitlements (
  user_id uuid primary key references auth.users (id) on delete cascade,
  status text not null check (status in ('paid', 'refunded')),
  -- Lemon Squeezy test-mode orders are recorded but never count as a real purchase.
  test_mode boolean not null default false,
  lemon_order_id text not null unique,
  lemon_customer_id text,
  variant_id text,
  total_cents integer check (total_cents >= 0),
  currency text,
  purchased_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.entitlements enable row level security;

create policy "Students can read their own entitlement"
  on public.entitlements
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- No insert, update or delete policies: only the service role (the webhook) writes.

-- Webhook deliveries already processed, so Lemon Squeezy retries are applied once.
-- Holds identifiers only; no names, emails or addresses from the order.
create table public.lemon_events (
  id text primary key, -- "<event_name>:<order_id>"
  event_name text not null,
  order_id text not null,
  user_id uuid references auth.users (id) on delete set null,
  test_mode boolean not null default false,
  outcome text not null, -- applied | unlinked | ignored
  received_at timestamptz not null default now()
);

alter table public.lemon_events enable row level security;
-- No policies: not readable or writable from the website or the app.
