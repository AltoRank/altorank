import type { Explainer } from "./types";

/**
 * Read from: lib/geo/ai-visibility.ts (engines, mentioned, cited, cost),
 * app/api/cron/geo/route.ts (cadence, ceilings, opt-in, plan gate),
 * supabase/migrations/020_ai_visibility.sql (geo_results columns),
 * lib/geo/actions.ts (what the actions are), lib/queries/geo.ts (latest
 * sweep only), lib/constants.ts (the section is marked "soon").
 */
export const geoExplainer: Explainer = {
  id: "geo",
  title: "AI visibility",
  intro:
    "Whether ChatGPT, Claude, Gemini and Perplexity name this brand when a buyer asks, measured against a fixed set of questions.",
  mountsAt: "app/(dashboard)/geo/page.tsx, PageHead actions (this track).",
  sections: [
    {
      title: "What is asked",
      lead: "A fixed prompt set per site. The set is the measurement, so it is chosen, not generated.",
      bullets: [
        "Each prompt is a question a buyer would actually ask. Changing the set changes the number and breaks the trend, which is why nothing writes prompts for you.",
        "Every enabled prompt is asked of every engine, so one sweep of ten prompts is forty answers.",
        "A run stops at 24 probes and 3 sites, whichever comes first, and a site is not measured again within 7 days of its last sweep.",
        "Measurement is opt-in per site, and on the hosted tier it needs an active plan: a web-search answer costs roughly sixty times a plain completion, so it is the most expensive thing the product does on a schedule.",
      ],
    },
    {
      title: "Which engines, and how",
      lead: "Four answer engines through one provider, with citations already extracted.",
      bullets: [
        "ChatGPT, Claude, Gemini and Perplexity, reached through DataForSEO's AI Optimization endpoints rather than each vendor directly: one contract, and the citation annotations arrive parsed.",
        "Answers are web-search answers, so the citations are what the engine actually read, and the fan-out queries it ran are recorded with each answer.",
        "The weekly cron runs Monday at 08:00 UTC. Each answer's cost in dollars is stored on its row, and the page shows the last run's total.",
        "A probe that fails is stored with its error and excluded from every rate, so a provider outage is never reported as invisibility.",
      ],
    },
    {
      title: "Mentioned, cited, and who won instead",
      lead: "Two yes/no facts per answer, and the domains that got the citation you did not.",
      bullets: [
        "Mentioned: the brand name appears in the answer text, matched on word boundaries and ignoring case, so 'Alto' does not fire on 'Palo Alto'.",
        "Cited: the site's own domain appears among the answer's citations. Being mentioned without being cited means the model knows the brand but is not reading the site.",
        "Competitor domains are every cited domain that is not yours. Search infrastructure such as google.com is left out of the action list.",
        "Mention rate and citation rate are computed over the newest sweep only. Two runs are never blended into one number.",
      ],
    },
    {
      title: "What to do about it",
      lead: "The sweep is turned into a ranked list of moves, each tied to the measurement that produced it.",
      bullets: [
        "A prompt where no engine names the brand becomes 'publish an answer to this question', with the domains that were cited instead as the pages to beat.",
        "A prompt where some engines name the brand and others do not becomes 'close the gap on those engines', usually a freshness or structured-data problem rather than a content one.",
        "Mentions without citations become 'turn mentions into citations'. A low readiness score alongside becomes 'fix readiness first', because an AI that cannot read the site cannot cite it.",
        "Every action states its evidence in numbers, and the ones the product can carry out itself are labelled.",
      ],
    },
  ],
  cannotYet: [
    "Switch tracking on or add prompts from this page. Both are set in the database today, which is why the section is marked 'soon' in the sidebar.",
    "Show a trend. The page reads the latest sweep only; the history is stored but not charted.",
    "Measure Google AI Overviews, Bing Copilot or any engine beyond the four above.",
    "Run a sweep on demand. Measurement happens on the weekly schedule.",
  ],
};
