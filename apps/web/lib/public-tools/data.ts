// ---------------------------------------------------------------------------
// One DataForSEO call for a public tool
// ---------------------------------------------------------------------------
//
// For `kind: "data"` tools. A thin layer over lib/seo/client.ts, which
// already authenticates, retries transient faults and records the reported
// cost to provider_spend. This adds only what an anonymous endpoint needs:
// credentials missing or a provider error become ToolError("upstream") with
// a readable sentence, and the result rows come back unwrapped.
//
// Use `live` endpoints only. A queued task (task_post / task_get) outlives
// the route's deadline and there is no one to collect it.

import { post, hasDataForSEOCredentials, DataForSEOError } from "@/lib/seo/client";
import { ToolError } from "./errors";

const UNAVAILABLE = "The data source behind this tool is unavailable right now. Try again later.";

export function dataAvailable(): boolean {
  return hasDataForSEOCredentials();
}

/**
 * POST one task to a DataForSEO live endpoint and return its `result` rows.
 *
 * @param tool      slug, for logs
 * @param endpoint  e.g. "/dataforseo_labs/google/keyword_ideas/live"
 * @param task      the single task object for that endpoint
 */
export async function dataforseoLive<T = unknown>(
  tool: string,
  endpoint: string,
  task: Record<string, unknown>,
  deps: { post?: typeof post } = {},
): Promise<T[]> {
  if (!deps.post && !hasDataForSEOCredentials()) {
    console.error(`[public-tools/${tool}] DataForSEO credentials are not set`);
    throw new ToolError("upstream", UNAVAILABLE);
  }
  if (!endpoint.endsWith("/live")) {
    // A programming error, caught in development: see the header.
    throw new Error(`public tools call live endpoints only, not ${endpoint}`);
  }
  try {
    const res = await (deps.post ?? post)<T>(endpoint, [task]);
    const first = res.tasks?.[0];
    return (first?.result ?? []) as T[];
  } catch (err) {
    const detail = err instanceof DataForSEOError ? `${err.statusCode} ${err.message}` : err instanceof Error ? err.message : String(err);
    console.error(`[public-tools/${tool}] DataForSEO ${endpoint} failed: ${detail}`);
    throw new ToolError("upstream", UNAVAILABLE);
  }
}
