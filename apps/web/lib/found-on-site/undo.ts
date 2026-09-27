// ---------------------------------------------------------------------------
// "That is not my article": taking a find back
// ---------------------------------------------------------------------------
//
// The check can be wrong - a page that quotes the draft at length, a
// colleague's rewrite that kept most of it - and the person who knows is the
// customer. Undoing puts the article back exactly as it was before the find
// (`found_on_site_prior`, migration 094: status, published_url, published_at)
// and remembers the page in `found_on_site_rejected`, so the next night does
// not find it again.
//
// Runs with the caller's client, so RLS decides whether they may touch the
// article at all; the action in app/actions/found-on-site.ts establishes who
// is asking first.

import type { SupabaseClient } from "@supabase/supabase-js";

const RESTORABLE = new Set(["draft", "review", "approved", "scheduled", "error"]);

export class NothingToUndoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NothingToUndoError";
  }
}

export interface UndoResult {
  articleId: string;
  restoredStatus: string;
  rejectedUrl: string;
}

export async function undoFoundOnSite(supabase: SupabaseClient, articleId: string): Promise<UndoResult> {
  const { data: a, error } = await supabase
    .from("articles")
    .select("id, status, published_url, found_on_site_at, found_on_site_prior, found_on_site_rejected")
    .eq("id", articleId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!a) throw new NothingToUndoError("Article not found.");
  if (a.status !== "live" || !a.found_on_site_at || !a.published_url) {
    throw new NothingToUndoError(
      "This article was not marked live by AltoRank finding it on your site, so there is nothing to undo here.",
    );
  }

  const prior = (a.found_on_site_prior ?? null) as
    | { status?: unknown; published_url?: unknown; published_at?: unknown }
    | null;
  // Written in the same statement as the find, so missing means the row was
  // edited by hand. Refuse rather than guess a status to put it back in.
  if (!prior || typeof prior.status !== "string" || !RESTORABLE.has(prior.status)) {
    throw new NothingToUndoError(
      "The state this article was in before it was found was not recorded, so it cannot be put back automatically. Set its status from the editor instead.",
    );
  }

  const rejectedUrl = a.published_url as string;
  const rejected = [...new Set([...((a.found_on_site_rejected as string[] | null) ?? []), rejectedUrl])];

  const { data: updated, error: updateErr } = await supabase
    .from("articles")
    .update({
      status: prior.status,
      published_url: typeof prior.published_url === "string" ? prior.published_url : null,
      published_at: typeof prior.published_at === "string" ? prior.published_at : null,
      found_on_site_at: null,
      found_on_site_evidence: null,
      found_on_site_prior: null,
      found_on_site_rejected: rejected,
    })
    .eq("id", articleId)
    // The same find it was read as: a second click, or a find replaced in
    // between, must not restore a state that is no longer the one before it.
    .eq("found_on_site_at", a.found_on_site_at as string)
    .select("id");
  if (updateErr) throw new Error(updateErr.message);
  if (!Array.isArray(updated) || updated.length === 0) {
    throw new NothingToUndoError("This article changed while it was being undone. Reload the page and try again.");
  }
  return { articleId, restoredStatus: prior.status, rejectedUrl };
}
