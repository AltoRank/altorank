"use server";

// ---------------------------------------------------------------------------
// The onboarding wizard's server side
// ---------------------------------------------------------------------------
//
// One action per screen, plus propose and finish. Each is scoped to one
// workspace and checks that the caller owns it - the wizard is reachable with
// a workspace id in the URL, and RLS narrows to the agency, not to the site.
//
// Every screen now writes somewhere. The first version saved the business
// profile and let the sitemap, blog, and article settings evaporate on
// Continue, which made three of five screens theatre.

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import {
  inferBusinessProfileDetailed,
  type BusinessProfile,
  type InferenceResult,
} from "@/lib/onboarding/business-profile";
import { resolveLocale } from "@/lib/onboarding/locale";
import { discoverSite, type SiteDiscovery } from "@/lib/onboarding/site-discovery";
import {
  outputToRow,
  parseBrandColor,
  parseYouTubeChannel,
  type OutputSettings,
  type SiteDetails,
} from "@/lib/onboarding/output-settings";

async function assertWorkspace(workspaceId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("workspaces")
    .select("id, domain, name, business_profile")
    .eq("id", workspaceId)
    .single();
  // RLS already scopes to the agency; this turns a foreign id into an error
  // rather than a silent no-op that looks like a save. Only "no rows"
  // (PGRST116) means that, though: a timeout or pool restart is reported as
  // what it is, not as an ownership problem.
  if (error && error.code !== "PGRST116") throw new Error(`Could not read the site: ${error.message}`);
  if (!data) throw new Error("That site is not on this account.");
  return { supabase, workspace: data };
}

/**
 * Read the site and propose a profile, with the reason when it cannot.
 * The wizard renders the reason; it never renders blanks as a success.
 */
export async function proposeProfile(workspaceId: string): Promise<InferenceResult> {
  const { workspace } = await assertWorkspace(workspaceId);
  if (!workspace.domain) return { profile: null, reason: "unreadable", source: "none" };
  return inferBusinessProfileDetailed(workspace.domain);
}

/** Save the profile the person confirmed. Labels stay in the profile; codes go in the columns. */
export async function saveProfile(workspaceId: string, profile: BusinessProfile): Promise<void> {
  const { supabase, workspace } = await assertWorkspace(workspaceId);
  const locale = resolveLocale(profile.language, profile.country);
  const { error } = await supabase
    .from("workspaces")
    .update({
      business_profile: profile,
      // The wizard is also where a site gets its display name; before this the
      // name was always the bare domain.
      name: profile.name?.trim() || workspace.name,
      language: locale.language,
      location_code: locale.locationCode,
    })
    .eq("id", workspaceId);
  if (error) throw new Error(error.message);
  revalidatePath("/onboarding");
  revalidatePath("/settings", "layout");
}

/** Look for the sitemap and blog. Returns what was verified live, and nothing else. */
export async function discoverSiteDetails(workspaceId: string): Promise<SiteDiscovery> {
  const { workspace } = await assertWorkspace(workspaceId);
  if (!workspace.domain) return { sitemapUrl: null, blogRootUrl: null, exampleArticleUrls: [], found: false };
  return discoverSite(workspace.domain);
}

const HTTP = /^https?:\/\/\S+$/i;

export async function saveSiteDetails(workspaceId: string, details: SiteDetails): Promise<void> {
  const { supabase } = await assertWorkspace(workspaceId);
  const clean = (u: string) => (HTTP.test(u.trim()) ? u.trim() : null);
  const { error } = await supabase
    .from("workspaces")
    .update({
      sitemap_url: clean(details.sitemapUrl),
      blog_root_url: clean(details.blogRootUrl),
      example_article_urls: details.exampleArticleUrls.map((u) => u.trim()).filter((u) => HTTP.test(u)).slice(0, 3),
    })
    .eq("id", workspaceId);
  if (error) throw new Error(error.message);
  revalidatePath("/settings", "layout");
}

export async function saveOutputSettings(workspaceId: string, s: OutputSettings): Promise<void> {
  const { supabase } = await assertWorkspace(workspaceId);
  // A colour or channel that does not parse is refused, not silently nulled:
  // the form validates the same way, so this only fires on a bypassed client.
  if (s.brandColor?.trim() && !parseBrandColor(s.brandColor)) throw new Error("Brand colour must be a hex value like #1a1815.");
  if (s.youtubeChannel?.trim() && !parseYouTubeChannel(s.youtubeChannel)) {
    throw new Error("YouTube channel must be a channel id (UC…), a handle (@name) or the channel URL.");
  }
  const { error } = await supabase.from("workspace_output_settings").upsert(
    { workspace_id: workspaceId, ...outputToRow(s), updated_at: new Date().toISOString() },
    { onConflict: "workspace_id" },
  );
  if (error) throw new Error(error.message);
  revalidatePath("/settings", "layout");
}

/**
 * The standing instruction for keyword research, on its own because it lives
 * on the Keywords tab and is saved on its own. Upsert so a site that never
 * finished the wizard still gets a row; the other columns take their defaults.
 */
export async function saveKeywordPrompt(workspaceId: string, prompt: string): Promise<void> {
  const { supabase } = await assertWorkspace(workspaceId);
  const { error } = await supabase.from("workspace_output_settings").upsert(
    {
      workspace_id: workspaceId,
      global_keyword_prompt: prompt.trim().slice(0, 2000) || null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "workspace_id" },
  );
  if (error) throw new Error(error.message);
  revalidatePath("/settings", "layout");
}

/**
 * Mark the wizard done, or skipped. Either way the dashboard stops sending the
 * person back here. Skipping is allowed on purpose: a wizard that cannot read
 * the site must not become a wall.
 */
export async function completeWizard(workspaceId: string, opts: { skipped?: boolean } = {}): Promise<void> {
  const { supabase } = await assertWorkspace(workspaceId);
  const now = new Date().toISOString();
  // Finishing is the opt-in. The wizard has just promised a month of drafts
  // and written the first one; the cron only writes for workspaces with
  // auto_generate on and status "on", and nothing else ever set them for a
  // site added through "Add workspace" (T2 walk, 2026-09-05) — so days two
  // onward were never written. Skipping leaves the site in setup: no plan
  // was made, so no promise was made.
  const { error } = await supabase
    .from("workspaces")
    .update(opts.skipped ? { onboarding_skipped_at: now } : { onboarded_at: now, status: "on", auto_generate: true })
    .eq("id", workspaceId);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
  revalidatePath("/content");
}
