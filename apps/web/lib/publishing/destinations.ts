// ---------------------------------------------------------------------------
// Where an article can be published: the workspace's connected CMSs
// ---------------------------------------------------------------------------
//
// The editor used to decide whether to show a Publish button by looking at
// `articles.cms`, a column only the manual "New article" form ever filled in.
// Every draft the product writes itself - the onboarding draft, every cron
// draft - has it null, so a workspace with WordPress connected still saw "No
// publishing destination yet" and fell into the copy-and-paste path, while the
// publish action ignored the column entirely and used the connection anyway.
// The UI was hiding one-click publishing for exactly the articles it generates.
//
// The connections are the truth. This module reads them once and both the
// page and the publish core use the same list, so what the button offers is
// what the action does.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CMSConfig } from "@/lib/types";

export type Destination = {
  /** workspace_integrations.id */
  id: string;
  /** integrations.id, e.g. "wordpress" */
  integrationId: string;
  /** Display name from the integrations table. */
  label: string;
  /** The adapter type inside the stored config. Usually equals integrationId. */
  type: CMSConfig["type"] | string;
};

/** One row as it comes back from workspace_integrations joined to integrations. */
export type IntegrationRow = {
  id: string;
  config: Record<string, unknown> | null;
  integration?: { id?: string; name?: string; tag?: string } | null;
};

/**
 * Turn integration rows into destinations, keeping only the CMS-tagged ones.
 * Pure, so the choice logic is testable without a database.
 */
export function toDestinations(rows: IntegrationRow[] | null | undefined): Destination[] {
  const out: Destination[] = [];
  for (const wi of rows ?? []) {
    if (wi.integration?.tag !== "CMS") continue;
    const integrationId = wi.integration?.id ?? "";
    // `type` is stored in the clear: lib/crypto encrypts the named secret
    // fields of a config and nothing else, so no key is needed to read it.
    // A row without one is filed under its integration id.
    const stored = (wi.config as Partial<CMSConfig> | null)?.type;
    const type: string = typeof stored === "string" && stored ? stored : integrationId;
    out.push({
      id: wi.id,
      integrationId,
      label: wi.integration?.name ?? integrationId ?? "CMS",
      type,
    });
  }
  return out;
}

/**
 * Pick the destination for one publish.
 *
 *   requested   the user chose one in the editor: it must be one of ours, and
 *               "one of ours" is checked here rather than trusted, because the
 *               id travels through the browser
 *   article.cms where this article already went (set on first publish), so a
 *               republish or an unpublish talks to the same system
 *   otherwise   the only connection, or the first when there are several -
 *               the cron has nobody to ask, and stable beats clever
 *
 * Throws with the same message the publish core has always used when there is
 * nothing connected, because callers and tests match on it.
 */
export function chooseDestination(
  destinations: Destination[],
  article: { cms?: string | null },
  requestedId?: string | null,
): Destination {
  if (destinations.length === 0) {
    throw new Error("No CMS integration connected for this workspace");
  }
  if (requestedId) {
    const hit = destinations.find((d) => d.id === requestedId);
    if (!hit) throw new Error("That destination is not connected to this workspace");
    return hit;
  }
  if (article.cms) {
    const same = destinations.find((d) => d.type === article.cms || d.integrationId === article.cms);
    if (same) return same;
  }
  return destinations[0];
}

/** The workspace's CMS destinations, through whichever client the caller holds. */
export async function getDestinations(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<Destination[]> {
  const { data } = await supabase
    .from("workspace_integrations")
    .select("id, config, integration:integrations(id, name, tag)")
    .eq("workspace_id", workspaceId);
  return toDestinations((data ?? []) as IntegrationRow[]);
}
