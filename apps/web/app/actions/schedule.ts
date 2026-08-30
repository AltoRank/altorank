"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { z } from "zod";

const cadenceSchema = z.object({
  workspace_id: z.string().uuid(),
  timezone: z.string().min(1),
  days_of_week: z.array(z.number().int().min(0).max(6)),
  publish_time: z.string().regex(/^\d{2}:\d{2}$/),
  enabled: z.boolean(),
});

export async function upsertCadence(data: z.infer<typeof cadenceSchema>) {
  const parsed = cadenceSchema.parse(data);
  const supabase = await createClient();

  const { error } = await supabase
    .from("publishing_cadences")
    .upsert(
      { ...parsed, updated_at: new Date().toISOString() },
      { onConflict: "workspace_id" },
    );

  if (error) throw new Error(error.message);

  revalidatePath(`/clients/${parsed.workspace_id}`);
}

export async function scheduleArticle(
  articleId: string,
  scheduledAt: string,
) {
  await requireAuth();
  const supabase = await createClient();

  // Only approved articles can be scheduled — scheduling must not bypass approval.
  const { data, error } = await supabase
    .from("articles")
    .update({
      status: "scheduled",
      scheduled_at: scheduledAt,
      updated_at: new Date().toISOString(),
    })
    .eq("id", articleId)
    .eq("status", "approved")
    .select("id")
    .single();

  if (error || !data) throw new Error("Article must be approved before scheduling");

  revalidatePath("/articles");
  revalidatePath(`/content/${articleId}`);
}

export async function unscheduleArticle(articleId: string) {
  const supabase = await createClient();

  const { error } = await supabase
    .from("articles")
    .update({
      status: "review",
      scheduled_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", articleId);

  if (error) throw new Error(error.message);

  revalidatePath("/articles");
  revalidatePath(`/content/${articleId}`);
}

export async function addToQueue(articleId: string) {
  await requireAuth();
  const supabase = await createClient();

  // Only approved articles enter the publish queue (cadence picks oldest scheduled).
  const { data, error } = await supabase
    .from("articles")
    .update({
      status: "scheduled",
      scheduled_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", articleId)
    .eq("status", "approved")
    .select("id")
    .single();

  if (error || !data) throw new Error("Article must be approved before scheduling");

  revalidatePath("/articles");
  revalidatePath(`/content/${articleId}`);
}
