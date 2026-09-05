import type { Explainer } from "./types";

/**
 * Read from: lib/seo/recommendations.ts (scoring), lib/content/pace.ts and
 * lib/content/generate-queue.ts (pace and the per-run cap),
 * app/api/cron/generate/route.ts and vercel.json plus
 * .github/workflows/generate-cron.yml (when it runs), and PR #67's
 * specification of the planner (60-entry cap, top-up, Move, Remove,
 * instructions, questions). Where #67 is the source, the copy says so in
 * `cannotYet`.
 */
export const contentPlanExplainer: Explainer = {
  id: "content-plan",
  title: "Content plan",
  intro:
    "A month of keywords, chosen by arithmetic you can read, written into a review queue that nothing leaves without you.",
  mountsAt:
    "TODO(track A): mount <HowItWorks explainer={contentPlanExplainer} /> in the PageHead actions of app/(dashboard)/content/page.tsx.",
  sections: [
    {
      title: "How keywords are chosen",
      lead:
        "Every candidate is scored as opportunity × winnability × relevance, from data already in your workspace. No model call, so the same inputs always give the same queue.",
      bullets: [
        "Opportunity is search volume on a log scale, plus the impressions the site already earns for the term in Search Console over the last 90 days when it is connected. Proven demand on this site beats estimated demand anywhere.",
        "Winnability comes from keyword difficulty, judged against the site's own authority when we have a reading. Unknown difficulty scores conservatively rather than as easy; difficulty 0 on a term with real volume is treated as not measured.",
        "Relevance is how much of the term appears in the vocabulary of your own crawled pages. A term the site already ranks for skips this test: the search results already decided it fits.",
        "A position between 11 and 20 is the largest multiplier, because one revision is cheaper than a new ranking. A position of 10 or better is left alone, and a term already covered by an article becomes a refresh rather than a duplicate.",
        "Each pick carries its reasons in plain words, in the order they mattered, and the draft keeps them so the reviewer can see why the topic was chosen.",
      ],
    },
    {
      title: "How the month is scheduled",
      lead:
        "The plan is one site's queue, capped, paced, and topped up so it never runs dry and never runs away.",
      bullets: [
        "A plan holds up to 60 entries. The header reads N of 60 scheduled and how many slots are free.",
        "Pace is set per site in articles a week: 1 before choosing a plan, 7 when a plan becomes active, up to 25. The monthly target is that pace scaled to 30 days.",
        "Top-up keeps everything already placed and appends from the day after the last entry. The nightly analysis run tops up every auto-generating site whose unwritten queue has fallen below its monthly target.",
        "Phrasings of one query collapse into one entry, so the plan does not schedule 'agency seo' and 'seo for agencies' as two articles that compete with each other.",
        "Terms flagged as keyword-provider noise are scored down for you and refused by the unattended path, so an unattended run never writes 'S Eo: A Complete Guide'.",
      ],
    },
    {
      title: "What the scheduler does, and when",
      lead:
        "A cron writes drafts from the top of the queue. It writes into Review and nowhere else.",
      bullets: [
        "It runs at 07:00 UTC on Vercel, and again at 01:00, 13:00 and 19:00 UTC from a GitHub Actions workflow calling the same endpoint with the same secret.",
        "Each run writes at most 2 drafts across every site, serving the site that has waited longest first, and stops at each site's weekly pace and the account's monthly quota.",
        "Only sites with auto-generation switched on and not paused are served. A site whose own pages could not be read well enough to judge relevance is skipped, with the reason recorded, rather than guessed at.",
        "Every draft lands in Review. The generator does not publish and has no setting that makes it publish.",
        "When a draft is written, the account's members are emailed the keyword, the word count, the fact-check verdict and the reasons the topic was chosen.",
      ],
    },
    {
      title: "Editing the plan",
      lead:
        "Each card is a keyword with a shape, a length band and whatever you want the writer to know.",
      bullets: [
        "Move opens a date picker and re-dates the entry. Remove deletes the entry, keeps the keyword, and marks it excluded so the next top-up does not put it straight back.",
        "The lightbulb opens Instructions: free text plus a length band (short 1,200-1,600 words, medium 1,600-2,400, long 2,400-3,200, comprehensive 3,200-4,200, or auto to follow the research). The writer is given the text verbatim.",
        "The question badge opens the interview: questions generated for that keyword, with a count of the ones still unanswered. Your answers are quoted to the writer as your first-hand experience, and it is told to use nothing beyond what you wrote.",
        "Every write from a card is filtered by the entry's id and the workspace the sidebar is on, so a stale tab cannot edit another site's plan.",
        "Up to three cards show per day, then a '+N more' count.",
      ],
    },
  ],
  cannotYet: [
    "Drag a card between days. Move uses a date picker.",
    "Plan across more than one site at once: a plan is always one workspace's.",
    "Promise a publish minute. Generation fires four times a day, so a draft arrives within that window, not at a chosen time.",
    "Instructions, questions, the 60-entry cap and top-up are specified in the planner update (#67). Until it lands, drafts are briefed from research alone and the plan grows one draft per run.",
  ],
};
