-- The price is $5 a month (docs/decisions.md#2026-09-27--price-5-a-month), so an account's row
-- now mirrors its Lemon Squeezy subscription instead of a one-time order. No purchase had been
-- recorded when this ran; stop rather than drop real rows if that is ever not the case.
do $$
begin
  if exists (select 1 from public.entitlements) or exists (select 1 from public.lemon_events) then
    raise exception 'entitlements or lemon_events has rows; migrate them by hand';
  end if;
end $$;

alter table public.entitlements
  drop constraint entitlements_status_check,
  drop column lemon_order_id,
  drop column total_cents,
  drop column currency,
  drop column purchased_at,
  -- Lemon Squeezy's own statuses, stored as given.
  add constraint entitlements_status_check
    check (status in ('on_trial', 'active', 'past_due', 'paused', 'unpaid', 'cancelled', 'expired')),
  add column lemon_subscription_id text not null unique,
  add column renews_at timestamptz,
  -- Set once cancelled: access continues until then.
  add column ends_at timestamptz,
  -- The subscription's own updated_at, so a late, older delivery never overwrites a newer state.
  add column lemon_updated_at timestamptz not null;

comment on table public.entitlements is
  'One row per account with a My Magic UW subscription, mirrored from Lemon Squeezy by the webhook.';

-- Whether the account has the app right now. The rule lives here once for the website and the
-- app; api/lemon-webhook.ts applies the same rule when two subscriptions compete for one account.
-- security_invoker keeps the table's row-level security: a student sees only their own row.
create view public.subscription_access with (security_invoker = true) as
select
  user_id,
  status,
  test_mode,
  renews_at,
  ends_at,
  not test_mode
    and (status in ('on_trial', 'active', 'past_due') or (status = 'cancelled' and ends_at > now()))
    as entitled
from public.entitlements;

revoke all on table public.subscription_access from anon, authenticated;
grant select on table public.subscription_access to authenticated;

-- Deliveries are now subscription events, identified by the subscription and its update time.
alter table public.lemon_events rename column order_id to lemon_id;
comment on column public.lemon_events.id is '"<event_name>:<subscription_id>:<subscription updated_at>"';
