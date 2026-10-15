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
  "published_at": "2026-09-04T10:00:00Z", // when the article first went live; dates a new, published post only (1.1.1)
  "indexnow_key": "<8-128 [A-Za-z0-9-]>" // stored; served at /{key}.txt (1.1.0)
}
```

Response `201 { id, url, slug, status, edit_url, images, indexnow_key_location }`.
`indexnow_key_location` is where the site serves the IndexNow key
(`home_url('/{key}.txt')`, so a WordPress in a subdirectory gets the right
path), or null; the dashboard submits to IndexNow with it (1.1.1). `images` is
`{ imported, failed, featured: "set" | "failed" | "none", featured_error }`:
an image that cannot be fetched never fails the publish (1.1.0). `status` is what the site
did, which may be `draft`; the dashboard reads it and does not submit a draft's
URL to search engines.

`PUT /wp-json/altorank/v1/edit`: same body plus one of `post_id`,
`external_id`, `current_slug` to find the post. Only a post that carries
`_altorank_external_id` (one `/submit` created) is found; anything else is a
404 (1.1.1). A body with only `status` is a status change (unpublish sends
`draft`); while "Post as draft" is on, `status=publish` on a post that is not
already live is ignored. The external id recorded at submit is never
rewritten by an edit.

`GET /wp-json/altorank/v1/posts?page=1&per_page=20&status=publish`:
`{ posts: [{ id, title, slug, url, status, date, modified, external_id, excerpt }], total, total_pages }`.

`GET /wp-json/altorank/v1/capabilities`: unauthenticated, `{ plugin, version, features }`.

## Build

```
bin/build-zip.sh            # -> packages/wordpress-plugin/altorank.zip
```

Lint without a local PHP: `docker run --rm -v "$PWD/altorank:/p" wordpress:latest sh -c 'find /p -name "*.php" -exec php -l {} \;'`.

## Tests

```
php tests/run.php           # plugin functions against in-memory WordPress fakes
```

`tests/bootstrap.php` fakes only the WordPress functions the plugin calls, so
a new WordPress call needs a fake on purpose. The app's unit suite runs this
and `php -l` over every file whenever `php` is on the PATH
(`apps/web/lib/cms/__tests__/wordpress-plugin-php.test.ts`); the static
checks beside it run everywhere.

## Releases and updates

The plugin is not on wordpress.org. The app serves the zip it was built with
at `/api/public/wordpress-plugin` (built from this directory at `next build`,
`X-Plugin-Version` header), and the dashboard's connection test refuses a
plugin older than `MIN_PLUGIN_VERSION` in `apps/web/lib/cms/wordpress-plugin.ts`.
Since 1.1.1 the header carries `Update URI`, so WordPress never offers a
wordpress.org plugin with the same slug as an update; there is no automatic
update channel yet, and an update is a re-upload of the zip.

A release bumps, together: `Version:` and `ALTORANK_VERSION` in
`altorank.php`, `Stable tag:` and a changelog entry in `readme.txt`, and
`MIN_PLUGIN_VERSION` when older installs must not connect.

## Hardening (1.1.0, revised in 1.1.1)

Four behaviours read out of the plugins the autopilot tools ship, ported
because each one is a real support ticket:

| Behaviour | Why |
| --- | --- |
| `rest_authentication_errors` cleared for the plugin's own routes only (priority 999) | Wordfence, iThemes and several managed hosts 401 every unauthenticated REST call before any `permission_callback` runs, so the token check never got a chance. Since 1.1.1 the decision reads the route WordPress dispatches (`$wp->query_vars['rest_route']`, the value `rest_api_loaded()` serves), matches the exact routes, skips requests with a logged-in user, never clears WordPress's own codes (`rest_cookie_invalid_nonce`, application-password errors), and returns `null` so the route's `permission_callback` decides. Every route still checks the token. |
| SEO meta via `meta_input` inside `wp_insert_post`, then an explicit Yoast indexable rebuild | Rank Math and Yoast build their rows on `save_post`; meta written afterwards was invisible until the next save, so a fresh post rendered with the default `<title>`. |
| Image import and featured image in `try/catch (\Throwable)`, reported in `images` | A dead image URL used to 500 the publish after the post row existed. |
| IndexNow key served at `/{key}.txt` from an option, on `parse_request` | Writing a file to the web root fails on read-only hosts and survives uninstall. The dashboard sends the key in `indexnow_key` and submits to IndexNow with the location the plugin reports (`indexnow_key_location` in the post response from 1.1.1, `GET /indexnow` before), so a WordPress in a subdirectory verifies. |
