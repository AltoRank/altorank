export const STEPS = [
  {
    n: 1,
    title: 'Add a domain',
    desc: 'Paste a URL. AltoRank creates the workspace, crawls the pages, benchmarks competitors, and finds the gap keywords worth writing. No configuration.',
  },
  {
    n: 2,
    title: 'Build the plan',
    desc: 'A 30-day calendar, one keyword per day, ranked by traffic against difficulty for that specific domain.',
  },
  {
    n: 3,
    title: 'Draft and review',
    desc: 'A draft every morning in your voice, SEO-scored, internally linked. You approve it or send it back. There is no third option.',
  },
  {
    n: 4,
    title: 'Publish',
    desc: 'Approved articles ship to Shopify, WordPress, Webflow, WooCommerce, or any of the other seven.',
  },
];

// Was a comparison against a "traditional SEO stack" (four tools, a spreadsheet,
// freelancers at $0.08/word). Nobody is choosing between AltoRank and a
// spreadsheet in 2026, they are choosing between AltoRank and the AI SEO tools
// below, all of which already do that whole list.
//
// Every row is checkable against the competitors' own live homepages, fetched
// 2026-08-30. All three lead with the word "autopilot"; two use the phrase
// "while you sleep" verbatim. None is open source and none offers self-hosting.
//
// The strongest available row, "backlink exchange vs none", is DELIBERATELY
// ABSENT. apps/web/lib/seo/exchange.ts implements a credit-based exchange, so
// claiming we do not run one would be false. Add that row the day it is cut,
// and not one commit before.
export const COMPARISON = [
  {
    label: 'Source code',
    legacy: 'Closed',
    ours: 'Open source, all of it',
  },
  {
    label: 'Run it yourself',
    legacy: 'Not offered',
    ours: 'Self-host free, no feature gates',
  },
  // Deliberately "where it lives", not "you can export it". A sitewide export
  // claim is not backed: ExportCsv exists on the backlinks page and nowhere
  // else. Self-hosting putting the database on your own infrastructure is
  // structurally true, and none of the three offers self-hosting.
  {
    label: 'Where your data lives',
    legacy: 'Their infrastructure',
    ours: 'Your own, if you self-host',
  },
  {
    label: 'Publishing',
    legacy: 'Autopilot, publishes without you',
    ours: 'You approve it, or it does not ship',
  },
  {
    label: 'Scoring and ranking logic',
    legacy: 'Not inspectable',
    ours: 'Readable source you can audit',
  },
  {
    label: 'More than one site',
    legacy: 'Priced per site',
    ours: 'A workspace per site, or per client',
  },
  {
    label: 'Starting price',
    legacy: 'Subscription only',
    ours: '$0 self-hosted',
  },
];

// Shown as the column header over the `legacy` values.
export const COMPARISON_THEM = 'Outrank, Distribb, BabyLoveGrowth';

export const CMS_LIST = [
  { code: 'SH', name: 'Shopify' },
  { code: 'WP', name: 'WordPress' },
  { code: 'MG', name: 'Magento' },
  { code: 'WC', name: 'WooCommerce' },
  { code: 'WF', name: 'Webflow' },
  { code: 'GH', name: 'Ghost' },
  { code: 'FR', name: 'Framer' },
  { code: 'WX', name: 'Wix' },
  { code: 'NO', name: 'Notion' },
  { code: 'HS', name: 'HubSpot' },
  { code: 'GT', name: 'Git' },
  { code: 'WH', name: 'Webhook' },
];

// The locale count the product actually supports. apps/web/lib/seo/locales.ts
// defines 35 entries (lines 13-47).
//
// The homepage previously showed 8 language chips and a line reading "+ 142
// more", i.e. the "150+ languages" claim CLAUDE.md records as removed on
// 2026-08-15 for being false. It had survived inside that card. Removed again
// 2026-08-30. If this number changes, change it in locales.ts and here.
export const LOCALE_COUNT = 35;

// Agent-readiness scan, the one piece of original data on the site.
// Source: memory/plans/2026-08-15-agency-outreach-plan.md. Both numbers are
// evidenced; do not round them up or restate them anywhere without checking.
export const READINESS_SCAN = {
  sites: 274,
  failedEverything: 86,
};
