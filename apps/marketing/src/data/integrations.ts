// The publishing destinations, and exactly what each one asks you for.
//
// SOURCE OF TRUTH: apps/web/app/actions/integrations.ts (the zod schemas) and
// apps/web/lib/cms/*.ts (what each adapter actually does with a credential).
// Every `fields` entry below is a key in that file's zod schema for the same
// provider, `required` matches whether the key is optional() there, and
// `advanced: true` marks a key the schema accepts but the connect dialog
// (apps/web/components/dashboard/connect-cms-dialog.tsx) does not ask for. If
// a schema changes, this file is wrong until it is changed too - the docs
// pages and /integrations both render from here, so a drift shows up on the
// public site.
//
// `publishes` and `unpublishes` are read from the adapter's publish() and
// unpublish() bodies. They are the honest answer to "what does approving do",
// and they differ per platform: some return to draft, some delete.
//
// `writes` lists the destination-side fields the adapter writes to, for the
// platforms where a field has to exist before the first publish (Webflow,
// Framer, Notion). Those names are the adapter's, verbatim.
//
// `auth` is deliberately plain language: what the user has to go and fetch.
// Nothing here describes a capability we do not ship.
export type IntegrationField = {
  key: string;
  label: string;
  required: boolean;
  hint: string;
  /** Accepted by the schema, not asked for by the connect form. */
  advanced?: boolean;
};

export type Integration = {
  slug: string;
  name: string;
  /** Two-letter code used by the homepage marquee. */
  code: string;
  auth: string;
  /** Set when a /docs/{slug} page exists. */
  documented?: boolean;
  soon?: boolean;
  fields?: IntegrationField[];
  /** Where the credential comes from, in their UI. */
  where?: string;
  /** What the adapter does when a person approves a draft. */
  publishes?: string;
  /** What "unpublish" does on this platform. */
  unpublishes?: string;
  /** Destination fields the adapter writes, where they must pre-exist. */
  writes?: { field: string; receives: string }[];
  notes?: string[];
};

export const INTEGRATIONS: Integration[] = [
  {
    slug: 'wordpress',
    name: 'WordPress',
    code: 'WP',
    auth: 'Application password',
    documented: true,
    where: 'WordPress admin → Users → your profile → Application Passwords',
    fields: [
      { key: 'siteUrl', label: 'Site URL', required: true, hint: 'The full URL including https://, e.g. https://example.com' },
      { key: 'username', label: 'Username', required: true, hint: 'The WordPress user the posts are authored as' },
      { key: 'applicationPassword', label: 'Application password', required: true, hint: 'Generated in WordPress, not your login password' },
    ],
    publishes: 'Creates a post through the REST API with status "publish", so it is live at once. The meta description is stored as the post excerpt and the slug is the one you approved.',
    unpublishes: 'Sets the same post back to draft. Nothing is deleted.',
    notes: [
      'An application password is revocable on its own, so removing AltoRank’s access never means changing your WordPress login.',
      'The user you name is the post author, so give it a role that can publish posts.',
      'Self-hosted WordPress and WordPress.com Business both expose the REST API this uses; the cheaper WordPress.com tiers do not.',
      'The connector does not write into Yoast, Rank Math or other SEO-plugin fields. If your plugin does not read the excerpt, set the SEO title and description in the plugin after publishing.',
    ],
  },
  {
    slug: 'shopify',
    name: 'Shopify',
    code: 'SH',
    auth: 'Admin API access token',
    documented: true,
    where: 'Shopify admin → Settings → Apps and sales channels → Develop apps',
    fields: [
      { key: 'storeUrl', label: 'Store URL', required: true, hint: 'Your myshopify.com URL including https://' },
      { key: 'accessToken', label: 'Admin API access token', required: true, hint: 'From a custom app you create in your own admin' },
      { key: 'blogId', label: 'Blog ID', required: false, hint: 'Which blog to post to. Left empty, the first blog on the store is used' },
    ],
    publishes: 'Creates a blog article with published set to true and the approval time as its publish date. The meta description becomes the article summary.',
    unpublishes: 'Deletes the article from the blog. Shopify has no draft state to return it to through this endpoint.',
    notes: [
      'The token belongs to a custom app in your own store, so you own it and can revoke it without involving us.',
      'Your store needs at least one blog before anything can publish to it, and the custom app needs write_content scope.',
    ],
  },
  {
    slug: 'woocommerce',
    name: 'WooCommerce',
    code: 'WC',
    auth: 'Application password',
    documented: true,
    where: 'WordPress admin → Users → your profile → Application Passwords',
    fields: [
      { key: 'siteUrl', label: 'Site URL', required: true, hint: 'Your store URL including https://' },
      { key: 'username', label: 'Username', required: true, hint: 'The WordPress user the posts are authored as' },
      { key: 'applicationPassword', label: 'Application password', required: true, hint: 'Generated in WordPress, not your login password' },
    ],
    publishes: 'Creates a WordPress post with status "publish", live at once, with the meta description as the excerpt.',
    unpublishes: 'Sets the post back to draft.',
    notes: [
      'WooCommerce runs on WordPress, so the connector is the WordPress one: articles publish as posts alongside your shop.',
      'Revocable on its own, without changing your WordPress login.',
    ],
  },
  {
    slug: 'webflow',
    name: 'Webflow',
    code: 'WF',
    auth: 'API token, scoped to a site and a collection',
    documented: true,
    where: 'Webflow → Site settings → Apps & integrations → API access',
    fields: [
      { key: 'apiToken', label: 'API token', required: true, hint: 'A site token with CMS read and write access' },
      { key: 'siteId', label: 'Site ID', required: true, hint: 'Found in Site settings → General' },
      { key: 'collectionId', label: 'Collection ID', required: true, hint: 'The blog collection articles are created in' },
    ],
    publishes: 'Creates a collection item, then publishes that item so it is live without a full site publish.',
    unpublishes: 'Archives the item. It stays in the CMS, hidden from the live site.',
    writes: [
      { field: 'name', receives: 'the title' },
      { field: 'slug', receives: 'the slug' },
      { field: 'post-body', receives: 'the article HTML (rich text)' },
      { field: 'post-summary', receives: 'the meta description' },
    ],
    notes: [
      'The four fields on the left have to exist in the collection with those slugs before the first publish. They are the defaults of Webflow’s own blog template, so most collections already have them.',
    ],
  },
  {
    slug: 'framer',
    name: 'Framer',
    code: 'FR',
    auth: 'API token, scoped to a site and a collection',
    documented: true,
    where: 'Framer → Site settings → General → Server API',
    fields: [
      { key: 'apiToken', label: 'API token', required: true, hint: 'A Framer Server API key for the project' },
      { key: 'siteId', label: 'Site ID', required: true, hint: 'The Framer project the collection lives in' },
      { key: 'collectionId', label: 'Collection ID', required: true, hint: 'The CMS collection articles are created in' },
    ],
    publishes: 'Creates a collection item with draft mode off, so it is live.',
    unpublishes: 'Flips the same item back to draft.',
    writes: [
      { field: 'name', receives: 'the title' },
      { field: 'slug', receives: 'the slug' },
      { field: 'content', receives: 'the article HTML' },
      { field: 'description', receives: 'the meta description' },
    ],
    notes: [
      'Only collections owned and editable by the project work. Collections synced from an external source are managed by that source.',
    ],
  },
  {
    slug: 'notion',
    name: 'Notion',
    code: 'NO',
    auth: 'Internal integration token + database ID',
    documented: true,
    where: 'notion.so/my-integrations → New integration, then share the database with it',
    fields: [
      { key: 'integrationToken', label: 'Integration token', required: true, hint: 'From an internal integration you create' },
      { key: 'databaseId', label: 'Database ID', required: true, hint: 'The 32-character id in the database URL' },
    ],
    publishes: 'Creates a page in the database, with the body converted from HTML to Notion blocks: paragraphs, headings and list items.',
    unpublishes: 'Archives the page.',
    writes: [
      { field: 'Name', receives: 'the title (the database’s title property)' },
      { field: 'Slug', receives: 'the slug (a text property)' },
    ],
    notes: [
      'Creating the integration is not enough: you also have to share the specific database with it from the database’s own menu, or every write returns a permission error.',
      'The database needs a text property called Slug next to its Name title. The write fails if it is missing.',
      'The conversion keeps paragraphs, h1 to h3 and list items as plain text and stops at Notion’s limit of 100 blocks per request, so a long article is truncated and inline links and bold are dropped. Notion is a staging destination, not a publishing one.',
    ],
  },
  {
    slug: 'ghost',
    name: 'Ghost',
    code: 'GH',
    auth: 'Admin API key',
    documented: true,
    where: 'Ghost admin → Settings → Integrations → Add custom integration',
    fields: [
      { key: 'apiUrl', label: 'Ghost URL', required: true, hint: 'Your Ghost site URL including https://' },
      { key: 'adminApiKey', label: 'Admin API key', required: true, hint: 'The id:secret pair from a custom integration, pasted as one string' },
    ],
    publishes: 'Creates a post with status "published" through the Admin API, from HTML, with the meta description set. Live at once.',
    unpublishes: 'Sets the post back to draft.',
    notes: [
      'Ghost’s Admin API is not available on their Starter plan. If you are on Starter this connector cannot work, and that is a limit on their side.',
      'The key is used to sign a short-lived token for every request; the key itself is never sent to Ghost.',
    ],
  },
  {
    slug: 'webhook',
    name: 'Webhook',
    code: 'WH',
    auth: 'Your endpoint, optionally signed',
    documented: true,
    where: 'Wherever you run it',
    fields: [
      { key: 'url', label: 'Webhook URL', required: true, hint: 'An https:// endpoint you control' },
      { key: 'secret', label: 'Signing secret', required: false, hint: 'When set, every request carries an HMAC-SHA256 signature of the body so your endpoint can verify it came from us' },
      { key: 'headers', label: 'Extra headers', required: false, advanced: true, hint: 'Additional headers sent with every request, for example your own bearer token. Accepted by the connector; not in the connect form yet' },
    ],
    publishes: 'POSTs a JSON body with action "publish" and the article. Any 2xx response counts as published; an id and url in the response are recorded as the published id and URL.',
    unpublishes: 'POSTs action "unpublish" with the id your endpoint returned.',
    notes: [
      'The escape hatch: if your stack is not in the list, this is how you publish to it.',
      'Nothing about the approval gate changes. The webhook fires when a human approves the draft, not when it is generated.',
      'Delivery is one attempt. A non-2xx response marks the publish as failed in the publish log and it can be retried from the article; there is no automatic retry, so return 2xx only once you have stored the article.',
    ],
  },
  {
    slug: 'magento',
    name: 'Magento',
    code: 'MG',
    auth: 'Admin bearer token',
    documented: true,
    where: 'Magento admin → System → Integrations',
    fields: [
      { key: 'baseUrl', label: 'Base URL', required: true, hint: 'Your Magento install URL including https://' },
      { key: 'adminToken', label: 'Admin token', required: true, hint: 'The access token from an integration you activate' },
      { key: 'storeCode', label: 'Store code', required: false, hint: 'For multi-store installs. Left empty, the default store is used' },
    ],
    publishes: 'Creates a CMS page (not a blog post: Magento has no blog without an extension) with the slug as its URL key, active, and the meta description set. It is reachable at /{slug} at once.',
    unpublishes: 'Deletes the CMS page.',
    notes: ['The integration has to be activated after it is created, or the token exists but authorises nothing.'],
  },
  {
    slug: 'wix',
    name: 'Wix',
    code: 'WX',
    auth: 'API key + account and site ID',
    documented: true,
    where: 'Wix → Settings → API keys (account level)',
    fields: [
      { key: 'apiKey', label: 'API key', required: true, hint: 'An account-level key with Blog permissions' },
      { key: 'accountId', label: 'Account ID', required: true, hint: 'Shown alongside the key when you create it' },
      { key: 'siteId', label: 'Site ID', required: true, hint: 'From the URL of your Wix dashboard' },
    ],
    publishes: 'Creates a draft post through the Blog API with the title and the meta description as excerpt, then publishes it.',
    unpublishes: 'Unpublishes the post. It stays in Wix as a draft.',
    notes: [
      'Wix API keys are account-level, so scope the permissions to Blog rather than granting the whole account.',
      'Wix takes its post body as structured rich content rather than HTML, and the HTML-to-rich-content conversion is not finished: today the post is created with its title and excerpt and the body has to be pasted in Wix. The adapter is in the open-source repository if you want to help close that.',
    ],
  },
  {
    slug: 'hubspot',
    name: 'HubSpot',
    code: 'HS',
    auth: 'Private app access token',
    documented: true,
    where: 'HubSpot → Settings → Integrations → Private apps',
    fields: [
      { key: 'accessToken', label: 'Access token', required: true, hint: 'From a private app with blog write scopes' },
      { key: 'blogId', label: 'Blog ID', required: false, hint: 'Which blog to post to. Left empty, the blog of your most recent post is used' },
    ],
    publishes: 'Creates a blog post in state PUBLISHED with the slug and meta description set.',
    unpublishes: 'Sets the post to DRAFT.',
    notes: [
      'A private app token is scoped and revocable without affecting your HubSpot login or other integrations.',
      'On a portal with no posts yet there is nothing to read the default blog from, so set the Blog ID explicitly.',
    ],
  },
  {
    slug: 'git',
    name: 'GitHub',
    code: 'GT',
    auth: 'Fine-grained token with contents:write on one repository',
    documented: true,
    where: 'GitHub → Settings → Developer settings → Fine-grained personal access tokens',
    fields: [
      { key: 'owner', label: 'Repo owner', required: true, hint: 'The user or organisation, e.g. acme' },
      { key: 'repo', label: 'Repository', required: true, hint: 'The repository the site builds from' },
      { key: 'branch', label: 'Branch', required: true, hint: 'The branch your host deploys, usually main' },
      { key: 'contentPath', label: 'Content directory', required: true, hint: 'Where posts live, e.g. src/content/blog. Files are only ever written inside it' },
      { key: 'token', label: 'GitHub token', required: true, hint: 'Scoped to that one repository with Contents: read and write' },
      { key: 'publicBaseUrl', label: 'Public URL of your blog', required: false, hint: 'Read from your sitemap when you connect; used to record where each post will appear' },
      { key: 'trailingSlash', label: 'Trailing slash', required: false, hint: 'Whether your post URLs end in /. Read from your sitemap, not guessed' },
      { key: 'extension', label: 'File extension', required: false, advanced: true, hint: 'md (default) or mdx' },
      { key: 'frontmatterDefaults', label: 'Front matter defaults', required: false, advanced: true, hint: 'Extra keys added to every post, e.g. an author or a layout' },
      { key: 'committer', label: 'Committer', required: false, advanced: true, hint: 'Name and email on the commit. Defaults to the token’s owner' },
    ],
    publishes: 'Commits one Markdown file to the branch at {content directory}/{slug}.md with YAML front matter (title, description, publishDate, tags, ogImage) and the body converted from HTML. Your host’s build deploys it; a commit is not a deploy, so the article is checked for going live afterwards.',
    unpublishes: 'Deletes that file in a second commit. The post disappears on the next build, which is the closest a static site has to unpublishing.',
    notes: [
      'Listed in the picker as “Git / static site”. It is the answer for Astro, Hugo, Jekyll, Next and anything else that builds from Markdown in a repository; there is no plugin to install and nothing runs on your site.',
      'Connecting checks two things: that the token can see the branch, and that the public blog URL actually responds. A wrong URL used to produce articles marked live at addresses that never existed.',
      'GitHub is the only provider today. Republishing an approved article updates the same file rather than creating a duplicate.',
    ],
  },
];

export const DOCUMENTED = INTEGRATIONS.filter((i) => i.documented);

// Brand marks, generated into public/logos/{CODE}.svg by
// scripts/extract-brand-logos.mjs from the dashboard's own icon set. Inlined
// rather than referenced as <img> so a mark with no published brand colour
// (Magento) can take the page's ink via currentColor. Null when a connector
// has no mark, and the caller shows the two-letter code instead.
const LOGOS = import.meta.glob('/public/logos/*.svg', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
export function logoSvg(code: string): string | null {
  return LOGOS[`/public/logos/${code}.svg`] ?? null;
}
