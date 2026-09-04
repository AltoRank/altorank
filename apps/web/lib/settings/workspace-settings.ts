import { createClient } from "@/lib/supabase/server";
import { getScopedWorkspaceId } from "@/lib/workspace-scope";
import type { BusinessProfile } from "@/lib/onboarding/business-profile";
import { EMPTY_PROFILE } from "@/lib/onboarding/business-profile";
import { outputFromRow, type OutputSettings, type SiteDetails } from "@/lib/onboarding/output-settings";

/**
 * Everything the workspace-scoped Settings tabs read, in one query per table.
 *
 * Scoped like every page: the workspace is the one the sidebar switcher is
 * on. Null when the account has no workspace yet; the tabs then say so rather
 * than rendering a form that would save into nothing.
 */
export interface WorkspaceSettings {
  id: string;
  name: string;
  domain: string;
  profile: BusinessProfile;
  site: SiteDetails;
  output: OutputSettings;
  keywordPrompt: string;
  /** Search Console: a token row exists for this workspace. */
  gscConnected: boolean;
  /** Newest GSC metric date synced for this workspace, or null when nothing has. */
  gscLastDate: string | null;
}

export async function getWorkspaceSettings(): Promise<WorkspaceSettings | null> {
  const scopeId = await getScopedWorkspaceId();
  if (!scopeId) return null;

  const supabase = await createClient();
  const [{ data: ws }, { data: output }, { count: gscCount }, { data: latest }] = await Promise.all([
    supabase
      .from("workspaces")
      .select("id, name, domain, business_profile, sitemap_url, blog_root_url, example_article_urls")
      .eq("id", scopeId)
      .maybeSingle(),
    supabase
      .from("workspace_output_settings")
      .select(
        "tone, internal_links, table_of_contents, call_to_action, first_person, mention_similar_products, global_article_prompt, global_keyword_prompt",
      )
      .eq("workspace_id", scopeId)
      .maybeSingle(),
    supabase
      .from("workspace_integrations")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", scopeId)
      .eq("integration_id", "gsc"),
    supabase
      .from("analytics_metrics")
      .select("metric_date")
      .eq("workspace_id", scopeId)
      .eq("source", "gsc")
      .order("metric_date", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (!ws) return null;

  const stored = ws.business_profile as Partial<BusinessProfile> | null;
  return {
    id: ws.id,
    name: ws.name,
    domain: ws.domain ?? "",
    // A site that skipped the wizard has no profile; the form opens on the
    // same blanks the wizard would, with the domain as the only fact.
    profile: {
      ...EMPTY_PROFILE,
      ...(stored ?? {}),
      name: stored?.name || ws.name,
      audiences: Array.isArray(stored?.audiences) ? stored.audiences : [],
      competitors: Array.isArray(stored?.competitors) ? stored.competitors : [],
    },
    site: {
      sitemapUrl: ws.sitemap_url ?? "",
      blogRootUrl: ws.blog_root_url ?? "",
      exampleArticleUrls: (ws.example_article_urls as string[] | null) ?? [],
    },
    output: outputFromRow(output),
    keywordPrompt: output?.global_keyword_prompt ?? "",
    gscConnected: (gscCount ?? 0) > 0,
    gscLastDate: (latest?.metric_date as string | undefined) ?? null,
  };
}
