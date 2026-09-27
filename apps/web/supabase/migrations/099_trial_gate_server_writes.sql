-- 099: what the trial gate counts and checks is written by the server only
-- Depends on: 083_free_allowance_lifetime (free_drafts_used), 085_agencies_to_accounts
-- and 086_card_trial (accounts_guard_privileged_columns as it stands), the
-- api_keys table and its policies, 001_initial_schema (articles.research).
-- Apply AFTER its code is live, like 097: see RUNBOOK.md.
--
-- The trial gate (apps/web/lib/billing/trial.ts) holds an account that has not
-- started its trial at one article, and 097 keeps that article's text from
-- every client token. Three things a signed-in person could still write or
-- read over PostgREST undid it:
--
-- 1. accounts.free_drafts_used. The hold and the spend gate read the larger of
--    this counter and the account's article count. The count is the person's
--    to change (their client deletes articles, and saves status), and this
--    column was not in the billing-column guard, so setting it to 0 and the
--    first article to `error` read as "nothing written" and bought another
--    paid draft, as often as they liked. It joins the guarded columns; the
--    writer records it with the service role (lib/content/generate.ts).
--
-- 2. api_keys INSERT and UPDATE. The policies let any owner or admin insert a
--    row, and the key hash is a plain sha256, so a person could choose their
--    own key without Settings (which refuses an account before its trial) -
--    and set `created_by` to any user, which is whose address the agent API
--    asks the trial gate and the operator list about. Inserts now come only
--    from the server (createApiKey and the OAuth code exchange both write with
--    the service role). A client token keeps one column to update, the one
--    Settings writes: `revoked_at`.
--
-- 3. articles.research -> enrichment -> faqSchema. The enrichment report kept
--    the FAQPage JSON-LD it built, and that schema is the article's FAQ
--    questions with their answers copied word for word from the text.
--    `research` is readable by a client token (the gate card counts sources
--    from it), so the answers were readable before the trial. Nothing read
--    the stored schema - the publisher builds it again from the text it is
--    about to send (lib/publishing/core.ts) - so the writer no longer stores
--    it (lib/content/enrich/index.ts), and the rows that have it lose it.
--
-- Idempotent: create or replace, revoke/grant, and an update that only
-- touches rows still carrying the key. Rollback in RUNBOOK.md.

-- 1 ---------------------------------------------------------------------------
-- The guard from 086, with free_drafts_used added to the list a signed-in
-- user may not write. Same body otherwise.

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
     or (new.free_drafts_used is distinct from old.free_drafts_used)
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

-- 2 ---------------------------------------------------------------------------

revoke insert, update on table public.api_keys from anon, authenticated;
grant update (revoked_at) on table public.api_keys to authenticated;
grant insert, update on table public.api_keys to service_role;

-- 3 ---------------------------------------------------------------------------

update public.articles
   set research = research #- '{enrichment,faqSchema}'
 where research -> 'enrichment' ? 'faqSchema';
