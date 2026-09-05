import type { Metadata } from "next";
import { PageHead } from "@/components/ui";
import { createClient } from "@/lib/supabase/server";
import { getScopedWorkspaceId } from "@/lib/workspace-scope";
import { ensureDefaultSources, type LinkSourceRow } from "@/lib/linking/detect";
import { LinkingConfig, type LinkTargetRow } from "@/components/dashboard/linking/linking-config";

export const metadata: Metadata = { title: "Linking configuration" };

export default async function LinkingPage() {
  const workspaceId = await getScopedWorkspaceId();
  const supabase = await createClient();

  if (!workspaceId) {
    return (
      <>
        <PageHead
          title="Linking configuration"
          subtitle="Configure how we find links on your website for internal linking."
        />
        <div className="px-8 py-6 text-[13px] text-ink-3">Add a site first.</div>
      </>
    );
  }

  // The sitemap and blog root from onboarding become the first two sources,
  // here rather than only in the migration, so a site onboarded after it also
  // starts with them. Idempotent, and confined to this workspace by RLS.
  await ensureDefaultSources(supabase, workspaceId);

  const [{ data: sources }, { data: targets }, { data: workspace }] = await Promise.all([
    supabase
      .from("link_sources")
      .select("id, workspace_id, kind, url, enabled, last_detected_at, pages_found, error, created_at")
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: true }),
    supabase
      .from("link_targets")
      .select("id, url, path, title, keyword, priority, anchors, source, enabled, site_page_id")
      .eq("workspace_id", workspaceId)
      .order("priority", { ascending: false })
      .order("created_at", { ascending: true })
      .limit(1000),
    supabase.from("workspaces").select("domain").eq("id", workspaceId).maybeSingle(),
  ]);

  return (
    <>
      <PageHead
        title="Linking configuration"
        subtitle={
          <span>
            Configure how we find links on your website for internal linking.
            {workspace?.domain ? (
              <>
                {" "}
                <span className="font-mono text-ink-2">{workspace.domain}</span>
              </>
            ) : null}
          </span>
        }
      />
      <LinkingConfig
        workspaceId={workspaceId}
        sources={(sources ?? []) as LinkSourceRow[]}
        targets={(targets ?? []) as LinkTargetRow[]}
      />
    </>
  );
}
