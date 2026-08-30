/**
 * JSON-LD proposals drafted from evidence found on the page.
 *
 * This is the remediation half of agent-readiness: `agent-readiness.ts` reports
 * that a site has no Organization schema, this module drafts one.
 *
 * The governing rule: **every field must be traceable to something on the
 * page.** We are writing structured claims about someone else's business onto
 * their own website. Inventing a `description`, guessing a `telephone`, or
 * assuming a social profile is the same class of error as the fabricated
 * traction that was scrubbed from AltoRank's own marketing, except the blast
 * radius is a client's brand. So every emitted field carries provenance, and
 * anything we cannot source is reported in `missing` for a human to fill rather
 * than guessed at.
 *
 * That shape is also what makes this safe behind the approval gate: a reviewer
 * sees "name came from og:site_name" and can accept or reject per field.
 *
 * Self-contained on purpose (no Supabase, no Next, no @/lib imports) so it
 * lifts into packages/core alongside agent-readiness.ts.
 */

import { collectJsonLdTypes } from "./agent-readiness";
import { decode, stripTags } from "./html-utils";

export { decode };

export type Confidence = "high" | "medium";

export interface FieldProvenance {
  field: string;
  value: unknown;
  /** Where on the page this came from, e.g. 'og:site_name', 'tel: link'. */
  source: string;
  confidence: Confidence;
}

export interface SchemaProposal {
  type: "Organization" | "FAQPage" | "Product";
  jsonLd: Record<string, unknown>;
  provenance: FieldProvenance[];
  /** Fields worth having that no evidence supported. Needs human input. */
  missing: string[];
  warnings: string[];
}

export interface ProposalSet {
  url: string;
  existingTypes: string[];
  proposals: SchemaProposal[];
  notes: string[];
}

// ── html helpers ──────────────────────────────────────────────────────────────

// decode / stripTags live in ./html-utils so this module and the markdown
// converter resolve entities identically.

function meta(html: string, key: string): string | undefined {
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]+content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${key}["']`, "i"),
  ];
  for (const p of patterns) {
    const v = html.match(p)?.[1];
    if (v && decode(v)) return decode(v);
  }
  return undefined;
}

/** Existing JSON-LD nodes, flattened through @graph. */
function existingNodes(html: string): Record<string, unknown>[] {
  const blocks = [
    ...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi),
  ].map((m) => m[1]);
  const nodes: Record<string, unknown>[] = [];
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) return void n.forEach(walk);
    if (n === null || typeof n !== "object") return;
    const rec = n as Record<string, unknown>;
    if (rec["@type"]) nodes.push(rec);
    for (const v of Object.values(rec)) if (typeof v === "object" && v !== null) walk(v);
  };
  for (const b of blocks) {
    try { walk(JSON.parse(b.trim())); } catch { /* malformed contributes nothing */ }
  }
  return nodes;
}

// ── sameAs ────────────────────────────────────────────────────────────────────

/**
 * Social profiles are the highest-value part of Organization schema: `sameAs`
 * is what resolves the entity across the open web.
 *
 * Share/intent URLs are excluded. A "tweet this" button is not the company's
 * profile, and a sameAs pointing at twitter.com/intent/tweet is a false claim
 * about identity, not a harmless extra.
 */
const SOCIAL = [
  { name: "linkedin", re: /https?:\/\/(?:[a-z]{2}\.)?(?:www\.)?linkedin\.com\/(?:company|in|school)\/[A-Za-z0-9_%-]+/gi },
  { name: "x", re: /https?:\/\/(?:www\.)?(?:twitter|x)\.com\/[A-Za-z0-9_]+/gi },
  { name: "facebook", re: /https?:\/\/(?:www\.)?facebook\.com\/[A-Za-z0-9.\-]+/gi },
  { name: "instagram", re: /https?:\/\/(?:www\.)?instagram\.com\/[A-Za-z0-9_.]+/gi },
  { name: "youtube", re: /https?:\/\/(?:www\.)?youtube\.com\/(?:@[A-Za-z0-9_.-]+|c\/[A-Za-z0-9_-]+|channel\/[A-Za-z0-9_-]+)/gi },
  { name: "github", re: /https?:\/\/(?:www\.)?github\.com\/[A-Za-z0-9_-]+/gi },
];

const SHARE_PATH = /\/(?:intent|share|sharer|shareArticle|dialog|home\?status)/i;
/** Platform routes that are never a company profile. */
const NON_PROFILE = /\/(?:privacy|terms|about|legal|policies|help|login|signup|hashtag|explore|search)(?:\/|$)/i;

export function extractSocialProfiles(html: string): string[] {
  const found = new Set<string>();
  for (const { re } of SOCIAL) {
    for (const m of html.matchAll(re)) {
      const url = m[0].replace(/[).,'"]+$/, "");
      if (SHARE_PATH.test(url) || NON_PROFILE.test(url)) continue;
      // Bare platform roots carry no identity.
      if (/^https?:\/\/(?:www\.)?[a-z.]+\.[a-z]{2,}\/?$/i.test(url)) continue;
      found.add(url);
    }
  }
  return [...found].sort();
}

// ── company name ──────────────────────────────────────────────────────────────

/**
 * The legal/trading name out of a footer copyright line.
 *
 * Ranked above the <title> because agency titles lead with keyword phrases far
 * more often than with the brand. Measured on ten live Italian and EU agency
 * sites: the title heuristic proposed "Realizzazione siti web" for genesi.it
 * and "OmniSearch" for netprofiler.nl, where the copyright line gave
 * "Genesi.IT S.r.l." and "Netprofiler".
 *
 * Legal suffixes (S.r.l., GmbH, BV) are kept deliberately: for an Organization
 * node the registered name is the more correct claim.
 */
export function extractCopyrightName(html: string): string | undefined {
  const text = decodeEntitiesForName(html);
  // Stripping tags joins the copyright line to whatever markup follows it, so
  // the capture has to stop at the phrases that typically come next. Without
  // this, netprofiler.nl yielded "Netprofiler Terms and conditions".
  const BOUNDARY =
    /\s*(?:[-–—|·©®™]|tutti i diritti|all rights|alle rechte|alle rechten|todos los derechos|p\.?\s?iva|vat|btw|kvk|c\.?f\.?|terms|privacy|cookie|sitemap|contact|impressum|disclaimer|powered by|realizzato|\d{4})/i;

  const raw = text.match(/(?:©|copyright)\s*(?:\d{4}\s*(?:[-–—]\s*\d{4})?\s*)?([A-ZÀ-Ý][^<>]{1,70})/i)?.[1];
  if (!raw) return undefined;

  let name = raw.split(BOUNDARY)[0].replace(/\s+/g, " ").trim();
  // Trailing separators go; a trailing period stays, since it is usually part of
  // a legal abbreviation ("Genesi.IT S.r.l.") rather than sentence punctuation.
  name = name.replace(/[,;:]+$/, "").replace(/\s*[®™]\s*$/, "").trim();

  // Guards: a stray "Copyright section" comment, and runaway captures. A
  // company name is rarely more than six words.
  if (name.length < 2) return undefined;
  if (/^(section|start|end|notice)\b/i.test(name)) return undefined;
  if (name.split(/\s+/).length > 6) return undefined;
  return name;
}

/** Entity-decode without collapsing tags, for footer scanning. */
function decodeEntitiesForName(html: string): string {
  return decode(html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "").replace(/<[^>]+>/g, " "));
}

const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Does a candidate name plausibly belong to this domain?
 *
 * Cheap, and it catches the exact failure the title heuristic produces: a
 * keyword phrase with no relationship to the brand. "Realizzazione siti web"
 * shares nothing with genesi.it; "Genesi.IT S.r.l." obviously does.
 */
export function nameMatchesDomain(name: string, domain: string): boolean {
  const host = normalise(domain.replace(/^www\./, "").split(".")[0]);
  const candidate = normalise(name);
  if (!host || !candidate) return false;
  if (candidate.includes(host) || host.includes(candidate)) return true;
  // Multi-word brands: every domain token appearing in order is good enough.
  return host.length > 6 && candidate.includes(host.slice(0, Math.ceil(host.length * 0.7)));
}

// ── Organization ──────────────────────────────────────────────────────────────

function proposeOrganization(html: string, url: string): SchemaProposal {
  const origin = new URL(url).origin;
  const provenance: FieldProvenance[] = [];
  const missing: string[] = [];
  const warnings: string[] = [];
  const node: Record<string, unknown> = { "@context": "https://schema.org", "@type": "Organization" };

  const add = (field: string, value: unknown, source: string, confidence: Confidence = "high") => {
    node[field] = value;
    provenance.push({ field, value, source, confidence });
  };

  // Name, in descending order of trustworthiness. Ordering is empirical: on ten
  // live agency sites og:site_name was right 5/5, while the title heuristic was
  // wrong 4/5 because agency titles lead with keyword phrases, not brands.
  //
  // Logo alt text is deliberately NOT a source. datodigitale.it's logo alt is
  // "Enel", a *client's* brand, which would have produced a confidently wrong
  // claim about who the site belongs to.
  const host = new URL(url).hostname;
  const siteName = meta(html, "og:site_name");
  const copyright = extractCopyrightName(html);
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  // Split on separators and commas so "Alberto Pozzi, Web Manager, ..." can
  // yield "Alberto Pozzi".
  const titleParts = title
    ? decode(title).split(/\s*[|–—·•,]\s*|\s+-\s+/).map((p) => p.trim()).filter(Boolean)
    : [];
  const domainConsistentPart = titleParts.find((p) => nameMatchesDomain(p, host));

  if (siteName) {
    add("name", siteName, "og:site_name");
  } else if (copyright) {
    add("name", copyright, "footer copyright line");
  } else if (domainConsistentPart) {
    add("name", domainConsistentPart, "<title> segment matching the domain", "medium");
    warnings.push(`name "${domainConsistentPart}" was inferred from <title>; confirm the legal or trading name`);
  } else if (titleParts.length) {
    // Nothing corroborates this. Emit the best guess so the proposal is usable,
    // but say plainly that it is unverified rather than dressing it as medium
    // confidence, and list it as needing a human.
    add("name", titleParts[0], "<title>, first segment (UNVERIFIED)", "medium");
    missing.push("name (confirm: no og:site_name, no copyright line, and the title does not match the domain)");
    warnings.push(
      `name "${titleParts[0]}" is a guess from a title that does not reference the domain. ` +
      "Agency titles usually lead with keywords, so this is very likely the tagline, not the company. Confirm before use.",
    );
  } else {
    missing.push("name");
  }

  add("url", origin, "page origin");

  // logo: an OG image is usually a social card, not a logo. Prefer real logos.
  const appleIcon = html.match(/<link[^>]+rel=["']apple-touch-icon["'][^>]+href=["']([^"']+)["']/i)?.[1];
  const namedLogo = html.match(/<img[^>]+(?:src)=["']([^"']+)["'][^>]*(?:alt|class)=["'][^"']*logo[^"']*["']/i)?.[1]
    ?? html.match(/<img[^>]*(?:alt|class)=["'][^"']*logo[^"']*["'][^>]*src=["']([^"']+)["']/i)?.[1];
  const logo = namedLogo ?? appleIcon;
  if (logo) {
    add("logo", new URL(logo, origin).href, namedLogo ? "img tagged as logo" : "apple-touch-icon",
      namedLogo ? "high" : "medium");
  } else {
    missing.push("logo");
  }

  const description = meta(html, "description") ?? meta(html, "og:description");
  if (description) add("description", description, "meta description");
  else missing.push("description");

  const sameAs = extractSocialProfiles(html);
  if (sameAs.length) {
    add("sameAs", sameAs, `${sameAs.length} social profile link(s) on the page`);
  } else {
    missing.push("sameAs");
    warnings.push("no social profiles found; sameAs is the strongest entity-resolution signal");
  }

  // Contact details only from explicit markup, never scraped from prose.
  const tel = html.match(/<a[^>]+href=["']tel:([^"']+)["']/i)?.[1];
  if (tel) add("telephone", decode(tel), "tel: link");
  const email = html.match(/<a[^>]+href=["']mailto:([^"'?]+)/i)?.[1];
  if (email) add("email", decode(email), "mailto: link");

  if (!tel && !email) missing.push("contactPoint");

  return { type: "Organization", jsonLd: node, provenance, missing, warnings };
}

// ── FAQPage ───────────────────────────────────────────────────────────────────

/**
 * Q&A pairs are only ever *extracted*, never written. Generating plausible
 * questions and marking them up as FAQPage would be asserting that content
 * exists on a page when it does not, which is both a false schema claim and a
 * structured-data policy violation.
 */
export function extractFaqPairs(html: string): { question: string; answer: string }[] {
  const pairs: { question: string; answer: string }[] = [];

  // <details><summary>Q</summary> A </details> — the most reliable signal.
  for (const m of html.matchAll(/<details[^>]*>([\s\S]*?)<\/details>/gi)) {
    const inner = m[1];
    const q = inner.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i)?.[1];
    if (!q) continue;
    const a = stripTags(inner.replace(/<summary[^>]*>[\s\S]*?<\/summary>/i, ""));
    const question = stripTags(q);
    if (question && a.length > 20) pairs.push({ question, answer: a });
  }

  // Heading ending in "?" followed by prose.
  if (!pairs.length) {
    const headings = [...html.matchAll(/<(h[23])[^>]*>([\s\S]*?)<\/\1>([\s\S]*?)(?=<h[23][\s>]|$)/gi)];
    for (const m of headings) {
      const question = stripTags(m[2]);
      if (!question.endsWith("?")) continue;
      const answer = stripTags((m[3].match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1]) ?? "");
      if (answer.length > 20) pairs.push({ question, answer });
    }
  }

  return pairs;
}

function proposeFaq(html: string): SchemaProposal | null {
  const pairs = extractFaqPairs(html);
  // Two pairs is the floor; one Q&A is usually a heading that happens to ask
  // something rhetorical rather than an FAQ section.
  if (pairs.length < 2) return null;

  return {
    type: "FAQPage",
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: pairs.map((p) => ({
        "@type": "Question",
        name: p.question,
        acceptedAnswer: { "@type": "Answer", text: p.answer },
      })),
    },
    provenance: pairs.map((p, i) => ({
      field: `mainEntity[${i}]`,
      value: p.question,
      source: "question and answer text present on the page",
      confidence: "high" as const,
    })),
    missing: [],
    warnings: [
      "FAQ markup must stay in sync with the visible page; remove it if the Q&A is edited away",
    ],
  };
}

// ── Product ───────────────────────────────────────────────────────────────────

function proposeProduct(html: string, url: string): SchemaProposal | null {
  const name = meta(html, "og:title");
  const priceRaw = meta(html, "product:price:amount") ?? meta(html, "og:price:amount");
  const currency = meta(html, "product:price:currency") ?? meta(html, "og:price:currency");
  const isProduct = (meta(html, "og:type") ?? "").toLowerCase().includes("product");

  // Without a name and a price signal there is nothing to assert; a Product
  // node with only a title is noise that can misrepresent a non-commerce page.
  if (!name || (!priceRaw && !isProduct)) return null;

  const provenance: FieldProvenance[] = [];
  const missing: string[] = [];
  const node: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Product",
    name,
    url,
  };
  provenance.push({ field: "name", value: name, source: "og:title", confidence: "high" });

  const image = meta(html, "og:image");
  if (image) {
    node.image = new URL(image, url).href;
    provenance.push({ field: "image", value: node.image, source: "og:image", confidence: "high" });
  } else missing.push("image");

  const description = meta(html, "og:description") ?? meta(html, "description");
  if (description) {
    node.description = description;
    provenance.push({ field: "description", value: description, source: "og:description", confidence: "high" });
  } else missing.push("description");

  if (priceRaw && currency) {
    node.offers = {
      "@type": "Offer",
      price: priceRaw,
      priceCurrency: currency,
      url,
    };
    provenance.push({
      field: "offers",
      value: `${priceRaw} ${currency}`,
      source: "product:price meta tags",
      confidence: "high",
    });
  } else {
    missing.push("offers");
  }

  return {
    type: "Product",
    jsonLd: node,
    provenance,
    missing,
    warnings: missing.includes("offers")
      ? ["no price found in meta tags; Product without an Offer is weak and may not be eligible for rich results"]
      : [],
  };
}

// ── entry point ───────────────────────────────────────────────────────────────

/**
 * Draft the schema a page is missing.
 *
 * Types already present are skipped rather than duplicated. Emitting a second
 * Organization node is a real and easy mistake (AltoRank's own homepage shipped
 * one until 2026-08-15) and it splits the entity signal instead of
 * strengthening it.
 */
export function proposeSchema(html: string, url: string): ProposalSet {
  const existingTypes = [...new Set(collectJsonLdTypes(html))];
  const has = (t: string) => existingTypes.includes(t);
  const proposals: SchemaProposal[] = [];
  const notes: string[] = [];

  const ENTITY_EQUIVALENTS = ["Organization", "LocalBusiness", "Corporation", "ProfessionalService"];
  if (ENTITY_EQUIVALENTS.some(has)) {
    notes.push(
      `entity schema already present (${existingTypes.filter((t) => ENTITY_EQUIVALENTS.includes(t)).join(", ")}); ` +
      "not proposing another Organization node",
    );
  } else {
    proposals.push(proposeOrganization(html, url));
  }

  if (has("FAQPage")) {
    notes.push("FAQPage already present; not proposing another");
  } else {
    const faq = proposeFaq(html);
    if (faq) proposals.push(faq);
    else notes.push("no FAQ content found on the page; nothing to mark up");
  }

  if (has("Product")) {
    notes.push("Product already present; not proposing another");
  } else {
    const product = proposeProduct(html, url);
    if (product) proposals.push(product);
  }

  // The existing-nodes scan is what makes augment-not-duplicate possible later.
  const nodeCount = existingNodes(html).length;
  if (nodeCount && proposals.length) {
    notes.push(`${nodeCount} existing JSON-LD node(s) on the page; proposals are additive`);
  }

  return { url, existingTypes, proposals, notes };
}

/** Render a proposal as a script tag ready to inject. */
export function renderJsonLd(proposal: SchemaProposal): string {
  return `<script type="application/ld+json">\n${JSON.stringify(proposal.jsonLd, null, 2)}\n</script>`;
}
