-- 086: the seven-day trial with a card
-- Depends on: 014_billing (plan_status), 085_agencies_to_accounts (accounts, accounts_guard_privileged_columns)
--
-- Hosted plans now start with a seven-day trial that asks for a card up
-- front and charges on day eight unless cancelled (2026-09-09, reversing the
-- no-trial rule of 2026-08-30). The trial is asked for *after* onboarding:
-- the account's first drafts are written and read before any card is
-- entered, so the free allowance (migration 083) stays as the pre-trial
-- draft budget and the trial is what unlocks approve, publish and further
-- writing.
--
-- `trial_ends_at` is written by the Stripe webhook from the subscription's
-- `trial_end`. It is also the one-trial-per-account record: Stripe does not
-- stop a customer starting a second trial, so checkout refuses to add trial
-- days to an account that already has this stamped, whether the trial is
-- running, converted or cancelled.

alter table accounts add column if not exists trial_ends_at timestamptz;

comment on column accounts.trial_ends_at is
  'End of the seven-day card trial, from Stripe. Non-null means the account has had its one trial.';

-- The billing-column guard from 072 as 085 renamed it, with trial_ends_at
-- added to the list a signed-in user may not write. Same body otherwise.

create or replace function public.accounts_guard_privileged_columns()
returns trigger
language plpgsql
set search_path to 'public'
as $$
declare
  is_admin boolean;
begin
  if pg_trigger_depth() = 0 then
    raise exception 'accounts_guard_privileged_columns is a trigger function'
      using errcode = '42501';
  end if;

  if auth.uid() is null then
    return new;
  end if;

  if (new.plan is distinct from old.plan)
     or (new.plan_status is distinct from old.plan_status)
     or (new.stripe_customer_id is distinct from old.stripe_customer_id)
     or (new.stripe_subscription_id is distinct from old.stripe_subscription_id)
     or (new.current_period_end is distinct from old.current_period_end)
     or (new.cancels_at is distinct from old.cancels_at)
     or (new.payment_failed_at is distinct from old.payment_failed_at)
     or (new.trial_ends_at is distinct from old.trial_ends_at)
     or (new.api_key is distinct from old.api_key)
  then
    raise exception 'Billing and API-key columns on an account are set by AltoRank, not by a signed-in user'
      using errcode = '42501';
  end if;

  select exists (
    select 1 from account_members m
    where m.user_id = auth.uid() and m.account_id = new.id and m.role in ('owner', 'admin')
  ) into is_admin;

  if not is_admin then
    if (new.name is distinct from old.name)
       or (new.slug is distinct from old.slug)
       or (new.logo_url is distinct from old.logo_url)
       or (new.custom_domain is distinct from old.custom_domain)
       or (new.accent_color is distinct from old.accent_color)
       or (new.remove_branding is distinct from old.remove_branding)
       or (new.report_email is distinct from old.report_email)
    then
      raise exception 'Only an owner or admin can change account settings'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

revoke execute on function public.accounts_guard_privileged_columns() from public, anon, authenticated;
