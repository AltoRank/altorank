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
import { recordEvent } from "@/lib/observability/record";

/**
 * A handler returns an envelope, an envelope with an explicit status, or -
 * for the one endpoint that serves a file - a finished Response.
 */
export type HandlerResult = Envelope | { envelope: Envelope; status: number } | Response;

/**
 * Mutations get a second, tighter window on top of the per-key 120/min: 30 a
 * minute per key. A looping agent that reschedules the same keyword forever
 * is stopped before it has moved the whole month around, and the reads it
 * needs to notice are not throttled with it. Same in-memory limiter the public
 * endpoints use (lib/tools/rate-limit.ts), keyed by API key id.
 */
export const MUTATION_LIMIT = 30;
export const MUTATION_WINDOW_MS = 60_000;
const MUTATION_SLUG = "agent-mutations";

/**
 * A third window, for the routes that spend money at a third party.
 *
 * `mutation` is about the shape of the account: a write that a looping agent
 * could repeat until the month is unrecognisable. Spend is a different
 * question and it is not answered by the same number. `POST /keywords/suggest`
 * writes nothing at all - it is a read by every definition the envelope uses -
 * and each call is one or two paid DataForSEO lookups. Marking it `mutation`
 * would be a lie in the audit trail *and* the wrong ceiling: 30 paid lookups a
 * minute per key is 43,200 a day, and it would throttle real writes on the
 * same budget as research.
 *
 * So: its own window, tighter, and orthogonal. 10 a minute per key still
 * covers an agent researching a roster of sites one after another - the
 * lookups themselves take seconds - and stops a loop before the bill notices.
 * A route may declare both; each window is taken and reported separately.
 */
export const SPEND_LIMIT = 10;
export const SPEND_WINDOW_MS = 60_000;
const SPEND_SLUG = "agent-spend";

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

/**
 * Take one of the secondary windows and describe it in headers.
 *
 * The headers are prefixed rather than replaced so they sit beside the per-key
 * read headers instead of overwriting them: a client that watches
 * `X-RateLimit-Remaining` is watching the 120/min, and the narrower window it
 * just spent from is a different number with a different name.
 */
function takeWindow(
  keyId: string,
  slug: string,
  limit: number,
  windowMs: number,
  headerInfix: string,
): { headers: Record<string, string>; allowed: boolean; retryAfter: number } {
  const state = takeToolRateLimit(slug, keyId, limit, windowMs);
  const headers = Object.fromEntries(
    Object.entries(toolRateLimitHeaders(state)).map(([k, v]) => [
      k === "Retry-After" ? k : k.replace("X-RateLimit-", `X-RateLimit-${headerInfix}-`),
      v,
    ]),
  );
  return { headers, allowed: state.allowed, retryAfter: Math.max(1, Math.ceil((state.resetAt - Date.now()) / 1000)) };
}

export function withAgent<P = Record<string, never>>(
  handler: AgentHandler<P>,
  options: { scope?: ApiKeyScope; mutation?: boolean; spend?: boolean } = {},
) {
  return async (request: NextRequest, route?: { params: Promise<P> }): Promise<NextResponse> => {
    const auth = await authenticateAgentRequest(request, options.scope ?? "read");
    if (!auth.ok) return envelopeResponse(auth.envelope, auth.rate);

    let extraHeaders: Record<string, string> = {};
    if (options.mutation) {
      const m = takeWindow(auth.ctx.key.id, MUTATION_SLUG, MUTATION_LIMIT, MUTATION_WINDOW_MS, "Mutations");
      extraHeaders = { ...extraHeaders, ...m.headers };
      if (!m.allowed) {
        return envelopeResponse(
          fail("rate_limited", `Too many mutations for this API key (${MUTATION_LIMIT}/min).`, GUIDANCE.rateLimited(m.retryAfter)),
          auth.ctx.rate,
          extraHeaders,
        );
      }
    }
    if (options.spend) {
      const s = takeWindow(auth.ctx.key.id, SPEND_SLUG, SPEND_LIMIT, SPEND_WINDOW_MS, "Spend");
      extraHeaders = { ...extraHeaders, ...s.headers };
      if (!s.allowed) {
        return envelopeResponse(
          fail(
            "rate_limited",
            `Too many paid lookups for this API key (${SPEND_LIMIT}/min).`,
            `${GUIDANCE.rateLimited(s.retryAfter)} This endpoint bills a third party per call, so its window is narrower than the read limit. Reuse the candidates you already have rather than asking again.`,
          ),
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
      // The 5xx an agent sees. Every other agent-API failure is a deliberate
      // envelope with a code and guidance; this branch is the one nobody
      // planned for, and until now the only trace of it was a console line in
      // whichever function happened to serve the request. The key's own account
      // is on the row, so "this customer's agent has been failing all week" is
      // a query rather than a support ticket.
      await recordEvent(
        {
          level: "error",
          source: "agent.api",
          message: `${request.method} ${request.nextUrl.pathname}: ${message}`,
          accountId: auth.ctx.accountId,
          // `label`, not `keyName`: the recorder redacts any context key whose
          // name looks like a credential, and this is the human label the
          // customer typed, which is exactly what makes the row useful.
          context: { method: request.method, path: request.nextUrl.pathname, label: auth.ctx.key.name },
        },
        auth.ctx.supabase,
      );
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
