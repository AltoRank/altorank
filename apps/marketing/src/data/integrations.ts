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
    auth: 'Admin API access token',
    documented: true,
    where: 'Shopify admin → Settings → Apps and sales channels → Develop apps',
    fields: [
      { key: 'storeUrl', label: 'Store URL', required: true, hint: 'Your myshopify.com URL including https://' },
      { key: 'accessToken', label: 'Admin API access token', required: true, hint: 'From a custom app you create in your own admin' },
      { key: 'blogId', label: 'Blog ID', required: false, hint: 'Which blog to post to. Left empty, the store’s default blog is used' },
    ],
    notes: [
      'The token belongs to a custom app in your own store, so you own it and can revoke it without involving us.',
      'Your store needs at least one blog before anything can publish to it.',
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
  { slug: 'magento', name: 'Magento', code: 'MG', auth: 'Admin token' },
  { slug: 'woocommerce', name: 'WooCommerce', code: 'WC', auth: 'Application password' },
  { slug: 'webflow', name: 'Webflow', code: 'WF', auth: 'API token + site and collection ID' },
  { slug: 'framer', name: 'Framer', code: 'FR', auth: 'API token + site and collection ID' },
  { slug: 'wix', name: 'Wix', code: 'WX', auth: 'API key + account and site ID' },
  { slug: 'notion', name: 'Notion', code: 'NO', auth: 'Integration token + database ID' },
  { slug: 'hubspot', name: 'HubSpot', code: 'HS', auth: 'Access token' },
  { slug: 'git', name: 'Git', code: 'GT', auth: 'GitHub token + repo and branch', soon: true },
];

export const DOCUMENTED = INTEGRATIONS.filter((i) => i.documented);
