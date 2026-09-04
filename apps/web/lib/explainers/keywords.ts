import type { Explainer } from "./types";

/**
 * Read from: lib/audit/domain-analysis.ts (the three sources and their
 * order), supabase/migrations/036_keyword_source_gap.sql (the `source`
 * values), lib/seo/recommendations.ts (assessKeywordQuality),
 * lib/seo/keywords.ts and lib/seo/client.ts (DataForSEO), lib/seo/intent.ts
 * (lexicon classifier), vercel.json (rank cron at 03:00 UTC),
 * app/actions/keywords.ts (hand-typed keywords).
 */
export const keywordsExplainer: Explainer = {
  id: "keywords",
  title: "Keywords and research",
  intro:
    "Where the terms come from, what is thrown out before an article is written about them, and where each number was measured.",
  mountsAt: "app/(dashboard)/keywords/page.tsx, PageHead actions (this track).",
  sections: [
    {
      title: "Where keywords come from",
      lead:
        "Four sources, used in the order of how much they know about this site, plus whatever you add by hand.",
      bullets: [
        "What the site already ranks for, read from the live search results with its position, so 'one revision from page one' is a question with an answer. Stored as source 'ranked'.",
        "What competitors rank for that this site does not, on a full analysis. Stored as 'gap'.",
        "Ideas seeded from the headings of your own pages, which say what the business does in its own words. Stored as 'ideas'.",
        "Google Ads keywords-for-site, stored as 'ads', only as a fallback when the first three leave the queue thin. It is the source of every junk set we have shipped, so its share of a list is capped.",
        "Anything you type into Find new keywords is tracked for the site the sidebar is on. Volume and difficulty are whatever you entered.",
      ],
    },
    {
      title: "What the quality filter rejects",
      lead:
        "Keyword providers return fragments with real-looking volume attached. A person discards them at a glance; the filter does it for the unattended path.",
      bullets: [
        "Fragments a searcher would not type: terms under three characters, single-letter words, split spellings of a term already tracked ('s eo' beside 'seo'), and a trailing two-letter fragment ('seo co').",
        "Phrases that start or end with a function word ('no keywords', 'ai in'), repeat a word ('seo and seo'), or join two nouns with 'and' or 'or', which is how an ads endpoint labels a topic pair.",
        "Sentence fragments carrying no topic: 'ai makes', 'are you', 'all the answers are correct'. Question words and comparatives are deliberately allowed, because 'what is logistics' is a real query.",
        "Flagged terms stay visible and are scored down to 30%, so they sit low in your queue instead of vanishing. Only the unattended scheduler refuses them outright, because a person may disagree with the heuristic.",
      ],
    },
    {
      title: "Provenance of the numbers",
      lead: "Every figure on this page was measured by something specific.",
      bullets: [
        "Volume and difficulty come from DataForSEO. Difficulty is stored as null when the provider had none, and renders as a dash, never as 0: the Google Ads endpoint carries no difficulty at all.",
        "Intent (info, commercial, transactional, navigational) is a lexicon classifier over the term, not a model's opinion.",
        "Positions come from the rank cron at 03:00 UTC, with results collected at 03:20. Impressions come from Search Console over the last 90 days when it is connected.",
        "Difficulty is judged against the site's own domain rating when one has been measured, because KD 40 means something different at DR 80 and at DR 2.",
        "Status follows the term into an article: New, Planned, Drafting, Shipped.",
      ],
    },
  ],
  cannotYet: [
    "Research without DataForSEO credentials. A self-hosted install without them tracks hand-typed keywords only, with no volume or difficulty lookups.",
    "Show the source per row in this table. The column exists on every keyword; the surface for it is the keyword research drawer (#72).",
    "Import keywords from a CSV or pull them directly from Search Console.",
    "Attach a difficulty to Google Ads-sourced terms. That endpoint does not carry one, and we do not invent it.",
  ],
};
