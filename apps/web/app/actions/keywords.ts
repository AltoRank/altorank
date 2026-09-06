"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { z } from "zod";

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

export async function updateKeywordStatus(id: string, status: string) {
  const supabase = await createClient();
  const { error } = await supabase.from("keywords").update({ status }).eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/keywords");
}
