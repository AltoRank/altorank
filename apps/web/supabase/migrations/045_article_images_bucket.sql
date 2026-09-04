-- 045: somewhere to put a featured image
-- Depends on: nothing; storage.buckets ships with Supabase
--
-- lib/storage/images.ts has uploaded to `article-images` since the first
-- version and the bucket was never created, so every image generation ended
-- in "Bucket not found". Until 043 that error was swallowed by a bare catch,
-- so the symptom was silence: 15 of 15 articles with no image and nothing
-- saying why. Observed for real on 2026-09-04, one layer behind the missing
-- API key that was hiding it.
--
-- Public, because a featured image is served from the customer's published
-- article to anonymous readers. Nothing private is ever put here.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'article-images',
  'article-images',
  true,
  10485760,
  array['image/webp', 'image/png', 'image/jpeg']
)
on conflict (id) do update
  set public = true,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- The service role writes these during generation and bypasses RLS, so the
-- only policy needed is the read the public bucket implies.
drop policy if exists "Article images are readable by anyone" on storage.objects;
create policy "Article images are readable by anyone" on storage.objects
  for select using (bucket_id = 'article-images');
