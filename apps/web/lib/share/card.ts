// ---------------------------------------------------------------------------
// The share card: only what was measured
// ---------------------------------------------------------------------------
//
// A 1200x630 image someone posts to say how their site is doing. Every number
// on it is a count or a measurement this product made; anything not measured
// is left off, not shown as zero. "0 clicks" under an unconnected Search
// Console would be the chart bug (dashboard, 2026-09-02) all over again, in a
// format that gets screenshotted.
//
// The rendering lives twice - a DOM version in the dialog (so "Copy image" and
// "Download PNG" can rasterise it client-side) and a satori version in the OG
// route - and both read from this one description, so they cannot disagree
// about what is on the card.

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

/** What the queries found. `null` everywhere means "not measured". */
export interface ShareCardFacts {
  domain: string;
  /** Domain authority 0-100, null when nobody measured it. */
  dr: number | null;
  /** Articles with status live. A count, always known. */
  published: number;
  /** Planned calendar entries dated today or later. A count, always known. */
  planned: number;
  /** Search Console connected for this workspace. */
  gscConnected: boolean;
  /** Clicks over the last 28 days, null when not connected or nothing synced. */
  clicks28d: number | null;
  /** agencies.remove_branding: the account owns its white-label. */
  removeBranding: boolean;
}

export interface ShareCardStat {
  label: string;
  value: string;
}

export interface ShareCard {
  domain: string;
  stats: ShareCardStat[];
  /** The one permitted line, or null for accounts that removed branding. */
  footer: string | null;
  /** Names what the card does not say, so the dialog can say it beside it. */
  omitted: string[];
}

export const BRAND_LINE = "Powered by AltoRank";

export function buildShareCard(f: ShareCardFacts): ShareCard {
  const stats: ShareCardStat[] = [];
  const omitted: string[] = [];

  if (typeof f.dr === "number" && Number.isFinite(f.dr)) {
    stats.push({ label: "Authority", value: String(Math.round(f.dr)) });
  } else {
    omitted.push("authority (not measured yet)");
  }

  stats.push({ label: "Articles published", value: f.published.toLocaleString("en-US") });
  stats.push({ label: "Articles planned", value: f.planned.toLocaleString("en-US") });

  if (f.gscConnected && typeof f.clicks28d === "number") {
    stats.push({ label: "Search clicks, 28 days", value: f.clicks28d.toLocaleString("en-US") });
  } else {
    omitted.push(f.gscConnected ? "search clicks (nothing synced yet)" : "search clicks (Search Console not connected)");
  }

  return {
    domain: f.domain,
    stats,
    footer: f.removeBranding ? null : BRAND_LINE,
    omitted,
  };
}
