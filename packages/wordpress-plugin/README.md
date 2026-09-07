# AltoRank WordPress plugin

The plugin side of the "WordPress plugin" connection in the dashboard
(`apps/web/lib/cms/wordpress-plugin.ts`). GPLv2, PHP 8.0+, WordPress 6.4+.

```
altorank/
  altorank.php          plugin header, constants, activation defaults
  includes/api.php      REST namespace altorank/v1
  includes/settings.php Settings -> AltoRank
  uninstall.php         removes the plugin's options
  readme.txt            wordpress.org listing
bin/build-zip.sh        builds altorank.zip
```

## Why a plugin when wp/v2 exists

`lib/cms/wordpress.ts` publishes through the core REST API with an application
password, and does as much as that API allows. The gaps it cannot close:

| Behaviour | wp/v2 + app password | plugin |
| --- | --- | --- |
| Import remote images to the media library | yes (`wp/v2/media`) | yes |
| Skip images already imported on a refresh | no: attachments cannot carry a source URL through wp/v2 | yes (`_altorank_source_url`) |
| Rank Math / Yoast fields | yes: both register their meta with `show_in_rest` | yes |
| SEOPress / AIOSEO fields | no: neither registers its meta for REST; the keys are silently dropped | yes |
| Keep YouTube iframes through sanitisation | n/a (WordPress sanitises by the user's capabilities) | yes |
| Hold as draft by site policy | no | yes (default on) |
| Credential | a WordPress user's application password | one per-site token |

## Contract

Requests carry `X-AltoRank-Token: <64 hex>`. The plugin compares it with
`hash_equals` against the option saved in Settings -> AltoRank and answers 403
otherwise. The token is never accepted in a query string.

`POST /wp-json/altorank/v1/submit`

```json
{
  "id": "<article id>",            // stored as _altorank_external_id; a resend updates instead of duplicating
  "title": "...",
  "content": "<p>HTML</p>",        // wp_kses_post, YouTube iframes kept
  "slug": "kebab-case",            // de-duplicated against every post, drafts included
  "meta_description": "...",       // excerpt + SEO plugin description
  "focus_keyword": "...",
  "featured_image_url": "https://...",
  "tags": ["..."],
  "category": "slug or name",      // created if missing; else the settings default
  "author": "id, login or email",  // else the settings default, else the first administrator
  "status": "publish",             // overridden to draft while "Post as draft" is on
  "created_at": "2026-09-04T10:00:00Z",
  "indexnow_key": "<8-128 [A-Za-z0-9-]>" // stored; served at /{key}.txt (1.1.0)
}
```

Response `201 { id, url, slug, status, edit_url, images }`. `images` is
`{ imported, failed, featured: "set" | "failed" | "none", featured_error }`:
an image that cannot be fetched never fails the publish (1.1.0). `status` is what the site
did, which may be `draft`; the dashboard reads it and does not submit a draft's
URL to search engines.

`PUT /wp-json/altorank/v1/edit`: same body plus one of `post_id`,
`external_id`, `current_slug` to find the post. A body with only `status` is a
status change (unpublish sends `draft`).

`GET /wp-json/altorank/v1/posts?page=1&per_page=20&status=publish`:
`{ posts: [{ id, title, slug, url, status, date, modified, external_id, excerpt }], total, total_pages }`.

`GET /wp-json/altorank/v1/capabilities`: unauthenticated, `{ plugin, version, features }`.

## Build

```
bin/build-zip.sh            # -> packages/wordpress-plugin/altorank.zip
```

Lint without a local PHP: `docker run --rm -v "$PWD/altorank:/p" wordpress:latest sh -c 'find /p -name "*.php" -exec php -l {} \;'`.

## Hardening (1.1.0)

Four behaviours read out of the plugins the autopilot tools ship, ported
because each one is a real support ticket:

| Behaviour | Why |
| --- | --- |
| `rest_authentication_errors` cleared for `altorank/v1` only (priority 999) | Wordfence, iThemes and several managed hosts 401 every unauthenticated REST call before any `permission_callback` runs, so the token check never got a chance. Every route still checks the token. |
| SEO meta via `meta_input` inside `wp_insert_post`, then an explicit Yoast indexable rebuild | Rank Math and Yoast build their rows on `save_post`; meta written afterwards was invisible until the next save, so a fresh post rendered with the default `<title>`. |
| Image import and featured image in `try/catch (\Throwable)`, reported in `images` | A dead image URL used to 500 the publish after the post row existed. |
| IndexNow key served at `/{key}.txt` from an option, on `parse_request` | Writing a file to the web root fails on read-only hosts and survives uninstall. The dashboard sends the key in `indexnow_key`; `GET /indexnow` reports it. |
