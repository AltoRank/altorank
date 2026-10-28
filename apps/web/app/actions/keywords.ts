"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { z } from "zod";

const createKeywordSchema = z.object({
  workspace_id: z.string().uuid(),
  // What a person types, as a searcher would have typed it: outer whitespace
  // gone and runs of it collapsed. "shipping on shopify " was stored with its
  // trailing space on 2026-09-09, which the unique index on (workspace, term)
  // then treated as a different keyword from "shipping on shopify".
  term: z
    .string()
    .transform((t) => t.replace(/\s+/g, " ").trim())
    .pipe(z.string().min(1, "Enter a keyword.")),
  // Null, not 0: a keyword typed in by hand has no measurement, and 0 read
  // as "no searches, difficulty 0" - green in the table, at the bottom of
  // every recommendation, and "all have difficulty" in the stat strip.
  volume: z.preprocess((v) => (v === null || v === "" ? null : Number(v)), z.number().nullable()),
  difficulty: z.preprocess((v) => (v === null || v === "" ? null : Number(v)), z.number().nullable()),
  intent: z.enum(["info", "commercial", "transactional", "navigational"]).default("info"),
});

export type CreateKeywordResult = { ok: true; term: string } | { ok: false; error: string };

/**
 * Track a keyword typed in by hand.
 *
 * Refusals come back as `{ ok: false, error }`, never as a throw: Next.js
 * replaces a thrown server-action message with an opaque digest in
 * production, and the dialog used to swallow the throw into console.error -
 * so a duplicate, or a term of only spaces, closed nothing and said nothing.
 * The duplicate check is case-insensitive on purpose: "Best CRM" and "best
 * crm" are one query to a searcher, and the unique index (case-sensitive) is
 * the backstop, not the rule.
 */
export async function createKeyword(formData: FormData): Promise<CreateKeywordResult> {
  const supabase = await createClient();
  const parsed = createKeywordSchema.safeParse({
    workspace_id: formData.get("workspace_id"),
    term: formData.get("term"),
    volume: formData.get("volume"),
    difficulty: formData.get("difficulty"),
    intent: formData.get("intent"),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the keyword and try again." };
  }
  const row = parsed.data;

  const { data: existing } = await supabase
    .from("keywords")
    .select("term, status")
    .eq("workspace_id", row.workspace_id)
    .ilike("term", row.term)
    .limit(1)
    .maybeSingle();
  if (existing) {
    return { ok: false, error: `"${existing.term}" is already tracked${existing.status ? ` (${existing.status})` : ""}.` };
  }

  // Typed in by hand: the provenance says so, so the sources rollup can tell
  // "we found it" from "you told us".
  const { error } = await supabase.from("keywords").insert({ ...row, source_type: "manual" });
  if (error) {
    // Two people adding the same term in the same second: the index wins,
    // and the message is the same one the check above would have given.
    if (error.code === "23505") return { ok: false, error: `"${row.term}" is already tracked.` };
    return { ok: false, error: error.message };
  }
  revalidatePath("/keywords");
  return { ok: true, term: row.term };
}

export async function updateKeywordStatus(id: string, status: string) {
  const supabase = await createClient();
  const { error } = await supabase.from("keywords").update({ status }).eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/keywords");
}
