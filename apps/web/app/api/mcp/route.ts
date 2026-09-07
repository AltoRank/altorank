import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { authenticateAgentRequest, bearerFrom } from "@/lib/agent/auth";
import { appBaseUrl } from "@/lib/agent/http";
import { createAltorankServer, type AgentCall } from "@/lib/mcp/server";
import { wwwAuthenticate } from "@/lib/oauth/metadata";
import { agentRequest } from "@/scripts/lib/agent-client";

/**
 * /api/mcp — the hosted MCP server, Streamable HTTP.
 *
 * The same 26 tools as `npm run mcp`, reachable at one URL any MCP client
 * adds as a connector: ChatGPT, Claude.ai, Claude Code, Cursor, Codex. Auth
 * is a bearer token, which is either an API key from /settings/api-keys or
 * the token the OAuth flow issued (also an API key; migration 080). A missing
 * or bad token answers 401 with the RFC 9728 pointer, and that header is what
 * lets a client discover the OAuth endpoints and sign the person in.
 *
 * Stateless on purpose: no session id, one transport per request, JSON
 * responses. Vercel functions do not share memory between invocations, so a
 * session held in one would be gone on the next. Every request carries the
 * whole context it needs (the token), which is all these tools require.
 *
 * The account tools call /api/agent/v1 over HTTP on this same deployment with
 * the caller's token, rather than importing the route logic: one code path
 * for the CLI, the stdio server and this, and the agent API stays the single
 * place scopes and rate limits are enforced.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ACCOUNT_NOTE =
  "You are connected through the hosted endpoint; the account tools use the token this connection was authorized with, " +
  "so there is nothing to configure. If a tool answers unauthorized, the person has to reconnect.";

function unauthorized(base: string, message: string, error?: "invalid_token"): NextResponse {
  return NextResponse.json(
    { jsonrpc: "2.0", error: { code: -32001, message }, id: null },
    { status: 401, headers: { "WWW-Authenticate": wwwAuthenticate(base, error), "Cache-Control": "no-store" } },
  );
}

async function handle(request: NextRequest): Promise<Response> {
  const base = appBaseUrl(request);
  const token = bearerFrom(request);
  if (!token) return unauthorized(base, "Authorization required. Connect with OAuth or send an AltoRank API key as a bearer token.");

  const auth = await authenticateAgentRequest(request);
  if (!auth.ok) {
    const code = auth.envelope.error.code;
    if (code === "rate_limited") {
      return NextResponse.json({ jsonrpc: "2.0", error: { code: -32000, message: auth.envelope.error.message }, id: null }, { status: 429 });
    }
    return unauthorized(base, auth.envelope.error.message, "invalid_token");
  }

  // Forward the caller's own token; the agent API re-checks scope per route.
  const call: AgentCall = (path, opts) => agentRequest(path, { ...opts, apiKey: token, baseUrl: base });

  const server = createAltorankServer(call, { accountNote: ACCOUNT_NOTE });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request, {
      authInfo: {
        token,
        clientId: auth.ctx.key.id,
        scopes: auth.ctx.key.scopes,
        expiresAt: auth.ctx.key.expires_at ? Math.floor(new Date(auth.ctx.key.expires_at).getTime() / 1000) : undefined,
      },
    });
  } finally {
    // One transport per request; let the SDK release it once the response is built.
    void transport.close().catch(() => undefined);
  }
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
