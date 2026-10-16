/**
 * What the scheduled work is expected to cost, from what the users have set.
 *
 * Operations showed what providers charged. It could not answer the question
 * that comes first - "what is this going to cost next month?" - which depends
 * not on the rate card alone but on the users: how many keywords they chose to
 * track, whether auto-generate is on, how many GEO prompts they defined. Those
 * are the drivers, and every rule here mirrors the cron that spends the money,
 * so the number is a forecast of the code, not a guess about it.
 *
 * Unit costs come from actuals when there are enough observations, and from
 * the dated defaults below otherwise. The card says which.
 */

/** Days and weeks in an average month; the crons run daily and weekly. */
const DAYS = 30.4;
const WEEKS = 4.35;

export type RateCard = {
  /** One standard-queue SERP, cron/serp. */
  serpQueued: number;
  /** One backlinks/backlinks call, weekly inside cron/serp. */
  backlinksSync: number;
  /** DataForSEO per article written: advanced SERP + keywords_for_keywords. */
  dfsPerArticle: number;
  /** Model cost per article, from anthropic rows with an article_id. */
  modelPerArticle: number;
  /** One LLM Responses probe with web search, cron/geo. */
  geoProbe: number;
  /** One full first look, cron/analyze - one-off per workspace. */
  firstLook: number;
};

/** Verified 2026-09-02 against live calls and provider_spend. */
export const DEFAULT_RATES: RateCard = {
  serpQueued: 0.0006,
  backlinksSync: 0.05,
  dfsPerArticle: 0.002 + 0.09,
  modelPerArticle: 0.16,
  geoProbe: 0.066,
  firstLook: 0.12,
};

/** How many engines cron/geo asks per prompt. Mirrors AI_ENGINES. */
export const GEO_ENGINES = 4;
/** cron/serp tracks at most this many keywords per workspace. */
export const TRACK_CAP = 200;
/** cron/geo probes at most this many workspaces per weekly run. */
export const GEO_WORKSPACES_PER_RUN = 3;

export type WorkspaceDrivers = {
  id: string;
  domain: string;
  /** planned + shipped keywords, plus article keywords not already counted. */
  trackedKeywords: number;
  autoGenerate: boolean;
  /** workspaces.auto_generate_weekly_limit; cron/generate defaults to PAID_DEFAULT_PACE. */
  weeklyLimit: number | null;
  geoTracking: boolean;
  enabledPrompts: number;
  needsFirstLook: boolean;
};

/**
 * The scheduled jobs the Operations schedule reports an actual cost for.
 * `analyze` is the first look, whether the nightly cron or setup bought it;
 * `refresh` is the scheduled rewrite, which has no forecast of its own.
 */
export type JobKey = "serp" | "backlinks" | "generate" | "geo" | "analyze" | "refresh";
/** The jobs with a monthly forecast. */
export type ForecastJob = "serp" | "backlinks" | "generate" | "geo";

export type WorkspaceForecast = {
  id: string;
  domain: string;
  /** USD per month, by job. `analyze` is a one-off and reported separately. */
  monthly: Record<ForecastJob, number>;
  oneOff: number;
  total: number;
};

export function forecastWorkspace(w: WorkspaceDrivers, rates: RateCard = DEFAULT_RATES): WorkspaceForecast {
  const tracked = Math.min(w.trackedKeywords, TRACK_CAP);
  const serp = tracked * rates.serpQueued * DAYS;
  const backlinks = rates.backlinksSync * WEEKS;

  // cron/generate: `auto_generate_weekly_limit ?? PAID_DEFAULT_PACE` drafts a week, opt-in.
  const perWeek = w.autoGenerate ? (w.weeklyLimit ?? 2) : 0;
  const generate = perWeek * WEEKS * (rates.dfsPerArticle + rates.modelPerArticle);

  // cron/geo: every enabled prompt across every engine, weekly, opt-in, and
  // only when there is something to ask - the code refuses an empty prompt
  // set on purpose.
  const geo = w.geoTracking && w.enabledPrompts > 0
    ? w.enabledPrompts * GEO_ENGINES * rates.geoProbe * WEEKS
    : 0;

  const oneOff = w.needsFirstLook ? rates.firstLook : 0;
  const monthly = { serp, backlinks, generate, geo };
  const total = serp + backlinks + generate + geo;
  return { id: w.id, domain: w.domain, monthly, oneOff, total };
}

export type Forecast = {
  perWorkspace: WorkspaceForecast[];
  byJob: Record<ForecastJob, number>;
  oneOff: number;
  monthlyTotal: number;
  /** Set when more workspaces opted into GEO than one weekly run can serve. */
  geoBacklog: number;
};

export function forecastAll(workspaces: WorkspaceDrivers[], rates: RateCard = DEFAULT_RATES): Forecast {
  const perWorkspace = workspaces.map((w) => forecastWorkspace(w, rates));
  const byJob = { serp: 0, backlinks: 0, generate: 0, geo: 0 };
  let oneOff = 0;
  for (const f of perWorkspace) {
    byJob.serp += f.monthly.serp;
    byJob.backlinks += f.monthly.backlinks;
    byJob.generate += f.monthly.generate;
    byJob.geo += f.monthly.geo;
    oneOff += f.oneOff;
  }
  const geoOptIns = workspaces.filter((w) => w.geoTracking && w.enabledPrompts > 0).length;
  return {
    perWorkspace,
    byJob,
    oneOff,
    monthlyTotal: byJob.serp + byJob.backlinks + byJob.generate + byJob.geo,
    geoBacklog: Math.max(0, geoOptIns - GEO_WORKSPACES_PER_RUN),
  };
}

/** provider_spend.job, as the schedule files it. A job not named here is not a scheduled one. */
const JOB_OF: Record<string, JobKey> = {
  "cron.generate": "generate",
  "cron.serp": "serp",
  // observedCron's names use underscores (cron.serp_collect), not the path's
  // hyphen; lib/billing/__tests__/scheduled-jobs.test.ts reads them from the
  // routes so the two cannot drift.
  "cron.serp_collect": "serp",
  "cron.geo": "geo",
  "cron.analyze": "analyze",
  "cron.refresh": "refresh",
  // Setup is a first look bought from the wizard instead of the night.
  onboarding: "analyze",
};

/**
 * Which scheduled job a recorded call belongs to, so actuals can sit in the
 * same row as the forecast. Null for anything not driven by a cron.
 *
 * By the work that bought it (provider_spend.job, migration 116) when the row
 * says: every call a cron makes is filed under that cron (observedCron), and
 * setup's under the first look. A row from before that is read the old way,
 * by its endpoint, with two corrections: a call made under a first look's
 * budget (a `stage`) is the first look's, and a model call is the writer's
 * only when it was bought for an article. Before, every model call - a
 * refresh, the wizard's profile read, setup's - was filed under generate, and
 * the first look's Actual was always empty.
 */
export function jobForSpend(row: {
  provider: string;
  operation: string;
  job?: string | null;
  stage?: string | null;
  hasArticle?: boolean;
}): JobKey | null {
  if (row.job) {
    const job = JOB_OF[row.job] ?? null;
    // The weekly backlink sync runs inside cron/serp and has a row of its own.
    if (job === "serp" && row.operation.startsWith("/backlinks/")) return "backlinks";
    return job;
  }
  if (row.stage) return "analyze";
  if (row.operation.startsWith("editor/")) return null;
  if (row.provider === "anthropic") return row.hasArticle ? "generate" : null;
  if (row.operation.startsWith("/serp/google/organic/task_")) return "serp";
  if (row.operation.startsWith("/serp/google/organic/tasks_ready")) return "serp";
  if (row.operation.startsWith("/backlinks/")) return "backlinks";
  if (row.operation.startsWith("/ai_optimization/")) return "geo";
  if (row.operation.startsWith("/serp/google/organic/live/advanced")) return "generate";
  if (row.operation.startsWith("/keywords_data/google_ads/keywords_for_keywords")) return "generate";
  return null;
}

/** Calls summed by provider and operation: what the rate card is measured from. */
export interface PricedGroup {
  provider: string;
  operation: string;
  /** Bought for an article. */
  hasArticle: boolean;
  /** Calls that reported a price. */
  priced: number;
  /** What those calls cost. */
  usd: number;
}

/**
 * A rate card with any unit we have measured enough times swapped in for its
 * default. Three observations is the floor: one call is an anecdote.
 */
export function measuredRates(
  observed: Array<{ provider: string; operation: string; costUsd: number | null; articleId?: string | null }>,
  base: RateCard = DEFAULT_RATES,
): { rates: RateCard; measured: Array<keyof RateCard> } {
  const priced = observed.filter((o) => o.costUsd !== null);
  const groups: PricedGroup[] = priced.map((o) => ({ provider: o.provider, operation: o.operation, hasArticle: Boolean(o.articleId), priced: 1, usd: o.costUsd as number }));
  const articles = new Set(priced.filter((o) => o.provider === "anthropic" && o.articleId).map((o) => o.articleId));
  return measuredRatesFromGroups(groups, articles.size, base);
}

/**
 * The same from sums (lib/admin/spend-summary.ts), so the card is measured on
 * every recorded call rather than on the rows one read returned.
 * `modelArticles` is the number of distinct articles priced model calls were
 * bought for.
 */
export function measuredRatesFromGroups(
  groups: readonly PricedGroup[],
  modelArticles: number,
  base: RateCard = DEFAULT_RATES,
): { rates: RateCard; measured: Array<keyof RateCard> } {
  const avg = (pred: (g: PricedGroup) => boolean): number | null => {
    let n = 0;
    let usd = 0;
    for (const g of groups) {
      if (!pred(g)) continue;
      n += g.priced;
      usd += g.usd;
    }
    return n >= 3 ? usd / n : null;
  };
  const rates: RateCard = { ...base };
  const measured: Array<keyof RateCard> = [];
  const set = (k: keyof RateCard, v: number | null) => { if (v !== null) { rates[k] = v; measured.push(k); } };

  set("serpQueued", avg((o) => o.operation.startsWith("/serp/google/organic/task_get/")));
  set("backlinksSync", avg((o) => o.operation.startsWith("/backlinks/backlinks")));
  set("geoProbe", avg((o) => o.operation.startsWith("/ai_optimization/")));

  const serpAdv = avg((o) => o.operation.startsWith("/serp/google/organic/live/advanced"));
  const kfk = avg((o) => o.operation.startsWith("/keywords_data/google_ads/keywords_for_keywords"));
  if (serpAdv !== null && kfk !== null) set("dfsPerArticle", serpAdv + kfk);

  // Model cost per article: total anthropic spend over distinct articles.
  if (modelArticles >= 3) {
    const model = groups.filter((g) => g.provider === "anthropic" && g.hasArticle).reduce((a, g) => a + g.usd, 0);
    set("modelPerArticle", model / modelArticles);
  }
  return { rates, measured };
}
