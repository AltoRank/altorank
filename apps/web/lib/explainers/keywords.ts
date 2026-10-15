import type { Explainer } from "./types";

/**
 * Read from: lib/audit/domain-analysis.ts (the three sources, the buyer test
 * over every candidate, the order they are stored in), lib/keyword-research/
 * discovery.ts (named rivals and buyer seeds; these replaced the competitor
 * gap, the heading seeds and the Google Ads fallback on 2026-09-11),
 * lib/seo/difficulty.ts (HOPELESS_DIFFICULTY), lib/seo/recommendations.ts
 * (assessKeywordQuality), lib/seo/keywords.ts and lib/seo/client.ts
 * (DataForSEO), lib/seo/intent.ts (lexicon classifier), vercel.json (rank
 * cron at 03:00 UTC), app/actions/keywords.ts and
 * components/dashboard/keyword-actions.tsx (hand-typed keywords: term and
 * intent only).
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
        "Three sources, each run through a buyer test before anything is stored, plus whatever you add by hand.",
      bullets: [
        "What the site already ranks for, read from the live search results with its position, counting only pages the site lists as its own. A rival's brand name it happens to rank for is dropped. Stored as source 'ranked'.",
        "What the competitors you named rank for, up to three of them and their top 20 positions, plus rivals read off the search results for your buyers' searches. Stored as 'gap'.",
        "Searches a buyer of this business would type, proposed by a model from the business profile and expanded with measured suggestions. Stored as 'ideas'.",
        "Every candidate, rankings included, then goes to the buyer test: a model is asked whether a buyer of this business types it. Only the ones it keeps are stored, after the quality filter below, and a term at difficulty 90 or more is dropped as unwinnable.",
        "Anything you type into Add keyword is tracked for the site the sidebar is on, with the intent you pick. No volume or difficulty is looked up for it.",
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
        "Volume and difficulty come from DataForSEO. Either is stored as null when the provider had none, or when the term was typed by hand, and renders as a dash, never as 0.",
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
    "Look up volume and difficulty for a keyword you type yourself.",
  ],
};
