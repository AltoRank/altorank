-- Per-workspace IndexNow key. Generated at onboarding; proving ownership is
-- hosting https://{domain}/{key}.txt, which the git adapter can commit and
-- every other platform documents as a one-file upload.
alter table workspaces add column if not exists indexnow_key text;
-- What each engine said when we told it about the published URL.
alter table articles add column if not exists indexing_status jsonb;
