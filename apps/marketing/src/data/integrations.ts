// The publishing destinations, and exactly what each one asks you for.
//
// SOURCE OF TRUTH: apps/web/app/actions/integrations.ts. Every `fields` entry
// below is a key in that file's zod schema for the same provider, and
// `required` matches whether the key is optional() there. If a schema changes,
// this file is wrong until it is changed too - the docs pages and /integrations
// both render from here, so a drift shows up on the public site.
//
// `auth` is deliberately plain language: what the user has to go and fetch.
// Nothing here describes a capability we do not ship. `soon: true` is the only
// honest way to list Git, which has an adapter and a schema but is not yet in
// the picker.
export type IntegrationField = {
  key: string;
  label: string;
  required: boolean;
  hint: string;
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
    notes: [
      'An application password is revocable on its own, so removing AltoRank’s access never means changing your WordPress login.',
      'The user you name is the post author, so give it a role that can publish posts.',
      'Self-hosted WordPress and WordPress.com Business both expose the REST API this uses; the cheaper WordPress.com tiers do not.',
    ],
  },
  {
    slug: 'shopify',
    name: 'Shopify',
    code: 'SH',
    auth: 'Custom app Client ID + secret, or a legacy Admin API access token',
    documented: true,
    where: 'Shopify Dev Dashboard (custom apps since 1 January 2026), or the admin’s Settings → Apps and sales channels → Develop apps on older stores',
    fields: [
      { key: 'storeUrl', label: 'Store URL', required: true, hint: 'Your myshopify.com URL including https://' },
      { key: 'clientId', label: 'Client ID', required: false, hint: 'Dev Dashboard apps. Give this and the secret, or the access token below' },
      { key: 'clientSecret', label: 'Client secret', required: false, hint: 'Stored encrypted; AltoRank exchanges it for 24-hour tokens and refreshes them itself' },
      { key: 'accessToken', label: 'Admin API access token', required: false, hint: 'Legacy custom apps only, shown once in the admin. Give this or the Client ID + secret' },
      { key: 'blogId', label: 'Blog ID', required: false, hint: 'Which blog to post to. Left empty, the store’s default blog is used' },
    ],
    notes: [
      'Exactly one credential: a Client ID + secret, or an access token. Both belong to a custom app in your own store, so you own them and can revoke them without involving us.',
      'Your store needs at least one blog before anything can publish to it.',
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
    notes: [
      'The collection needs a text field for the title and a rich-text field for the body before the first publish.',
      'Webflow separates saving an item from publishing the site, so a published article appears in the CMS immediately and on the live site at the next publish.',
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
    notes: [
      'Creating the integration is not enough: you also have to share the specific database with it from the database’s own menu, or every write returns a permission error.',
      'Notion is a good staging destination — articles land as pages you can review again before moving them anywhere public.',
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
      { key: 'apiUrl', label: 'API URL', required: true, hint: 'Your Ghost site URL including https://' },
      { key: 'adminApiKey', label: 'Admin API key', required: true, hint: 'The id:secret pair from a custom integration' },
    ],
    notes: [
      'Ghost’s Admin API is not available on their Starter plan. If you are on Starter this connector cannot work, and that is a limit on their side.',
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
      { key: 'url', label: 'Endpoint URL', required: true, hint: 'An https:// endpoint you control' },
      { key: 'secret', label: 'Shared secret', required: false, hint: 'Sent so your endpoint can verify the request came from us' },
      { key: 'headers', label: 'Extra headers', required: false, hint: 'Any additional headers your endpoint needs' },
    ],
    notes: [
      'The escape hatch: if your stack is not in the list, this is how you publish to it.',
      'Nothing about the approval gate changes. The webhook fires when a human approves the draft, not when it is generated.',
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
    notes: ['Wix API keys are account-level, so scope the permissions to Blog rather than granting the whole account.'],
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
      { key: 'blogId', label: 'Blog ID', required: false, hint: 'Which blog to post to. Left empty, the default blog is used' },
    ],
    notes: ['A private app token is scoped and revocable without affecting your HubSpot login or other integrations.'],
  },
  { slug: 'git', name: 'Git', code: 'GT', auth: 'GitHub token + repo and branch', soon: true },
];

export const DOCUMENTED = INTEGRATIONS.filter((i) => i.documented);
