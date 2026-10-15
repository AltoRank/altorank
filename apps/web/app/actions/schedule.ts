"use server";

import { revalidatePath } from "next/cache";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { sentBackToReview } from "@/lib/articles/approval";
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
  await requireAuth();
  const parsed = cadenceSchema.parse(data);
  const supabase = await createClient();

  const { error } = await supabase
    .from("publishing_cadences")
    .upsert(
      { ...parsed, updated_at: new Date().toISOString() },
      { onConflict: "workspace_id" },
    );

  if (error) throw new Error(error.message);

  revalidatePath(`/workspaces/${parsed.workspace_id}`);
}

/**
 * Put an approved article on a date, or move a scheduled one to another.
 *
 * "Reschedule" calls this on a scheduled article, and the write used to match
 * only `approved`, so it always failed with "must be approved". Both states
 * carry an approval; the approval is required, not just the status.
 *
 * The write is the server's (migration 109: a signed-in user's client may not
 * set `scheduled` or `scheduled_at`). The person's own client reads the row
 * first, which is what decides they may act on this article at all.
 */
export async function scheduleArticle(
  articleId: string,
  scheduledAt: string,
) {
  await requireAuth();
  const when = new Date(scheduledAt);
  if (Number.isNaN(when.getTime())) throw new Error("Pick a valid date and time");
  const supabase = await createClient();

  const article = await readApproved(supabase, articleId, ["approved", "scheduled"]);
  const { data, error } = await createServiceClient()
    .from("articles")
    .update({
      status: "scheduled",
      scheduled_at: when.toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", articleId)
    .eq("status", article.status)
    .not("approved_by", "is", null)
    .select("id")
    .maybeSingle();

  if (error || !data) throw new Error("Article must be approved before scheduling");

  revalidatePath("/articles");
  revalidatePath(`/content/${articleId}`);
}

/**
 * Cancel a schedule: back to Review, the approval cleared, and held.
 *
 * It used to set `review` and leave the approval and the hold alone, so in a
 * workspace with auto-approve on the rule signed the draft off again and
 * published it in the same cron run as the cancel. Now it is requestChanges
 * for a scheduled article: the person approves again, or releases the hold.
 */
export async function unscheduleArticle(articleId: string) {
  const { user } = await requireAuth();
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("articles")
    .update({
      ...sentBackToReview(user.id, new Date().toISOString()),
      updated_at: new Date().toISOString(),
    })
    .eq("id", articleId)
    .eq("status", "scheduled")
    .select("id");

  if (error) throw new Error(error.message);
  if (!data?.length) throw new Error("Only a scheduled article can be unscheduled");

  revalidatePath("/articles");
  revalidatePath(`/content/${articleId}`);
}

export async function addToQueue(articleId: string) {
  await requireAuth();
  const supabase = await createClient();

  // Only approved articles enter the publish queue (cadence picks oldest
  // scheduled). Written by the server, like scheduleArticle.
  await readApproved(supabase, articleId, ["approved"]);
  const { data, error } = await createServiceClient()
    .from("articles")
    .update({
      status: "scheduled",
      scheduled_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", articleId)
    .eq("status", "approved")
    .not("approved_by", "is", null)
    .select("id")
    .maybeSingle();

  if (error || !data) throw new Error("Article must be approved before scheduling");

  revalidatePath("/articles");
  revalidatePath(`/content/${articleId}`);
}

/**
 * The article through the person's own client (RLS: they may act on it), in
 * one of `statuses` and carrying a recorded approval. Throws the message the
 * schedule picker shows otherwise.
 */
async function readApproved(
  supabase: Awaited<ReturnType<typeof createClient>>,
  articleId: string,
  statuses: string[],
): Promise<{ status: string }> {
  const { data } = await supabase
    .from("articles")
    .select("id, status, approved_by")
    .eq("id", articleId)
    .maybeSingle();
  if (!data || !statuses.includes(data.status as string) || !data.approved_by) {
    throw new Error("Article must be approved before scheduling");
  }
  return { status: data.status as string };
}
