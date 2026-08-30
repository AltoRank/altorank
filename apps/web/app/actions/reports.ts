"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { generateReport } from "@/lib/reports/generate";

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
 * Get the URL for a report.
 */
export async function getReportUrl(reportId: string): Promise<string | null> {
  const supabase = await createClient();

  const { data } = await supabase
    .from("reports")
    .select("url")
    .eq("id", reportId)
    .single();

  return data?.url ?? null;
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

  if (report?.url) {
    // Extract storage path from URL
    const urlObj = new URL(report.url);
    const path = urlObj.pathname.split("/reports/").pop();
    if (path) {
      await supabase.storage.from("reports").remove([path]);
    }
  }

  await supabase.from("reports").delete().eq("id", reportId);
  revalidatePath("/reports");
}
