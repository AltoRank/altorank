// Runs the agent-readiness checks for the public endpoint and the share page,
// under one deadline, and keeps the result for six hours so a shared link
// never re-crawls the site it describes.
//
// The checker itself is lib/audit/agent-readiness.ts and is reused as is;
// this module only decides how long it may take and where the answer lives.

import {
  runAgentReadiness,
  fetchResource,
  ReadinessDeadline,
  FETCH_TIMEOUT_MS,
  type FetchedResource,
  type ResourceFetcher,
} from "@/lib/audit/agent-readiness";
import type { createServiceClient } from "@/lib/supabase/server";
import { shapePublicCheck, type PublicCheckData } from "./shape";

type ServiceClient = ReturnType<typeof createServiceClient>;

/**
 * Wall-clock budget for one run. Vercel Hobby allows 60s, but a visitor is
 * watching a progress state, and 25s is where a wait stops being a check and
 * becomes a hang. Checks that have not run by then come back unknown.
 */
export const DEADLINE_MS = 25_000;
export const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

type TimedFetch = (url: string, timeoutMs: number) => Promise<FetchedResource>;

/**
 * A fetcher that hands each request only the time left before `deadlineAt`
 * and stops the run once that is spent. A fetch that fails exactly because
 * the deadline arrived is a deadline, not an unreachable URL: reporting it
 * as {status: 0} would let "no sitemap" be written down about a site that
 * simply took long to answer.
 */
export function deadlineFetcher(
  deadlineAt: number,
  fetchImpl: TimedFetch = fetchResource,
  now: () => number = Date.now,
): ResourceFetcher {
  return async (url) => {
    const remaining = deadlineAt - now();
    if (remaining <= 0) throw new ReadinessDeadline();
    const res = await fetchImpl(url, Math.min(FETCH_TIMEOUT_MS, remaining));
    if (res.status === 0 && now() >= deadlineAt) throw new ReadinessDeadline();
    return res;
  };
}

/** Run the nine checks against a normalised domain, bounded by DEADLINE_MS. */
export async function runPublicCheck(
  domain: string,
  opts: { deadlineMs?: number; fetchImpl?: TimedFetch; now?: () => number } = {},
): Promise<PublicCheckData> {
  const now = opts.now ?? Date.now;
  const fetcher = deadlineFetcher(now() + (opts.deadlineMs ?? DEADLINE_MS), opts.fetchImpl, now);
  const result = await runAgentReadiness(domain, fetcher);
  return shapePublicCheck(result, new Date(now()));
}

/** A result worth keeping: every check ran and the site answered. */
export function isCacheable(data: PublicCheckData): boolean {
  return !data.error && !data.partial;
}

export function isFresh(createdAt: string, now: number = Date.now()): boolean {
  return now - new Date(createdAt).getTime() < CACHE_TTL_MS;
}

export async function loadCachedCheck(
  supabase: ServiceClient,
  domain: string,
): Promise<PublicCheckData | null> {
  const { data } = await supabase
    .from("public_checks")
    .select("result, created_at")
    .eq("domain", domain)
    .maybeSingle();
  if (!data || !isFresh(data.created_at)) return null;
  return data.result as PublicCheckData;
}

export async function storeCheck(supabase: ServiceClient, data: PublicCheckData): Promise<void> {
  if (!isCacheable(data)) return;
  const { error } = await supabase.from("public_checks").upsert({
    domain: data.domain,
    score: data.score,
    result: data,
    created_at: data.checked_at,
  });
  if (error) console.error("[public-check] cache write", data.domain, error.message);
}
