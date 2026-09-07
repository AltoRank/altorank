"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { z } from "zod";
import { canAddToPlan, addToPlanBlockedReason } from "@/lib/keywords/lifecycle";

const createKeywordSchema = z.object({
  workspace_id: z.string().uuid(),
  term: z.string().min(1),
  volume: z.coerce.number().default(0),
  difficulty: z.coerce.number().default(0),
  intent: z.enum(["info", "commercial", "transactional", "navigational"]).default("info"),
});

export async function createKeyword(formData: FormData) {
  const supabase = await createClient();
  const parsed = createKeywordSchema.parse({
    workspace_id: formData.get("workspace_id"),
    term: formData.get("term"),
    volume: formData.get("volume"),
    difficulty: formData.get("difficulty"),
    intent: formData.get("intent"),
  });

  // Typed in by hand: the provenance says so, so the sources rollup can tell
  // "we found it" from "you told us".
  const { error } = await supabase.from("keywords").insert({ ...parsed, source_type: "manual" });
  if (error) throw new Error(error.message);
  revalidatePath("/keywords");
}

/**
 * Returns `{ error }` rather than throwing: a thrown server-action message is
 * replaced with a hex digest in a production build, and this one is read by a
 * toast. `{ ok: true }` on success.
 */
export async function updateKeywordStatus(id: string, status: string): Promise<{ ok?: true; error?: string }> {
  const supabase = await createClient();

  // Refuse the backwards write server-side too. The button hides itself for a
  // keyword the plan already owns, but the action is reachable on its own and
  // the row can change between render and click.
  if (status === "planned") {
    const { data: current, error: readError } = await supabase
      .from("keywords")
      .select("status")
      .eq("id", id)
      .maybeSingle();
    if (readError) return { error: readError.message };
    if (!current) return { error: "That keyword no longer exists." };
    if (!canAddToPlan(current.status as string)) {
      return { error: addToPlanBlockedReason(current.status as string) };
    }
  }

  const { error } = await supabase.from("keywords").update({ status }).eq("id", id);
  if (error) return { error: error.message };
  revalidatePath("/keywords");
  return { ok: true };
}
