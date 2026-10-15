import type { Explainer } from "./types";
import { CHECK_IMPACT } from "@/lib/audit/agent-readiness";
import { describeCheckWeights } from "@/lib/public-check/shape";

/** "sitemap (3 points)": a check's id with its weight, from CHECK_IMPACT. */
const w = (id: keyof typeof CHECK_IMPACT) => `${id} (${CHECK_IMPACT[id]} point${CHECK_IMPACT[id] === 1 ? "" : "s"})`;

/**
 * Read from: lib/audit/agent-readiness.ts (the nine checks and CHECK_IMPACT,
 * the score weights; the per-check weights below are read from it, so this
 * copy cannot drift from the score again), lib/audit/domain-analysis.ts (where
 * the score is recorded), lib/audit/readiness-report.ts (artifacts and placement,
 * nothing persisted), components/dashboard/readiness-check.tsx.
 */
export const readinessExplainer: Explainer = {
  id: "readiness",
  title: "Agent readiness",
  intro:
    "Nine checks on whether an AI assistant can read a site at all, and the files that fix the ones that fail.",
  mountsAt: "app/(dashboard)/readiness/page.tsx, PageHead actions (this track).",
  sections: [
    {
      title: "Crawler access",
      lead: "Can the crawlers that feed AI assistants fetch the site, and are they told where to look?",
      bullets: [
        `${w("robots_reachable")}: /robots.txt answers with content. A 5xx or 403 is reported as 'not conclusive', not as 'you have no robots.txt': the server refused us, which is a different fact.`,
        `${w("ai_crawlers_allowed")}: GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, PerplexityBot, Google-Extended, CCBot and Applebot-Extended may each fetch the homepage. A group naming the bot overrides the wildcard group. Fix: remove or scope the Disallow rules.`,
        `${w("sitemap")}: declared with a Sitemap: line in robots.txt, or reachable at /sitemap.xml. Fix: add the line and confirm the file answers 200.`,
        `${w("content_signals")}: a Content-Signal line in robots.txt declaring ai-train, search and ai-input preferences. Optional and emerging; it is reported, not demanded.`,
      ],
    },
    {
      title: "Structured data",
      lead: "Does the homepage tell a machine what the business is, in a form it can parse?",
      bullets: [
        `${w("structured_data")}: any JSON-LD on the homepage, walking into @graph and nested nodes, because Yoast and most WordPress plugins emit one block with everything inside it. Fix: a generated JSON-LD block for the head.`,
        `${w("entity_schema")}: an Organization, LocalBusiness, Corporation or ProfessionalService type among them, which is what makes the site a resolvable entity rather than a document. Fix: a generated Organization block with placement notes for WordPress and Shopify.`,
        `${w("machine_readable")}: /llms.txt served as non-HTML text, or a markdown content type on the homepage. A redirect to the homepage does not count, which is how two sites were once recorded as having a file they do not have. Fix: an llms.txt built from the homepage's own content.`,
      ],
    },
    {
      title: "Page basics",
      lead: "Two checks on the homepage's own markup.",
      bullets: [
        `${w("title_meta")}: a <title> and a meta description are both present.`,
        `${w("single_h1")}: exactly one h1 element. The count is reported when it is not.`,
        "Both are read from the homepage HTML as fetched with a browser-shaped but honestly identified user agent, because a bare tool agent gets a stripped page from a good share of real sites.",
      ],
    },
    {
      title: "The score, and the fixes",
      lead: "Weighted by each check's effect on whether AI assistants can read the site, and identical to the Python checker verified against Cloudflare's scanner.",
      bullets: [
        `Each check carries points: ${describeCheckWeights()} The score is the points that passed as a percentage of the points checked, so a blocked AI crawler costs the most and a missing llms.txt the least.`,
        "Failed checks produce artifacts you can copy: JSON-LD blocks, an llms.txt, robots.txt edits, each with a note saying where on the site it goes.",
        "It reads public configuration only: the homepage, /robots.txt, /sitemap.xml and /llms.txt. Any domain, no workspace needed, nothing stored.",
        "A homepage that is unreachable or answers 4xx or 5xx yields a score of 0 with the reason, not a list of failed checks.",
      ],
    },
  ],
  cannotYet: [
    "Apply the fixes to your site. Artifacts are copy-and-paste, with placement instructions.",
    "Check pages beyond the homepage. The site audit crawls pages; this check reads configuration.",
    // Was: "Every nightly analysis records it". The score is written to
    // workspace_metrics only by analyseDomain (lib/audit/domain-analysis.ts),
    // which runs at the site's first look (the analyze cron, or the setup
    // run in lib/onboarding/pipeline.ts and its "Try again"); no cron re-runs
    // a completed one (app/api/cron/analyze/route.ts).
    "Re-check the score on a schedule or chart it over time. It is recorded against the workspace when the whole site is analysed, which is at first look and when a failed setup run is tried again, and the workspace chart does not plot it.",
    "Confirm a crawler actually fetched the site. robots.txt says what is allowed, not what happened.",
  ],
};
