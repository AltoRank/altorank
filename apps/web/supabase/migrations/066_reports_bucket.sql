-- 066: somewhere to put the monthly PDF report
-- Depends on: 053 (user_workspace_ids()); storage.buckets ships with Supabase
--
-- lib/reports/generate.ts has uploaded to `reports` since the first version
-- and no migration created the bucket, so on a fresh environment the monthly
-- cron failed at the upload and no report and no email were ever produced.
-- Where the bucket had been created by hand it was public, and the mailed
-- link (getPublicUrl) served a client's traffic and keyword figures to
-- anyone holding the URL.
--
-- Private, PDF only. Reads go through a signed URL: the cron mints one for
-- the email with the service role, and the dashboard mints one per click
-- through the cookie-bound client, which is where the policies below apply.
--
-- Objects are stored at reports/<workspace_id>/<period>.pdf, so the second
-- folder segment is the workspace and the same predicate as every
-- workspace-scoped table decides who may read, write or delete.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'reports',
  'reports',
  false,
  20971520,
  array['application/pdf']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Reports are readable by workspace members" on storage.objects;
create policy "Reports are readable by workspace members" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'reports'
    and (storage.foldername(name))[2] in (select id::text from public.user_workspace_ids() as w(id))
  );

drop policy if exists "Reports are written by workspace members" on storage.objects;
create policy "Reports are written by workspace members" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'reports'
    and (storage.foldername(name))[2] in (select id::text from public.user_workspace_ids() as w(id))
  );

drop policy if exists "Reports are replaced by workspace members" on storage.objects;
create policy "Reports are replaced by workspace members" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'reports'
    and (storage.foldername(name))[2] in (select id::text from public.user_workspace_ids() as w(id))
  );

drop policy if exists "Reports are deleted by workspace members" on storage.objects;
create policy "Reports are deleted by workspace members" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'reports'
    and (storage.foldername(name))[2] in (select id::text from public.user_workspace_ids() as w(id))
  );
