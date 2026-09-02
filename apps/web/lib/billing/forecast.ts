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
  /** workspaces.auto_generate_weekly_limit; cron/generate defaults to 2. */
  weeklyLimit: number | null;
  geoTracking: boolean;
  enabledPrompts: number;
  needsFirstLook: boolean;
};

export type JobKey = "serp" | "backlinks" | "generate" | "geo" | "analyze";

export type WorkspaceForecast = {
  id: string;
  domain: string;
  /** USD per month, by job. `analyze` is a one-off and reported separately. */
  monthly: Record<Exclude<JobKey, "analyze">, number>;
  oneOff: number;
  total: number;
};

export function forecastWorkspace(w: WorkspaceDrivers, rates: RateCard = DEFAULT_RATES): WorkspaceForecast {
  const tracked = Math.min(w.trackedKeywords, TRACK_CAP);
  const serp = tracked * rates.serpQueued * DAYS;
  const backlinks = rates.backlinksSync * WEEKS;

  // cron/generate: `auto_generate_weekly_limit ?? 2` drafts a week, opt-in.
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
  byJob: Record<Exclude<JobKey, "analyze">, number>;
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

/**
 * Which scheduled job a recorded operation belongs to, so actuals can sit in
 * the same row as the forecast. Null for anything not driven by a cron.
 */
export function jobForOperation(provider: string, operation: string): JobKey | null {
  if (provider === "anthropic") return "generate";
  if (operation.startsWith("/serp/google/organic/task_")) return "serp";
  if (operation.startsWith("/serp/google/organic/tasks_ready")) return "serp";
  if (operation.startsWith("/backlinks/")) return "backlinks";
  if (operation.startsWith("/ai_optimization/")) return "geo";
  if (operation.startsWith("/serp/google/organic/live/advanced")) return "generate";
  if (operation.startsWith("/keywords_data/google_ads/keywords_for_keywords")) return "generate";
  return null;
}

/**
 * A rate card with any unit we have measured enough times swapped in for its
 * default. Three observations is the floor: one call is an anecdote.
 */
export function measuredRates(
  observed: Array<{ provider: string; operation: string; costUsd: number | null; articleId?: string | null }>,
  base: RateCard = DEFAULT_RATES,
): { rates: RateCard; measured: Array<keyof RateCard> } {
  const avg = (pred: (o: (typeof observed)[number]) => boolean): number | null => {
    const xs = observed.filter((o) => pred(o) && o.costUsd !== null).map((o) => o.costUsd as number);
    return xs.length >= 3 ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
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
  const model = observed.filter((o) => o.provider === "anthropic" && o.articleId && o.costUsd !== null);
  const articles = new Set(model.map((o) => o.articleId));
  if (articles.size >= 3) {
    set("modelPerArticle", model.reduce((a, o) => a + (o.costUsd as number), 0) / articles.size);
  }
  return { rates, measured };
}
