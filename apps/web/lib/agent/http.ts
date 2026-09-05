// ---------------------------------------------------------------------------
// Route-handler plumbing for /api/agent/v1
// ---------------------------------------------------------------------------
//
// `withAgent` authenticates, rate-limits, runs the handler, and turns whatever
// it returns - or throws - into an envelope with the rate-limit headers on it.
// Handlers only ever build envelopes; they never see a Response.

import { NextResponse, type NextRequest } from "next/server";
import type { ApiKeyScope } from "./api-keys";
import { authenticateAgentRequest, type AgentContext } from "./auth";
import { ERROR_STATUS, fail, type Envelope } from "./envelope";
import { rateLimitHeaders, type RateLimitDecision } from "./rate-limit";

export type HandlerResult = Envelope | { envelope: Envelope; status: number };

export type AgentHandler<P> = (
  request: NextRequest,
  ctx: AgentContext,
  params: P,
) => Promise<HandlerResult>;

export function envelopeResponse(
  result: HandlerResult,
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
  options: { scope?: ApiKeyScope } = {},
) {
  return async (request: NextRequest, route?: { params: Promise<P> }): Promise<NextResponse> => {
    const auth = await authenticateAgentRequest(request, options.scope ?? "read");
    if (!auth.ok) return envelopeResponse(auth.envelope, auth.rate);

    const params = route ? await route.params : ({} as P);
    try {
      return envelopeResponse(await handler(request, auth.ctx, params), auth.ctx.rate);
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
