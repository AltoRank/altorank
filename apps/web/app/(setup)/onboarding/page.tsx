import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getScopedWorkspaceId } from "@/lib/workspace-scope";
import { OnboardingWizard } from "@/components/onboarding/wizard";
import type { BusinessProfile } from "@/lib/onboarding/business-profile";
import { DEFAULT_OUTPUT_SETTINGS, type OutputSettings, type Tone } from "@/lib/onboarding/output-settings";

export const metadata: Metadata = { title: "Set up your site" };

// Reading the site and asking a model about it happens inside a server action
// from this page; give it room.
export const maxDuration = 120;

/**
 * The wizard, for the scoped workspace.
 *
 * Scoped like every other page: the workspace comes from the switcher, not from
 * a query parameter, so a person with two sites sets up the one they are
 * looking at. A saved profile, site details and output settings are handed
 * back in so reopening the wizard edits rather than re-proposes.
 */
export default async function OnboardingPage() {
  const scopeId = await getScopedWorkspaceId();
  if (!scopeId) redirect("/workspaces");

  const supabase = await createClient();
  const [{ data: workspace }, { data: destinations }, { data: output }] = await Promise.all([
    supabase
      .from("workspaces")
      .select("id, domain, business_profile, sitemap_url, blog_root_url, example_article_urls, auto_generate_weekly_limit")
      .eq("id", scopeId)
      .single(),
    supabase.from("integrations").select("id, name, description").eq("tag", "CMS").order("name"),
    supabase
      .from("workspace_output_settings")
      .select("tone, internal_links, table_of_contents, call_to_action, first_person, mention_similar_products, global_article_prompt")
      .eq("workspace_id", scopeId)
      .maybeSingle(),
  ]);
  if (!workspace) redirect("/workspaces");

  const initialOutput: OutputSettings = output
    ? {
        tone: output.tone as Tone,
        internalLinks: output.internal_links,
        tableOfContents: output.table_of_contents,
        callToAction: output.call_to_action,
        firstPerson: output.first_person,
        mentionSimilarProducts: output.mention_similar_products,
        globalArticlePrompt: output.global_article_prompt ?? "",
      }
    : DEFAULT_OUTPUT_SETTINGS;

  return (
    <OnboardingWizard
      workspaceId={workspace.id}
      domain={workspace.domain ?? ""}
      weeklyLimit={workspace.auto_generate_weekly_limit ?? 1}
      initialProfile={(workspace.business_profile as BusinessProfile | null) ?? null}
      initialSite={{
        sitemapUrl: workspace.sitemap_url ?? "",
        blogRootUrl: workspace.blog_root_url ?? "",
        exampleArticleUrls: (workspace.example_article_urls as string[] | null) ?? [],
      }}
      initialOutput={initialOutput}
      destinations={destinations ?? []}
    />
  );
}
