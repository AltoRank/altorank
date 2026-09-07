import type { Explainer } from "./types";

/**
 * Read from: lib/cms/types.ts (the adapter interface: publish, unpublish,
 * testConnection; no update), lib/cms/adapter.ts (the thirteen adapters),
 * lib/cms/wordpress.ts, lib/cms/wordpress-plugin.ts, lib/cms/git.ts,
 * lib/cms/webhook.ts (each pattern's behaviour), lib/publishing/core.ts
 * (IndexNow waits for a git build), lib/crypto.ts (secrets encrypted at rest).
 *
 * The plugin was described as "coming" here until 2026-09-06 because #71 had
 * not merged when this was written. It has: migration 056 seeds the
 * `wordpress-plugin` integration row, lib/cms/wordpress-plugin.ts is the
 * adapter, /api/public/wordpress-plugin serves the zip. Present tense now.
 */
export const integrationsExplainer: Explainer = {
  id: "integrations",
  title: "Integrations",
  intro:
    "Four ways an approved article can reach a site, and what each one can and cannot do once it is there.",
  mountsAt: "app/(dashboard)/connect/page.tsx, PageHead actions.",
  sections: [
    {
      title: "Credential connections",
      lead:
        "WordPress (application password), WooCommerce, Shopify, Magento, Webflow, Ghost, Framer, Wix, Notion and HubSpot: we call their API with a credential you paste.",
      bullets: [
        "The secret fields of every configuration are encrypted at rest; the connection type is stored in the clear so the app can name the destination without a key.",
        "Test connection runs before anything is saved, against the platform's own API.",
        "Publish creates a new post, page or entry with the title, HTML, slug, meta description and featured image, and stores the id and URL that came back.",
        "Unpublish reverses it through the same platform: WordPress posts go back to draft, others are removed or unpublished as the platform allows.",
        "Search Console, GA4 and Bing are read-only connections for analytics; they never receive an article.",
      ],
    },
    {
      title: "Plugin token",
      lead:
        "A WordPress plugin with a per-site token, so the site does not hand out an application password and posts can be edited in place.",
      bullets: [
        "The dialog asks for the site URL only, links to the plugin install screen, shows a generated token to paste into the plugin's settings, and tests the connection before saving.",
        "Posts arrive as drafts by default. Remote images are imported into the media library and tagged, so a refresh reuses them; the featured image is set on the post.",
        "SEO fields for Rank Math, Yoast, SEOPress and AIOSEO are written, slugs are de-duplicated, and the HTML is sanitised on the WordPress side.",
        "It adds an edit-in-place route, which is the one thing none of the credential connections offer today.",
      ],
    },
    {
      title: "Git commit",
      lead:
        "For sites with no CMS: Astro, Next, Hugo, Eleventy, Jekyll. The article becomes a Markdown file committed to your repository, and your build deploys it.",
      bullets: [
        "GitHub only, with a token that has contents:write on the repository, a branch, and the directory your posts live in.",
        "The filename is derived from the slug and reduced to one safe segment inside that directory, with the extension fixed to .md or .mdx. A slug can never write outside the content directory.",
        "Frontmatter is built from the article plus any defaults your collection requires. The public URL is derived from your site's own sitemap, trailing slash included.",
        "A commit is not a deploy, so IndexNow and Google are told only after the publish cron confirms the page is live.",
        "Unpublish deletes the file, and refuses to delete anything outside the content directory.",
      ],
    },
    {
      title: "Webhook",
      lead: "Your endpoint receives the article as JSON and decides what to do with it.",
      bullets: [
        "Publish POSTs {action: 'publish', article: {title, html, slug, metaDescription, tags, publishedAt}} to your URL; unpublish sends {action: 'unpublish', externalId}.",
        "With a secret set, the body is signed with HMAC-SHA256 and the hex digest sent as X-Webhook-Signature: sha256=... Custom headers are sent as configured, so a bearer token works.",
        "Delivery makes up to three attempts, waiting 0.5s then 2s, on a network error, a 429 or a 5xx; every other 4xx is not retried. Each attempt lands in the publish log, so an endpoint that failed twice and then accepted shows all three.",
        "If your endpoint answers with an id and a url, they are stored on the article; if it answers with nothing, the article is still marked live.",
      ],
    },
  ],
  cannotYet: [
    "Update a live post through a credential connection. The adapter interface is publish, unpublish and test; publishing again creates a new post. The WordPress plugin is the one destination that edits in place.",
    "Two-way sync. An edit made in the CMS after publishing does not come back into the editor.",
    "Publish to GitLab or Bitbucket. Git means GitHub.",
    "Retry a webhook on a schedule. One publish call makes up to three attempts, backing off on a network error, a 429 or a 5xx; a 4xx is your endpoint saying no and is not retried. After that it is a person's decision, from the article.",
  ],
};
