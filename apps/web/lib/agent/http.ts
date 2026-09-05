// ---------------------------------------------------------------------------
// Route-handler plumbing for /api/agent/v1
// ---------------------------------------------------------------------------
//
// `withAgent` authenticates, rate-limits, runs the handler, and turns whatever
// it returns - or throws - into an envelope with the rate-limit headers on it.
// Handlers only ever build envelopes; they never see a Response.

import { NextResponse, type NextRequest } from "next/server";
import { takeToolRateLimit, rateLimitHeaders as toolRateLimitHeaders } from "@/lib/tools/rate-limit";
import type { ApiKeyScope } from "./api-keys";
import { authenticateAgentRequest, type AgentContext } from "./auth";
import { ERROR_STATUS, fail, GUIDANCE, type Envelope } from "./envelope";
import { rateLimitHeaders, type RateLimitDecision } from "./rate-limit";

/**
 * A handler returns an envelope, an envelope with an explicit status, or -
 * for the one endpoint that serves a file - a finished Response.
 */
export type HandlerResult = Envelope | { envelope: Envelope; status: number } | Response;

/**
 * Mutations get a second, tighter window on top of the per-key 120/min: 30 a
 * minute per key. A looping agent that reschedules the same keyword forever
 * is stopped before it has moved the whole month around, and the reads it
 * needs to notice are not throttled with it. Same in-memory limiter the free
 * tools use (lib/tools/rate-limit.ts), keyed by API key id.
 */
export const MUTATION_LIMIT = 30;
export const MUTATION_WINDOW_MS = 60_000;
const MUTATION_SLUG = "agent-mutations";

export type AgentHandler<P> = (
  request: NextRequest,
  ctx: AgentContext,
  params: P,
) => Promise<HandlerResult>;

export function envelopeResponse(
  result: Exclude<HandlerResult, Response>,
  rate?: RateLimitDecision,
  extraHeaders: Record<string, string> = {},
): NextResponse {
  const envelope = "envelope" in result ? result.envelope : result;
  const status =
    "envelope" in result ? result.status : envelope.ok ? 200 : ERROR_STATUS[envelope.error.code];
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...(rate ? rateLimitHeaders(rate) : {}),
    ...extraHeaders,
  };
  return NextResponse.json(envelope, { status, headers });
}

export function withAgent<P = Record<string, never>>(
  handler: AgentHandler<P>,
  options: { scope?: ApiKeyScope; mutation?: boolean } = {},
) {
  return async (request: NextRequest, route?: { params: Promise<P> }): Promise<NextResponse> => {
    const auth = await authenticateAgentRequest(request, options.scope ?? "read");
    if (!auth.ok) return envelopeResponse(auth.envelope, auth.rate);

    let extraHeaders: Record<string, string> = {};
    if (options.mutation) {
      const m = takeToolRateLimit(MUTATION_SLUG, auth.ctx.key.id, MUTATION_LIMIT, MUTATION_WINDOW_MS);
      // Prefixed so they sit beside, not over, the per-key read headers.
      extraHeaders = Object.fromEntries(
        Object.entries(toolRateLimitHeaders(m)).map(([k, v]) => [k === "Retry-After" ? k : k.replace("X-RateLimit-", "X-RateLimit-Mutations-"), v]),
      );
      if (!m.allowed) {
        const retryAfter = Math.max(1, Math.ceil((m.resetAt - Date.now()) / 1000));
        return envelopeResponse(
          fail("rate_limited", `Too many mutations for this API key (${MUTATION_LIMIT}/min).`, GUIDANCE.rateLimited(retryAfter)),
          auth.ctx.rate,
          extraHeaders,
        );
      }
    }

    const params = route ? await route.params : ({} as P);
    try {
      const result = await handler(request, auth.ctx, params);
      if (result instanceof Response) {
        for (const [k, v] of Object.entries({ ...rateLimitHeaders(auth.ctx.rate), ...extraHeaders })) result.headers.set(k, v);
        return result as NextResponse;
      }
      return envelopeResponse(result, auth.ctx.rate, extraHeaders);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error("[agent api]", request.method, request.nextUrl.pathname, message);
      return envelopeResponse(
        fail(
          "internal_error",
          message,
          "AltoRank hit an unexpected error. Retry once; if it repeats, report the message to the human rather than working around it.",
        ),
        auth.ctx.rate,
      );
    }
  };
}

/** Parse a JSON body, or say precisely why not. */
export async function readJson<T>(request: NextRequest): Promise<{ body: T } | { envelope: Envelope }> {
  try {
    return { body: (await request.json()) as T };
  } catch {
    return {
      envelope: fail(
        "invalid_request",
        "Body is not valid JSON.",
        "Send a JSON object with Content-Type: application/json.",
      ),
    };
  }
}

/**
 * Where the dashboard lives, for the links handed back to humans.
 *
 * NEXT_PUBLIC_APP_URL wins; the request's own origin is the fallback, which is
 * right for a self-hosted install that never set the variable.
 */
export function appBaseUrl(request: NextRequest): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, "");
  return configured || request.nextUrl.origin;
}
