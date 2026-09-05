-- The rest of the per-site output switches.
--
-- 049 gave every site tone, links, TOC, CTA, first person and similar
-- products. The enrichment pipeline (lib/content/enrich) meanwhile added
-- infographics, a how-to video and FAQ schema and ran all three on every
-- article with nothing to turn them off, and the image style lived in the
-- free-form `workspaces.brand_style` json where no form could reach it.
-- These are the columns the settings form and the pipeline now share.
--
-- `image_style` values are the presets `lib/content/enrich/labels.ts` already
-- names, spelled the same way ('brand-text', hyphen) so there is one
-- identifier per preset in the database, the prompts and the form.
--
-- `featured_image_style` is the cover: `title_cover` sets the article title in
-- type (the one image allowed to carry text), `match_body` reuses the body
-- preset, the rest are body presets applied to the hero.
--
-- `brand_color` is the bar colour in infographics and the accent named in
-- image prompts. `youtube_channel` is a channel id (UC…) or a handle (@…);
-- the video step searches only that channel when it is set.

alter table workspace_output_settings
  add column if not exists infographics boolean not null default true,
  add column if not exists video boolean not null default true,
  add column if not exists emojis boolean not null default false,
  add column if not exists faq_schema boolean not null default true,
  add column if not exists image_style text not null default 'sketch',
  add column if not exists featured_image_style text not null default 'title_cover',
  add column if not exists brand_color text,
  add column if not exists youtube_channel text;

alter table workspace_output_settings drop constraint if exists workspace_output_settings_image_style_check;
alter table workspace_output_settings
  add constraint workspace_output_settings_image_style_check
  check (image_style in ('sketch','watercolor','realistic','illustration','brand-text'));

alter table workspace_output_settings drop constraint if exists workspace_output_settings_featured_image_style_check;
alter table workspace_output_settings
  add constraint workspace_output_settings_featured_image_style_check
  check (featured_image_style in ('title_cover','sketch','watercolor','illustration','match_body'));

alter table workspace_output_settings drop constraint if exists workspace_output_settings_brand_color_check;
alter table workspace_output_settings
  add constraint workspace_output_settings_brand_color_check
  check (brand_color is null or brand_color ~ '^#[0-9a-fA-F]{6}$');

alter table workspace_output_settings drop constraint if exists workspace_output_settings_youtube_channel_check;
alter table workspace_output_settings
  add constraint workspace_output_settings_youtube_channel_check
  check (youtube_channel is null or youtube_channel ~ '^(UC[A-Za-z0-9_-]{22}|@[A-Za-z0-9_.-]{3,30})$');

comment on column workspace_output_settings.infographics is 'Chart the numbers the text already states (lib/content/enrich/infographic.ts).';
comment on column workspace_output_settings.video is 'Embed one YouTube video in the first how-to section (lib/content/enrich/video.ts).';
comment on column workspace_output_settings.emojis is 'Prompt switch: allow emojis in headings and lists. Off means none.';
comment on column workspace_output_settings.faq_schema is 'Return FAQPage JSON-LD for a FAQ the article already has, for the publishing adapter.';
comment on column workspace_output_settings.image_style is 'Preset for images generated inside the body. Same identifiers as lib/content/enrich/labels.ts.';
comment on column workspace_output_settings.featured_image_style is 'Preset for the cover image; match_body follows image_style.';
comment on column workspace_output_settings.brand_color is 'Hex colour: infographic bars and the accent named in image prompts.';
comment on column workspace_output_settings.youtube_channel is 'UC… id or @handle. When set, the video step searches only this channel.';

-- The preset the pipeline used to persist into `brand_style.image_style`
-- moves here, so a site whose images were already consistent keeps that look
-- rather than falling to the new default. The key is then removed from the
-- json: one home for the setting, and a re-run of this file finds nothing to
-- move.
insert into workspace_output_settings (workspace_id, image_style)
select id, brand_style->>'image_style'
  from workspaces
 where brand_style->>'image_style' in ('sketch','watercolor','realistic','illustration','brand-text')
on conflict (workspace_id) do update
  set image_style = excluded.image_style,
      updated_at = now();

update workspaces
   set brand_style = brand_style - 'image_style'
 where brand_style ? 'image_style';
