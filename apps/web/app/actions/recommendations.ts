"use server";

import { requireAuth } from "@/lib/auth/require-auth";
import { createClient } from "@/lib/supabase/server";
import { recommendKeywords } from "@/lib/seo/recommendations";

export type KeywordSuggestion = {
  term: string;
  volume: number;
  difficulty: number | null;
  intent: string;
  action: "write" | "refresh" | "skip";
  position: number | null;
  reason: string;
};

/**
 * The queue the unattended pipeline picks from, for a person choosing by
 * hand. The New article form asked for a keyword as free text next to a
 * placeholder about project management tools, while the workspace already
 * held a scored, ranked list of terms it could win (2026-09-02).
 */
export async function suggestKeywords(workspaceId: string, limit = 8): Promise<KeywordSuggestion[]> {
  const { agencyId } = await requireAuth();
  const supabase = await createClient();

  // The workspace must belong to the caller's account: this reads keyword
  // research someone paid for.
  const { data: ws } = await supabase
    .from("workspaces")
    .select("id")
    .eq("id", workspaceId)
    .eq("agency_id", agencyId)
    .maybeSingle();
  if (!ws) return [];

  const recs = await recommendKeywords(supabase, workspaceId, { limit: limit * 3 });
  return recs
    .filter((r) => r.quality === "ok" && r.action !== "skip")
    .slice(0, limit)
    .map((r) => ({
      term: r.term,
      volume: r.volume,
      difficulty: r.difficulty,
      intent: r.intent,
      action: r.action as "write" | "refresh",
      position: r.currentPosition,
      reason: r.reasons[0] ?? "",
    }));
}
