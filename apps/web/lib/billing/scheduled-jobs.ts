// ---------------------------------------------------------------------------
// What each scheduled job does, and what its spend is filed under
// ---------------------------------------------------------------------------
//
// The Operations schedule (app/(dashboard)/admin/scheduled-work.tsx) reads
// the times from vercel.json. Everything else about a job is kept here, and
// lib/billing/__tests__/scheduled-jobs.test.ts fails when vercel.json names a
// cron this map does not: three of twelve were missing (refresh, site-pages,
// ops-digest) and showed their raw path and a dash for cost, which on that
// table reads as "spent nothing".

import type { JobKey } from "./forecast";

export interface ScheduledJob {
  /** What its spend is filed under (jobForSpend); null for a job that buys nothing. */
  key: JobKey | null;
  does: string;
  drivers: string;
}

export const SCHEDULED_JOBS: Record<string, ScheduledJob> = {
  "/api/cron/analyze": {
    key: "analyze",
    does: "First look at a workspace: crawl, profile, discovery, authority. One-off, batches of 3. Actual includes the first looks setup buys.",
    drivers: "workspaces never analysed",
  },
  "/api/cron/serp": {
    key: "serp",
    does: "Posts one standard-queue SERP per tracked keyword; weekly backlink sync when due.",
    drivers: "planned + shipped + article keywords, cap 200",
  },
  "/api/cron/serp-collect": {
    // Its cost is the serp row's: the queue charges on collection, and
    // showing the forecast twice read as double the spend.
    key: null,
    does: "Collects the SERPs posted at 03:00 and writes rankings. Counted under serp.",
    drivers: "same tasks",
  },
  "/api/cron/analytics": { key: null, does: "GSC / GA4 pull for connected workspaces. Google APIs, no provider spend.", drivers: "—" },
  "/api/cron/exchange": { key: null, does: "Backlink-exchange matching between workspaces. No provider spend.", drivers: "—" },
  "/api/cron/generate": {
    key: "generate",
    does: "Writes the day's drafts: advanced SERP + related keywords, then the model.",
    drivers: "auto-generate on × weekly limit (default 2)",
  },
  "/api/cron/publish": { key: null, does: "Pushes approved articles to their CMS. No provider spend.", drivers: "—" },
  "/api/cron/reports": { key: null, does: "Monthly PDF from stored data. No provider spend.", drivers: "—" },
  "/api/cron/geo": {
    key: "geo",
    does: "AI-visibility probes: every enabled prompt across 4 engines, with web search.",
    drivers: "opt-in workspaces × prompts × 4, max 3 workspaces/run",
  },
  "/api/cron/refresh": {
    key: "refresh",
    does: "Content refresh: finds pages to improve from Search Console, then rewrites one due page per site as a proposal. The rewrite is a model call.",
    drivers: "refresh-on workspaces, enabled weekdays, max 2 rewrites/run",
  },
  "/api/cron/site-pages": {
    key: null,
    does: "Re-reads one site's sitemap and pages, and checks whether a draft went live on the site. Public pages only, no provider spend.",
    drivers: "—",
  },
  "/api/cron/ops-digest": {
    key: null,
    does: "Emails the operators what went wrong yesterday. No provider spend.",
    drivers: "—",
  },
};
