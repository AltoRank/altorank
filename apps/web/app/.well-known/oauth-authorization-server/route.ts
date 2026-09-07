import type { NextRequest } from "next/server";
import { authorizationServerMetadata } from "@/lib/oauth/metadata";
import { appBaseUrl, oauthJson } from "@/lib/oauth/http";

/** RFC 8414 discovery for the hosted MCP endpoint. Public, cacheable for an hour. */
export function GET(request: NextRequest) {
  return oauthJson(authorizationServerMetadata(appBaseUrl(request)), 200, {
    "Cache-Control": "public, max-age=3600",
    "Access-Control-Allow-Origin": "*",
  });
}
