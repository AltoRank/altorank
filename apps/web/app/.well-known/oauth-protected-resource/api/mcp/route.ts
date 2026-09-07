import type { NextRequest } from "next/server";
import { protectedResourceMetadata } from "@/lib/oauth/metadata";
import { appBaseUrl, oauthJson } from "@/lib/oauth/http";

/** RFC 9728: which authorization server protects /api/mcp. Path form, `/.well-known/oauth-protected-resource/api/mcp`, which is where a client that starts from the resource URL looks first. */
export function GET(request: NextRequest) {
  return oauthJson(protectedResourceMetadata(appBaseUrl(request)), 200, {
    "Cache-Control": "public, max-age=3600",
    "Access-Control-Allow-Origin": "*",
  });
}
