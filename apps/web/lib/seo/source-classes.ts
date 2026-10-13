// ---------------------------------------------------------------------------
// Whose pages the writer may cite: what each researched site IS
// ---------------------------------------------------------------------------
//
// The writer is handed the pages that rank for its keyword, and on a buyer's
// search most of those pages belong to businesses selling the same thing. In
// the live first articles of 2026-10-01 the writer cited rival businesses in
// about 6 of 9 head runs and 3 of 8 main runs: a rival clinic as the authority
// for a figure, a rival agency quoted in bold in 3 of 3 runs, vendors of the
// very software the owner sells. An article that sends its reader to the
// competition is worse than no article, and the fact check read it as clean.
//
// So every site research reads is put in a class before anything is quoted:
//
//   own                the business's own site
//   named_rival        a competitor the owner (or the results pages) named
//   same_service       sells the owner's service, or a direct substitute
//   information        public body, university, encyclopedia, association,
//                      media, research, standards body
//   supplier_retailer  sells equipment or products, not the owner's service
//   other              directories, forums, listings, everything else
//   unclassified       nobody could say
//
// Code decides what it can (the own domain, the owner's rivals, government,
// academic and encyclopedia hosts); one narrow model call per draft decides
// the rest (lib/seo/source-classify.ts). This file is pure: it is read at
// generation, by the fact check at approval, and by the publish gate, so it
// imports no client and makes no request.
//
// Fail closed. A figure is offered to the writer only from an `information`
// page or the business's own; a site nobody classified is never quoted. A
// link to a `same_service` or `named_rival` site is removed from the draft
// (the anchor text stays), and a figure or claim attributed to one is
// `high_risk` in the fact check.

import { stripTags } from "@/lib/audit/html-utils";
import type { SourceFigure } from "./source-figures";

export type SourceClass =
  | "own"
  | "named_rival"
  | "same_service"
  | "information"
  | "supplier_retailer"
  | "other"
  | "unclassified";

export interface ClassifiedSource {
  /** Host without `www.`, lower case. */
  host: string;
  class: SourceClass;
  /** Who decided: a code rule, the model, or nobody (unclassified). */
  by: "code" | "model" | "none";
}

/** A link the draft carried to a site it may not send readers to. */
export interface RemovedLink {
  href: string;
  host: string;
  class: SourceClass;
  /** The anchor text, kept in the article as plain text. */
  text: string;
  /**
   * The plain text of the block (paragraph, list item, cell) the link was
   * in, so only a sentence of that block is read as still crediting the
   * removed site - not every sentence anywhere that shares its anchor words.
   */
  context?: string;
}

/**
 * What research decided about its sources, saved with the research so the
 * fact check at approval reads the same evidence generation did.
 */
export interface SourceReview {
  /** The business's own domain, bare. */
  ownDomain: string | null;
  /** The competitors the owner named and the results-page rivals, as stored on the profile. */
  rivals: string[];
  classes: ClassifiedSource[];
  /**
   * The model's part: `ok` it answered, `skipped` nothing was left for it,
   * `unavailable` no key or no business description to judge against,
   * `failed` it was asked and gave no usable answer.
   */
  model: "ok" | "skipped" | "unavailable" | "failed";
  /** Figures read off pages the writer was not offered, with the page's class. */
  heldBack: Array<SourceFigure & { class: SourceClass }>;
  /** Links removed from the draft after writing. Absent until the scrub ran. */
  removedLinks?: RemovedLink[];
  /** Hosts the draft links to that no rule or model classified. Absent until the scrub ran. */
  unclassifiedLinks?: string[];
}

/** Sites the article may not cite, quote or link. */
export const BLOCKED_CLASSES: ReadonlySet<SourceClass> = new Set<SourceClass>(["same_service", "named_rival"]);
/** Sites a figure may be quoted from. Everything else is held back. */
export const FIGURE_CLASSES: ReadonlySet<SourceClass> = new Set<SourceClass>(["information", "own"]);

/** The classes the model may answer with. `own` and `named_rival` are code's alone. */
export const MODEL_CLASSES = ["same_service", "information", "supplier_retailer", "other"] as const;
export type ModelClass = (typeof MODEL_CLASSES)[number];

/** `https://www.Acme.example/x` or `www.acme.example` to `acme.example`; "" when it is not a host. */
export function bareHost(urlOrHost: string | null | undefined): string {
  const raw = (urlOrHost ?? "").trim();
  if (!raw) return "";
  let host = raw;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      host = new URL(raw).hostname;
    } catch {
      return "";
    }
  } else {
    host = raw.replace(/[/?#].*$/, "");
  }
  host = host.toLowerCase().replace(/\.$/, "").replace(/^www\d?\./, "");
  return /^[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)+$/u.test(host) ? host : "";
}

/** True when `host` is `parent` or one of its subdomains. */
function within(host: string, parent: string): boolean {
  return Boolean(host && parent) && (host === parent || host.endsWith(`.${parent}`));
}

/**
 * Hosts that are public information by their name alone: government,
 * academic, intergovernmental, encyclopedias. Suffix rules, so they hold in
 * every country and language (`.gov.tr`, `.gouv.fr`, `.gob.es`, `.ac.uk`).
 * Everything else, associations and publishers included, is the model's call.
 */
const INFORMATION_HOST =
  /(?:^|\.)(?:gov|edu|mil|int)(?:\.[a-z]{2})?$|(?:^|\.)(?:gouv|gob|govt|go|ac|gv)\.[a-z]{2}$|(?:^|\.)(?:gc\.ca|canada\.ca|europa\.eu|who\.int|wikipedia\.org|wikimedia\.org|wikidata\.org|wiktionary\.org)$/;

const squash = (s: string) =>
  s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/ı/g, "i").replace(/[^\p{L}\p{N}]/gu, "");

/** Words of a name, each cut at an apostrophe ("Acme'nin" is Acme), folded. */
function words(text: string): string[] {
  return text
    .split(/[^\p{L}\p{N}'’]+/u)
    .map((w) => squash(w.split(/['’]/)[0]))
    .filter(Boolean);
}

/**
 * The part of a host a brand is called by: `acme` for `blog.acme.co.uk`.
 * Second-level registries (`co.uk`, `com.tr`, `com.au`) are read as one
 * suffix.
 */
export function brandLabel(host: string): string {
  const labels = bareHost(host).split(".");
  if (labels.length < 2) return labels[0] ?? "";
  const twoLevel = labels.length >= 3 && labels[labels.length - 1].length === 2 && labels[labels.length - 2].length <= 3;
  return labels[labels.length - (twoLevel ? 3 : 2)];
}

/** A typed competitor name, or a domain, as a host when it is one. */
const DOMAIN_SHAPE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/;
function rivalDomain(entry: string): string | null {
  const host = bareHost(entry);
  return host && DOMAIN_SHAPE.test(host) ? host : null;
}

/**
 * Words that make a name an institution - an association, a public body, a
 * school, a network or a register - in the supported languages, folded. A
 * source named like this is not a business that sells a service, even when a
 * seller's domain is spelt from the same generic words.
 */
const INSTITUTION =
  /^(?:association|associations|society|federation|alliance|network|council|college|institute|institution|university|ministry|department|agency|authority|board|commission|foundation|organi[sz]ation|register|registry|bureau|office|union|chamber|academy|journal|survey|statistics|associazione|societa|federazione|rete|consiglio|collegio|istituto|universita|ministero|agenzia|autorita|commissione|fondazione|organizzazione|ordine|camera|accademia|asociacion|sociedad|federacion|consejo|colegio|instituto|universidad|ministerio|agencia|autoridad|fundacion|organizacion|societe|federation|reseau|conseil|ordre|universite|ministere|autorite|verband|gesellschaft|bund|netzwerk|rat|kammer|institut|hochschule|universitat|ministerium|behorde|amt|bundesamt|stiftung|kommission|akademie|dernegi|dernek|federasyon|federasyonu|birligi|birlik|konseyi|kurulu|kurumu|enstitusu|enstitu|universitesi|bakanligi|ajansi|vakfi|odasi|akademisi)$/;

/** Leading words a name may carry before the name itself ("the", "il", "die"). */
const LEADING = /^(?:the|a|an|il|lo|la|i|gli|le|l|el|los|las|der|die|das|den|dem|des|une?|bir)$/;

/**
 * Does this source name - the name a sentence credits ("Acme Apps", "the
 * Coastal Physio Network") - name the business behind `host` (or the typed
 * `name`)?
 *
 * Strict on purpose, because a match makes the claim high risk and blocks
 * approval. The brand, spelt as a run of whole words, must be what the name
 * starts with, and the rest of the name must not make it an institution:
 * "Acme Apps" and "Acme Physio Clinic" name acmeapps.example and
 * acmephysio.example, but "Northland Physiotherapy Association" does not name
 * physiotherapy.example, and "Coastal Physio Network of Northland" does not name
 * coastalphysio.example. Sellers whose domain is two generic words are common
 * in local markets, and those same words start the names of the associations
 * and public bodies the writer is told to cite.
 */
export function namesBusiness(sourceName: string, hostOrName: string): boolean {
  const domain = rivalDomain(hostOrName);
  const target = domain ? squash(brandLabel(domain)) : squash(hostOrName);
  if (target.length < 3) return false;
  const tokens = words(sourceName);
  let start = 0;
  while (start < tokens.length - 1 && LEADING.test(tokens[start])) start++;
  let run = "";
  let end = start;
  while (end < tokens.length && run.length < target.length) run += tokens[end++];
  if (run !== target) return false;
  return !tokens.slice(end).some((w) => INSTITUTION.test(w));
}

/** The competitors on a profile: the ones the owner named, then the results-page rivals. */
export function rivalsOf(profile: unknown): string[] {
  if (!profile || typeof profile !== "object") return [];
  const p = profile as { competitors?: unknown; searchRivals?: unknown };
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : []);
  return [...new Set([...list(p.competitors), ...list(p.searchRivals)].map((s) => s.trim()))];
}

/** Does this host belong to one of the named rivals (a domain, or a typed name)? */
function isNamedRival(host: string, rivals: readonly string[]): boolean {
  return rivals.some((r) => {
    const domain = rivalDomain(r);
    if (domain) return within(host, domain);
    const name = squash(r);
    return name.length >= 3 && squash(brandLabel(host)) === name;
  });
}

/** What code alone can say about a host, or null when it is the model's question. */
export function classifyByCode(host: string, owner: { ownDomain: string | null; rivals: readonly string[] }): ClassifiedSource | null {
  const h = bareHost(host);
  if (!h) return null;
  const own = bareHost(owner.ownDomain);
  if (own && within(h, own)) return { host: h, class: "own", by: "code" };
  if (isNamedRival(h, owner.rivals)) return { host: h, class: "named_rival", by: "code" };
  if (INFORMATION_HOST.test(h)) return { host: h, class: "information", by: "code" };
  return null;
}

/**
 * The class of the site a URL is on: the review's verdict for that host (or a
 * host it is a subdomain of, or one that is its subdomain), else what code can
 * say, else `unclassified`.
 */
export function classOf(url: string, review: SourceReview | null | undefined): SourceClass {
  const host = bareHost(url);
  if (!host) return "unclassified";
  const owner = { ownDomain: review?.ownDomain ?? null, rivals: review?.rivals ?? [] };
  const byCode = classifyByCode(host, owner);
  // Own and named rivals are the owner's word and outrank a model's.
  if (byCode && (byCode.class === "own" || byCode.class === "named_rival")) return byCode.class;
  const known = review?.classes.find((c) => c.host === host) ??
    review?.classes.find((c) => within(host, c.host) || within(c.host, host));
  if (known && known.class !== "unclassified") return known.class;
  return byCode?.class ?? "unclassified";
}

/**
 * The host of a URL research read but nobody classified - the classifier
 * failed, was unavailable, or the site was past its cap - or null. A site
 * research never read is not this: nobody was asked about it.
 */
export function readButUnclassified(url: string, review: SourceReview | null | undefined): string | null {
  if (!review || classOf(url, review) !== "unclassified") return null;
  const host = bareHost(url);
  return review.classes.some((c) => c.class === "unclassified" && (within(host, c.host) || within(c.host, host))) ? host : null;
}

/** True when the article may not cite, quote or link the site this URL is on. */
export function isBlockedSource(url: string, review: SourceReview | null | undefined): boolean {
  return BLOCKED_CLASSES.has(classOf(url, review));
}

/** The blocked sites a review knows of: its blocked hosts and the owner's rivals. */
export function blockedNames(review: SourceReview | null | undefined): string[] {
  if (!review) return [];
  return [...new Set([...review.classes.filter((c) => BLOCKED_CLASSES.has(c.class)).map((c) => c.host), ...review.rivals])];
}

/** The blocked host or rival a piece of text names, or null. */
export function namedBlockedSource(text: string | null | undefined, review: SourceReview | null | undefined): string | null {
  if (!text) return null;
  for (const name of blockedNames(review)) if (namesBusiness(text, name)) return name;
  return null;
}

/**
 * The blocked host whose held-back figures carry every figure in a sentence,
 * or null. A figure read off a rival's page and written into the draft with
 * no source is still the rival's figure.
 */
export function heldBackSource(figures: readonly string[], review: SourceReview | null | undefined): string | null {
  const blocked = review?.heldBack.filter((f) => BLOCKED_CLASSES.has(f.class)) ?? [];
  if (!blocked.length || !figures.length) return null;
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "");
  let host: string | null = null;
  for (const figure of figures) {
    const needle = norm(figure);
    if (!/\p{N}/u.test(needle)) return null;
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const bounded = new RegExp(`(?<![\\p{N}.,])${escaped}(?![\\p{N}]|[.,]\\p{N})`, "u");
    const hit = blocked.find((f) => f.figures.some((x) => norm(x) === needle) || bounded.test(norm(f.sentence)));
    if (!hit) return null;
    host ??= bareHost(hit.url) || hit.domain;
  }
  return host;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const fold = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/ı/g, "i").replace(/\s+/g, " ").trim();

/**
 * The removed link this sentence still carries, or null: the sentence is in
 * the block the link was removed from, and it still has the link's words as
 * whole words. Elsewhere the same words are ordinary prose.
 */
export function removedAnchorIn(sentence: string, review: SourceReview | null | undefined): RemovedLink | null {
  const text = fold(sentence);
  const where = squash(sentence);
  if (!where) return null;
  return (
    review?.removedLinks?.find((r) => {
      const anchor = fold(r.text);
      if (anchor.length < 3 || !r.context || !squash(r.context).includes(where)) return false;
      return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(anchor)}(?![\\p{L}\\p{N}])`, "u").test(text);
    }) ?? null
  );
}

const ANCHOR = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
/** Where a block ends, as the fact check splits them (lib/ai/fact-check.ts `toBlocks`). */
const BLOCK_END = /<\/(?:p|h[1-6]|li|blockquote|td|th|div|figcaption)>|<br\s*\/?>/gi;

/** The plain text of the block around `html[from, to)`. */
function blockAround(html: string, from: number, to: number): string {
  let start = 0;
  for (const m of html.slice(0, from).matchAll(BLOCK_END)) start = (m.index ?? 0) + m[0].length;
  const after = html.slice(to);
  const close = after.search(new RegExp(BLOCK_END.source, "i"));
  const end = close === -1 ? html.length : to + close;
  return stripTags(html.slice(start, end)).replace(/\s+/g, " ").trim().slice(0, 2000);
}
const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

/**
 * Remove every link to a site the article may not send readers to, keeping
 * the anchor text, and say what was removed. Links to sites nobody classified
 * stay, and are listed for the reviewer.
 */
export function scrubBlockedLinks(
  html: string,
  review: SourceReview | null | undefined,
): { html: string; removed: RemovedLink[]; unclassified: string[] } {
  const removed: RemovedLink[] = [];
  const unclassified = new Set<string>();
  const out = html.replace(ANCHOR, (whole, attrs: string, inner: string, at: number) => {
    const m = attrs.match(HREF);
    const href = (m?.[1] ?? m?.[2] ?? m?.[3] ?? "").trim();
    if (!/^https?:\/\//i.test(href)) return whole;
    const cls = classOf(href, review);
    if (BLOCKED_CLASSES.has(cls)) {
      removed.push({
        href,
        host: bareHost(href),
        class: cls,
        text: inner.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim(),
        context: blockAround(html, at, at + whole.length),
      });
      return inner;
    }
    if (cls === "unclassified") unclassified.add(bareHost(href));
    return whole;
  });
  return { html: out, removed, unclassified: [...unclassified].filter(Boolean) };
}

/** What the reviewer is told about the sources, or nothing to say. */
export function sourceReviewNotes(review: SourceReview | null | undefined): string[] {
  if (!review) return [];
  const notes: string[] = [];
  const held = review.heldBack.filter((f) => BLOCKED_CLASSES.has(f.class));
  const heldHosts = [...new Set(held.map((f) => bareHost(f.url) || f.domain))];
  if (held.length) {
    notes.push(
      `${held.length} figure${held.length === 1 ? "" : "s"} on pages of businesses that sell what you sell (${heldHosts.slice(0, 4).join(", ")}${heldHosts.length > 4 ? ", …" : ""}) ${held.length === 1 ? "was" : "were"} kept from the writer.`,
    );
  }
  if (review.model === "failed" || review.model === "unavailable") {
    notes.push("The ranking pages' sites could not be classified, so only figures from public, academic and encyclopedia sites were offered to the writer.");
  }
  const removed = review.removedLinks ?? [];
  if (removed.length) {
    const hosts = [...new Set(removed.map((r) => r.host))];
    notes.push(
      `Removed ${removed.length} link${removed.length === 1 ? "" : "s"} to businesses that sell what you sell (${hosts.slice(0, 4).join(", ")}${hosts.length > 4 ? ", …" : ""}); the linked words are still in the text. Check the sentences around them do not still credit that business.`,
    );
  }
  const unknown = review.unclassifiedLinks ?? [];
  const read = unknown.filter((h) => review.classes.some((c) => c.class === "unclassified" && (within(h, c.host) || within(c.host, h))));
  const unread = unknown.filter((h) => !read.includes(h));
  const list = (hosts: string[]) => `${hosts.slice(0, 4).join(", ")}${hosts.length > 4 ? ", …" : ""}`;
  if (read.length) {
    notes.push(
      `The draft links ${read.length} site${read.length === 1 ? "" : "s"} research read but could not classify (${list(read)}). Check none of them sells what you sell.`,
    );
  }
  if (unread.length) {
    notes.push(
      `The draft links ${unread.length} site${unread.length === 1 ? "" : "s"} research did not read (${list(unread)}). Check none of them sells what you sell.`,
    );
  }
  return notes;
}
