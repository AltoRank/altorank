"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { parseAttribution, type Attribution } from "@/lib/attribution";

/**
 * Record where the caller's account heard of us.
 *
 * Any member may answer: the wizard is run by whoever set the site up, and
 * an answer is not a setting that needs an owner to guard it. Saving again
 * replaces the answer, so going Back and picking differently, or correcting
 * it later from Settings, leaves one row and one truth rather than a history
 * to reconcile.
 *
 * Validation runs before the membership lookup on purpose: a bad value never
 * costs a query, and the message the screen shows is the validator's, not the
 * database's.
 */
export async function saveAttribution(source: string, note: string | null = null): Promise<Attribution> {
  const answer = parseAttribution(source, note);
  const { agencyId } = await requireAuth();
  const supabase = await createClient();

  const { error } = await supabase
    .from("agencies")
    .update({
      attribution_source: answer.source,
      attribution_note: answer.note,
      attribution_answered_at: new Date().toISOString(),
    })
    .eq("id", agencyId);
  if (error) throw new Error(error.message);

  revalidatePath("/settings");
  return answer;
}
