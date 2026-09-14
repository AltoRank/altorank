-- Source packets are service-written. A client editing a keyword cannot mark
-- an arbitrary packet ready. They are not shipped with the polling UI payload.
create table draft_preparations (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  keyword_id uuid not null references keywords(id) on delete cascade,
  payload jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, keyword_id)
);
alter table draft_preparations enable row level security;
revoke all on draft_preparations from public,anon,authenticated;
grant all on draft_preparations to service_role;

create table onboarding_choice_checks (
  run_id uuid primary key references onboarding_runs(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  candidates jsonb not null check (jsonb_typeof(candidates)='array'),
  status text not null default 'queued' check (status in ('queued','preparing','done')),
  lease uuid,
  lease_until timestamptz,
  attempts integer not null default 0 check (attempts between 0 and 2),
  results jsonb not null default '[]' check (jsonb_typeof(results)='array'),
  created_at timestamptz not null default now()
);
alter table onboarding_choice_checks enable row level security;
revoke all on onboarding_choice_checks from public,anon,authenticated;
grant all on onboarding_choice_checks to service_role;

create function claim_onboarding_choices(p_run uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare token uuid := gen_random_uuid(); site uuid;
begin
  select workspace_id into site from onboarding_runs where id=p_run and status='running' for update;
  if not found then return null; end if;
  perform 1 from onboarding_choice_checks where run_id=p_run and workspace_id=site and attempts>=2
    and status in ('queued','preparing') and (lease_until is null or lease_until<now()) for update;
  if found then
    delete from calendar_entries where workspace_id=(select workspace_id from onboarding_runs where id=p_run)
      and status='queue' and article_id is null
      and keyword_id::text in (select value->>'keywordId' from onboarding_choice_checks c,jsonb_array_elements(c.candidates) where c.run_id=p_run);
    update onboarding_runs set planned='[]',status='partial',finished_at=now(),updated_at=now(),
      phases=coalesce((select jsonb_agg(value) from jsonb_array_elements(phases) where value->>'phase' not in ('planning','drafting')),'[]'::jsonb)
        || '[{"phase":"planning","status":"failed","detail":"Source preparation was interrupted twice. Your research is saved; retry preparation to check article sources."},{"phase":"drafting","status":"skipped","detail":"No draft was started or allowance used."}]'::jsonb
      where id=p_run;
    update onboarding_choice_checks set status='done',lease=null,lease_until=null where run_id=p_run;
    return null;
  end if;
  update onboarding_choice_checks set status='preparing', lease=token,
    lease_until=now()+interval '6 minutes', attempts=attempts+1
    where run_id=p_run and workspace_id=site and status in ('queued','preparing') and attempts<2
      and (lease_until is null or lease_until<now());
  if not found then return null; end if;
  update onboarding_runs set updated_at=now() where id=p_run;
  return token;
end $$;
revoke all on function claim_onboarding_choices(uuid) from public,anon,authenticated;
grant execute on function claim_onboarding_choices(uuid) to service_role;

-- Completing a stale worker cannot replace a newer worker's choices or reopen
-- a run the customer has already advanced. One transaction seals both rows.
create function finish_onboarding_choices(p_run uuid,p_token uuid,p_planned jsonb,p_phases jsonb,p_results jsonb) returns boolean
language plpgsql security definer set search_path = public as $$
declare site uuid; candidates jsonb; choice jsonb; original jsonb; packet jsonb; topic uuid;
begin
  select workspace_id into site from onboarding_runs where id=p_run and status='running' for update;
  if not found then return false; end if;
  if jsonb_typeof(p_planned) is distinct from 'array' or
     jsonb_typeof(p_phases) is distinct from 'array' or
     jsonb_typeof(p_results) is distinct from 'array' then return false; end if;
  if jsonb_array_length(p_planned)>5 or
     (select count(distinct value->>'keywordId') from jsonb_array_elements(p_planned))<>jsonb_array_length(p_planned)
     then return false; end if;
  select c.candidates into candidates from onboarding_choice_checks c where c.run_id=p_run and c.workspace_id=site
    and c.status='preparing' and c.lease=p_token and c.lease_until>now() for update;
  if not found then return false; end if;
  for choice in select value from jsonb_array_elements(p_planned) loop
    if jsonb_typeof(choice) is distinct from 'object' or
       jsonb_typeof(choice->'preparation') is distinct from 'object' or
       jsonb_typeof(choice->'preparation'->'context') is distinct from 'string' or
       length(choice->'preparation'->>'context')<>64 or
       jsonb_typeof(choice->'preparation'->'checkedAt') is distinct from 'string'
       then return false; end if;
    topic:=(choice->>'keywordId')::uuid;
    select value into original from jsonb_array_elements(candidates) where value->>'keywordId'=topic::text;
    if not found or (choice-'preparation') is distinct from (original-'preparation') then return false; end if;
    -- Exact original task, current workspace keyword, and the private packet
    -- must all agree. A receipt is not itself evidence that sources were ready.
    perform 1 from keywords where id=topic and workspace_id=site and term=choice->>'term'
      and plan_excluded_at is null and opportunity->>'status'='qualified'
      and opportunity->'version'=choice->'brief'->'version'
      and opportunity->'context'=choice->'brief'->'context'
      and not exists(select 1 from unnest(array['angle','buyingJob','audience','offering','format','conversionPath','reason']) k
        where opportunity->k is distinct from choice->'brief'->k);
    if not found then return false; end if;
    select payload into packet from draft_preparations where workspace_id=site and keyword_id=topic;
    if not found or packet->>'status' is distinct from 'ready' or
       packet->>'context' is distinct from choice->'preparation'->>'context' or
       packet->>'createdAt' is distinct from choice->'preparation'->>'checkedAt' or
       packet->'plan'->'requirements' is distinct from choice->'preparation'->'requirements' or
       jsonb_typeof(packet->'plan'->'requirements') is distinct from 'array' or
       jsonb_array_length(packet->'plan'->'requirements')=0 or
       packet->>'expiresAt' is null or (packet->>'expiresAt')::timestamptz<=now()
       then return false; end if;
  end loop;
  update onboarding_runs set planned=p_planned, phases=p_phases, updated_at=now(),
    status=case when jsonb_array_length(p_planned)>0 then 'awaiting_choice' else 'partial' end,
    finished_at=case when jsonb_array_length(p_planned)>0 then null else now() end
    where id=p_run;
  -- Only this run's unwritten provisional choices are removed. Existing
  -- content and any newly attached article survive.
  delete from calendar_entries where workspace_id=site and status='queue' and article_id is null
    and keyword_id::text in (select value->>'keywordId' from onboarding_choice_checks c,jsonb_array_elements(c.candidates) where c.run_id=p_run)
    and keyword_id::text not in (select value->>'keywordId' from jsonb_array_elements(p_planned));
  update onboarding_choice_checks set status='done',lease=null,lease_until=null,results=p_results where run_id=p_run;
  return true;
exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow or invalid_parameter_value then
  return false;
end $$;
revoke all on function finish_onboarding_choices(uuid,uuid,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function finish_onboarding_choices(uuid,uuid,jsonb,jsonb,jsonb) to service_role;
