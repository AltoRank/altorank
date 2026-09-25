// ---------------------------------------------------------------------------
// What the writer knows about the business: its own pages, as fetched
// ---------------------------------------------------------------------------
//
// A real signup, 2026-09-22 (Turkish web/mobile agency). His first article was
// a competent guide to choosing an agency - any agency. The writer had been
// given his name, a two-sentence description and his audiences, and nothing
// the onboarding crawl had read a minute earlier: not the services page, not
// the portfolio with named public apps, not the about page, not the contact
// page. It marketed the category, and the contact link it did know was a
// guessed path that answered 404.
//
// This turns the pages already fetched into one input for the writer:
//
//   offerings   the services or products its pages name, with the page
//   work        the projects its portfolio names, as the site names them
//   stated      founding, team and location - only where a page states them
//   about       the opening of its about page, in its own words
//   pages       its section pages, which exist and may be linked
//   conversion  where a ready reader goes, checked again now
//
// Nothing here is inferred. Every entry is text a page carried
// (lib/audit/site-extract.ts kept it at crawl time, migration 095), every URL
// is one that answered 2xx, and what could not be found or checked is said in
// `notes` so the prompt can tell the writer plainly instead of leaving a gap
// it would fill.
//
// Costs no model call and no paid API: one database read, and at most three
// plain GETs to the customer's own site to re-check the conversion page.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { SafeFetch } from "@/lib/public-tools/safe-fetch";
import type { ResearchLayer } from "@/lib/seo/research";
import type { SiteFacts } from "@/lib/ai/types";
import { fold, ROLE_LANGUAGES, type SitePageExtract } from "@/lib/audit/site-extract";
import type { ObservedCheck } from "@/lib/onboarding/business-profile";
import { absoluteOnSite, checkSiteUrl } from "@/lib/onboarding/observed-facts";
import { classifyHref, normaliseSiteUrl } from "@/lib/seo/links";

/** A `site_pages` row, as much of it as the facts are built from. */
export interface SitePageRow {
  url: string;
  title: string | null;
  h1: string | null;
  page_type?: string | null;
  status: number | null;
  extract: SitePageExtract | null;
}

const MAX_OFFERINGS = 12;
const MAX_WORK = 12;
const MAX_STATED = 8;
const MAX_PAGES = 10;
/** Conversion candidates re-checked per draft. Each is one GET to the customer's site. */
const MAX_CONVERSION_CHECKS = 3;

const ROLE_NAME: Record<string, string> = {
  home: "Home",
  offering: "Services",
  work: "Work",
  about: "About",
  contact: "Contact",
  pricing: "Pricing",
};

function isOk(status: number | null): boolean {
  return typeof status === "number" && status >= 200 && status < 300;
}

/**
 * A page the site has: it answered 2xx on the last crawl, or it carries an
 * extract. An extract is only ever written from a 2xx body and is cleared
 * when the page answers 404/410, and a crawl that could not read the page (a
 * timeout, a 429, a 5xx) leaves it alone (lib/seo/site-crawl.ts). So a
 * business page does not drop out of what the writer knows because one
 * nightly run was rate-limited; the notes say it was not re-read.
 */
export function isReadPage(row: Pick<SitePageRow, "status" | "extract">): boolean {
  return isOk(row.status) || row.extract?.v === 1;
}

/** The PostgREST filter for `isReadPage`, so the query and the check cannot drift. */
export const READ_PAGE_FILTER = "and(status.gte.200,status.lt.300),extract.not.is.null";

function pathDepth(url: string): number {
  try {
    return new URL(url).pathname.split("/").filter(Boolean).length;
  } catch {
    return 99;
  }
}

/**
 * Build the facts from the rows, without the conversion page (which needs a
 * network check; see `resolveConversionPage`). Pure, so what the writer is
 * told can be tested against fixture rows.
 */
export function buildSiteFacts(rows: SitePageRow[], domain: string): SiteFacts {
  const read = rows.filter(isReadPage);
  const byKey = new Map<string, SitePageRow>();
  for (const r of read) {
    const key = normaliseSiteUrl(r.url, domain);
    if (!byKey.has(key) || (!byKey.get(key)!.extract && r.extract)) byKey.set(key, r);
  }
  const pages = [...byKey.values()].sort((a, b) => pathDepth(a.url) - pathDepth(b.url));
  /** A same-site URL the writer may link: only one we fetched ourselves. */
  const fetchedUrl = (url: string): string | null => byKey.get(normaliseSiteUrl(url, domain))?.url ?? null;
  const isSameSite = (url: string) => classifyHref(url, domain) === "internal";
  /**
   * Whether a link on a section's index page is an item of that section:
   * under the same first path segment (`/hizmetler/web` on `/hizmetler`), or
   * a fetched page with the same role. A services page also links "Contact
   * us", and that is not a service.
   */
  const inSection = (indexUrl: string, url: string, role: string): boolean => {
    const first = (u: string) => {
      try {
        return new URL(u).pathname.split("/").filter(Boolean)[0]?.toLowerCase() ?? "";
      } catch {
        return "";
      }
    };
    if (first(indexUrl) && first(indexUrl) === first(url) && normaliseSiteUrl(indexUrl, domain) !== normaliseSiteUrl(url, domain)) return true;
    return byKey.get(normaliseSiteUrl(url, domain))?.extract?.role === role;
  };

  const facts: SiteFacts = {
    pagesRead: pages.length,
    offerings: [],
    work: [],
    stated: [],
    about: null,
    headings: [],
    pages: [],
    conversion: null,
    notes: [],
  };

  const addNamed = (
    list: { name: string; url: string | null }[],
    cap: number,
    name: string | null | undefined,
    url: string | null,
  ) => {
    const clean = (name ?? "").replace(/\s+/g, " ").trim();
    if (clean.length < 2 || list.length >= cap) return;
    const existing = list.find((x) => fold(x.name) === fold(clean));
    if (existing) {
      if (!existing.url && url) existing.url = url;
      return;
    }
    list.push({ name: clean, url });
  };
  /** A link's URL as the writer may use it: fetched when on this site, as-is when elsewhere. */
  const linkUrl = (url: string): string | null => (isSameSite(url) ? fetchedUrl(url) : url);

  const withExtract = pages.filter((p): p is SitePageRow & { extract: SitePageExtract } => p.extract?.v === 1);

  // Detail pages first: a page about one service names it best.
  for (const p of withExtract.filter((x) => x.extract.role === "offering" && x.extract.detail)) {
    addNamed(facts.offerings, MAX_OFFERINGS, p.extract.name ?? p.h1 ?? p.title, p.url);
  }
  for (const p of withExtract.filter((x) => x.extract.role === "offering" && !x.extract.detail)) {
    for (const l of p.extract.links) {
      if (inSection(p.url, l.url, "offering")) addNamed(facts.offerings, MAX_OFFERINGS, l.text, linkUrl(l.url));
    }
  }

  for (const p of withExtract.filter((x) => x.extract.role === "work" && x.extract.detail)) {
    addNamed(facts.work, MAX_WORK, p.extract.name ?? p.h1 ?? p.title, p.url);
  }
  for (const p of withExtract.filter((x) => x.extract.role === "work" && !x.extract.detail)) {
    // A portfolio names its projects by linking them, often to the live app
    // or the client's site rather than to a page here.
    for (const l of p.extract.links) {
      if (!isSameSite(l.url) || inSection(p.url, l.url, "work")) addNamed(facts.work, MAX_WORK, l.text, linkUrl(l.url));
    }
  }

  // The homepage last: on a one-page site it is where the services and the
  // work are, and on any other it repeats what the section pages say.
  for (const role of ["offering", "work", "pricing", "home"] as const) {
    for (const p of withExtract.filter((x) => x.extract.role === role && !x.extract.detail && x.extract.headings?.length)) {
      if (facts.headings.length >= 4) break;
      facts.headings.push({ page: p.extract.name ?? p.h1 ?? p.title ?? ROLE_NAME[role] ?? "Home", url: p.url, items: p.extract.headings });
    }
  }

  const seenStated = new Set<string>();
  for (const role of ["about", "home", "contact"] as const) {
    for (const p of withExtract.filter((x) => x.extract.role === role)) {
      for (const s of p.extract.stated) {
        const key = fold(s.text);
        if (seenStated.has(key) || facts.stated.length >= MAX_STATED) continue;
        seenStated.add(key);
        facts.stated.push({ kind: s.kind, text: s.text, source: p.url });
      }
    }
  }

  const about = withExtract.find((x) => x.extract.role === "about" && x.extract.text);
  if (about) facts.about = { text: about.extract.text, source: about.url };

  for (const role of ["offering", "work", "about", "contact", "pricing"] as const) {
    for (const p of withExtract.filter((x) => x.extract.role === role && !x.extract.detail)) {
      if (facts.pages.length >= MAX_PAGES || facts.pages.some((x) => x.url === p.url)) continue;
      facts.pages.push({ role: ROLE_NAME[role], name: p.extract.name ?? p.h1 ?? p.title ?? ROLE_NAME[role], url: p.url });
    }
  }

  const stale = pages.filter((p) => !isOk(p.status));
  if (stale.length) {
    facts.notes.push(
      `${stale.length} of these pages did not answer the latest crawl (${[...new Set(stale.map((p) => (p.status ? `HTTP ${p.status}` : "no answer")))].join(", ")}); ` +
        "what they say is from the last time they answered.",
    );
  }

  if (facts.pagesRead === 0) {
    facts.notes.push("No page of this site has been read yet, so nothing is known about it beyond the profile.");
  } else if (!withExtract.some((x) => x.extract.role !== "home")) {
    facts.notes.push(
      `None of the ${facts.pagesRead} pages read was recognised as a services, portfolio, about or contact page. ` +
        `Pages are recognised by their structured data, or by their names in ${ROLE_LANGUAGES.slice(0, -1).join(", ")} ` +
        `and ${ROLE_LANGUAGES[ROLE_LANGUAGES.length - 1]}; a site in another language was not checked this way.`,
    );
  }
  return facts;
}

/** The pages worth offering as the conversion page, best first. */
export function conversionCandidates(rows: SitePageRow[], domain: string): string[] {
  const facts = rows.filter((r) => isReadPage(r) && r.extract?.v === 1 && !r.extract.detail);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const role of ["contact", "pricing"] as const) {
    for (const r of facts.filter((x) => x.extract!.role === role).sort((a, b) => pathDepth(a.url) - pathDepth(b.url))) {
      const key = normaliseSiteUrl(r.url, domain);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r.url);
    }
  }
  return out;
}

export interface ConversionOutcome {
  conversion: SiteFacts["conversion"];
  /** For the reviewer: what was checked, and why the page is what it is. */
  note: string;
}

/**
 * Where a ready reader goes, checked now.
 *
 * The saved conversion page first - it was checked when the profile was
 * proposed, or a person typed it - then the contact and pricing pages the
 * crawl read. Each is opened once. A page that answers is used; a page that
 * is definitively gone is skipped; a page the site will not let us check
 * right now (a rate limit, a bot wall) is used only if it had already been
 * shown to exist, and the note says it was not re-checked. When none is
 * left, there is no conversion page, and the prompt says so rather than
 * letting the writer build one from a word.
 */
export async function resolveConversionPage(opts: {
  stored: string | null | undefined;
  storedCheck?: ObservedCheck | null;
  candidates: string[];
  domain: string;
  fetch?: SafeFetch;
}): Promise<ConversionOutcome> {
  const { domain } = opts;
  const failures: string[] = [];
  const stored = opts.stored?.trim() ? absoluteOnSite(opts.stored, domain) : null;
  const tried = new Set<string>();

  const attempt = async (url: string, shownBefore: boolean, label: string, anyHost = false): Promise<ConversionOutcome | null> => {
    tried.add(normaliseSiteUrl(url, domain));
    const check = await checkSiteUrl(url, domain, { fetch: opts.fetch, anyHost });
    // `check` completes a sentence the prompt starts; `note` is a sentence of its own.
    const inline = label.charAt(0).toLowerCase() + label.slice(1);
    if (check.state === "verified") {
      return {
        conversion: { url: check.url, check: `${inline} answered HTTP ${check.status} when this draft was written` },
        note: `${label} ${check.url} answered HTTP ${check.status}.`,
      };
    }
    if (check.state === "unverified" && shownBefore) {
      return {
        conversion: { url, check: `${inline} was shown to exist before; not re-checked now (${check.reason})` },
        note: `${label} ${url} could not be re-checked now (${check.reason}); used because it answered before.`,
      };
    }
    failures.push(`${url} ${check.state === "unverified" ? `could not be checked (${check.reason})` : check.reason.startsWith("HTTP") ? `answered ${check.reason}` : check.reason}`);
    return null;
  };

  // Why the saved page was passed over, for the note; null when there was
  // none or it was used.
  let storedFailure: string | null = null;
  if (stored) {
    // Shown to exist before: the site read checked this very URL (a person
    // may have typed a different one since), or the crawl fetched it.
    const same = (u: string | null | undefined) => {
      const abs = u ? absoluteOnSite(u, domain) : null;
      return abs !== null && normaliseSiteUrl(abs, domain) === normaliseSiteUrl(stored, domain);
    };
    const storedVerified = Boolean(opts.storedCheck?.verified && same(opts.storedCheck.proposed)) || opts.candidates.some(same);
    // A stored page on another host can only have been typed by a person:
    // the site read refuses to store one (lib/onboarding/observed-facts.ts).
    const hit = await attempt(stored, storedVerified, "The saved conversion page", classifyHref(stored, domain) !== "internal");
    if (hit) return hit;
    storedFailure = failures[failures.length - 1] ?? null;
  }
  let checks = 0;
  for (const url of opts.candidates) {
    if (checks >= MAX_CONVERSION_CHECKS) break;
    if (tried.has(normaliseSiteUrl(url, domain))) continue;
    checks++;
    // Every candidate was fetched with a 2xx by the crawl: shown to exist.
    const hit = await attempt(url, true, "The contact page read on the site");
    if (hit) {
      return storedFailure
        ? { conversion: hit.conversion, note: `The saved conversion page ${storedFailure}; using ${hit.conversion!.url} instead. ${hit.note}` }
        : hit;
    }
  }
  if (!stored && opts.candidates.length === 0) {
    return { conversion: null, note: "No contact, booking or pricing page was found among the pages read, and none is saved." };
  }
  return { conversion: null, note: `No conversion page could be confirmed: ${failures.join("; ")}.` };
}

/** One line for the draft's research panel: what the writer was told, and from what. */
function layerDetail(facts: SiteFacts, conversionNote: string): string {
  const parts = [
    `${facts.offerings.length} offering${facts.offerings.length === 1 ? "" : "s"}`,
    `${facts.work.length} piece${facts.work.length === 1 ? "" : "s"} of work`,
    `${facts.stated.length} stated fact${facts.stated.length === 1 ? "" : "s"}`,
  ];
  return [`${parts.join(", ")} from ${facts.pagesRead} page${facts.pagesRead === 1 ? "" : "s"} read.`, conversionNote, ...facts.notes]
    .filter(Boolean)
    .join(" ");
}

/**
 * The facts for one draft, with the conversion page re-checked. Never
 * throws: a draft is still written without them, and the layer says why.
 */
export async function loadSiteFacts(
  supabase: SupabaseClient,
  workspaceId: string,
  domain: string | null | undefined,
  profile: unknown,
  opts: { fetch?: SafeFetch } = {},
): Promise<{ facts: SiteFacts; layer: ResearchLayer }> {
  const empty = (note: string): SiteFacts => ({
    pagesRead: 0, offerings: [], work: [], headings: [], stated: [], about: null, pages: [], conversion: null, notes: [note],
  });
  if (!domain) {
    const facts = empty("This workspace has no domain, so none of the business's pages could be read.");
    return { facts, layer: { id: "site_facts", status: "unavailable", detail: facts.notes[0] } };
  }
  try {
    const { data, error } = await supabase
      .from("site_pages")
      .select("url, title, h1, page_type, status, extract")
      .eq("workspace_id", workspaceId)
      .or(READ_PAGE_FILTER)
      .limit(1000);
    if (error) {
      const facts = empty(`The business's pages could not be read from the database (${error.message}).`);
      return { facts, layer: { id: "site_facts", status: "failed", detail: facts.notes[0] } };
    }
    const rows = (data ?? []) as SitePageRow[];
    const facts = buildSiteFacts(rows, domain);

    const p = (profile && typeof profile === "object" ? profile : {}) as {
      conversionUrl?: unknown;
      observedChecks?: { conversionUrl?: ObservedCheck | null } | null;
    };
    const outcome = await resolveConversionPage({
      stored: typeof p.conversionUrl === "string" ? p.conversionUrl : null,
      storedCheck: p.observedChecks?.conversionUrl ?? null,
      candidates: conversionCandidates(rows, domain),
      domain,
      fetch: opts.fetch,
    });
    facts.conversion = outcome.conversion;
    if (!outcome.conversion) facts.notes.push(outcome.note);
    return {
      facts,
      layer: {
        id: "site_facts",
        status: facts.pagesRead > 0 ? "ok" : "unavailable",
        detail: layerDetail(facts, outcome.conversion ? outcome.note : ""),
      },
    };
  } catch (err) {
    const facts = empty(`The business's pages could not be read (${err instanceof Error ? err.message : "unknown error"}).`);
    return { facts, layer: { id: "site_facts", status: "failed", detail: facts.notes[0] } };
  }
}
