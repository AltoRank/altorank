import type { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { registrationResponse, saveClient, validateRegistration } from "@/lib/oauth/clients";
import { oauthError, oauthJson, readBody } from "@/lib/oauth/http";
import { takeToolRateLimit } from "@/lib/tools/rate-limit";
import { clientIp } from "@/lib/growth-plan/http";

/**
 * POST /api/oauth/register — dynamic client registration (RFC 7591).
 *
 * Open by design; see lib/oauth/clients.ts. Rate-limited per IP because an
 * open insert endpoint is otherwise a free table-filler.
 */
export async function POST(request: NextRequest) {
  const limit = takeToolRateLimit("oauth-register", clientIp(request.headers), 20, 60 * 60 * 1000);
  if (!limit.allowed) return oauthError("too_many_requests", "Too many registrations from this address; try again later.", 429);

  const outcome = validateRegistration(await readBody(request));
  if (!outcome.ok) return oauthError(outcome.error, outcome.description, 400);

  // A failed insert (most likely: migration 080 not applied) must still be an
  // OAuth error body. An empty 500 makes every client library throw on the
  // parse rather than on the message, which hides the cause from the person.
  try {
    await saveClient(createServiceClient(), outcome.client);
  } catch (err) {
    return oauthError("server_error", err instanceof Error ? err.message : "Could not register the client.", 500);
  }
  return oauthJson(registrationResponse(outcome.client), 201);
}
