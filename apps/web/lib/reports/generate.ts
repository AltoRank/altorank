import type { SupabaseClient } from "@supabase/supabase-js";
import { renderToBuffer } from "@react-pdf/renderer";
import React from "react";
import { ReportPDF } from "./pdf-template";
import { aggregateReportData } from "./metrics";
import { EMAIL_LINK_TTL_SECONDS, REPORTS_BUCKET, reportStoragePath } from "./storage";

/**
 * Generate a PDF report for a workspace, upload it to the private `reports`
 * bucket, and save the object path to the reports table.
 *
 * The returned `url` is a signed link, valid for EMAIL_LINK_TTL_SECONDS, for
 * the email that announces the report. The dashboard does not use it: it
 * signs a fresh one per click from the stored path (app/actions/reports.ts).
 * Before 066 the bucket did not exist in any migration, and where it had been
 * created by hand it was public and this mailed `getPublicUrl`.
 */
export async function generateReport(
  supabase: SupabaseClient,
  workspaceId: string,
  startDate: string,
  endDate: string,
): Promise<{ reportId: string; url: string }> {
  // Aggregate data
  const data = await aggregateReportData(supabase, workspaceId, startDate, endDate);

  // Render PDF — cast needed because @react-pdf/renderer expects DocumentProps at the type level
  // but the component returns a valid <Document> at runtime
  const pdfBuffer = await renderToBuffer(
    React.createElement(ReportPDF, { data }) as any,
  );

  // Upload to Supabase Storage
  const storagePath = reportStoragePath(workspaceId, startDate, endDate);

  const { error: uploadError } = await supabase.storage
    .from(REPORTS_BUCKET)
    .upload(storagePath, pdfBuffer, {
      contentType: "application/pdf",
      upsert: true,
    });

  if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`);

  const { data: signed, error: signError } = await supabase.storage
    .from(REPORTS_BUCKET)
    .createSignedUrl(storagePath, EMAIL_LINK_TTL_SECONDS);

  if (signError || !signed?.signedUrl) {
    throw new Error(`Could not sign the report link: ${signError?.message ?? "no URL returned"}`);
  }

  // Upsert report row
  const { data: report, error: dbError } = await supabase
    .from("reports")
    .upsert(
      {
        workspace_id: workspaceId,
        period: `${startDate} - ${endDate}`,
        articles_count: data.articlesPublished,
        traffic: data.ga4Summary
          ? `${data.ga4Summary.pageviews} pageviews`
          : "—",
        keywords_count: data.totalKeywords,
        status: "delivered",
        url: storagePath,
        created_at: new Date().toISOString(),
      },
      { onConflict: "workspace_id,period" },
    )
    .select("id")
    .single();

  if (dbError) throw new Error(dbError.message);

  return { reportId: report.id, url: signed.signedUrl };
}
