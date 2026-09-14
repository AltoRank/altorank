-- Evidence snapshots can exceed the HTTP URL limit. Keep the compare-and-set
-- payload in the RPC body and patch only the grouping key on a matching row.
create function save_onboarding_task_group(
  p_workspace uuid, p_keyword uuid, p_expected jsonb, p_task_key text
) returns boolean language plpgsql security invoker set search_path = public as $$
begin
  update keywords set opportunity = jsonb_set(opportunity, '{taskKey}', to_jsonb(p_task_key))
  where workspace_id = p_workspace and id = p_keyword and opportunity = p_expected;
  return found;
end $$;
revoke all on function save_onboarding_task_group(uuid, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function save_onboarding_task_group(uuid, uuid, jsonb, text) to service_role;
