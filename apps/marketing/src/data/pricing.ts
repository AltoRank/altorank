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
    features: [
      '100 articles / month included',
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
      '400 articles / month included',
      'Unlimited workspaces: a site or a client each',
      '€0.45 per additional article',
      'Role-based permissions for your team',
      'Priority support, same-day',
      'Onboarding call and migration help',
    ],
    cta: 'Get started',
    href: null,
    popular: false,
  },
];
