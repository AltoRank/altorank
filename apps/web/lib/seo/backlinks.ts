// ---------------------------------------------------------------------------
// Backlink monitoring via DataForSEO
// ---------------------------------------------------------------------------
//
// What links to this site, from the backlink index. This existed since the
// first commit and had never run: the request sent `order_by: ["rank.desc"]`
// (the API wants a comma), nothing called the action, and nothing marked a
// vanished link as lost. Verified live 2026-09-02: altorank.co, 3,465 rows,
// $0.024 per hundred.
//
// One row per referring domain per target, because the site-wide footer link
// from supalabs.co showed up once per page it sits on and the table is keyed
// on (workspace, source domain, target).

import type { SupabaseClient } from "@supabase/supabase-js";
import { post } from "./client";

/** Single backlink item from DataForSEO. */
type DFSBacklinkItem = {
  url_from?: string | null;
  domain_from?: string | null;
  /** 0–1000 in DataForSEO's scale, not a 0–100 DR. */
  domain_from_rank?: number | null;
  anchor?: string | null;
  url_to?: string | null;
};

/** Result wrapper for the backlinks/live task. */
type BacklinksResult = {
  total_count?: number | null;
  items?: DFSBacklinkItem[] | null;
};

export type BacklinkData = {
  sourceDomain: string;
  /** DataForSEO's 0–1000 rank scaled to a DR-like 0–100. */
  sourceDr: number;
  anchorText: string;
  targetUrl: string;
};

export function parseBacklinkItem(item: DFSBacklinkItem): BacklinkData | null {
  const sourceDomain = (item.domain_from ?? "").trim().toLowerCase();
  const targetUrl = (item.url_to ?? "").trim();
  if (!sourceDomain || !targetUrl) return null;
  const rank = typeof item.domain_from_rank === "number" ? item.domain_from_rank : 0;
  return {
    sourceDomain,
    sourceDr: Math.max(0, Math.min(100, Math.round(rank / 10))),
    anchorText: (item.anchor ?? "").trim(),
    targetUrl,
  };
}

/**
 * Fetch backlink data for a domain using DataForSEO's backlinks/live
 * endpoint. Returns one row per referring domain and target.
 */
export async function getBacklinksData(
  domain: string,
  options?: { limit?: number },
): Promise<{ links: BacklinkData[]; total: number | null }> {
  const response = await post<BacklinksResult>("/backlinks/backlinks/live", [
    {
      target: domain.replace(/^https?:\/\//, "").replace(/^www\./, ""),
      mode: "one_per_domain",
      limit: options?.limit ?? 200,
      order_by: ["rank,desc"],
    },
  ]);

  const links: BacklinkData[] = [];
  const seen = new Set<string>();
  let total: number | null = null;
  for (const task of response.tasks ?? []) {
    for (const result of task.result ?? []) {
      if (typeof result?.total_count === "number") total = result.total_count;
      for (const item of result?.items ?? []) {
        const parsed = item ? parseBacklinkItem(item) : null;
        if (!parsed) continue;
        const key = `${parsed.sourceDomain}|${parsed.targetUrl}`;
        if (seen.has(key)) continue;
        seen.add(key);
        links.push(parsed);
      }
    }
  }
  return { links, total };
}

export type BacklinkRow = { source_domain: string; target_url: string; status: string };

/**
 * Which stored live links did not come back this time. Pure, so it is
 * testable: the caller marks them lost. A link that reappears is set live
 * again by the upsert.
 */
export function lostBacklinks(existing: BacklinkRow[], fetched: BacklinkData[]): BacklinkRow[] {
  const now = new Set(fetched.map((b) => `${b.sourceDomain}|${b.targetUrl}`));
  return existing.filter((r) => r.status === "live" && !now.has(`${r.source_domain.toLowerCase()}|${r.target_url}`));
}

/**
 * Fetch, upsert, and mark what vanished. Used by the Backlinks page button,
 * the first-look analysis and the weekly pass in the serp cron.
 */
export async function syncBacklinks(
  supabase: SupabaseClient,
  workspaceId: string,
  domain: string,
): Promise<{ fetched: number; total: number | null; lost: number }> {
  const { links, total } = await getBacklinksData(domain);

  const { data: existing } = await supabase
    .from("backlinks")
    .select("source_domain, target_url, status")
    .eq("workspace_id", workspaceId);

  const now = new Date().toISOString();
  if (links.length) {
    const rows = links.map((bl) => ({
      workspace_id: workspaceId,
      source_domain: bl.sourceDomain,
      source_dr: bl.sourceDr,
      anchor_text: bl.anchorText,
      target_url: bl.targetUrl,
      status: "live" as const,
      discovered_at: now,
    }));
    const { error } = await supabase
      .from("backlinks")
      .upsert(rows, { onConflict: "workspace_id,source_domain,target_url", ignoreDuplicates: false });
    if (error) throw new Error(`Failed to upsert backlinks: ${error.message}`);
  }

  const lost = lostBacklinks((existing ?? []) as BacklinkRow[], links);
  for (const r of lost) {
    await supabase
      .from("backlinks")
      .update({ status: "lost" })
      .eq("workspace_id", workspaceId)
      .eq("source_domain", r.source_domain)
      .eq("target_url", r.target_url);
  }

  return { fetched: links.length, total, lost: lost.length };
}
