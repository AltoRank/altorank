// ---------------------------------------------------------------------------
// Read-only blog API: who is asking, and for which site
// ---------------------------------------------------------------------------
//
// packages/altorank-next-blog pulls published articles into a Next.js site
// through GET /api/blog/v1/articles. The caller is a build server, not a
// person, so there is no session: it sends the agency's API key as a bearer
// token and names the workspace it wants.
//
// TODO(api-keys): this reads `agencies.api_key`, the single per-account key
// that Settings rotates. Track B is adding an `api_keys` table with scoped,
// read-only keys; when it lands, resolve the key there and require the `blog`
// scope, so a key that can only read articles cannot also drive generation.
//
// Everything here runs with the service client, because an API key is not a
// Supabase session and RLS has nothing to resolve. That makes the two checks
// below the whole boundary: the key must name an agency, and the workspace
// must belong to that agency. Nothing is read before both hold.

import { NextResponse } from "next/server";
import { apiKeyState, hashApiKey, looksLikeApiKey } from "@/lib/agent/api-keys";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/supabase/server";

export type BlogAuth =
  | { ok: true; supabase: SupabaseClient; workspaceId: string; domain: string }
  | { ok: false; response: NextResponse };

const NO_STORE = { "Cache-Control": "no-store" };

function deny(status: number, error: string): BlogAuth {
  return { ok: false, response: NextResponse.json({ error }, { status, headers: NO_STORE }) };
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const m = header.match(/^Bearer\s+(\S+)$/i);
  return m ? m[1] : null;
}

export async function authenticateBlogRequest(request: Request): Promise<BlogAuth> {
  const key = bearerToken(request);
  if (!key) return deny(401, "Missing Authorization: Bearer <api key>");

  const workspaceId = new URL(request.url).searchParams.get("workspace_id");
  if (!workspaceId) return deny(400, "workspace_id is required");

  const supabase = createServiceClient();

  // Scoped keys (settings → API keys) first; the legacy single account key
  // stays accepted until every install has rotated to a scoped one.
  let agency: { id: string } | null = null;
  if (looksLikeApiKey(key)) {
    const { data: row } = await supabase
      .from("api_keys")
      .select("agency_id, revoked_at, expires_at, scopes")
      .eq("key_hash", hashApiKey(key))
      .maybeSingle();
    if (row && apiKeyState(row) === "active") {
      const scopes = (row.scopes as string[] | null) ?? [];
      if (scopes.length && !scopes.includes("read")) return deny(403, "This key cannot read articles");
      agency = { id: row.agency_id as string };
    }
  }
  if (!agency) {
    const { data: legacy } = await supabase
      .from("agencies")
      .select("id")
      .eq("api_key", key)
      .maybeSingle();
    agency = legacy ? { id: legacy.id as string } : null;
  }
  if (!agency) return deny(401, "Invalid API key");

  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id, domain")
    .eq("id", workspaceId)
    .eq("agency_id", agency.id)
    .maybeSingle();
  if (!workspace) return deny(404, "Workspace not found for this API key");

  return { ok: true, supabase, workspaceId: workspace.id, domain: workspace.domain };
}

/** The columns the list endpoint returns. The detail endpoint adds the body. */
export const ARTICLE_LIST_COLUMNS =
  "id, slug, title, meta_description, featured_image_url, keyword, word_count, published_url, published_at, updated_at";

export function json(body: unknown, init: ResponseInit = {}) {
  return NextResponse.json(body, { ...init, headers: { ...NO_STORE, ...(init.headers ?? {}) } });
}
