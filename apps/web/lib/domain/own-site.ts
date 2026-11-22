// ---------------------------------------------------------------------------
// Is this the business's own site, or a link to somewhere else?
// ---------------------------------------------------------------------------
//
// The domain field takes whatever a person pastes, and `normalizeDomain`
// keeps only the host. A signup pasted a share link on 2026-11-16: the host
// of a link shortener became their "website", the first look read the
// shortener's own page ("too little readable text"), and every phase was
// skipped. A social profile or a marketplace listing ends the same way: the
// host belongs to someone else, and the page we would read is theirs.
//
// So before a site is made from what was typed:
//
//   a shortener or share link   is followed, by its redirect headers only,
//                               and the site it leads to is used; when it
//                               leads nowhere we can use, it is refused
//   a social profile, a link    refused, with a sentence asking for the
//   page, a marketplace         business's own site
//   listing
//
// Hosted sites on their own subdomain (a store on a shop platform, a blog on
// a blogging platform) are sites and pass: only hosts where a business is a
// path on someone else's site are listed.
//
// Only listed shortener hosts are ever requested, and only for their
// redirect header: the address a link points at is read, never fetched, so
// nothing typed here can make the server call a host of the typist's choice.

import { DOMAIN_PATTERN, normalizeDomain } from "./shape";

export type NotOwnSite = "shortener" | "social" | "link_page" | "marketplace";

const SHORTENERS = [
  "share.google", "g.co", "goo.gl", "g.page", "bit.ly", "bitly.com", "tinyurl.com", "t.co", "ow.ly", "buff.ly", "is.gd", "v.gd", "rebrand.ly",
  "cutt.ly", "shorturl.at", "lnkd.in", "fb.me", "youtu.be", "wa.me", "t.me", "amzn.to", "amzn.eu", "rb.gy", "tiny.cc", "s.id", "qr.codes", "page.link",
];
const SOCIAL = [
  "facebook.com", "fb.com", "instagram.com", "tiktok.com", "x.com", "twitter.com", "linkedin.com", "youtube.com", "pinterest.com", "threads.net",
  "threads.com", "snapchat.com", "whatsapp.com", "telegram.org", "telegram.me", "reddit.com", "discord.gg", "discord.com", "twitch.tv", "vk.com",
];
const LINK_PAGES = ["linktr.ee", "linktree.com", "beacons.ai", "bio.link", "linkin.bio", "taplink.cc", "lnk.bio", "campsite.bio", "msha.ke", "allmylinks.com"];
const MARKETPLACES = [
  "etsy.com", "fiverr.com", "upwork.com", "booking.com", "yelp.com", "trustpilot.com", "google.com", "maps.app.goo.gl", "apple.com", "play.google.com",
  "depop.com", "vinted.com", "gumroad.com", "justdial.com", "indiamart.com", "alibaba.com", "aliexpress.com", "walmart.com", "thumbtack.com", "houzz.com",
];
/** Marketplaces with a site per country: any ending. */
const MARKETPLACE_ANYWHERE = /(^|\.)(amazon|ebay|airbnb|tripadvisor)\.(com|co\.[a-z]{2}|com\.[a-z]{2}|[a-z]{2})$/;

const onHost = (host: string, list: readonly string[]) => list.some((h) => host === h || host.endsWith(`.${h}`));

/** What a host is when it is not a business's own site; null when it may be one. */
export function hostKind(rawHost: string): NotOwnSite | null {
  const host = rawHost.trim().toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  if (!host) return null;
  // Maps and business-profile links live under hosts that also shorten.
  if (host === "maps.app.goo.gl") return "marketplace";
  if (onHost(host, SHORTENERS)) return "shortener";
  if (onHost(host, LINK_PAGES)) return "link_page";
  if (onHost(host, SOCIAL)) return "social";
  // A site built on a platform's own subdomain is a site.
  if (host === "sites.google.com" || host === "business.site" || host.endsWith(".business.site")) return host === "sites.google.com" ? "marketplace" : null;
  if (onHost(host, MARKETPLACES) || MARKETPLACE_ANYWHERE.test(host)) return "marketplace";
  return null;
}

const WHAT: Record<NotOwnSite, string> = {
  shortener: "a share link",
  social: "a social media profile",
  link_page: "a link-in-bio page",
  marketplace: "a listing on someone else's site",
};

/** The sentence at the field: what it is, and what to enter instead. */
export function notOwnSiteMessage(kind: NotOwnSite): string {
  return `That is ${WHAT[kind]}, not your website. Enter your business's own site, like acme.com: we read it to plan and write your articles.`;
}

export type OwnSite =
  /** `via`: the share link's host, when the domain is where one led. */
  | { ok: true; domain: string; via?: string }
  | { ok: false; kind: NotOwnSite; reason: string };

const refuse = (kind: NotOwnSite): OwnSite => ({ ok: false, kind, reason: notOwnSiteMessage(kind) });

function parse(raw: string): URL | null {
  const typed = raw.trim();
  if (!typed) return null;
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `https://${typed}`);
  } catch {
    return null;
  }
}

/** How many redirects a share link is followed through, and how long each may take. */
const MAX_HOPS = 5;
const HOP_TIMEOUT_MS = 4_000;

/**
 * The domain to make a site for, from what was typed; or why not.
 *
 * Never throws. Anything that does not parse as a URL is handed back
 * normalised, for the caller's own shape check to refuse in its own words.
 */
export async function resolveOwnSite(raw: string, deps: { fetch?: (url: string, init: RequestInit) => Promise<Response>; timeoutMs?: number } = {}): Promise<OwnSite> {
  const url = parse(raw);
  if (!url) return { ok: true, domain: normalizeDomain(raw) };
  const first = hostKind(url.hostname);
  if (first === null) return { ok: true, domain: normalizeDomain(url.hostname) };
  if (first !== "shortener") return refuse(first);
  // Without the outside world (the browser suite) a share link leads nowhere.
  if (process.env.E2E_STUBS === "1" && !deps.fetch) return refuse("shortener");

  const get = deps.fetch ?? ((target: string, init: RequestInit) => fetch(target, init));
  let at = url;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    let location: string | null = null;
    try {
      const res = await get(at.toString(), {
        method: "GET",
        redirect: "manual",
        headers: { "user-agent": "AltoRankBot/1.0 (+https://altorank.co)" },
        signal: AbortSignal.timeout(deps.timeoutMs ?? HOP_TIMEOUT_MS),
      });
      location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    } catch {
      location = null;
    }
    if (!location) return refuse("shortener");
    let next: URL;
    try {
      next = new URL(location, at);
    } catch {
      return refuse("shortener");
    }
    if (next.protocol !== "https:" && next.protocol !== "http:") return refuse("shortener");
    const kind = hostKind(next.hostname);
    if (kind === null) {
      const domain = normalizeDomain(next.hostname);
      return DOMAIN_PATTERN.test(domain) ? { ok: true, domain, via: normalizeDomain(url.hostname) } : refuse("shortener");
    }
    if (kind !== "shortener") return refuse(kind);
    at = next;
  }
  return refuse("shortener");
}

/**
 * A domain of its own that only forwards to a profile or a listing: where
 * the reachability check landed (lib/domain/reachable.ts `landed`), read the
 * same way. Null when it landed on a site.
 */
export function landedAway(landed: string | null | undefined): Extract<OwnSite, { ok: false }> | null {
  if (!landed) return null;
  const url = parse(landed);
  const kind = url ? hostKind(url.hostname) : null;
  return kind ? (refuse(kind) as Extract<OwnSite, { ok: false }>) : null;
}
