// ---------------------------------------------------------------------------
// Competitor names to competitor domains
// ---------------------------------------------------------------------------
//
// The profile model reads "Trainerize" on a homepage and returns "trainerize".
// Discovery then asked DataForSEO what the domain "trainerize" ranks for, got
// nothing, and the strongest keyword source a site with no Search Console has
// contributed zero rows without saying so (fitsuite.co, 2026-09-19: three
// named rivals, none read). The wizard has always said "Domains, not names";
// this makes the stored value agree with it.
//
// A name is resolved by searching for it and taking the first result whose
// host is that name, then by a DNS check on `<name>.com`. What cannot be
// resolved is returned as such, never guessed: a wrong domain seeds research
// with somebody else's market.

import { checkDomainReachable } from "@/lib/domain/reachable";
import { fetchAdvancedSerp } from "@/lib/seo/brief-data";

const DOMAIN_SHAPE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/;

/** Hosts that rank for every brand name and are never the brand. */
const NOT_THE_BRAND = /(^|\.)(g2|capterra|getapp|trustpilot|trustradius|softwareadvice|wikipedia|linkedin|facebook|instagram|youtube|x|twitter|reddit|crunchbase|producthunt|apple|google|amazon|appvizer|alternativeto)\.[a-z.]+$/;

export interface ResolvedCompetitors {
  /** Domain-shaped entries, in the order given, de-duplicated. */
  domains: string[];
  /** Names nothing could place. Reported, never queried. */
  unresolved: string[];
}

export interface ResolveDeps {
  /** Organic result URLs for a brand-name search. */
  searchHosts?: (name: string) => Promise<string[]>;
  /** True when the domain has DNS. */
  reachable?: (domain: string) => Promise<boolean>;
}

const clean = (c: string) => c.trim().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "").toLowerCase();
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export const looksLikeDomain = (entry: string) => DOMAIN_SHAPE.test(clean(entry));

/**
 * Which of the hosts a brand-name search returned is the brand's own site.
 *
 * The first host whose name part IS the squashed brand name ("pt distinction"
 * -> ptdistinction.com), directories excluded. Equality rather than
 * containment: "coach" must not resolve to truecoach.co.
 */
export function pickCompetitorDomain(name: string, hosts: readonly string[]): string | null {
  const wanted = squash(name);
  if (!wanted) return null;
  for (const raw of hosts) {
    const host = clean(raw);
    if (!DOMAIN_SHAPE.test(host) || NOT_THE_BRAND.test(host)) continue;
    const labels = host.split(".");
    // app.trainerize.com and trainerize.com both answer to "trainerize".
    const match = labels.slice(0, -1).find((label) => squash(label) === wanted);
    if (match) return labels.slice(labels.indexOf(match)).join(".");
  }
  return null;
}

async function defaultSearchHosts(name: string): Promise<string[]> {
  const serp = await fetchAdvancedSerp(name, { languageCode: "en", locationCode: 2840 });
  return serp.organic.slice(0, 10).map((r) => {
    try { return new URL(r.url).hostname; } catch { return ""; }
  }).filter(Boolean);
}

async function defaultReachable(domain: string): Promise<boolean> {
  return (await checkDomainReachable(domain)).ok;
}

export async function resolveCompetitorDomains(
  entries: readonly string[],
  deps: ResolveDeps = {},
): Promise<ResolvedCompetitors> {
  const searchHosts = deps.searchHosts ?? defaultSearchHosts;
  const reachable = deps.reachable ?? defaultReachable;

  const resolved = await Promise.all(
    entries.map(async (entry): Promise<{ entry: string; domain: string | null }> => {
      const cleaned = clean(entry);
      if (!cleaned) return { entry, domain: null };
      if (DOMAIN_SHAPE.test(cleaned)) return { entry, domain: cleaned };
      const fromSearch = pickCompetitorDomain(cleaned, await searchHosts(cleaned).catch(() => []));
      if (fromSearch) return { entry, domain: fromSearch };
      const guess = `${squash(cleaned)}.com`;
      const ok = DOMAIN_SHAPE.test(guess) && (await reachable(guess).catch(() => false));
      return { entry, domain: ok ? guess : null };
    }),
  );

  const domains = [...new Set(resolved.flatMap((r) => (r.domain ? [r.domain] : [])))];
  const unresolved = resolved.filter((r) => !r.domain && clean(r.entry)).map((r) => clean(r.entry));
  return { domains, unresolved };
}
