-- 114: Blog keys - read one site's published articles, nothing else
-- Depends on: 051 (api_keys), 085 (accounts, workspaces.account_id),
-- 099 (api_keys written by the service role).
-- Apply AFTER its code is live: see RUNBOOK.md. The code reads and writes
-- `api_keys.workspace_id` when it exists and works without it (a blog key
-- cannot be created until this is applied; every other key is unchanged).
--
-- packages/altorank-next-blog runs on a customer's site and keeps its key in
-- that site's environment. Until now the only key Settings made was an agent
-- key: account-wide, with `read` and `generate`. A blog key is a different
-- credential:
--
--   * `scopes` is exactly `{blog}`. The agent API and the hosted MCP refuse
--     a key carrying `blog` (lib/agent/auth.ts), and `blog` is not one of the
--     scopes an OAuth connector can ask for (lib/oauth/codes.ts).
--   * `workspace_id` names the one site it reads. The blog API answers only
--     for that site (lib/blog-api/auth.ts), and only its live articles.
--
-- The check below holds that shape for every writer: a key with a site is a
-- blog key and nothing else, and a blog key always has a site. The trigger
-- holds the site to the key's own account. Deleting the site deletes its
-- blog keys (there is nothing left for them to read).
--
-- Every existing row has no site and no `blog` scope, so the check holds for
-- them as they are. Idempotent: `if not exists`, drop-then-add for the
-- constraint and the trigger, `create or replace` for the function. Rollback
-- in RUNBOOK.md.

alter table public.api_keys
  add column if not exists workspace_id uuid references public.workspaces(id) on delete cascade;

create index if not exists api_keys_workspace on public.api_keys (workspace_id) where workspace_id is not null;

alter table public.api_keys drop constraint if exists api_keys_blog_key_shape;
alter table public.api_keys add constraint api_keys_blog_key_shape check (
  (workspace_id is null and not ('blog' = any (scopes)))
  or (workspace_id is not null and scopes = array['blog']::text[])
);

-- caller: internal (trigger only - see the REVOKE below)
create or replace function public.api_keys_site_in_account()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if new.workspace_id is not null and not exists (
    select 1 from workspaces w
     where w.id = new.workspace_id
       and w.account_id = new.account_id
  ) then
    raise exception 'A blog key reads a site on its own account'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke execute on function public.api_keys_site_in_account() from public, anon, authenticated;

drop trigger if exists api_keys_site_in_account on public.api_keys;
create trigger api_keys_site_in_account
  before insert or update of workspace_id, account_id on public.api_keys
  for each row execute function public.api_keys_site_in_account();

-- 099 left a client token one column to update, `revoked_at`; restated so a
-- re-run after a manual change still leaves `workspace_id` server-written.
revoke insert, update on table public.api_keys from anon, authenticated;
grant update (revoked_at) on table public.api_keys to authenticated;
grant insert, update on table public.api_keys to service_role;

comment on column public.api_keys.workspace_id is
  'Set only on a blog key (scopes = {blog}): the one site whose live articles it reads through /api/blog/v1.';
