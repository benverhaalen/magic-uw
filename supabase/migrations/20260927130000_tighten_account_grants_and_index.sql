-- Defence in depth beside row-level security: the browser/app roles can only read their own
-- entitlement; nothing else is granted. The webhook uses the service role, which bypasses both.
revoke all on table public.entitlements from anon, authenticated;
grant select on table public.entitlements to authenticated;
revoke all on table public.lemon_events from anon, authenticated;

-- Deleting an account sets lemon_events.user_id to null; index it so that stays cheap.
create index lemon_events_user_id_idx on public.lemon_events (user_id);
