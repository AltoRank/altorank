import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchPageSpeedDetailed } from "@/lib/audit/pagespeed";
import { e2eStubsEnabled } from "@/lib/e2e/stubs";

/** Run alongside the chosen draft, updating the same workspace's first look. */
export async function finishDeferredAudit(supabase: SupabaseClient, workspaceId: string, domain: string): Promise<void> {
  if (e2eStubsEnabled()) return;
  const {data: audit} = await supabase.from("domain_audits").select("id, pagespeed").eq("workspace_id",workspaceId).order("started_at",{ascending:false}).limit(1).maybeSingle();
  if (!audit || audit.pagespeed?.unavailable !== "Deferred until after topic selection") return;
  const outcome = await fetchPageSpeedDetailed(`https://${domain.replace(/^https?:\/\//, "")}`);
  const pagespeed = outcome.ok ? {...outcome.result} : {unavailable:outcome.detail};
  const {error} = await supabase.from("domain_audits").update({pagespeed}).eq("id",audit.id).eq("workspace_id",workspaceId);
  if(error) throw new Error("Could not save the deferred performance audit.");
}
