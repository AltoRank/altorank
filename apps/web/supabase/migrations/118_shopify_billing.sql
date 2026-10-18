-- 118: an account billed through Shopify
-- Depends on: 110_shopify_installations, 085_agencies_to_accounts (accounts).
-- Apply BEFORE its code is deployed: the code reads billing_provider, and
-- every existing account defaults to 'stripe', which is what it is today.
--
-- A store that installed AltoRank from the Shopify App Store pays through
-- Shopify App Pricing, not Stripe: Shopify hosts the plan picker and charges
-- the merchant, and the App Store forbids billing them anywhere else. The
-- plan the store chose is read from the Partner API and written to the same
-- columns the Stripe webhook writes (plan, plan_status, current_period_end,
-- cancels_at, trial_ends_at), so quota, the trial gate and every entitlement
-- check keep reading one model. billing_provider says which of the two wrote
-- them, so neither ever overwrites the other's account, and the dashboard
-- sends a Shopify-billed owner to Shopify to change plan instead of Stripe.

alter table accounts
  add column if not exists billing_provider text not null default 'stripe';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'accounts_billing_provider_check') then
    alter table accounts
      add constraint accounts_billing_provider_check check (billing_provider in ('stripe', 'shopify'));
  end if;
end $$;

-- What the Partner API needs to answer for a store, and what it last said.
alter table shopify_installations add column if not exists shop_gid text;
alter table shopify_installations add column if not exists plan_handle text;
alter table shopify_installations add column if not exists plan_checked_at timestamptz;

-- Nobody signed in may change who bills an account. A trigger of its own, like
-- 101's, rather than one more line in accounts_guard_privileged_columns, which
-- 099 replaces whole.

-- caller: internal (trigger only - see the REVOKE below)
create or replace function public.accounts_guard_billing_provider()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if pg_trigger_depth() = 0 then
    raise exception 'accounts_guard_billing_provider is a trigger function'
      using errcode = '42501';
  end if;

  if auth.uid() is not null and new.billing_provider is distinct from old.billing_provider then
    raise exception 'How an account is billed is recorded by AltoRank, not by a signed-in user'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke execute on function public.accounts_guard_billing_provider() from public, anon, authenticated;

drop trigger if exists accounts_guard_billing_provider on public.accounts;
create trigger accounts_guard_billing_provider
  before update on public.accounts
  for each row execute function public.accounts_guard_billing_provider();
