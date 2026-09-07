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
 * The same mechanism - a POST to our own URL carrying CRON_SECRET - is what
 * takes the onboarding run out of the browser's request (`selfInvoke`):
 * /api/onboard/start dispatches the worker, the worker dispatches the first
 * draft, and every hop is its own invocation with its own budget. Nothing is
 * lost if a request fails, because the calendar entry stays unfulfilled and
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
  /**
   * Settles once every dispatched request has answered or failed. Never
   * rejects. A caller inside a serverless function hands this to `after()`
   * so the instance is not frozen with the requests still in its socket
   * buffer; nobody waits on it otherwise.
   */
  settled: Promise<void>;
}

/**
 * Most drafts one signup will fan out.
 *
 * Seven is the free week (FREE_DRAFTS), and the first is written by the
 * onboarding run itself, so six is the rest of it. A paid site plans thirty and
 * the same six go out fast; the remainder stays with the cron, because thirty
 * concurrent model calls is a spike at the provider rather than a feature.
 */
export const MAX_FAN_OUT = 6;

export interface SelfInvokeDeps {
  baseUrl?: string | null;
  secret?: string | null;
  fetchImpl?: typeof fetch;
}

export type SelfInvocation =
  | { baseUrl: string; secret: string; fetchImpl: typeof fetch }
  | { skipped: "no-secret" | "no-base-url" };

/**
 * Whether this install can call itself, and with what.
 *
 * Requires CRON_SECRET: the endpoints are server-to-server, and without the
 * secret there is no way to authenticate a call that has no user session.
 * When it is missing the callers degrade rather than throw - the fan-out to
 * the cron's pace, the onboarding worker to running inline - so a self-hosted
 * install that has not set it still onboards.
 */
export function selfInvocation(deps: SelfInvokeDeps = {}): SelfInvocation {
  const secret = deps.secret ?? process.env.CRON_SECRET ?? null;
  const baseUrl = deps.baseUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? null;
  if (!secret) return { skipped: "no-secret" };
  if (!baseUrl) return { skipped: "no-base-url" };
  return { baseUrl: baseUrl.replace(/\/$/, ""), secret, fetchImpl: deps.fetchImpl ?? fetch };
}

export function canSelfInvoke(deps: SelfInvokeDeps = {}): boolean {
  return !("skipped" in selfInvocation(deps));
}

/** POST `body` to one of our own routes, authenticated as the cron is. */
export function selfInvoke(path: string, body: unknown, how: Exclude<SelfInvocation, { skipped: string }>): Promise<Response> {
  return how.fetchImpl(`${how.baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-cron-secret": how.secret },
    body: JSON.stringify(body),
  });
}

/**
 * Dispatch one request per target and return immediately.
 */
export function fanOutDrafts(
  workspaceId: string,
  targets: readonly FanOutTarget[],
  deps: SelfInvokeDeps = {},
): FanOutResult {
  if (targets.length === 0) return { dispatched: 0, skipped: "nothing-to-do", settled: Promise.resolve() };
  const how = selfInvocation(deps);
  if ("skipped" in how) return { dispatched: 0, skipped: how.skipped, settled: Promise.resolve() };

  const batch = targets.slice(0, MAX_FAN_OUT);
  const requests = batch.map((target) =>
    // The rejection is swallowed on purpose: a dispatch that never lands
    // leaves the plan entry for the cron, which is the same place it would
    // have been written before this existed.
    selfInvoke("/api/internal/draft", { workspaceId, keywordId: target.keywordId, keyword: target.term }, how).then(
      () => undefined,
      () => undefined,
    ),
  );
  return { dispatched: batch.length, skipped: null, settled: Promise.all(requests).then(() => undefined) };
}

/** What the onboarding worker hands to /api/internal/draft for the first draft. */
export interface FirstDraftDispatch {
  workspaceId: string;
  runId: string;
  keyword: string;
  keywordId: string | null;
  selection?: { reasons: string[]; score: number; difficulty: number | null; volume: number | null };
}

/**
 * The first draft, in its own invocation. Unlike the fan-out this returns the
 * request itself: the worker wants to know if it never landed, because then
 * nothing will ever finish the run and it has to close it as failed.
 */
export function dispatchFirstDraft(
  body: FirstDraftDispatch,
  deps: SelfInvokeDeps = {},
): { request: Promise<Response> } | { skipped: "no-secret" | "no-base-url" } {
  const how = selfInvocation(deps);
  if ("skipped" in how) return { skipped: how.skipped };
  return { request: selfInvoke("/api/internal/draft", body, how) };
}

/** Shared by the route so the auth rule lives in one place. */
export function authorised(request: Request): boolean {
  return isAuthorizedCron(request);
}
