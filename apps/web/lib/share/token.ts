// ---------------------------------------------------------------------------
// The public share link: an unguessable token, and only the measured card
// ---------------------------------------------------------------------------
//
// A posted link is opened by people with no session, and by the chat app's
// unfurler before any person at all. Both go through the service role, so
// the token has to be the whole credential: 128 random bits, generated on
// first share, cleared on revoke. The page and the image behind it expose
// `publicShareCard` and nothing else - not the `omitted` list, which names
// what the account has not connected, and not the facts the card was built
// from.

import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ShareCard, ShareCardStat } from "./card";

const TOKEN_BYTES = 16;
const TOKEN_RE = /^[0-9a-f]{32}$/;

export function generateShareToken(): string {
  return randomBytes(TOKEN_BYTES).toString("hex");
}

/** Shape check only; a malformed token never reaches the database. */
export function isShareToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_RE.test(value);
}

/**
 * The workspace behind a token, or null. The caller's client decides what
 * "behind" means: on the service role this is the public resolver, so the
 * shape check above is the only thing between the internet and the row.
 */
export async function resolveShareToken(supabase: SupabaseClient, token: unknown): Promise<string | null> {
  if (!isShareToken(token)) return null;
  const { data } = await supabase.from("workspaces").select("id").eq("share_token", token).maybeSingle();
  return (data?.id as string | undefined) ?? null;
}

/** What the public page and image are allowed to show. */
export interface PublicShareCard {
  domain: string;
  stats: ShareCardStat[];
  footer: string | null;
}

/**
 * Strip the card to what is on the picture. `omitted` stays behind: it tells
 * the owner what was left off and why ("Search Console not connected"), and
 * that is a fact about the account, not a measurement of the site.
 */
export function publicShareCard(card: ShareCard): PublicShareCard {
  return {
    domain: card.domain,
    stats: card.stats.map((s) => ({ label: s.label, value: s.value })),
    footer: card.footer,
  };
}

// Re-exported for the server-side callers that already import it from here;
// client components import lib/share/url directly (see that file).
export { shareUrl } from "./url";
