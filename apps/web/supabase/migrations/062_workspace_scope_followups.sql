-- 053 introduced workspace-scoped members (agency_members.workspace_ids) and
-- moved every workspace-owned table's policy to user_workspace_ids(). Three
-- migrations merged after it (052's refresh tables, 054's research runs, 055's
-- linking tables) were written against the older agency predicate, so a member
-- restricted to one site could still read and write these rows for every site
-- in the agency. Same predicate as 053, applied to the six tables it missed.

drop policy if exists "Refresh candidates by agency" on refresh_candidates;
create policy "Refresh candidates by access" on refresh_candidates
  for all using (workspace_id in (select user_workspace_ids()))
  with check (workspace_id in (select user_workspace_ids()));

drop policy if exists "Refresh tasks by agency" on refresh_tasks;
create policy "Refresh tasks by access" on refresh_tasks
  for all using (workspace_id in (select user_workspace_ids()))
  with check (workspace_id in (select user_workspace_ids()));

drop policy if exists "Refresh executions by agency" on refresh_executions;
create policy "Refresh executions by access" on refresh_executions
  for all using (workspace_id in (select user_workspace_ids()))
  with check (workspace_id in (select user_workspace_ids()));

drop policy if exists "Research runs by agency" on keyword_research_runs;
create policy "Research runs by access" on keyword_research_runs
  for all using (workspace_id in (select user_workspace_ids()))
  with check (workspace_id in (select user_workspace_ids()));

drop policy if exists "Link sources by agency" on link_sources;
create policy "Link sources by access" on link_sources
  for all using (workspace_id in (select user_workspace_ids()))
  with check (workspace_id in (select user_workspace_ids()));

drop policy if exists "Link targets by agency" on link_targets;
create policy "Link targets by access" on link_targets
  for all using (workspace_id in (select user_workspace_ids()))
  with check (workspace_id in (select user_workspace_ids()));
