// ---------------------------------------------------------------------------
// Read-only blog API: who is asking, and for which site
// ---------------------------------------------------------------------------
//
// packages/altorank-next-blog pulls published articles into a Next.js site
// through GET /api/blog/v1/articles. The caller is a build server, not a
// person, so there is no session: it sends an API key as a bearer token and
// names the workspace it wants.
//
// Three kinds of key are accepted, in this order:
//
//   1. A blog key (scopes `{blog}`, migration 118). Made for this: it is bound
//      to one site, reads that site's live articles here and nothing else, and
//      the agent API refuses it. A request for any other site is a 403.
//   2. An agent key with `read`. Accepted so sites set up before blog keys
//      existed keep building. It reaches the whole account and the agent API,
//      which is why the dashboard now makes blog keys for this.
//   3. The legacy plaintext `accounts.api_key`. Accepted for the same reason.
//
// Everything here runs with the service client, because an API key is not a
// Supabase session and RLS has nothing to resolve. That makes the checks
// below the whole boundary: the key must name an account, a blog key must
// name this site, and the site must belong to that account. Nothing is read
// before all of them hold.

import { NextResponse } from "next/server";
import { apiKeyState, hashApiKey, isBlogKey, looksLikeApiKey } from "@/lib/agent/api-keys";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/supabase/server";
import { accountTrialGate } from "@/lib/billing/body-lock";
import { BODY_LOCKED_MESSAGE } from "@/lib/billing/trial-refusal";
import { RateLimiter, rateLimitHeaders } from "@/lib/agent/rate-limit";
import { isMissingColumn } from "@/lib/supabase/missing-column";

export type BlogKeyKind = "blog" | "agent" | "legacy";

export type BlogAuth =
  | { ok: true; supabase: SupabaseClient; workspaceId: string; domain: string; keyKind: BlogKeyKind }
  | { ok: false; response: NextResponse };

const NO_STORE = { "Cache-Control": "no-store" };

function deny(status: number, error: string, headers: Record<string, string> = {}): BlogAuth {
  return { ok: false, response: NextResponse.json({ error }, { status, headers: { ...NO_STORE, ...headers } }) };
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const m = header.match(/^Bearer\s+(\S+)$/i);
  return m ? m[1] : null;
}

/**
 * Per key, per instance, like the agent API's limiter (lib/agent/rate-limit.ts
 * explains the in-memory trade-off), but its own bucket and a wider window: a
 * site's build fetches every article once, in parallel, and should not fail
 * on a limit meant for a looping agent. The client waits out a 429 and retries.
 */
export const BLOG_RATE_LIMIT = 600;
export const blogRateLimiter = new RateLimiter(BLOG_RATE_LIMIT);

/** Only touch the row once a minute, like lib/agent/auth.ts. */
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

type KeyRow = {
  id: string;
  account_id: string;
  revoked_at: string | null;
  expires_at: string | null;
  last_used_at: string | null;
  scopes: string[] | null;
  workspace_id?: string | null;
};

const KEY_COLUMNS = "id, account_id, revoked_at, expires_at, last_used_at, scopes";

/** The key's row, with its site when migration 118 is applied. */
async function readKeyRow(supabase: SupabaseClient, key: string): Promise<KeyRow | null> {
  const hash = hashApiKey(key);
  const first = await supabase.from("api_keys").select(`${KEY_COLUMNS}, workspace_id`).eq("key_hash", hash).maybeSingle();
  if (!isMissingColumn(first.error)) return (first.data as KeyRow | null) ?? null;
  const again = await supabase.from("api_keys").select(KEY_COLUMNS).eq("key_hash", hash).maybeSingle();
  return (again.data as KeyRow | null) ?? null;
}

export async function authenticateBlogRequest(request: Request): Promise<BlogAuth> {
  const key = bearerToken(request);
  if (!key) return deny(401, "Missing Authorization: Bearer <api key>");

  // A uuid, compared as Postgres compares it: case does not matter.
  const requested = new URL(request.url).searchParams.get("workspace_id")?.trim().toLowerCase() || null;

  const supabase = createServiceClient();

  let account: { id: string; bucket: string } | null = null;
  let keyKind: BlogKeyKind = "legacy";
  let boundSite: string | null = null;
  let keyRow: KeyRow | null = null;
  if (looksLikeApiKey(key)) {
    const row = await readKeyRow(supabase, key);
    if (row && apiKeyState(row) === "active") {
      if (isBlogKey(row)) {
        // A blog key with no site cannot exist once 114 is applied (its check
        // constraint); before that, none can be made. Refuse rather than guess.
        if (!row.workspace_id) return deny(401, "Invalid API key");
        keyKind = "blog";
        boundSite = row.workspace_id;
      } else {
        const scopes = row.scopes ?? [];
        if (scopes.length && !scopes.includes("read")) return deny(403, "This key cannot read articles");
        keyKind = "agent";
      }
      account = { id: row.account_id, bucket: row.id };
      keyRow = row;
    }
  }
  if (!account) {
    const { data: legacy } = await supabase
      .from("accounts")
      .select("id")
      .eq("api_key", key)
      .maybeSingle();
    account = legacy ? { id: legacy.id as string, bucket: `legacy:${legacy.id as string}` } : null;
  }
  if (!account) return deny(401, "Invalid API key");

  const rate = blogRateLimiter.check(account.bucket);
  if (!rate.allowed) return deny(429, "Too many requests for this API key", rateLimitHeaders(rate));

  // A key in steady use on a customer's site must not look unused in
  // Settings, where "Last used —" invites revoking it. Best effort.
  if (keyRow) {
    const lastUsed = keyRow.last_used_at ? new Date(keyRow.last_used_at).getTime() : 0;
    if (Date.now() - lastUsed > LAST_USED_WRITE_INTERVAL_MS) {
      void supabase
        .from("api_keys")
        .update({ last_used_at: new Date().toISOString() })
        .eq("id", keyRow.id)
        .then(() => undefined, () => undefined);
    }
  }

  // A blog key names its site; `workspace_id` may be left out, and naming
  // another site is refused, not answered as "no articles".
  const workspaceId = requested ?? boundSite;
  if (!workspaceId) return deny(400, "workspace_id is required");
  if (boundSite && workspaceId !== boundSite.toLowerCase()) return deny(403, "This blog key is for a different site (workspace_id)");

  // The detail endpoint hands out the article rendered to HTML, read with the
  // service role, so the trial gate is asked here: `status = 'live'` is not
  // proof that anyone paid. A signed-in person writes their own articles'
  // status through PostgREST (the editor saves through their client), and an
  // account that had not started its trial could set its first draft to
  // `live` and read it back from here. A key is nobody's session, so the
  // bypass list never applies; operators resolve from the account's members.
  if ((await accountTrialGate(supabase, account.id, null)) === "gated") return deny(403, BODY_LOCKED_MESSAGE);

  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id, domain")
    .eq("id", workspaceId)
    .eq("account_id", account.id)
    .maybeSingle();
  // 403, not 404: the client reads a 404 as "no such article", and a site
  // whose workspace id is wrong, or whose workspace was deleted, must fail
  // its build and keep the pages it has, not regenerate them as empty.
  if (!workspace) return deny(403, "This API key cannot read that workspace (check workspace_id)");

  return { ok: true, supabase, workspaceId: workspace.id, domain: workspace.domain, keyKind };
}

/** The columns the list endpoint returns. The detail endpoint adds the body. */
export const ARTICLE_LIST_COLUMNS =
  "id, slug, title, meta_description, featured_image_url, keyword, word_count, published_url, published_at, updated_at";

export function json(body: unknown, init: ResponseInit = {}) {
  return NextResponse.json(body, { ...init, headers: { ...NO_STORE, ...(init.headers ?? {}) } });
}
