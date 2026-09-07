// ---------------------------------------------------------------------------
// Reading the pages the customer already has, in the first minute
// ---------------------------------------------------------------------------
//
// The gap this closes, stated plainly: the wizard asks for the blog, says
// "Used to find your existing pages for internal links", and then nothing
// fetches them. `detectLinks` reads the sitemap for URLs; the pages themselves
// were only ever read by `cron/site-pages`, which selects on
// `first_analysed_at` and does one workspace a night, so a customer who signed
// up this morning had an empty `site_pages` and a product that knew the count
// of their posts and nothing else about them.
//
// So onboarding reads them. Free (a plain GET and some regular expressions),
// technical (`lib/seo/tech-audit.ts` - status codes, tag lengths, H1 counts,
// canonicals, robots directives), and bounded, because it is sharing 300
// seconds with keyword discovery and a site with 600 posts must not eat them.
//
// Best effort throughout. Every failure here is a phase that says what
// happened and a run that carries on: a site with no sitemap, a robots.txt
// that refuses us, a server that times out - none of those is a reason for
// someone's onboarding to fail, and all of them are worth saying out loud.

import type { SupabaseClient } from "@supabase/supabase-js";
import { syncSitePages, type CrawlSummary } from "@/lib/seo/site-crawl";
import { e2eStubsEnabled, isReservedTestDomain, stubAssessExistingPages } from "@/lib/e2e/stubs";
import { plural } from "@/lib/utils";

/**
 * The budget, and why each number is what it is.
 *
 * `budgetMs` is the binding one. The onboarding worker's ceiling is 300s and
 * `analyseDomain` measured 61s-2.9min on two real runs (2026-09-07), so the
 * crawl gets 45 seconds and stops mid-site rather than pushing the run at the
 * platform's limit. At 3 workers and a 10s per-request timeout that is 40-100
 * pages on a healthy site; the cap is 40 so the number is predictable and the
 * rest is left to the nightly cron, which orders by `last_pages_crawl_at` and
 * is therefore self-healing.
 *
 * `concurrency` is 3 rather than the cron's 4: this runs beside the rest of
 * onboarding, and a stranger's server should not meet four of our sockets at
 * once for a job nobody asked them to serve.
 */
export const ONBOARDING_CRAWL = {
  maxPages: 40,
  concurrency: 3,
  timeoutMs: 10_000,
  budgetMs: 45_000,
} as const;

export interface PagesPhaseOutcome {
  status: "done" | "skipped" | "failed";
  /** One or two sentences for the run screen. Never claims more than happened. */
  detail: string;
  /** For the caller's log; not shown. */
  summary: CrawlSummary | null;
}

/**
 * What the crawl did, in the run screen's voice.
 *
 * Pure, so the sentences can be tested against a summary rather than against a
 * network. Every branch is a real outcome the crawl can reach, and each one
 * names the reason rather than reporting a zero: "0 pages checked" under a
 * site with no sitemap reads as "your site is empty", which is a different and
 * false claim.
 */
export function describeAssessment(summary: CrawlSummary): PagesPhaseOutcome {
  const tech = summary.tech;
  const skip = (detail: string): PagesPhaseOutcome => ({ status: "skipped", detail, summary });

  if (summary.robotsBlocked) {
    return skip("Your robots.txt asks crawlers not to read these pages, so we did not.");
  }
  if (summary.discovered === 0) {
    // Two different facts, and "no sitemap" is the wrong one to report for a
    // site whose sitemap index we simply did not finish walking inside the
    // budget. Discovery obeys the same deadline the page loop does, so this
    // branch is reachable on a large, slow site that has a perfectly good
    // sitemap.
    return skip(
      summary.truncated
        ? "Ran out of time reading your sitemap, so we did not check existing pages this time. The nightly crawl picks them up."
        : "No sitemap we could read, so there were no existing pages to check.",
    );
  }
  if (summary.pages.length === 0) {
    return skip(
      summary.disallowed > 0
        ? `Your robots.txt keeps us out of all ${plural(summary.disallowed, "page")} in the sitemap.`
        : "Found pages in the sitemap but ran out of time before reading any.",
    );
  }
  if (summary.fetched === 0) {
    return skip(`None of the ${plural(summary.pages.length, "page")} we tried would load.`);
  }

  const read = plural(summary.fetched, "page");
  const rest = tailNotes(summary);

  if (!tech || tech.findings === 0) {
    return { status: "done", detail: `Read ${read}. Nothing technical to fix.${rest}`, summary };
  }
  return {
    status: "done",
    detail:
      `Read ${read}. Found ${plural(tech.findings, "technical issue")} ` +
      `on ${tech.pagesWithIssues.toLocaleString()} of them.${rest}`,
    summary,
  };
}

/** The caveats that belong on the end of the sentence, when they apply. */
function tailNotes(summary: CrawlSummary): string {
  const notes: string[] = [];
  if (summary.truncated) {
    notes.push(`Stopped at ${summary.pages.length} of ${summary.discovered}; the nightly pass reads the rest.`);
  }
  if (summary.disallowed > 0) {
    notes.push(`${plural(summary.disallowed, "page")} skipped because robots.txt says so.`);
  }
  if (summary.failed > 0) {
    notes.push(`${plural(summary.failed, "page")} did not load.`);
  }
  return notes.length ? ` ${notes.join(" ")}` : "";
}

/**
 * Crawl what the site already published and record the technical assessment.
 *
 * Never throws: a caller in the middle of onboarding gets an outcome to show,
 * including for the write failure that `syncSitePages` raises on purpose.
 */
export async function assessExistingPages(
  supabase: SupabaseClient,
  workspaceId: string,
  domain: string,
): Promise<PagesPhaseOutcome> {
  // E2E_STUBS on a reserved test name: fixture pages and findings, no fetch
  // (lib/e2e/stubs.ts). Every e2e domain is `*.altorank.test`, which resolves
  // to nothing, so the real crawl there would spend the suite's time on DNS
  // failures and prove nothing.
  //
  // Only for those names, though, and that is the point. The other stubs
  // replace a model call, a DataForSEO call and a written article - things
  // that cost money and must never fire under test. This one replaces a plain
  // GET that costs nothing, so a real domain under E2E_STUBS=1 gets the real
  // crawl, which is how this phase is exercised against a live site with no
  // paid call anywhere in the run.
  if (e2eStubsEnabled() && isReservedTestDomain(domain)) {
    try {
      return await stubAssessExistingPages(supabase, workspaceId, domain);
    } catch (err) {
      return { status: "failed", detail: err instanceof Error ? err.message : "stub failed", summary: null };
    }
  }
  try {
    const summary = await syncSitePages(supabase, workspaceId, domain, {
      ...ONBOARDING_CRAWL,
      techChecks: true,
      // Every page, even one whose bytes have not changed since a previous
      // run: this is the run that computes the findings, and skipping the
      // fetch would leave `tech_findings` null on exactly the pages we already
      // know about.
      skipUnchanged: false,
    });
    return describeAssessment(summary);
  } catch (err) {
    return {
      status: "failed",
      detail: err instanceof Error ? err.message : "Could not read your existing pages.",
      summary: null,
    };
  }
}
