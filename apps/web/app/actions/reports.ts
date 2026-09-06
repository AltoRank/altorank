"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { generateReport } from "@/lib/reports/generate";
import { DASHBOARD_LINK_TTL_SECONDS, REPORTS_BUCKET, storagePathFromReportUrl } from "@/lib/reports/storage";

/**
 * Generate a report for a workspace.
 */
export async function generateReportAction(
  workspaceId: string,
  startDate: string,
  endDate: string,
) {
  const supabase = await createClient();

  const result = await generateReport(supabase, workspaceId, startDate, endDate);

  revalidatePath("/reports");
  return result;
}

/**
 * A link to open a report now. The bucket is private (066), so this signs the
 * stored object path per click; the cookie-bound client only gets a signature
 * for a workspace the caller may see, which is the storage policy doing the
 * same job RLS does on the row.
 */
export async function getReportUrl(reportId: string): Promise<string | null> {
  const supabase = await createClient();

  const { data } = await supabase
    .from("reports")
    .select("url")
    .eq("id", reportId)
    .single();

  const path = storagePathFromReportUrl(data?.url);
  if (!path) return null;

  const { data: signed, error } = await supabase.storage
    .from(REPORTS_BUCKET)
    .createSignedUrl(path, DASHBOARD_LINK_TTL_SECONDS);
  if (error) {
    console.error(`[reports] could not sign ${path}: ${error.message}`);
    return null;
  }
  return signed?.signedUrl ?? null;
}

/**
 * Delete a report (file + DB record).
 */
export async function deleteReport(reportId: string) {
  const supabase = await createClient();

  const { data: report } = await supabase
    .from("reports")
    .select("url, workspace_id, period")
    .eq("id", reportId)
    .single();

  const path = storagePathFromReportUrl(report?.url);
  if (path) {
    await supabase.storage.from(REPORTS_BUCKET).remove([path]);
  }

  await supabase.from("reports").delete().eq("id", reportId);
  revalidatePath("/reports");
}
