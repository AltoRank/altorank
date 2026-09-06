/**
 * Writing the first week in parallel instead of over a day.
 *
 * The measured cost of a draft is OBSERVED_SECONDS_PER_ARTICLE (103s) and a
 * function has RUN_BUDGET_SECONDS (300s), so one invocation fits two drafts and
 * `cron/generate` caps itself at MAX_ARTICLES_PER_RUN for that reason. Four runs
 * a day at two each is about eight articles a day across every workspace, which
 * is why a new account's seven drafts took roughly a day to appear even though
 * the entitlement was granted instantly.
 *
 * Raising the cap does not fix it: three sequential drafts is ~310s against a
 * 300s function, which generate-queue.ts already worked out and refused. The
 * constraint is per-invocation wall clock, not per-day capacity, so the fix is
 * more invocations rather than a longer one. Each draft here gets its own
 * request, its own 300s, and runs concurrently with the others: seven drafts
 * finish in about the time one takes.
 *
 * Deliberately fire-and-forget. The caller is the onboarding stream, which is
 * itself inside a 300s budget and has already written the first draft inline;
 * waiting for six more would put it right back over the limit. Nothing is lost
 * if a request fails, because the calendar entry stays unfulfilled and
 * `cron/generate` picks it up on its next pass, exactly as it did before.
 */
import { isAuthorizedCron } from "@/lib/cron-auth";

/** One draft to write: the keyword, and the plan entry it belongs to. */
export interface FanOutTarget {
  keywordId: string;
  term: string;
}

export interface FanOutResult {
  /** Requests actually dispatched. */
  dispatched: number;
  /** Why nothing was dispatched, when nothing was. */
  skipped: "no-secret" | "no-base-url" | "nothing-to-do" | null;
}

/**
 * Most drafts one signup will fan out.
 *
 * Seven is the free week (FREE_DRAFTS), and the first is written inline by the
 * onboarding pipeline, so six is the rest of it. A paid site plans thirty and
 * the same six go out fast; the remainder stays with the cron, because thirty
 * concurrent model calls is a spike at the provider rather than a feature.
 */
export const MAX_FAN_OUT = 6;

/**
 * Dispatch one request per target and return immediately.
 *
 * Requires CRON_SECRET: the endpoint is server-to-server, and without the
 * secret there is no way to authenticate a call that has no user session. When
 * it is missing this no-ops and says so rather than throwing, so a self-hosted
 * install that has not set it degrades to the old cron-paced behaviour instead
 * of failing onboarding.
 */
export function fanOutDrafts(
  workspaceId: string,
  targets: readonly FanOutTarget[],
  deps: {
    baseUrl?: string | null;
    secret?: string | null;
    fetchImpl?: typeof fetch;
  } = {},
): FanOutResult {
  const secret = deps.secret ?? process.env.CRON_SECRET ?? null;
  const baseUrl = deps.baseUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? null;
  const doFetch = deps.fetchImpl ?? fetch;

  if (targets.length === 0) return { dispatched: 0, skipped: "nothing-to-do" };
  if (!secret) return { dispatched: 0, skipped: "no-secret" };
  if (!baseUrl) return { dispatched: 0, skipped: "no-base-url" };

  const batch = targets.slice(0, MAX_FAN_OUT);
  for (const target of batch) {
    // No await, and the rejection is swallowed on purpose: a dispatch that
    // never lands leaves the plan entry for the cron, which is the same place
    // it would have been written before this existed.
    void doFetch(`${baseUrl.replace(/\/$/, "")}/api/internal/draft`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-cron-secret": secret },
      body: JSON.stringify({ workspaceId, keywordId: target.keywordId, keyword: target.term }),
    }).catch(() => undefined);
  }
  return { dispatched: batch.length, skipped: null };
}

/** Shared by the route so the auth rule lives in one place. */
export function authorised(request: Request): boolean {
  return isAuthorizedCron(request);
}
