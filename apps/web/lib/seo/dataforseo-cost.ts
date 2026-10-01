// ---------------------------------------------------------------------------
// What a DataForSEO call can cost, before it is made
// ---------------------------------------------------------------------------
//
// Every response reports its own `cost`, which is what spend records. A first
// look's budget needs the number before the call (lib/billing/spend-scope.ts):
// it claims this estimate, and settles the reported cost once the call
// answers. So the estimate is meant to be at or above the bill - list prices,
// every row a task may return - and is corrected down at settle.
//
// List prices checked 2026-09-06 against DataForSEO's pricing pages and live
// calls (private notes, B-api-cost-efficiency): Labs $0.012 a task plus
// $0.00012 a returned row; Google Ads keyword data on the live queue $0.09 a
// task; a live organic results page $0.002 per ten results (doubled here: the
// founder's spec prices a top-10 page at $0.004); the standard queue $0.0006;
// backlinks $0.02 a call plus rows; a rendered instant page $0.0051.

/** For an endpoint nobody listed here: dear enough that a first look notices. */
export const UNLISTED_TASK_USD = 0.1;

type Task = Record<string, unknown>;

const rows = (task: Task, fallback: number): number => {
  const limit = Number(task.limit);
  return Number.isFinite(limit) && limit > 0 ? limit : fallback;
};

function perTask(endpoint: string, task: Task): number {
  if (endpoint.startsWith("/dataforseo_labs/")) {
    // keyword_overview bills per keyword sent; the rest per row returned.
    const keywords = Array.isArray(task.keywords) ? task.keywords.length : 0;
    const items = endpoint.includes("/keyword_overview/") ? Math.max(1, keywords) : rows(task, 100);
    return 0.012 + 0.00012 * items;
  }
  if (endpoint.startsWith("/keywords_data/")) return endpoint.endsWith("/live") ? 0.09 : 0.06;
  if (endpoint.startsWith("/serp/")) {
    if (endpoint.includes("/task_post")) return 0.0012;
    const depth = Number(task.depth);
    const pages = Number.isFinite(depth) && depth > 0 ? Math.ceil(depth / 10) : 1;
    return 0.004 * pages;
  }
  if (endpoint.startsWith("/backlinks/")) {
    const targets = task.targets && typeof task.targets === "object" ? Object.keys(task.targets as object).length : 0;
    return 0.02 + 0.00003 * Math.max(rows(task, 100), targets);
  }
  if (endpoint.startsWith("/on_page/instant_pages")) return 0.006;
  return UNLISTED_TASK_USD;
}

/** The most `body` sent to `endpoint` should cost, in USD. */
export function estimateDataForSEOUsd(endpoint: string, body: readonly unknown[]): number {
  const tasks = (body.length ? body : [{}]).map((t) => (t && typeof t === "object" ? (t as Task) : {}));
  return tasks.reduce((sum, task) => sum + perTask(endpoint, task), 0);
}
