"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { appUrl } from "@/lib/app-url";
import type { DomainAudit } from "@/lib/types";

/**
 * Start a domain audit by calling the audit API route.
 */
export async function startDomainAudit(workspaceId: string): Promise<string> {
  await requireAuth();
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

  // Hand the crawl to /api/audit, which answers 202 immediately and does the
  // work in `after`. Two things here are deliberate and were both wrong before.
  //
  // The cookie header: that route authenticates the caller with
  // supabase.auth.getUser(). A bare fetch() from a Server Function carries no
  // cookies, so every one of these arrived anonymous and was answered 401.
  //
  // Awaiting the response: `fetch` does not reject on 4xx, so the old
  // `.catch(() => {})` caught nothing and a 401 looked exactly like success.
  // The row was left at "running" with nothing ever coming to clear it. We now
  // wait for the 202 (fast, the crawl happens after it) and mark the audit
  // failed if the worker refused the job, so the UI can say so.
  const baseUrl = appUrl();
  const cookieHeader = (await cookies())
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");

  try {
    const res = await fetch(`${baseUrl}/api/audit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: cookieHeader },
      body: JSON.stringify({ auditId: audit.id, workspaceId }),
    });
    if (!res.ok) throw new Error(`worker returned ${res.status}`);
  } catch (err) {
    console.error(`[audit ${audit.id}] could not start:`, err);
    await supabase
      .from("domain_audits")
      .update({ status: "failed", completed_at: new Date().toISOString() })
      .eq("id", audit.id);
    throw new Error("Could not start the audit. Please try again.");
  }

  revalidatePath("/audits");
  return audit.id;
}

/**
 * Get the status of a running or completed audit.
 */
export async function getAuditStatus(auditId: string): Promise<DomainAudit | null> {
  await requireAuth();
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
  await requireAuth();
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("domain_audits")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("started_at", { ascending: false });

  // `data ?? []` on a failed read painted "Total audits 0" over a 137-word
  // paragraph explaining that no audit has ever run - to an account whose
  // audits simply could not be loaded.
  if (error) throw new Error(`could not read this site's audits (${error.message})`);
  return (data ?? []) as DomainAudit[];
}
