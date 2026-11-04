// ---------------------------------------------------------------------------
// Can the run read this site? Asked before it starts
// ---------------------------------------------------------------------------
//
// The wizard's reader and the run's crawler ask for pages differently, and
// they can disagree. A signup on 2026-11-04: the reader read the homepage and
// proposed a profile, auto-start began the run, and the crawl had every
// connection dropped. Two runs, four minutes, and a gate with no article,
// when one request before the run would have said so.
//
// So the homepage is fetched here exactly the way the run's crawl fetches it
// (crawlSite, with its fallbacks), and only a site that gave no answer at all
// is held back: the run cannot get anything from it. A refusal (403, 429, a
// bot check) is let through, because the run has a way round it (it judges
// the domain's rankings against the business profile).
//
// Free: a page fetch, no model and no search-data call.

import { crawlSite, isDroppedConnection, usablePages } from "./crawler";

export type SiteReach =
  | { ok: true }
  /** `line` is the sentence the wizard shows; `why` is the short reason, for the log. */
  | { ok: false; why: string; line: string };

/** Statuses the run has a fallback for; see the header. */
const REFUSED = new Set([403, 406, 429]);

export async function siteReach(domain: string): Promise<SiteReach> {
  const [home] = await crawlSite(`https://${domain}`, 1, 0, 0);
  if (!home || usablePages([home]).length > 0 || REFUSED.has(home.status)) return { ok: true };
  if (home.status > 0) {
    return {
      ok: false,
      why: `HTTP ${home.status}`,
      line: `Your homepage answered our reader with an error (HTTP ${home.status}), so there is nothing for us to read yet. Nothing was written and nothing is charged. Check that ${domain} opens for visitors, then try again.`,
    };
  }
  const why = home.error ?? "no response";
  return { ok: false, why, line: lineFor(domain, why) };
}

/** What to tell the owner for a homepage that never answered, by its reason. */
export function lineFor(domain: string, why: string): string {
  const lead = `We can’t reach ${domain} from our servers, so we can’t write anything for it yet. Nothing was written and nothing is charged.`;
  if (isDroppedConnection({ cause: { code: why } })) {
    return `${lead} Your host closed the connection without answering, which is how some hosts (SiteGround, for one) turn automated readers away. Allow AltoRankBot in your host’s or firewall’s bot settings, then try again.`;
  }
  if (why.startsWith("timed out")) return `${lead} Your homepage took longer than 10 seconds to answer. Try again in a minute.`;
  if (why === "host not found") return `${lead} No server answers for ${domain}. Check it is spelled the way visitors type it.`;
  if (why.startsWith("TLS certificate")) return `${lead} Its security certificate could not be checked. Browsers may cope, but our reader cannot; your host can fix the certificate.`;
  return `${lead} The connection failed (${why}). Try again in a minute; if it keeps happening, check that your host allows AltoRankBot.`;
}
