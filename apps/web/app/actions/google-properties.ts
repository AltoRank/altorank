"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { insertWorkspaceAsServer } from "@/lib/workspaces/insert";
import { getValidAccessToken, tokenGrants } from "@/lib/google/oauth";
import { listGSCSites, type GSCSite } from "@/lib/google/gsc";
import { listGA4Properties, matchGA4Property } from "@/lib/google/ga4";
import { backfillAnalytics } from "@/lib/google/sync";
import { getWorkspaceAllowance, workspaceLimitMessage } from "@/lib/billing/workspaces";
import { generateIndexNowKey } from "@/lib/seo/indexing";
import { PAID_DEFAULT_PACE } from "@/lib/content/pace";
import { canSpend } from "@/lib/billing/spend-gate";
import { startRun } from "@/lib/onboarding/run-store";
import { dispatchWorker } from "@/lib/onboarding/run-dispatch";

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
  /**
   * That workspace already reads Search Console. Connecting from the
   * onboarding wizard lands here with the site being set up already
   * connected, and "already a workspace" did not say so.
   */
  existingConnected: boolean;
  /**
   * That workspace has a Search Console row whose token Google refused
   * (migration 070): connected once, not reading anything now. Not
   * `existingConnected`, so the picker offers a Reconnect rather than
   * calling a dead connection "connected".
   */
  existingNeedsReconnect: boolean;
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
  const { accountId } = await requireAuth();
  const supabase = await createClient();

  const { data: conn } = await supabase
    .from("account_integrations")
    .select("tokens")
    .eq("account_id", accountId)
    .eq("provider", "google")
    .maybeSingle();
  const encrypted = (conn?.tokens as { encrypted?: string } | null)?.encrypted;
  if (!encrypted) return { connected: false, properties: [] };

  try {
    const admin = createServiceClient();
    const accessToken = await getValidAccessToken(encrypted, async (next) => {
      await admin
        .from("account_integrations")
        .update({ tokens: { encrypted: next } })
        .eq("account_id", accountId)
        .eq("provider", "google");
    });

    const sites: GSCSite[] = await listGSCSites(accessToken);
    const { data: existing } = await supabase.from("workspaces").select("id, domain");
    const byDomain = new Map(
      (existing ?? [])
        .filter((w) => w.domain)
        .map((w) => [(w.domain as string).replace(/^www\./, "").toLowerCase(), w.id as string]),
    );
    const existingIds = [...byDomain.values()];
    const { data: gscRows } = existingIds.length
      ? await supabase
          .from("workspace_integrations")
          .select("workspace_id, needs_reconnect")
          .eq("integration_id", "gsc")
          .in("workspace_id", existingIds)
      : { data: [] as { workspace_id: string; needs_reconnect: boolean | null }[] };
    // A row the nightly sync marked dead is not a connection: the site reads
    // nothing until someone reconnects it.
    const connectedIds = new Set<string>();
    const deadIds = new Set<string>();
    for (const r of gscRows ?? []) {
      (r.needs_reconnect ? deadIds : connectedIds).add(r.workspace_id as string);
    }

    return {
      connected: true,
      properties: sites
        .map((s) => {
          const existingWorkspaceId = byDomain.get(domainOf(s.siteUrl)) ?? null;
          return {
            siteUrl: s.siteUrl,
            domain: domainOf(s.siteUrl),
            permissionLevel: s.permissionLevel,
            canRead: READABLE.has(s.permissionLevel),
            isOwner: s.permissionLevel === "siteOwner",
            existingWorkspaceId,
            existingConnected: existingWorkspaceId !== null && connectedIds.has(existingWorkspaceId),
            existingNeedsReconnect: existingWorkspaceId !== null && deadIds.has(existingWorkspaceId),
          };
        })
        .sort((a, b) => Number(b.canRead) - Number(a.canRead) || a.domain.localeCompare(b.domain)),
    };
  } catch (err) {
    return { connected: true, properties: [], error: err instanceof Error ? err.message : "Could not read your properties" };
  }
}

export type ConnectResult =
  | { ok: true; workspaceId: string; synced: number }
  | { ok: false; message: string };

/**
 * Connect a site that is already a workspace to the account's stored consent.
 *
 * The callback links every site its consent covers, but only at the moment
 * of consent. Someone who connected from the onboarding wizard with a Google
 * account that could not see their site yet, then verified it in Search
 * Console and came back as the page told them to, found their site listed as
 * "already a workspace" with nothing to press: the picker creates workspaces,
 * and this one existed. This is that button. Same checks as the callback's
 * linking: the property is one this consent can read, and the site belongs
 * to the account the consent is stored on (the workspace list the picker is
 * built from is whatever RLS shows, which for someone in two accounts is
 * both). Writing goes through the person's own client, so RLS still decides
 * which sites they may touch.
 */
export async function connectPropertyToWorkspace(siteUrl: string): Promise<ConnectResult> {
  const { accountId } = await requireAuth();
  const supabase = await createClient();

  const { connected, properties, error } = await listDetectedProperties();
  if (!connected) return { ok: false, message: "No Google account is connected yet. Connect one first." };
  if (error) return { ok: false, message: error };
  const property = properties.find((p) => p.siteUrl === siteUrl);
  if (!property) {
    return { ok: false, message: "This Google account no longer lists that property. Reload the page." };
  }
  if (!property.canRead) {
    return {
      ok: false,
      message: "This Google account cannot read that property's search data. Ask its owner for full access in Search Console.",
    };
  }

  // This account's site for the property, looked up here rather than taken
  // from the list: the list is built from every site RLS shows, across all
  // the person's accounts, and the consent belongs to one of them.
  const { data: own } = await supabase
    .from("workspaces")
    .select("id, domain")
    .eq("account_id", accountId)
    .not("domain", "is", null);
  const site = (own ?? []).find(
    (w) => (w.domain as string).replace(/^www\./, "").toLowerCase() === property.domain,
  );
  if (!site) {
    return { ok: false, message: `No site on this account is ${property.domain}. Select it to create one.` };
  }
  const workspaceId = site.id as string;

  // A live connection is left as it is. A row Google refused the token for
  // is written over with this consent, which has just listed the property,
  // so it is the Reconnect the picker offers for it.
  const { data: already } = await supabase
    .from("workspace_integrations")
    .select("id, needs_reconnect")
    .eq("workspace_id", workspaceId)
    .eq("integration_id", "gsc")
    .maybeSingle();
  if (already && !already.needs_reconnect) return { ok: true, workspaceId, synced: 0 };

  const { data: conn } = await supabase
    .from("account_integrations")
    .select("tokens")
    .eq("account_id", accountId)
    .eq("provider", "google")
    .maybeSingle();
  const encrypted = (conn?.tokens as { encrypted?: string } | null)?.encrypted;
  if (!encrypted) return { ok: false, message: "No Google account is connected yet. Connect one first." };

  const { error: writeError } = await supabase.from("workspace_integrations").upsert(
    {
      workspace_id: workspaceId,
      integration_id: "gsc",
      config: { type: "gsc", gscSiteUrl: property.siteUrl },
      tokens: { encrypted },
      connected_at: new Date().toISOString(),
      needs_reconnect: false,
      last_sync_error: null,
    },
    { onConflict: "workspace_id,integration_id" },
  );
  if (writeError) return { ok: false, message: `Could not connect ${property.domain}: ${writeError.message}` };

  // The last week now, as the callback does for one site; the nightly sync
  // covers the same days if this fails.
  let synced = 0;
  try {
    const r = await backfillAnalytics(supabase, workspaceId, "gsc", 7);
    synced = r.gsc;
  } catch {
    synced = 0;
  }

  revalidatePath("/connect/google");
  revalidatePath("/connect");
  return { ok: true, workspaceId, synced };
}

export type CreateResult =
  /** `setupRefused`: the spend gate's sentence for sites created without a setup run. */
  | { ok: true; created: number; skipped: number; setupRefused?: string }
  | { ok: false; reason: "limit"; message: string; needed: number };

/**
 * Create a workspace per chosen property, connect it, and start its first look.
 *
 * The plan limit is checked against the number being asked for, not one at a
 * time, so someone ticking four boxes on a free account is told they need a
 * plan before anything is half-created.
 */
export async function createWorkspacesFromProperties(siteUrls: string[]): Promise<CreateResult> {
  const { accountId, user } = await requireAuth(["owner", "admin"]);
  const supabase = await createClient();

  const { properties } = await listDetectedProperties();
  const chosen = properties.filter(
    (p) => siteUrls.includes(p.siteUrl) && p.canRead && !p.existingWorkspaceId,
  );
  if (!chosen.length) return { ok: true, created: 0, skipped: siteUrls.length };

  const allowance = await getWorkspaceAllowance(supabase, accountId, user.email);
  if (allowance.remaining !== null && chosen.length > allowance.remaining) {
    return {
      ok: false,
      reason: "limit",
      message: workspaceLimitMessage(allowance),
      needed: chosen.length,
    };
  }

  const { data: conn } = await supabase
    .from("account_integrations")
    .select("tokens")
    .eq("account_id", accountId)
    .eq("provider", "google")
    .maybeSingle();
  const encrypted = (conn?.tokens as { encrypted?: string } | null)?.encrypted ?? null;

  // Only when the consent includes Analytics: Search Console is connected on
  // its own now, and asking GA4 with a token that lacks its scope is a 403.
  let ga4Properties: Awaited<ReturnType<typeof listGA4Properties>> = [];
  if (encrypted) {
    try {
      if (tokenGrants(encrypted, "ga4")) {
        const accessToken = await getValidAccessToken(encrypted, async () => {});
        ga4Properties = await listGA4Properties(accessToken).catch(() => []);
      }
    } catch {
      ga4Properties = [];
    }
  }

  const createdIds: string[] = [];
  for (const p of chosen) {
    // By the server, after the allowance above (lib/workspaces/insert.ts).
    const inserted = await insertWorkspaceAsServer(supabase, user.id, accountId, {
      name: p.domain,
      domain: p.domain,
      initials: p.domain.slice(0, 2).toUpperCase(),
      color: "av-c1",
      indexnow_key: generateIndexNowKey(),
      auto_generate: true,
      auto_generate_weekly_limit: PAID_DEFAULT_PACE,
    });
    if (!inserted.ok) continue;
    const ws = { id: inserted.id };
    createdIds.push(ws.id);

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

  // Each site's setup - crawl, profile, keywords, backlinks, authority and the
  // first draft where the account allows it - through the same door the
  // wizard uses: a run row, the spend gate asked before it is created, the
  // onboarding worker with the service role. This used to run the whole
  // pipeline in after() on the person's own client with no gate and no run
  // row, so the one setup door that did not ask was also the one the
  // account's setup-run count could not see: an account before its trial
  // could remove a site and import it again for another paid setup, as often
  // as it liked (round-4 review). The rows are written now and the workers
  // dispatched after the response, as /api/onboard/start does.
  const service = createServiceClient();
  const runIds: string[] = [];
  let setupRefused: string | undefined;
  for (const id of createdIds) {
    const started = await startRun(service, { id, account_id: accountId }, Date.now(), {
      mayCreate: async () => {
        const gate = await canSpend(supabase, accountId, {
          userEmail: user.email ?? undefined,
          workspaceId: id,
          action: "setup",
        });
        return gate.allowed ? null : gate.message;
      },
    });
    if (started.refused !== undefined) setupRefused = started.refused;
    else if (started.created) runIds.push(started.runId);
  }
  if (runIds.length) {
    after(async () => {
      for (const runId of runIds) await dispatchWorker(runId);
    });
  }

  revalidatePath("/workspaces");
  revalidatePath("/connect");
  return {
    ok: true,
    created: createdIds.length,
    skipped: siteUrls.length - createdIds.length,
    ...(setupRefused ? { setupRefused } : {}),
  };
}
