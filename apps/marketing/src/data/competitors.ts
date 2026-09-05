// The /alternatives/* head-to-heads, in one place.
//
// /alternatives (the directory), /alternatives/altorank (the own-brand
// roundup) and /compare (the "X vs Y" hub) all render from this array, so a
// new head-to-head is one entry rather than three edits that drift apart.
//
// `positioning` is how THEY describe themselves, and `ours` is the axis we
// differ on. Every value here is already stated and sourced on the linked
// page: this file adds no new claim about any competitor. When a figure moves,
// fix it on the head-to-head first (that page carries the source and the date)
// and then here.
export type Competitor = {
  slug: string;
  name: string;
  /** Their own category, for the "X vs Y" subtitle. */
  theirCategory: string;
  /** Who genuinely picks them over us. */
  bestFor: string;
  /** The one axis that decides it. */
  axis: string;
  /** How many tools the head-to-head tests, when it is a roundup rather than a
   *  two-way comparison. Read from the page; 0 or absent means head-to-head. */
  toolsTested?: number;
};

export const COMPETITORS: Competitor[] = [
  { slug: 'outrank', name: 'Outrank', theirCategory: 'Single-site autopilot', bestFor: "Agencies hitting Outrank's single-site limits", axis: 'Per-site subscriptions vs a workspace per client', toolsTested: 8 },
  { slug: 'distribb', name: 'Distribb', theirCategory: 'Autopilot publishing', bestFor: 'Anyone who wants the publishing decision back', axis: 'Publishes unattended vs stops at your inbox' },
  { slug: 'babylovegrowth', name: 'BabyLoveGrowth', theirCategory: 'Autopilot + link network', bestFor: 'Anyone weighing an automated link network', axis: 'Automatic link matching vs human-approved placements' },
  { slug: 'rankpill', name: 'RankPill', theirCategory: 'Fully autonomous publishing', bestFor: 'Anyone burned by a $1 trial that converted', axis: 'Trial that converts vs nothing charged until you pick a plan' },
  { slug: 'seoforge', name: 'SEOForge', theirCategory: 'Content + backlinks', bestFor: 'Anyone who wants to know where the backlinks come from', axis: 'Opaque link sourcing vs a named, verified placement' },
  { slug: 'rankingcoach', name: 'rankingCoach', theirCategory: 'Small-business SEO bundle', bestFor: 'Agencies who need content depth, not a local-presence bundle', axis: 'Breadth across local presence vs depth in content', toolsTested: 2 },
  { slug: 'search-atlas', name: 'Search Atlas', theirCategory: 'Broad SEO suite', bestFor: 'Anyone tired of broad-stack bloat who mainly ships content', axis: 'A whole suite vs the content pipeline done properly', toolsTested: 9 },
  { slug: 'contentbird', name: 'contentbird', theirCategory: 'Enterprise content platform', bestFor: "Stores and their agencies priced out of contentbird's €399 floor", axis: 'Enterprise floor vs €0 self-hosted', toolsTested: 8 },
  { slug: 'rankyak', name: 'RankYak', theirCategory: 'Automated article publishing', bestFor: 'Anyone comparing daily-article tools on who reviews the draft', axis: 'Unattended cadence vs an enforced review gate', toolsTested: 6 },
  { slug: 'shopify-magic', name: 'Shopify Magic', theirCategory: 'In-admin AI copy', bestFor: 'Merchants who only need product-description copy inside Shopify', axis: 'Copy inside the admin vs a ranked content programme', toolsTested: 6 },
  { slug: 'describely', name: 'Describely', theirCategory: 'Product-content generator', bestFor: 'Catalogue teams who only need product fields filled', axis: 'Product fields vs collection pages, articles and schema', toolsTested: 6 },
  { slug: 'seowind', name: 'SEOWind', theirCategory: 'Brief-first AI writing', bestFor: 'Writers who want a brief and will do the writing', axis: 'A brief for a human vs a draft plus the publish path', toolsTested: 6 },
];
