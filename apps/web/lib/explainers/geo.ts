import type { Explainer } from "./types";

/**
 * Read from: lib/geo/surfaces.ts (which surfaces, how), lib/geo/runs.ts (a
 * sweep's plan, slices, closing rule), lib/geo/ai-visibility.ts (mentioned,
 * cited, named brands, the interval), app/api/cron/geo/route.ts (cadence,
 * ceilings, opt-in, plan gate), migrations 020 and 122, lib/geo/actions.ts
 * (what the actions are), lib/geo/read.ts (latest sweep only),
 * lib/constants.ts (the section is marked "soon").
 */
export const geoExplainer: Explainer = {
  id: "geo",
  title: "AI visibility",
  intro:
    "Whether the ChatGPT app, Gemini and Google AI Mode name this brand when a buyer asks, sampled against a fixed set of questions.",
  mountsAt: "app/(dashboard)/geo/page.tsx, PageHead actions (this track).",
  sections: [
    {
      title: "What is asked",
      lead: "A fixed prompt set per workspace. The set is the measurement, so it is chosen, not generated.",
      bullets: [
        "Each prompt is a question a buyer would actually ask. Changing the set changes the number and breaks the trend, which is why nothing writes prompts for you.",
        "A weekly sweep asks every enabled prompt on every surface several times (five by default), because the same question rarely gets the same answer twice.",
        "The samples are spread over five days and collected as they come back. A sweep that captures less than 95% of its plan is marked partial, and says so.",
        "Measurement is opt-in per workspace, and on the hosted tier it needs an active plan.",
      ],
    },
    {
      title: "Which surfaces, and how",
      lead: "The consumer products a buyer types into, not the model APIs behind them.",
      bullets: [
        "The ChatGPT app and the Gemini app through DataForSEO's LLM Scraper, and Google AI Mode through its AI Mode results. Each is asked from the site's country and in its language.",
        "ChatGPT decides for itself whether to search, as it does for a buyer, so some answers cite nothing.",
        "Answers are queued at $0.0012 each: ten prompts on three surfaces at five samples is about $0.18 a week. Each answer's cost is stored on its row.",
        "A sample that fails is stored with its error and excluded from every rate, so a provider outage is never reported as invisibility.",
      ],
    },
    {
      title: "Mentioned, cited, and who is named instead",
      lead: "Two yes/no facts per answer, the brands it named, and the pages it cited.",
      bullets: [
        "Mentioned: the brand name or domain appears in the answer text, matched on word boundaries and ignoring case, so 'Alto' does not fire on 'Palo Alto'.",
        "Cited: the site's own domain appears among the answer's sources. Being mentioned without being cited means the model knows the brand but is not reading the site.",
        "Named instead: the brands the answers named. The ChatGPT app reports them; for the other surfaces a brand counts when the answer's text names it.",
        "The mention rate comes with a 95% range: with thirty answers and no mention, the true rate could still be near 10%.",
      ],
    },
    {
      title: "What to do about it",
      lead: "The sweep is turned into a ranked list of moves, each tied to the measurement that produced it.",
      bullets: [
        "A prompt where no answer names the brand becomes 'publish an answer to this question', with the brands named and the pages cited instead.",
        "A prompt named on some surfaces and never on others becomes 'close the gap on those surfaces': usually retrieval, since each grounds its answer in its own search.",
        "Mentions without citations become 'turn mentions into citations'. A low readiness score alongside becomes 'fix readiness first', because an AI that cannot read the site cannot cite it.",
        "Every action states its evidence in numbers, and the ones the product can carry out itself are labelled.",
      ],
    },
  ],
  cannotYet: [
    "Switch tracking on or add prompts from this page. Both are set in the database today, which is why the section is marked 'soon' in the sidebar.",
    "Show a trend. The page reads the latest finished sweep only; every sweep is stored but not charted.",
    "Measure Claude, Perplexity or Microsoft Copilot: there is no consumer scraper for them, and an API answer would be reported as if it were the product.",
    "Run a sweep on demand. Sweeps start on the daily schedule, at most once a week per site.",
  ],
};
