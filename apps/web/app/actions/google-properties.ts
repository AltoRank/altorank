"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getValidAccessToken } from "@/lib/google/oauth";
import { listGSCSites, type GSCSite } from "@/lib/google/gsc";
import { listGA4Properties, matchGA4Property } from "@/lib/google/ga4";
import { getWorkspaceAllowance, workspaceLimitMessage } from "@/lib/billing/workspaces";
import { generateIndexNowKey } from "@/lib/seo/indexing";
import { onboardWorkspace } from "@/app/actions/onboard-workspace";

/** What a Search Console property looks like to the person choosing. */
export type DetectedProperty = {
  siteUrl: string;
  /** The domain a workspace would be created for. */
  domain: string;
  permissionLevel: string;
  /**
   * Google reports the permission of the account that connected, not the
   * owner's address, so we cannot show "owned by x@y.com". We can show
   * something better: whether this account itself is the owner.
   */
  canRead: boolean;
  isOwner: boolean;
  /** Set when a workspace for this domain already exists. */
  existingWorkspaceId: string | null;
};

function domainOf(siteUrl: string): string {
  if (siteUrl.startsWith("sc-domain:")) return siteUrl.slice("sc-domain:".length).toLowerCase();
  try {
    return new URL(siteUrl).host.replace(/^www\./, "").toLowerCase();
  } catch {
    return siteUrl.toLowerCase();
  }
}

/** Search Console permissions that can actually read search analytics. */
const READABLE = new Set(["siteOwner", "siteFullUser"]);

export async function listDetectedProperties(): Promise<
  { connected: boolean; properties: DetectedProperty[]; error?: string }
> {
  const { agencyId } = await requireAuth();
  const supabase = await createClient();

  const { data: conn } = await supabase
    .from("agency_integrations")
    .select("tokens")
    .eq("agency_id", agencyId)
    .eq("provider", "google")
    .maybeSingle();
  const encrypted = (conn?.tokens as { encrypted?: string } | null)?.encrypted;
  if (!encrypted) return { connected: false, properties: [] };

  try {
    const admin = createServiceClient();
    const accessToken = await getValidAccessToken(encrypted, async (next) => {
      await admin
        .from("agency_integrations")
        .update({ tokens: { encrypted: next } })
        .eq("agency_id", agencyId)
        .eq("provider", "google");
    });

    const sites: GSCSite[] = await listGSCSites(accessToken);
    const { data: existing } = await supabase.from("workspaces").select("id, domain");
    const byDomain = new Map(
      (existing ?? [])
        .filter((w) => w.domain)
        .map((w) => [(w.domain as string).replace(/^www\./, "").toLowerCase(), w.id as string]),
    );

    return {
      connected: true,
      properties: sites
        .map((s) => ({
          siteUrl: s.siteUrl,
          domain: domainOf(s.siteUrl),
          permissionLevel: s.permissionLevel,
          canRead: READABLE.has(s.permissionLevel),
          isOwner: s.permissionLevel === "siteOwner",
          existingWorkspaceId: byDomain.get(domainOf(s.siteUrl)) ?? null,
        }))
        .sort((a, b) => Number(b.canRead) - Number(a.canRead) || a.domain.localeCompare(b.domain)),
    };
  } catch (err) {
    return { connected: true, properties: [], error: err instanceof Error ? err.message : "Could not read your properties" };
  }
}

export type CreateResult =
  | { ok: true; created: number; skipped: number }
  | { ok: false; reason: "limit"; message: string; needed: number };

/**
 * Create a workspace per chosen property, connect it, and start its first look.
 *
 * The plan limit is checked against the number being asked for, not one at a
 * time, so someone ticking four boxes on a free account is told they need a
 * plan before anything is half-created.
 */
export async function createWorkspacesFromProperties(siteUrls: string[]): Promise<CreateResult> {
  const { agencyId, user } = await requireAuth(["owner", "admin"]);
  const supabase = await createClient();

  const { properties } = await listDetectedProperties();
  const chosen = properties.filter(
    (p) => siteUrls.includes(p.siteUrl) && p.canRead && !p.existingWorkspaceId,
  );
  if (!chosen.length) return { ok: true, created: 0, skipped: siteUrls.length };

  const allowance = await getWorkspaceAllowance(supabase, agencyId, user.email);
  if (allowance.remaining !== null && chosen.length > allowance.remaining) {
    return {
      ok: false,
      reason: "limit",
      message: workspaceLimitMessage(allowance),
      needed: chosen.length,
    };
  }

  const { data: conn } = await supabase
    .from("agency_integrations")
    .select("tokens")
    .eq("agency_id", agencyId)
    .eq("provider", "google")
    .maybeSingle();
  const encrypted = (conn?.tokens as { encrypted?: string } | null)?.encrypted ?? null;

  let ga4Properties: Awaited<ReturnType<typeof listGA4Properties>> = [];
  if (encrypted) {
    try {
      const accessToken = await getValidAccessToken(encrypted, async () => {});
      ga4Properties = await listGA4Properties(accessToken).catch(() => []);
    } catch {
      ga4Properties = [];
    }
  }

  const createdIds: string[] = [];
  for (const p of chosen) {
    const { data: ws, error } = await supabase
      .from("workspaces")
      .insert({
        agency_id: agencyId,
        name: p.domain,
        domain: p.domain,
        initials: p.domain.slice(0, 2).toUpperCase(),
        color: "av-c1",
        indexnow_key: generateIndexNowKey(),
        auto_generate: true,
        auto_generate_weekly_limit: 2,
      })
      .select("id")
      .single();
    if (error || !ws) continue;
    createdIds.push(ws.id as string);

    if (encrypted) {
      const ga4 = matchGA4Property(ga4Properties, p.domain);
      const connectedAt = new Date().toISOString();
      await supabase.from("workspace_integrations").upsert(
        [
          { workspace_id: ws.id, integration_id: "gsc", config: { type: "gsc", gscSiteUrl: p.siteUrl }, tokens: { encrypted }, connected_at: connectedAt },
          ...(ga4
            ? [{ workspace_id: ws.id, integration_id: "ga4", config: { type: "ga4", ga4PropertyId: ga4.propertyId }, tokens: { encrypted }, connected_at: connectedAt }]
            : []),
        ],
        { onConflict: "workspace_id,integration_id" },
      );
    }
  }

  // The first look for each, after the response: crawl, profile, keywords,
  // backlinks, authority, and the first draft where the quota allows.
  after(async () => {
    for (const id of createdIds) {
      await onboardWorkspace(id).catch((err) =>
        console.error("[connect/google] onboarding", id, err instanceof Error ? err.message : err),
      );
    }
  });

  revalidatePath("/workspaces");
  revalidatePath("/connect");
  return { ok: true, created: createdIds.length, skipped: siteUrls.length - createdIds.length };
}
