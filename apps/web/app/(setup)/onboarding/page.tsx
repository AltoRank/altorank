import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getScopedWorkspaceId } from "@/lib/workspace-scope";
import { OnboardingWizard } from "@/components/onboarding/wizard";
import type { BusinessProfile } from "@/lib/onboarding/business-profile";

export const metadata: Metadata = { title: "Set up your site" };

// The first screen reads the site with one model call, which is slower than a
// page render and faster than the article pipeline.
export const maxDuration = 120;

/**
 * The onboarding wizard.
 *
 * Scoped like every other page: the workspace comes from the switcher, not from
 * a URL parameter, so landing here cannot configure a site the rest of the app
 * is not showing.
 *
 * Re-entrant on purpose. Someone who abandoned the wizard at step 3 can come
 * back to a filled form rather than a fresh crawl, because the profile is saved
 * as soon as the first step is left.
 */
export default async function OnboardingPage() {
  const scopeId = await getScopedWorkspaceId();
  if (!scopeId) redirect("/workspaces");

  const supabase = await createClient();
  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id, domain, business_profile")
    .eq("id", scopeId)
    .single();

  if (!workspace) redirect("/workspaces");

  // The destination grid is the integrations table, not a list in the
  // component. A hardcoded grid drifts the moment a connector is added or
  // removed - and it already had, silently omitting Git / static site, which
  // is the one destination a Next.js, Astro or Hugo site can use.
  const { data: destinations } = await supabase
    .from("integrations")
    .select("id, name, description")
    .eq("tag", "CMS")
    .order("name");

  return (
    <OnboardingWizard
      workspaceId={workspace.id}
      domain={workspace.domain ?? ""}
      initialProfile={(workspace.business_profile as BusinessProfile | null) ?? null}
      destinations={destinations ?? []}
    />
  );
}
