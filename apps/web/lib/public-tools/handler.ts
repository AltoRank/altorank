// ---------------------------------------------------------------------------
// POST /api/public/tools/<slug>, as a function the tests can call
// ---------------------------------------------------------------------------
//
// Order matters and is the same for every tool:
//
//   1. slug      unknown -> 404 not_found
//   2. body      not JSON, or fails the tool's zod schema -> 400 invalid_input
//   3. cache     an identical input answered recently -> 200, cached: true
//                (before the rate limit, so a shared link costs nobody)
//   4. per-IP    this tool's window for this connection -> 429 rate_limited
//   5. spend     paid kinds only: reserve today's budget -> 429 daily_cap
//   6. run       with a deadline; ToolError keeps its code, a timeout is
//                upstream, anything else is logged and answered `unknown`
//
// The route file only adapts Next's request to this.

import { takeToolRateLimit, rateLimitHeaders } from "@/lib/tools/rate-limit";
import type { Block } from "./blocks";
import { DAILY_CAP_MESSAGE, STATUS_BY_CODE, ToolError, type ToolErrorCode } from "./errors";
import { getTool as defaultGetTool, type AnyPublicTool } from "./registry";
import { reserveSpend as defaultReserveSpend } from "./spend";
import { cacheKey, getCached, setCached } from "./cache";
import { safeFetch, FetchFailedError, UnsafeUrlError, type SafeFetch } from "./safe-fetch";

export const TOOL_DEADLINE_MS = 45_000;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

export type ToolResponseBody =
  | { ok: true; data: { blocks: Block[] }; cached?: boolean }
  | { ok: false; error: string; code: ToolErrorCode };

export interface ToolResponse {
  status: number;
  body: ToolResponseBody;
  headers: Record<string, string>;
}

export interface HandlerDeps {
  getTool?: (slug: string) => AnyPublicTool | undefined;
  reserveSpend?: (tool: string, estimateCents: number) => Promise<boolean>;
  fetch?: SafeFetch;
  deadlineMs?: number;
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

  if (tool.kind !== "fetch") {
    const reserve = deps.reserveSpend ?? defaultReserveSpend;
    if (!(await reserve(slug, tool.estimateCents))) return fail("daily_cap", DAILY_CAP_MESSAGE, limitHeaders);
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
    return { status: 200, body: { ok: true, data: { blocks }, cached: false }, headers: limitHeaders };
  } catch (err) {
    if (err instanceof ToolError) return fail(err.code, err.message, limitHeaders);
    // A tool that let a fetch error escape still gets a readable answer.
    if (err instanceof UnsafeUrlError) return fail("invalid_input", err.message, limitHeaders);
    if (err instanceof FetchFailedError) {
      return fail("upstream", `Could not fetch that page: ${err.message}.`, limitHeaders);
    }
    console.error(`[public-tools/${slug}]`, err);
    return fail("unknown", "Something went wrong on our side. Try again in a minute.", limitHeaders);
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
}
