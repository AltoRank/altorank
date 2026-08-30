"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import type { DomainAudit } from "@/lib/types";

/**
 * Start a domain audit by calling the audit API route.
 */
export async function startDomainAudit(workspaceId: string): Promise<string> {
  const supabase = await createClient();

  // Create the audit record
  const { data: audit, error } = await supabase
    .from("domain_audits")
    .insert({
      workspace_id: workspaceId,
      status: "running",
      started_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (error) throw new Error(error.message);

  // Trigger the crawl via internal API (non-blocking)
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  fetch(`${baseUrl}/api/audit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ auditId: audit.id, workspaceId }),
  }).catch(() => {
    // Fire and forget — the API route handles errors
  });

  revalidatePath("/audits");
  return audit.id;
}

/**
 * Get the status of a running or completed audit.
 */
export async function getAuditStatus(auditId: string): Promise<DomainAudit | null> {
  const supabase = await createClient();

  const { data } = await supabase
    .from("domain_audits")
    .select("*")
    .eq("id", auditId)
    .single();

  return (data as DomainAudit) ?? null;
}

/**
 * Get all audits for a workspace.
 */
export async function getWorkspaceAudits(workspaceId: string): Promise<DomainAudit[]> {
  const supabase = await createClient();

  const { data } = await supabase
    .from("domain_audits")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("started_at", { ascending: false });

  return (data ?? []) as DomainAudit[];
}
