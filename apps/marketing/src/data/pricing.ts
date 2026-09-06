// Pricing ladder simplified 2026-08-30 (Mike): €0 self-host / €69 managed /
// €199 agency. Three rungs, all euros.
//
// Changes from the 2026-08-15 ladder ($0 / $29 BYOK / €99 / €199):
//   - Cloud BYOK removed. It asked a buyer to hold provider keys AND pay us,
//     which is the worst of both ends of the ladder.
//   - Managed €99 -> €69.
//   - Currency is euros throughout. SUPALABS SRL is an Italian company and the
//     buyer is largely European; mixing $ and € read as neither.
// At €69, $5k MRR is roughly 72 managed customers.
// See memory/plans/2026-07-29-open-source-agpl-pivot.md (Phase 0 blocker #5).
// Keep this in sync with buildProductSchema() in @/lib/schema and the price
// figures baked into apps/marketing/scripts/daily-blog.mjs.
//
// The former "Custom" card was folded into the Talk-to-sales footer on
// pricing.astro, four cards is the layout ceiling.

import { OSS_REPO_PUBLIC, OSS_REPO_URL } from '@/constants';

/**
 * Two months free on an annual commitment: pay for ten, get twelve.
 *
 * Stated as "2 months free" rather than "17% off" because that is the same
 * discount described in the unit the buyer thinks in, and because a percentage
 * invites arithmetic that a month count does not.
 *
 * Competitors anchor harder - BabyLoveGrowth shows EUR 247 struck through
 * against EUR 99 - but a struck-through price we never charged is a fabricated
 * anchor, which is the same class of claim this repo keeps removing.
 */
export const YEARLY_MONTHS_FREE = 2;

/** Monthly-equivalent price when billed annually, or null for free tiers. */
export function yearlyMonthly(monthly: number): number {
  return Math.round((monthly * (12 - YEARLY_MONTHS_FREE)) / 12);
}

export const PLANS = [
  {
    name: 'Self-host',
    price: '€0',
    monthly: 0,
    period: 'forever',
    desc: OSS_REPO_PUBLIC
      ? 'The whole engine, open source. Your infrastructure, your API keys, no feature gates.'
      : 'The whole engine, open source: your infrastructure, your API keys, no feature gates. The repo is not public yet; see what ships and when.',
    features: [
      'Everything open, no paid tier held back',
      'Runs on your own infrastructure',
      'Bring your own Anthropic key',
      // Was 'CLI + MCP server'. The MCP server is real
      // (apps/web/scripts/mcp.ts, npm run mcp). The CLI is not: there is no
      // `bin` entry in any package.json and nothing is published to a
      // registry. open-source.astro already states plainly that "the one thing
      // that is NOT built yet is a packaged command-line tool" - this card was
      // selling it two sections above that sentence.
      'MCP server, drive it from Claude Code',
      'All 11 CMS integrations',
      'Multi-tenant and white-label reports, ungated',
      'Community support',
    ],
    cta: OSS_REPO_PUBLIC ? 'View on GitHub' : 'See what ships',
    href: OSS_REPO_PUBLIC ? OSS_REPO_URL : '/open-source',
    popular: false,
  },
  // Nothing below is a feature the free tier lacks: under AGPL there are no
  // feature gates, and "no paid tier held back" is the first defensible claim
  // in POSITIONING.md. The paid rungs sell hosting, included model and data
  // costs, volume and support - the things self-hosting makes you provide
  // yourself. Listing white-label or multi-tenant as an Agency differentiator
  // contradicted the Self-host card directly, which is how it read before.
  {
    name: 'Managed',
    price: '€69',
    /** Monthly amount in euros. The display strings above are derived from
     *  this; keep them together or they drift, which is how eleven pages ended
     *  up quoting a price the ladder no longer charged. */
    monthly: 69,
    period: '/mo',
    desc: 'No API keys to manage, because model and data costs are included. For solo operators and agencies running one or two brands.',
    // The included count is now reachable. It was not: cron/generate ran once a
    // day and wrote one article per site, so a site topped out near 30 a month
    // against a plan sold as 100. That ceiling was a five-minute serverless
    // function, not a view about publishing, and it has been lifted - four runs
    // a day, so the binding limit is `auto_generate_weekly_limit`, which is the
    // customer's own setting. Hence "at the pace you set" rather than a
    // frequency we would have to keep true - and since migration 041 there is
    // a control on each site's Settings tab that actually sets it, which that
    // sentence had been describing for a while without one existing. Choosing
    // a plan raises a site from the free tier's 1 a week to 7, about 30 a
    // month; the ceiling is 25 a week, about 108, so a single site can reach
    // the included 100 if someone turns it up.
    // Keep in step with PLAN_ARTICLE_LIMITS and the cadence in app/api/cron/generate.

    features: [
      '100 articles / month included, at the pace you set per site',
      'Articles publish without the AltoRank line',
      'Up to 3 workspaces (sites or clients)',
      '€0.60 per additional article',
      'No API keys needed, costs included',
      'Voice profile training',
      'Keyword research + rank tracking',
      'All 11 CMS integrations',
      'Email support',
    ],
    cta: 'Get started',
    /**
     * The one free thing on the cloud side, and it was invisible.
     *
     * apps/web ships FREE_DRAFTS = 1: a signup with no plan gets a workspace,
     * a first look and one complete article with its fact check, and cannot
     * approve or publish it without choosing a plan (needsPlanToShip). That
     * offer existed in the code and appeared nowhere a buyer could see it, so
     * the only EUR 0 on this page was Self-host - a different product, on the
     * buyer's own infrastructure, with their own API keys.
     *
     * Worded against what the code actually does. It is not a trial: no clock,
     * no card, nothing expires. It is one article. Keep this in step with
     * FREE_DRAFTS in apps/web/lib/billing/quota.ts.
     */
    ctaNote: 'First article free, no card. Approving or publishing it is where a plan starts.',
    href: null,
    popular: true,
  },
  {
    name: 'Agency',
    price: '€199',
    monthly: 199,
    period: '/mo',
    desc: 'For agencies running content across a full client roster. Everything metered on output, not seats or workspaces.',
    features: [
      'Everything in Managed',
      '400 articles / month included, at the pace you set per site',
      'Unlimited workspaces: a site or a client each',
      '€0.45 per additional article',
      // Was 'Role-based permissions for your team'. There is no role column
      // and no permission system (apps/web/lib/auth/operators.ts says so in
      // as many words); every member of an agency account has the same
      // access. Selling permissions that do not exist is the class of claim
      // this file keeps removing. Seats are genuinely unmetered, so say that.
      'Unlimited team members, no per-seat charge',
      'Priority support, same-day',
      'Onboarding call and migration help',
    ],
    cta: 'Get started',
    href: null,
    popular: false,
  },
];

/**
 * The plan ladder as a comparison table, one row per thing the code actually
 * enforces or the operator actually provides. Every figure here has a source
 * in apps/web:
 *   articles/month       PLAN_ARTICLE_LIMITS  (lib/stripe.ts)
 *   per extra article    OVERAGE_CENTS        (lib/billing/quota.ts)
 *   workspaces           PLAN_WORKSPACE_LIMITS (lib/billing/workspaces.ts)
 *   free first article   FREE_DRAFTS          (lib/billing/quota.ts)
 *   approval gate        needsPlanToShip      (lib/billing/quota.ts)
 * Rows about support and onboarding restate the plan cards. There is no
 * add-on catalogue because there are no add-ons: the only metered extra is
 * the per-article rate, and it is a row here rather than a second table.
 * Do not add a volume-discount ladder; none is charged.
 */
export const AT_A_GLANCE: { label: string; values: [string, string, string] }[] = [
  { label: 'Price', values: ['€0', '€69 / month', '€199 / month'] },
  { label: 'Billed yearly', values: ['—', `€${yearlyMonthly(69)} / month`, `€${yearlyMonthly(199)} / month`] },
  { label: 'Articles included per month', values: ['Unmetered, your API bill', '100', '400'] },
  { label: 'Each article past the included volume', values: ['—', '€0.60', '€0.45'] },
  { label: 'Workspaces (a site or a client each)', values: ['Unlimited', '3', 'Unlimited'] },
  { label: 'Before choosing a plan', values: ['—', '1 workspace, 1 complete article to read, no card', '1 workspace, 1 complete article to read, no card'] },
  { label: 'Model and search-data costs', values: ['You bring the keys', 'Included', 'Included'] },
  { label: 'Human approval before anything publishes', values: ['Yes', 'Yes', 'Yes'] },
  { label: 'CMS integrations', values: ['All 11', 'All 11', 'All 11'] },
  { label: 'White-label reports and multi-client', values: ['Yes', 'Yes', 'Yes'] },
  { label: 'MCP server for Claude Code', values: ['Yes', 'Yes', 'Yes'] },
  { label: 'Team members', values: ['Unlimited', 'Unlimited', 'Unlimited'] },
  { label: 'Support', values: ['Community', 'Email', 'Priority, same-day, plus onboarding call'] },
];

/** Pricing FAQ. Rendered on /pricing and emitted as FAQPage schema there. */
export const PRICING_FAQ: { question: string; answer: string }[] = [
  {
    question: 'Is there a free trial?',
    answer: 'No trial, and no card up front. Instead, adding a domain gives you one workspace and one complete article with its fact check, to read before you decide. Approving or publishing that article is where a plan starts. Nothing expires and nothing is charged until you choose one.',
  },
  {
    question: 'What counts as an article against the monthly volume?',
    answer: 'Every article created in the calendar month, across all your workspaces, whether the schedule wrote it or you asked for it. Deleting a draft gives the slot back. The count resets on the first of the month.',
  },
  {
    question: 'What happens when I go past the included articles?',
    answer: 'Articles keep generating and each one past the included volume is billed at the per-article rate for your plan, €0.60 on Managed and €0.45 on Agency, as a line on your next invoice. There is no hard stop and no need to upgrade mid-month.',
  },
  {
    question: 'Are there add-ons or volume discounts?',
    answer: 'No. There is one metered extra, the per-article rate above, and yearly billing is two months free. Everything else, including white-label reports, all eleven integrations and the MCP server, is in every plan, including the free self-hosted one. For volume beyond the Agency tier, talk to us.',
  },
  {
    question: 'What is the difference between Managed and self-hosting?',
    answer: 'The software is identical; there are no feature gates. Self-hosting means your infrastructure, your Anthropic and search-data keys, your upgrades, and no article limit because the bill is yours. Managed means we run it, the model and data costs are included, and the volume is metered.',
  },
  {
    question: 'How does the Agency plan price a client roster?',
    answer: 'On articles, not on clients or seats. Unlimited workspaces, one per site or client, 400 articles a month across all of them, and €0.45 for each beyond that. Ten clients at ten articles each and one client at a hundred cost the same.',
  },
  {
    question: 'How do I cancel?',
    answer: 'From the billing page, in one click, with no call. Your articles stay readable afterwards, and anything already published on your site is yours; it was published to your CMS, not hosted by us.',
  },
  {
    question: 'Which currency and who is the seller?',
    answer: 'All prices are in euros. The seller is SUPALABS SRL, an Italian company, so EU customers receive a VAT invoice and GDPR applies to us by establishment.',
  },
];
