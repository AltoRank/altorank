// ---------------------------------------------------------------------------
// SERP position tracking via DataForSEO
// ---------------------------------------------------------------------------

import { post, get } from "./client";

/** Single organic SERP item from DataForSEO. */
type DFSSerpItem = {
  type: string;
  rank_group: number;
  rank_absolute: number;
  domain: string;
  url: string;
  title: string;
};

/** Result wrapper for a single SERP task. */
type SerpTaskResult = {
  keyword: string;
  items: DFSSerpItem[] | null;
};

export type RankingResult = {
  keyword: string;
  position: number | null;
  url: string | null;
};

/**
 * Check where `domain` ranks for each keyword using
 * DataForSEO's SERP organic live/regular endpoint.
 */
export async function checkRankings(
  keywords: string[],
  domain: string,
  options?: { languageCode?: string; locationCode?: number },
): Promise<RankingResult[]> {
  if (keywords.length === 0) return [];

  const languageCode = options?.languageCode ?? "en";
  const locationCode = options?.locationCode ?? 2840;

  // Normalise domain for matching (strip protocol + trailing slash)
  const normalisedDomain = domain
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "")
    .toLowerCase();

  const tasks = keywords.map((keyword) => ({
    keyword,
    location_code: locationCode,
    language_code: languageCode,
  }));

  const response = await post<SerpTaskResult>(
    "/serp/google/organic/live/regular",
    tasks,
  );

  const results: RankingResult[] = [];

  for (const task of response.tasks) {
    if (!task.result) continue;

    for (const result of task.result) {
      const kw = result.keyword;
      const { position, url } = positionFor(result.items, normalisedDomain);
      results.push({ keyword: kw, position, url });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// The queued path, for the nightly cron
// ---------------------------------------------------------------------------
//
// The same SERP costs $0.002 live (about six seconds), $0.0012 priority
// (about a minute) and $0.0006 on the standard queue (about five minutes).
// The cron runs at three in the morning; nothing is waiting on it. It had been
// paying the live rate for every keyword since it was written - at the
// 200-keyword cap, $0.40 a night per workspace where $0.12 would do.
//
// So the cron posts tasks and a second cron collects them. checkRankings()
// above stays as it is for the interactive path, where a person has pressed
// "check now" and six seconds is the right trade.
//
// No state table. The tag on each task carries the workspace and keyword id,
// and tasks_ready hands it back, so the collector needs nothing from us to
// know where a result belongs. DataForSEO keeps uncollected results for three
// days, so a collector that misses a night catches up the next.

/** What we stamp on a task so the result can find its way home. */
const TAG_PREFIX = "rank";

export function encodeRankTag(workspaceId: string, keywordId: string): string {
  return `${TAG_PREFIX}|${workspaceId}|${keywordId}`;
}

export function decodeRankTag(tag: string | null | undefined): { workspaceId: string; keywordId: string } | null {
  if (!tag) return null;
  const [prefix, workspaceId, keywordId] = tag.split("|");
  if (prefix !== TAG_PREFIX || !workspaceId || !keywordId) return null;
  return { workspaceId, keywordId };
}

/** Where `domain` sits in a list of SERP items, or null when it does not. */
export function positionFor(
  items: DFSSerpItem[] | null | undefined,
  domain: string,
): { position: number | null; url: string | null } {
  const normalised = domain.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "").toLowerCase();
  for (const item of items ?? []) {
    if (item.type !== "organic") continue;
    const itemDomain = (item.domain ?? "").replace(/^www\./, "").toLowerCase();
    if (itemDomain === normalised) return { position: item.rank_group, url: item.url };
  }
  return { position: null, url: null };
}

/** DataForSEO accepts at most 100 tasks per POST (40006 above that). */
const TASKS_PER_POST = 100;

export type RankTask = { keywordId: string; term: string };

/**
 * Queue one SERP per keyword at the standard rate. Returns how many were
 * accepted; the results arrive via collectRankingTasks() later.
 */
export async function postRankingTasks(
  workspaceId: string,
  tasks: RankTask[],
  options?: { languageCode?: string; locationCode?: number },
): Promise<{ posted: number; failed: number }> {
  if (!tasks.length) return { posted: 0, failed: 0 };
  const languageCode = options?.languageCode ?? "en";
  const locationCode = options?.locationCode ?? 2840;

  let posted = 0;
  let failed = 0;
  for (let i = 0; i < tasks.length; i += TASKS_PER_POST) {
    const batch = tasks.slice(i, i + TASKS_PER_POST).map((t) => ({
      keyword: t.term,
      location_code: locationCode,
      language_code: languageCode,
      // 1 is the standard queue. 2 doubles the price for a minute's speed.
      priority: 1,
      tag: encodeRankTag(workspaceId, t.keywordId),
    }));
    const res = await post<unknown>("/serp/google/organic/task_post", batch);
    for (const task of res.tasks ?? []) {
      // 20100 is "Task Created"; anything else on a task means it was refused.
      if (task.status_code === 20100) posted += 1;
      else failed += 1;
    }
  }
  return { posted, failed };
}

type ReadyTask = { id: string; tag?: string | null; endpoint_regular?: string | null };

export type CollectedRanking = {
  workspaceId: string;
  keywordId: string;
  keyword: string;
  items: DFSSerpItem[] | null;
};

/**
 * Fetch every finished rank task we posted and have not yet collected.
 *
 * tasks_ready lists only uncollected tasks from the last three days, up to
 * 1,000 per call, so this is idempotent: run it twice and the second run
 * finds nothing. Tasks with a tag we did not write are left alone - the
 * account may have other queued work.
 */
export async function collectRankingTasks(): Promise<CollectedRanking[]> {
  const ready = await get<ReadyTask>("/serp/google/organic/tasks_ready");
  const ours: Array<{ id: string; workspaceId: string; keywordId: string }> = [];
  for (const task of ready.tasks ?? []) {
    for (const r of task.result ?? []) {
      const decoded = decodeRankTag(r.tag);
      if (decoded && r.id) ours.push({ id: r.id, ...decoded });
    }
  }

  const out: CollectedRanking[] = [];
  for (const t of ours) {
    const res = await get<SerpTaskResult>(`/serp/google/organic/task_get/regular/${t.id}`).catch(() => null);
    for (const task of res?.tasks ?? []) {
      for (const result of task.result ?? []) {
        out.push({ workspaceId: t.workspaceId, keywordId: t.keywordId, keyword: result.keyword, items: result.items });
      }
    }
  }
  return out;
}
