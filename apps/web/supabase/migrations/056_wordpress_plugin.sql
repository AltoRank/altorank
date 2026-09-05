-- 056: WordPress through the AltoRank plugin, and per-attempt webhook delivery rows
--
-- A second WordPress connection method. The application-password row
-- ('wordpress', 002) talks to wp/v2 with a WordPress user's credentials and can
-- only do what wp/v2 exposes. This one talks to the plugin in
-- packages/wordpress-plugin over altorank/v1 with a per-site token, and gets
-- media-library image import with de-duplication, SEOPress/AIOSEO fields, and
-- the plugin's own draft-by-default setting. The connect dialog finds the
-- integrations row by id, so without this row the tab cannot save.
insert into integrations (id, name, tag, description, icon_key) values
  ('wordpress-plugin', 'WordPress plugin', 'CMS',
   'Recommended for WordPress: install our plugin, paste a token. Imports images, writes Rank Math / Yoast / SEOPress / AIOSEO fields.',
   'wordpress')
on conflict (id) do nothing;

-- The webhook adapter now retries (3 attempts, backoff) and reports each
-- attempt, so a customer's endpoint that failed twice and then accepted the
-- article shows all three rows, not only the outcome. Those rows are neither
-- cron nor manual; they are delivery records, and the constraint has to say so.
alter table publish_log
  drop constraint if exists publish_log_triggered_by_check,
  add constraint publish_log_triggered_by_check
    check (triggered_by in ('cron', 'manual', 'webhook'));
