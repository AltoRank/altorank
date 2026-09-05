=== AltoRank ===
Contributors: altorank
Tags: seo, publishing, rank math, yoast, content
Requires at least: 6.4
Tested up to: 7.1
Requires PHP: 8.0
Stable tag: 1.0.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Receives articles approved in your AltoRank dashboard as WordPress posts. Adds nothing to your public pages.

== Description ==

AltoRank writes and refreshes SEO articles for your site. This plugin is the
last step: when an article is approved in the dashboard, it arrives here as a
post.

What the plugin does with an incoming article:

* Creates the post (as a draft, unless you turn that off) with title, body, slug, excerpt, tags and category.
* Downloads every image in the article into your media library, so your site never depends on ours. Each import is recorded, and an article refreshed later reuses the same files instead of importing them again.
* Sets the featured image.
* Fills in the SEO title, meta description and focus keyword for whichever SEO plugin you run: Rank Math, Yoast SEO, SEOPress or All in One SEO.
* Updates a post in place when the article is refreshed, and sets it back to draft when it is unpublished.

What the plugin does not do:

* It adds nothing to your public site. No scripts, no styles, no "powered by" link, no credit, no meta tag, no footprint of any kind. Your visitors cannot tell it is installed.
* It never publishes on its own. Every article has passed a human approval step in the dashboard before it is sent, and by default it still lands here as a draft for an editor on your site to publish.
* It does not phone home. The plugin only ever answers requests; it makes no outbound request except downloading the images of an article it has just been sent.
* It does not need a WordPress user account or password. The dashboard authenticates with a single token you paste into the settings page.

= Authentication =

The dashboard generates a 64-character token when you connect the site. Paste
it into Settings -> AltoRank. Every request from the dashboard carries it in the
`X-AltoRank-Token` header, never in a URL, and the plugin compares it in
constant time. An unmatched token is answered with 403 and nothing else. A
site with no token saved refuses every request.

= REST routes =

All under `/wp-json/altorank/v1/`:

* `GET /capabilities`: plugin version and feature list. The one route without authentication; it discloses nothing else.
* `POST /test-integration`: creates a draft named `altorank-test-post-<time>` and deletes it again. Used by the dashboard's "Test connection" and by the settings page button.
* `POST /submit`: create a post.
* `PUT /edit`: update a post the dashboard sent earlier, found by id, external id or current slug.
* `GET /posts`: paginated list of the site's posts (`page`, `per_page`, `status`), used for refreshes and internal linking.

== Installation ==

1. Install and activate the plugin.
2. In your AltoRank dashboard, open Integrations and choose "WordPress plugin". Enter your site URL; a token is shown.
3. Paste the token into Settings -> AltoRank on your site and save.
4. Press "Test connection" on either side. Both run the same check.

== Frequently Asked Questions ==

= Where do articles appear? =

As posts (never pages or other post types), under the category you chose in
settings or the one the dashboard sent. As drafts by default: turn off "Post as
draft" to publish immediately on approval.

= Which SEO plugin do I need? =

Any of Rank Math, Yoast SEO, SEOPress or All in One SEO, or none. The plugin
writes the fields for all four; the ones no plugin reads are harmless.

= Does this add links to my site? =

No. Nothing is inserted into your pages, posts or templates. The article body
is exactly what you approved in the dashboard.

= What happens when I uninstall? =

The plugin's settings are removed. Posts and images it created are your
content and stay.

== Changelog ==

= 1.0.0 =
* First release: submit, edit, posts and test-integration routes; media library import with de-duplication; Rank Math, Yoast, SEOPress and AIOSEO fields; post-as-draft default.
