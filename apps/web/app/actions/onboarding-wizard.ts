"use server";

// ---------------------------------------------------------------------------
// The onboarding wizard's server side
// ---------------------------------------------------------------------------
//
// Three actions: propose a profile from the site, save what the person confirmed,
// and record that they finished. Each is scoped to one workspace and checks that
// the caller owns it - the wizard is reachable with a workspace id in the URL,
// and RLS narrows to the agency, not to the site.

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import {
  inferBusinessProfile,
  type BusinessProfile,
} from "@/lib/onboarding/business-profile";

async function assertWorkspace(workspaceId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("workspaces")
    .select("id, domain, name, business_profile")
    .eq("id", workspaceId)
    .single();

  // RLS already scopes to the agency; this turns a foreign id into an error
  // rather than a silent no-op that looks like a save.
  if (error || !data) throw new Error("That site is not on this account.");
  return { supabase, workspace: data };
}

/**
 * Read the site and propose a profile. Returns null when the site could not be
 * read or no model is configured - the wizard then shows empty fields, which is
 * exactly the experience we had before this existed.
 */
export async function proposeProfile(
  workspaceId: string,
): Promise<BusinessProfile | null> {
  const { workspace } = await assertWorkspace(workspaceId);
  if (!workspace.domain) return null;

  return inferBusinessProfile(workspace.domain);
}

/** Save the profile the person confirmed. */
export async function saveProfile(
  workspaceId: string,
  profile: BusinessProfile,
): Promise<void> {
  const { supabase, workspace } = await assertWorkspace(workspaceId);

  const { error } = await supabase
    .from("workspaces")
    .update({
      business_profile: profile,
      // The wizard is also where a site gets its display name; before this the
      // name was always the bare domain.
      name: profile.name?.trim() || workspace.name,
      language: profile.language || null,
    })
    .eq("id", workspaceId);

  if (error) throw new Error(error.message);
  revalidatePath("/onboarding");
}

/**
 * Mark the wizard done and hand off.
 *
 * Deliberately does not require an integration: the last step is skippable, and
 * a person who skipped it still has a configured site.
 */
export async function completeWizard(workspaceId: string): Promise<void> {
  const { supabase } = await assertWorkspace(workspaceId);

  const { data: { user } } = await supabase.auth.getUser();
  const steps = (user?.user_metadata?.onboarding_steps as string[]) ?? [];
  await supabase.auth.updateUser({
    data: { onboarding_steps: [...new Set([...steps, "wizard"])] },
  });

  revalidatePath("/dashboard");
}
