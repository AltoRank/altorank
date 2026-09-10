// ---------------------------------------------------------------------------
// The free allowance's second draft waits for the first to be read
// ---------------------------------------------------------------------------
//
// Seven free drafts, once. Until 2026-09-10 the product spent them itself: the
// onboarding minute fanned the first week's plan out as parallel drafts, and a
// signup had all seven inside five minutes - three of them on one topic, two
// written for a buyer the business does not have, and nobody had read a word.
//
// The first draft is the wow. The other six are the customer's decision, once
// they have seen what a draft looks like: approved it, held it, or edited it.
// Until then, an unattended run on the free allowance writes nothing more and
// says why. A paid plan is a volume limit, not an allowance, and is not gated
// here.

import type { SupabaseClient } from "@supabase/supabase-js";

export interface DraftSignal {
  status: string;
  generated_autonomously: boolean | null;
  approved_at: string | null;
  held_by: string | null;
  /** The editor bumps this on a save; the pipeline's own writes land within minutes of creation. */
  created_at: string;
  updated_at: string | null;
}

/** A person did something with this draft: approved, held, or edited it later. */
export function reviewed(a: DraftSignal): boolean {
  if (a.approved_at || a.held_by) return true;
  if (!["review", "drafting", "error"].includes(a.status)) return true;
  if (a.updated_at && a.created_at) {
    // The generation pipeline's own updates finish within minutes; an edit an
    // hour later is a person.
    return new Date(a.updated_at).getTime() - new Date(a.created_at).getTime() > 60 * 60 * 1000;
  }
  return false;
}

/**
 * The reason an unattended free-tier run must not write, or null when it may.
 * Pure: the caller passes the rows.
 */
export function firstDraftBlocker(drafts: DraftSignal[]): string | null {
  const autonomous = drafts.filter((d) => d.generated_autonomously && d.status !== "error");
  if (autonomous.length === 0) return null;
  if (drafts.some(reviewed)) return null;
  return (
    "Your first draft is waiting for your review. The next drafts on the free allowance start " +
    "once you have read it - approve it, hold it, or edit it, and the plan continues."
  );
}

/** The rows `firstDraftBlocker` needs, for one workspace. */
export async function firstDraftAwaitsReview(supabase: SupabaseClient, workspaceId: string): Promise<string | null> {
  const { data } = await supabase
    .from("articles")
    .select("status, generated_autonomously, approved_at, held_by, created_at, updated_at")
    .eq("workspace_id", workspaceId);
  return firstDraftBlocker((data ?? []) as DraftSignal[]);
}
