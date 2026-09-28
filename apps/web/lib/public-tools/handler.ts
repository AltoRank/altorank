// ---------------------------------------------------------------------------
// POST /api/public/tools/<slug>, as a function the tests can call
// ---------------------------------------------------------------------------
//
// Order matters and is the same for every tool:
//
//   1. slug      unknown -> 404 not_found
//   2. body      not JSON, or fails the tool's zod schema -> 400 invalid_input
//   3. account   paid kinds only: nobody signed in -> 401 auth_required;
//                email not confirmed -> 403 email_unverified. Before the
//                cache, so a cached paid answer is not a way round the gate.
//   4. cache     an identical input answered recently -> 200, cached: true
//                (before the limits, so a repeat costs nobody a run)
//   5. per-IP    this tool's window for this connection -> 429 rate_limited
//   6. user run  paid kinds only: take one of the account's runs for today
//                -> 429 user_cap (Retry-After: next UTC midnight). Fails
//                closed: a count that cannot be reached is daily_cap.
//   7. spend     paid kinds only: reserve today's budget -> 429 daily_cap
//                (the account's run is given back)
//   8. run       with a deadline; ToolError keeps its code, a timeout is
//                upstream, anything else is logged and answered `unknown`.
//                A paid run that fails `upstream` or `unknown` gives the
//                account's run back, so only a delivered result counts.
//
// The route file only adapts Next's request to this.

import { takeToolRateLimit, rateLimitHeaders } from "@/lib/tools/rate-limit";
import type { Block } from "./blocks";
import {
  AUTH_REQUIRED_MESSAGE,
  DAILY_CAP_MESSAGE,
  EMAIL_UNVERIFIED_MESSAGE,
  STATUS_BY_CODE,
  ToolError,
  type ToolErrorCode,
} from "./errors";
import { getTool as defaultGetTool, type AnyPublicTool } from "./registry";
import { reserveSpend as defaultReserveSpend } from "./spend";
import {
  nextUtcMidnight,
  releaseUserRun as defaultReleaseUserRun,
  reserveUserRun as defaultReserveUserRun,
  userDailyRuns,
  type UserRunReservation,
} from "./user-runs";
import type { ToolViewer } from "./viewer";
import { isPaidKind } from "./types";
import { cacheKey, getCached, setCached } from "./cache";
import { safeFetch, FetchFailedError, UnsafeUrlError, type SafeFetch } from "./safe-fetch";

export const TOOL_DEADLINE_MS = 45_000;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

export type ToolResponseBody =
  | { ok: true; data: { blocks: Block[] }; cached?: boolean; remaining?: number }
  | { ok: false; error: string; code: ToolErrorCode };

export interface ToolResponse {
  status: number;
  body: ToolResponseBody;
  headers: Record<string, string>;
}

export interface HandlerDeps {
  getTool?: (slug: string) => AnyPublicTool | undefined;
  reserveSpend?: (tool: string, estimateCents: number) => Promise<boolean>;
  /**
   * The signed-in caller, read only for paid kinds. Absent means nobody is
   * signed in; the route passes the cookie reader (viewer.ts).
   */
  getViewer?: () => Promise<ToolViewer | null>;
  reserveUserRun?: (userId: string) => Promise<UserRunReservation>;
  releaseUserRun?: (userId: string, day: string) => Promise<void>;
  fetch?: SafeFetch;
  deadlineMs?: number;
  now?: () => Date;
}

/** The `user_cap` sentence and its Retry-After, from the moment it is said. */
export function userCapAnswer(now: Date, limit: number = userDailyRuns()): { message: string; retryAfter: number } {
  const reset = nextUtcMidnight(now);
  const seconds = Math.max(1, Math.ceil((reset.getTime() - now.getTime()) / 1000));
  const hours = Math.round(seconds / 3600);
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  const wait =
    seconds >= 90 * 60
      ? `in about ${hours} hours`
      : `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const runs = `${limit} free run${limit === 1 ? "" : "s"}`;
  return {
    message: `That is your ${runs} of the AI and search-data tools for today. They come back at midnight UTC (${reset.toISOString().slice(0, 16).replace("T", " ")} UTC, ${wait}).`,
    retryAfter: seconds,
  };
}

function fail(code: ToolErrorCode, error: string, headers: Record<string, string> = {}): ToolResponse {
  return { status: STATUS_BY_CODE[code], body: { ok: false, error, code }, headers };
}

export async function handleToolRequest(
  slug: string,
  readBody: () => Promise<unknown>,
  ip: string,
  deps: HandlerDeps = {},
): Promise<ToolResponse> {
  const tool = (deps.getTool ?? defaultGetTool)(slug);
  if (!tool) return fail("not_found", "There is no tool at that address.");

  let raw: unknown;
  try {
    raw = await readBody();
  } catch {
    return fail("invalid_input", 'Send a JSON body, for example { "url": "https://example.com" }.');
  }
  const parsed = tool.input.safeParse(raw ?? {});
  if (!parsed.success) {
    return fail("invalid_input", parsed.error.issues[0]?.message ?? "That input is not valid.");
  }
  const input = parsed.data;
  const paid = isPaidKind(tool.kind);

  let viewer: ToolViewer | null = null;
  if (paid) {
    viewer = deps.getViewer ? await deps.getViewer() : null;
    if (!viewer) return fail("auth_required", AUTH_REQUIRED_MESSAGE);
    if (!viewer.verified) return fail("email_unverified", EMAIL_UNVERIFIED_MESSAGE);
  }

  const key = cacheKey(slug, input);
  const hit = getCached(key);
  if (hit) return { status: 200, body: { ok: true, data: { blocks: hit }, cached: true }, headers: {} };

  const limit = takeToolRateLimit(`public-tool:${slug}`, ip, tool.perIpLimit.limit, tool.perIpLimit.windowMs);
  const limitHeaders = rateLimitHeaders(limit);
  if (!limit.allowed) {
    const minutes = Math.max(1, Math.ceil((limit.resetAt - Date.now()) / 60_000));
    return fail(
      "rate_limited",
      `That is ${tool.perIpLimit.limit} runs of this tool from your connection. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
      limitHeaders,
    );
  }

  // The account's run, then the shared budget. A run taken here is given
  // back on every path below that ends without a result from our side.
  let reserved: { userId: string; day: string } | null = null;
  let remaining: number | undefined;
  const releaseRun = async () => {
    if (!reserved) return;
    const { userId, day } = reserved;
    reserved = null;
    await (deps.releaseUserRun ?? defaultReleaseUserRun)(userId, day);
  };

  if (paid && viewer) {
    const taken = await (deps.reserveUserRun ?? defaultReserveUserRun)(viewer.id);
    if (!taken.ok) {
      if (taken.reason === "cap") {
        const { message, retryAfter } = userCapAnswer(deps.now?.() ?? new Date());
        return fail("user_cap", message, { ...limitHeaders, "Retry-After": String(retryAfter) });
      }
      // The count could not be reached. Refuse, as the budget below does.
      return fail("daily_cap", DAILY_CAP_MESSAGE, limitHeaders);
    }
    reserved = { userId: viewer.id, day: taken.day };
    remaining = taken.remaining;

    const reserve = deps.reserveSpend ?? defaultReserveSpend;
    if (!(await reserve(slug, tool.estimateCents))) {
      await releaseRun();
      return fail("daily_cap", DAILY_CAP_MESSAGE, limitHeaders);
    }
  }

  const controller = new AbortController();
  const deadlineMs = deps.deadlineMs ?? TOOL_DEADLINE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ToolError("upstream", "That took too long to answer. Try again, or try a smaller page."));
    }, deadlineMs);
  });

  try {
    const blocks = await Promise.race([
      tool.run(input, { ip, signal: controller.signal, fetch: deps.fetch ?? safeFetch }),
      deadline,
    ]);
    if (!Array.isArray(blocks)) throw new Error(`tool ${slug} returned no blocks`);
    setCached(key, blocks, tool.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS);
    return {
      status: 200,
      body: { ok: true, data: { blocks }, cached: false, ...(remaining !== undefined ? { remaining } : {}) },
      headers: limitHeaders,
    };
  } catch (err) {
    const answer = failureFor(slug, err, limitHeaders);
    // Our side or a provider's: the person got nothing, so the run is theirs
    // again. An input the tool itself refused keeps its count.
    if (answer.body.ok === false && (answer.body.code === "upstream" || answer.body.code === "unknown")) {
      await releaseRun();
    }
    return answer;
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
}

function failureFor(slug: string, err: unknown, headers: Record<string, string>): ToolResponse {
  if (err instanceof ToolError) return fail(err.code, err.message, headers);
  // A tool that let a fetch error escape still gets a readable answer.
  if (err instanceof UnsafeUrlError) return fail("invalid_input", err.message, headers);
  if (err instanceof FetchFailedError) {
    return fail("upstream", `Could not fetch that page: ${err.message}.`, headers);
  }
  console.error(`[public-tools/${slug}]`, err);
  return fail("unknown", "Something went wrong on our side. Try again in a minute.", headers);
}
