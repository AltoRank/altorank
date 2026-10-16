// Analytics sync for one workspace integration, shared by the nightly cron
// and the moment of connection.
//
// Connecting Search Console used to store tokens and redirect to the
// integrations page with "Analytics will start flowing on the next scheduled
// sync", which meant 04:00 UTC the next day. Now the connection itself pulls
// the last week, and the person lands on the workspace with the numbers.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getValidAccessToken, isGoogleReconnectError } from "@/lib/google/oauth";
import { fetchGA4Metrics } from "@/lib/google/ga4";
import {
  fetchGSCDailyTotals,
  fetchGSCPageMetrics,
  fetchGSCQueryMetrics,
  fetchGSCQueryPageMetrics,
  gscPropertyCovers,
  listGSCSites,
  matchGSCSite,
} from "@/lib/google/gsc";
import { articleIndex, gscRowsForDay } from "@/lib/gsc/rows";
import { isoDaysAgo } from "@/lib/gsc/analysis";
import { gscDatesAround } from "@/lib/gsc/read";

export type SyncableIntegration = {
  id: string;
  tokens: { encrypted?: string } | null;
  config: { ga4PropertyId?: string; gscSiteUrl?: string } | null;
  workspace: { id: string; domain: string | null } | null;
  /** Migration 070: Google refused the refresh token; only a reconnect clears it. */
  needs_reconnect?: boolean | null;
};

export type SyncResult = { workspaceId: string; ga4: number; gsc: number; error?: string; needsReconnect?: boolean };

/** The result for a connection that is waiting on the person, not on Google. */
export const NEEDS_RECONNECT_MESSAGE = "Google disconnected: the stored token was refused. Reconnect Google to resume syncing.";

/**
 * Record that Google refused the token on this one connection row.
 *
 * Only the row whose token was refused. A site's gsc and ga4 rows can hold
 * tokens from different Google users now: a consent writes only the rows it
 * was granted (see the OAuth callback), so a GA4 connect by someone who never
 * granted Search Console leaves the gsc row on the token it had. Marking both
 * flagged a healthy GA4 row with another person's refusal, and reconnecting
 * Search Console would not have cleared it. The callback clears the rows it
 * writes fresh tokens to.
 */
export async function markGoogleNeedsReconnect(supabase: SupabaseClient, integrationId: string, message: string): Promise<void> {
  await supabase
    .from("workspace_integrations")
    .update({ needs_reconnect: true, last_sync_error: message.slice(0, 500) })
    .eq("id", integrationId);
}

/**
 * The Search Console property this integration reads, resolved once and
 * stored on the integration's config.
 *
 * The account may own a domain property, a URL-prefix property, or none at
 * all, and guessing `sc-domain:<domain>` produced a 403 on every run for
 * altorank.co (2026-09-02). Shared by the nightly sync and the URL inspection
 * action, so both ask the same question and store the same answer.
 */
export async function resolveGscSiteUrl(
  supabase: SupabaseClient,
  integration: Pick<SyncableIntegration, "id" | "config">,
  domain: string,
  accessToken: string,
): Promise<string> {
  // A stored property is used only while it belongs to the site's domain. One
  // that does not (the domain changed, or the row names another site's
  // property) is resolved again from what the token can see.
  const stored = integration.config?.gscSiteUrl;
  if (stored && gscPropertyCovers(stored, domain)) return stored;
  const sites = await listGSCSites(accessToken);
  const match = matchGSCSite(sites, domain);
  if (!match) {
    const owned = sites.map((s) => s.siteUrl).slice(0, 5).join(", ") || "none";
    throw new Error(
      `This Google account has no Search Console property for ${domain}. It can see: ${owned}. Add the property in Search Console, or reconnect with the account that owns it.`,
    );
  }
  await supabase
    .from("workspace_integrations")
    .update({ config: { ...(integration.config ?? {}), gscSiteUrl: match.siteUrl } })
    .eq("id", integration.id);
  return match.siteUrl;
}

/**
 * Whether a day Google answered counts as measured. With rows, always: Google
 * serves final data only. Empty, only once the day is past the publishing lag;
 * before that, an empty answer is a day Google has not written yet, which is
 * the trap SYNC_LAG_DAYS exists for, and recording it would turn "not in yet"
 * into a measured zero.
 */
export function dayAnswered(date: string, storedRows: number, now: Date = new Date(), lagDays: number = SYNC_LAG_DAYS): boolean {
  return storedRows > 0 || date <= isoDaysAgo(now, lagDays);
}

const shiftDay = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * The recorded range after a day Google answered: one unbroken run of synced
 * days, never a span with an unsynced hole in it.
 *
 * Readers take every day inside the range as measured (no rows there is a
 * measured zero), so the range may only grow by days next to it. The nightly
 * run asks for the last SYNC_LAG_DAYS days, so a day up to that far past the
 * end still joins it; a day further out means the days between were never
 * asked for (the cron did not run, or the token was refused for weeks and has
 * just been reconnected), and the range starts again at that day. A day far
 * before the start is left out rather than bridging the hole.
 *
 * `seed` is the stored history the first recorded range starts from, so the
 * rows stored before migration 115 still count: the oldest stored day, kept
 * only when the stored rows reach to within the same distance of the day.
 */
export function nextSyncedRange(
  range: { from: string | null; through: string | null },
  date: string,
  seed: { earliest: string | null; latestBefore: string | null } = { earliest: null, latestBefore: null },
  gapDays: number = SYNC_LAG_DAYS,
): { from: string; through: string } | null {
  if (!range.from || !range.through) {
    const joins = seed.earliest && seed.latestBefore && seed.latestBefore >= shiftDay(date, -gapDays - 1);
    return { from: joins && seed.earliest! < date ? seed.earliest! : date, through: date };
  }
  if (date > shiftDay(range.through, gapDays)) return { from: date, through: date };
  if (date < shiftDay(range.from, -gapDays)) return null;
  return { from: date < range.from ? date : range.from, through: date > range.through ? date : range.through };
}

/**
 * Record that a Search Console day synced, on the site's gsc row (whichever
 * row's token drove the sync). Clears a previous failure, and widens the
 * recorded range (migration 115) to cover the day when Google's answer counts
 * (`nextSyncedRange`).
 *
 * The range columns are written only when the row read back has them, so
 * this is a no-op for them on a database without 115, not a failed update.
 */
async function recordGscSynced(supabase: SupabaseClient, workspaceId: string, date: string, storedRows: number, now: Date): Promise<void> {
  const { data: row } = await supabase
    .from("workspace_integrations")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("integration_id", "gsc")
    .maybeSingle();
  if (!row) return;
  const r = row as { id: string; needs_reconnect?: boolean | null; last_sync_error?: string | null; synced_from?: string | null; synced_through?: string | null };
  // A refused token's message stays until a reconnect clears it.
  if (r.last_sync_error && !r.needs_reconnect) {
    await supabase.from("workspace_integrations").update({ last_sync_error: null }).eq("id", r.id);
  }
  if (!("synced_through" in r)) return;
  const patch: Record<string, string> = { last_synced_at: now.toISOString() };
  if (dayAnswered(date, storedRows, now)) {
    const range = { from: r.synced_from ?? null, through: r.synced_through ?? null };
    // Only the first range reads the stored history; after that it is the range.
    const seed = range.from && range.through ? undefined : await gscDatesAround(supabase, workspaceId, date);
    const next = nextSyncedRange(range, date, seed);
    if (next) {
      patch.synced_from = next.from;
      patch.synced_through = next.through;
    }
  }
  await supabase.from("workspace_integrations").update(patch).eq("id", r.id);
}

/**
 * Record why a Search Console sync failed, on the site's gsc row. A refused
 * token is markGoogleNeedsReconnect's; this is every other failure - above all
 * an account with no Search Console property for the domain, which used to be
 * returned to the cron's log and nowhere else, so the product kept describing
 * the connection as new.
 *
 * Only when the gsc row's own token drove the sync. Connecting Analytics runs
 * the same sync from the ga4 row, whose token may belong to someone who never
 * granted Search Console; its failure says nothing about the gsc connection,
 * and stamping it there would describe a working connection as failing.
 */
async function recordGscFailed(supabase: SupabaseClient, integrationId: string, message: string): Promise<void> {
  await supabase
    .from("workspace_integrations")
    .update({ last_sync_error: message.slice(0, 500) })
    .eq("id", integrationId)
    .eq("integration_id", "gsc")
    .eq("needs_reconnect", false);
}

/** Rows per insert request when storing a day of Search Console. */
const INSERT_CHUNK = 1_000;

/** Sync one day of GA4 and Search Console data for one integration. */
export async function syncWorkspaceAnalytics(
  supabase: SupabaseClient,
  integration: SyncableIntegration,
  dateStr: string,
): Promise<SyncResult> {
  const ws = integration.workspace;
  if (!ws) return { workspaceId: "", ga4: 0, gsc: 0, error: "no workspace" };
  const encrypted = integration.tokens?.encrypted;
  if (!encrypted) return { workspaceId: ws.id, ga4: 0, gsc: 0, error: "no tokens" };
  // A dead token stays dead until the person reconnects. Asking Google again
  // every night only adds a refused request to the log; the row says why.
  if (integration.needs_reconnect) return { workspaceId: ws.id, ga4: 0, gsc: 0, error: NEEDS_RECONNECT_MESSAGE, needsReconnect: true };

  try {
    const accessToken = await getValidAccessToken(encrypted, async (newEncrypted) => {
      await supabase.from("workspace_integrations").update({ tokens: { encrypted: newEncrypted } }).eq("id", integration.id);
    });

    // Re-running a day must not double it: clear that day's rows for this
    // workspace and source before inserting. The cron never re-ran a day, but
    // the connect-time backfill overlaps with the next night's run.
    let ga4Count = 0;
    let gscCount = 0;

    // GA4 failing is GA4's problem, not Search Console's: Analytics is its
    // own consent now (lib/google/oauth.ts), so a token can read one and not
    // the other, and a GA4 refusal used to abandon the Search Console pull
    // below with it. The refused-refresh case cannot land here; it is thrown
    // by getValidAccessToken above.
    let ga4Error: string | undefined;
    if (integration.config?.ga4PropertyId) {
      try {
        const metrics = await fetchGA4Metrics(accessToken, integration.config.ga4PropertyId, dateStr, dateStr);
        const rows = metrics.map((m) => ({ workspace_id: ws.id, source: "ga4" as const, metric_date: dateStr, pageviews: m.pageviews, sessions: m.sessions, page_url: m.pageUrl }));
        // An empty answer means the provider has not written that day yet, not
        // that the day was empty. Now that the cron re-asks for recent days,
        // deleting before checking would wipe a day that already landed.
        if (rows.length) {
          await supabase.from("analytics_metrics").delete().eq("workspace_id", ws.id).eq("source", "ga4").eq("metric_date", dateStr);
          await supabase.from("analytics_metrics").insert(rows);
          ga4Count = rows.length;
        }
      } catch (err) {
        ga4Error = err instanceof Error ? err.message : "GA4 sync failed";
      }
    }

    if (ws.domain) {
      const siteUrl = await resolveGscSiteUrl(supabase, integration, ws.domain, accessToken);

      // Four reports, four row shapes, one delete. lib/gsc/analysis.ts says
      // which shape answers which question and why they are never summed
      // together; lib/gsc/rows.ts is the mapping from report to row.
      const { data: liveArticles } = await supabase
        .from("articles")
        .select("id, published_url")
        .eq("workspace_id", ws.id)
        .eq("status", "live")
        .not("published_url", "is", null);

      const [totals, queries, pages, queryPages] = await Promise.all([
        fetchGSCDailyTotals(accessToken, siteUrl, dateStr),
        fetchGSCQueryMetrics(accessToken, siteUrl, dateStr, dateStr),
        fetchGSCPageMetrics(accessToken, siteUrl, dateStr, dateStr),
        fetchGSCQueryPageMetrics(accessToken, siteUrl, dateStr, dateStr),
      ]);
      const rows = gscRowsForDay({
        workspaceId: ws.id,
        date: dateStr,
        totals,
        queries,
        pages,
        queryPages,
        articleIdByUrl: articleIndex((liveArticles ?? []) as Array<{ id: string; published_url: string | null }>),
      });
      if (rows.length) {
        await supabase.from("analytics_metrics").delete().eq("workspace_id", ws.id).eq("source", "gsc").eq("metric_date", dateStr);
        // In chunks: a day is no longer capped at 500 rows per report, and one
        // request carrying tens of thousands of rows is one a proxy refuses. A
        // refused chunk fails the day, so it is not recorded as synced.
        for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
          const { error } = await supabase.from("analytics_metrics").insert(rows.slice(i, i + INSERT_CHUNK));
          if (error) throw new Error(`Storing Search Console rows for ${dateStr} failed: ${error.message}`);
        }
        gscCount = rows.length;
      }
      await recordGscSynced(supabase, ws.id, dateStr, rows.length, new Date());
    }

    return { workspaceId: ws.id, ga4: ga4Count, gsc: gscCount, ...(ga4Error ? { error: ga4Error } : {}) };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    // invalid_grant / 401 from the refresh: the connection needs the person,
    // so the row is marked and the product stops reporting "Connected".
    // Any other failure (a 5xx, a property that vanished) is the night's
    // error and nothing more; tomorrow's run tries again.
    if (isGoogleReconnectError(err)) {
      await markGoogleNeedsReconnect(supabase, integration.id, message);
      return { workspaceId: ws.id, ga4: 0, gsc: 0, error: message, needsReconnect: true };
    }
    if (ws.domain) await recordGscFailed(supabase, integration.id, message);
    return { workspaceId: ws.id, ga4: 0, gsc: 0, error: message };
  }
}

/**
 * How many days back the nightly sync reaches.
 *
 * Search Console publishes a day's data two to three days after the day. The
 * nightly cron used to ask for exactly yesterday, once, and never again: the
 * request returned zero rows because Google had not written that day yet, the
 * cron logged `synced: 3, success: true`, and the day was permanently skipped.
 * Every workspace's GSC series stopped at the last day the connect-time
 * backfill had covered - 2026-08-31 on production, found 2026-09-17 - while
 * the job reported a clean run every night in between.
 *
 * Three days covers the lag with one to spare. Each day is deleted-then-
 * inserted for the workspace and source, so re-syncing a day that already
 * landed is idempotent, not a duplicate.
 */
export const SYNC_LAG_DAYS = 3;

/** The dates the nightly sync asks for, newest first: D-1 back to D-SYNC_LAG_DAYS. */
export function syncDates(now: Date = new Date(), lagDays: number = SYNC_LAG_DAYS): string[] {
  const out: string[] = [];
  for (let i = 1; i <= lagDays; i++) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/** Yesterday back to `days` ago, one call set per day. Search Console lags
 *  about two days, so the newest day or two may be empty; that is Google. */
export async function backfillAnalytics(
  supabase: SupabaseClient,
  workspaceId: string,
  integrationId: string,
  days = 7,
): Promise<{ days: number; gsc: number; ga4: number; errors: string[] }> {
  const { data: integration } = await supabase
    .from("workspace_integrations")
    .select("*, workspace:workspaces(id, domain)")
    .eq("workspace_id", workspaceId)
    .eq("integration_id", integrationId)
    .maybeSingle();
  if (!integration) return { days: 0, gsc: 0, ga4: 0, errors: ["integration not found"] };

  const out = { days: 0, gsc: 0, ga4: 0, errors: [] as string[] };
  for (let i = 1; i <= days; i++) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    const r = await syncWorkspaceAnalytics(supabase, integration as SyncableIntegration, d.toISOString().slice(0, 10));
    out.days++;
    out.gsc += r.gsc;
    out.ga4 += r.ga4;
    if (r.error) out.errors.push(r.error);
  }
  return out;
}
