import { INTEGRATIONS } from '@/data/integrations';

export const STEPS = [
  {
    n: 1,
    title: 'Add a domain',
    desc: 'Paste a URL. AltoRank creates the workspace, crawls the pages, benchmarks competitors, and finds the gap keywords worth writing. No configuration.',
  },
  {
    n: 2,
    title: 'Build the plan',
    desc: 'A 30-day calendar, one keyword per day, ranked by traffic against difficulty for that specific domain. Connect Google Search Console and the plan starts from your own clicks, impressions and positions, read-only, rather than from an estimate.',
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
  // The next three rows are the category's Trustpilot pages, condensed. The
  // most repeated one-star review across Outrank, RankPill and BabyLoveGrowth
  // is a charge after a 3-day trial and no way to cancel from the app
  // (altorank-notes, 2026-09-02-what-the-reviews-say.md). "Their" column
  // states what their own pricing pages say; ours states what the billing
  // page does (settings/billing: Cancel subscription opens the confirmation).
  {
    label: 'Trial',
    legacy: '3-day trial, card first, charged on day 3',
    ours: 'None. Nothing charged until you choose a plan',
  },
  {
    label: 'Cancelling',
    legacy: 'Through support, or a retention flow',
    ours: 'A button on your billing page',
  },
  {
    label: 'After you cancel',
    legacy: 'Access ends with the plan',
    ours: 'Articles and history stay readable',
  },
];

// Shown as the column header over the `legacy` values.
export const COMPARISON_THEM = 'Outrank, Distribb, BabyLoveGrowth';

// Eleven connectable destinations, plus Git marked as not-yet.
//
// `soon` is not decoration and not a roadmap tease. apps/web/lib/cms/git.ts is
// written and covered by tests, and adapter.ts resolves it - but the zod
// discriminated union in apps/web/app/actions/integrations.ts has eleven
// members and `git` is not one of them. There is no path, UI or action, by
// which anyone can connect it. The adapter is reachable only by code that
// already holds a config no form can produce.
//
// Listing it plain made this page claim twelve while pricing.ts, the STEPS
// copy above ("the other seven", i.e. four named + seven) and open-source.astro
// all said eleven. The count was the smaller problem: detect.ts tells an Astro,
// Hugo, Jekyll or Next site its answer is the git adapter, so a visitor
// following the site's own advice arrived at a picker that does not offer it.
//
// Remove the flag the day `git` joins that union, and not one commit before.
export const CMS_LIST: { code: string; name: string; soon?: boolean }[] = [
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
  { code: 'WH', name: 'Webhook' },
  { code: 'GT', name: 'Git', soon: true },
];

/** Where a homepage integration tile lands.
 *
 *  Every tile pointed at /integrations, so eleven links went to one page and
 *  the reader had to find their platform a second time. Each documented
 *  connector has its own setup guide at /docs/{slug} (data/integrations.ts is
 *  the source of truth for which ones do), so the tile goes straight there.
 *  Anything undocumented, and Git while it is `soon`, still lands on the
 *  overview. */
export function cmsHref(code: string): string {
  const i = INTEGRATIONS.find((x) => x.code === code);
  return i && i.documented && !i.soon ? `/docs/${i.slug}` : '/integrations';
}

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

// ── Homepage sections added 2026-09-04 ────────────────────────────────────
//
// The page now follows the section architecture the category converges on:
// proof -> stats -> problem/solution -> how it works -> features -> links ->
// integrations -> more features -> examples -> AI visibility -> pricing -> FAQ
// -> CTA. The ARCHITECTURE is borrowed. The CLAIMS are not: every number below
// is one we can evidence, and the two sections the category fills with
// testimonials and a review wall are deliberately absent here, because we have
// no customers to quote and will not invent any (see the deleted Results block
// in PRODUCT.md, and cfd78ef / edc6ed9).

/** The stats bar. Each figure names its source; do not restate one elsewhere
 *  without checking it. */
export const STATS: { value: string; label: string; source: string }[] = [
  { value: '274', label: 'sites scanned for AI readability', source: 'READINESS_SCAN.sites' },
  { value: '86', label: 'of them failed every one of the nine checks', source: 'READINESS_SCAN.failedEverything' },
  { value: '11', label: 'publishing destinations, live today', source: 'CMS_LIST minus soon' },
  { value: `${LOCALE_COUNT}`, label: 'locales, counted in the code', source: 'LOCALE_COUNT' },
];

/** "Your problem / our solution": the tools one workspace replaces. Each row
 *  is a capability that exists in apps/web today. */
export const REPLACES: { tool: string; ours: string }[] = [
  { tool: 'A keyword research tool', ours: 'Gap keywords for your specific domain, ranked by traffic against difficulty, from live SERP data' },
  { tool: 'A writer, or a writing tool', ours: 'A draft every morning in your voice, trained on three to five of your own pieces' },
  { tool: 'An on-page checker', ours: 'An SEO score and a fact-check verdict on every draft before you open it' },
  { tool: 'An internal-linking plugin', ours: 'Links to your existing pages, chosen from your sitemap, in every article' },
  { tool: 'A publishing workflow', ours: 'One click to any of eleven destinations, after a person approves' },
  { tool: 'A client reporting tool', ours: 'White-label reports and a workspace per client, in the free build' },
];

/** The "and so much more" grid. Nine capabilities that are already stated on
 *  this site or exist in apps/web. Keep each `href` pointing at the page that
 *  substantiates the claim. */
export const MORE_FEATURES: { title: string; desc: string; href?: string }[] = [
  { title: 'An inbox, not an autopilot', desc: 'Every draft lands with an SEO score and a fact-check verdict. You approve it or send it back; there is no third option and no setting that skips this.', href: '/approval-first-seo-content' },
  { title: 'Written in your voice', desc: 'Three to five published pieces become a voice profile: tone, cadence, vocabulary and the phrases you refuse to use. One profile per workspace.' },
  { title: 'Search Console, read-only', desc: 'Connect it and the plan starts from your own clicks, impressions and positions rather than an estimate. It never writes to your property.' },
  { title: 'Rank and AI-citation tracking', desc: 'Positions per keyword, and snapshots of whether ChatGPT, Perplexity and AI Overviews cite your pages, per workspace.', href: '/geo/track-ai-citations-for-clients' },
  { title: 'A workspace per client', desc: 'Each site or client gets its own voice, plan, connections and report. Agencies run a roster; nothing leaks between them.', href: '/for-agencies' },
  { title: 'White-label reporting', desc: 'Client-facing reports under your brand, in the free self-hosted build, not behind a paid tier.', href: '/open-source' },
  { title: 'Nine AI-readability checks', desc: 'The technical signals that decide whether an AI assistant can read a site at all, checked and fixed, not just scored.', href: '/geo' },
  { title: 'Drive it from Claude Code', desc: 'An MCP server exposes research, drafting and review. It exposes no publish tool, so an agent cannot route around the approval either.', href: '/docs/mcp' },
  { title: `${LOCALE_COUNT} locales`, desc: 'Counted in the code rather than rounded up on a landing page. If you do not sell in English, the plan and the drafts follow the market you pick.' },
];

/** One line per destination, for the integrations tiles. Keys match CMS_LIST. */
export const CMS_BLURB: Record<string, string> = {
  SH: 'Store blog, product-aware',
  WP: 'Any self-hosted site',
  MG: 'Admin-token publish',
  WC: 'WordPress with a shop',
  WF: 'CMS collections',
  GH: 'Native Admin API',
  FR: 'CMS collections',
  WX: 'Wix Blog',
  NO: 'Fill a database',
  HS: 'HubSpot blog',
  WH: 'Anything that takes JSON',
  GT: 'Markdown to your repo',
};

/** Homepage FAQ. Answers restate claims made elsewhere on the site; nothing new. */
export const HOME_FAQ: { question: string; answer: string }[] = [
  { question: 'Does AltoRank publish articles automatically?', answer: 'No. It researches, drafts and scores automatically, then stops at your inbox. A person approves each draft before it reaches a live site, and the MCP server exposes no publish tool, so this holds even when an AI agent is driving the product.' },
  { question: 'Is it really free to self-host?', answer: 'Yes. The whole product is open source under AGPL-3.0, with multi-client workspaces, white-label reports and the approval gate all in the free build. You bring your own model API key. The managed plans exist for people who would rather not run infrastructure.' },
  { question: 'Which platforms can it publish to?', answer: 'WordPress, Shopify, Magento, WooCommerce, Webflow, Ghost, Framer, Wix, Notion, HubSpot and any webhook endpoint - eleven today - with Git for static sites shipping next. Each connector uses a credential you create and can revoke yourself.' },
  { question: 'How does it learn my writing voice?', answer: 'You point it at three to five pieces you have already published. It extracts tone, cadence, vocabulary and the phrases you avoid into a voice profile, and every draft in that workspace is written against it. A second site never inherits the first one\'s voice.' },
  { question: 'Does it help with ChatGPT and AI search, not only Google?', answer: 'Yes. It checks the nine technical signals that decide whether an AI assistant can read a site, fixes the ones it can, structures articles to be extractable and citable, and tracks whether your pages are being cited.' },
  { question: 'Who is behind AltoRank?', answer: 'AltoRank is built and operated by SUPALABS SRL (VAT 04596950248), a company in Italy. GDPR applies to us as a matter of establishment, not only because we sell into the EU.' },
];
