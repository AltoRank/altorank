import type { SupabaseClient } from "@supabase/supabase-js";
import { renderToBuffer } from "@react-pdf/renderer";
import React from "react";
import { ReportPDF } from "./pdf-template";
import { aggregateReportData } from "./metrics";

/**
 * Generate a PDF report for a workspace, upload to Supabase Storage,
 * and save the URL to the reports table.
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
  const period = `${startDate}_${endDate}`;
  const storagePath = `reports/${workspaceId}/${period}.pdf`;

  const { error: uploadError } = await supabase.storage
    .from("reports")
    .upload(storagePath, pdfBuffer, {
      contentType: "application/pdf",
      upsert: true,
    });

  if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`);

  const { data: urlData } = supabase.storage
    .from("reports")
    .getPublicUrl(storagePath);

  const reportUrl = urlData.publicUrl;

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
        url: reportUrl,
        created_at: new Date().toISOString(),
      },
      { onConflict: "workspace_id,period" },
    )
    .select("id")
    .single();

  if (dbError) throw new Error(dbError.message);

  return { reportId: report.id, url: reportUrl };
}
