// ---------------------------------------------------------------------------
// What a business says about itself, kept from pages we already fetched
// ---------------------------------------------------------------------------
//
// A real signup, 2026-09-22 (Turkish web/mobile agency): onboarding read his
// services page, his portfolio with named public projects, his about page and
// his contact page, stored their titles and threw the rest away. The writer
// then got three profile fields and wrote an article that marketed the
// category - "how to choose an agency" - instead of him. Everything it needed
// to market his own offer had been downloaded and discarded a minute earlier.
//
// This keeps the minimal part of each such page while the HTML is in hand: no
// second request, no model, no paid API. Two crawls call it - the sitemap
// crawl (lib/seo/site-crawl.ts) and the homepage-first link crawl
// (lib/audit/crawler.ts), because a hand-built site with no sitemap is only
// ever reached the second way - and the result is stored on the page's
// `site_pages` row (migration 095). lib/content/site-facts.ts turns the rows
// into what the writer is told.
//
// Which page is which is decided by the page itself, in this order: its
// structured data (AboutPage, ContactPage, Service...), then the words in its
// URL, then its own heading. The words are a table in the languages listed in
// ROLE_LANGUAGES. A page in any other language is not guessed at: it gets no
// role, and the writer is told plainly that no such page was recognised.
//
// Pure functions over one HTML string. Nothing here fetches.

import { decode, decodeEntities, stripTags } from "./html-utils";
import { extractMainContent } from "./markdown";

/** What a page is for the business. Articles and everything else have none. */
export type PageRole = "offering" | "work" | "about" | "contact" | "pricing";

export interface SiteLink {
  /** The link's visible text, as the site writes it. */
  text: string;
  /** Absolute URL. */
  url: string;
}

export interface StatedFact {
  kind: "founded" | "team" | "location";
  /** The sentence (or structured-data value) exactly as the page states it. */
  text: string;
}

export interface SitePageExtract {
  /** Shape version, so a reader can tell an extract written by older code. */
  v: 1;
  /** "home" is the site root; the rest are PageRole. */
  role: PageRole | "home";
  /** Which signal decided the role, so a wrong one can be traced. */
  roleFrom: "root" | "schema" | "path" | "heading";
  /**
   * A page about ONE service, product or project (`/services/web-design`,
   * `/portfolio/some-app`), as opposed to the index that lists them.
   */
  detail: boolean;
  /** What the page calls itself: its H1, else the first part of its title. */
  name: string | null;
  /** H2/H3 inside the main content, in order. An index page's list of services or plans. */
  headings: string[];
  /** Links inside the main content that carry words. A portfolio's projects, a services index's services. */
  links: SiteLink[];
  /** The opening of the page's main text. Only on an about page; everywhere else it is not needed. */
  text: string;
  /** Founding year, team size and location, only where the page states them. */
  stated: StatedFact[];
}

/** The languages whose page names the role table knows. Said out loud wherever it matters. */
export const ROLE_LANGUAGES = ["English", "Turkish", "Italian", "Spanish", "French", "German", "Portuguese", "Dutch"] as const;

/**
 * Path segments that name a blog. Shared with lib/seo/site-crawl.ts, which
 * uses it to tell a post from a page; here it keeps a post whose slug happens
 * to contain "contact" from being taken for the contact page.
 */
export const POST_SEGMENTS = /\/(blog|posts?|articles?|news|insights|stories|guide|guida|guides)\//i;

/**
 * Lower-case, accents folded, Turkish dotless i and German sharp s spelled
 * out. "İletişim", "iletisim" and "ILETISIM" are one word here, which is how
 * a hand-built Turkish site and a WordPress slug of the same page compare.
 */
export function fold(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ı/g, "i")
    .replace(/ß/g, "ss")
    .trim();
}

/**
 * The words a page's URL or heading uses for each role, folded. One entry per
 * spelling a site actually uses; a slug and a heading are both matched whole,
 * never as a substring, so "/blog/how-to-contact-support" is not a contact page.
 */
const ROLE_WORDS: Record<PageRole, readonly string[]> = {
  offering: [
    // en
    "services", "our-services", "service", "what-we-do", "solutions", "our-solutions", "capabilities",
    "expertise", "products", "our-products", "product", "features",
    // tr
    "hizmetler", "hizmetlerimiz", "hizmet", "cozumler", "cozumlerimiz", "urunler", "urunlerimiz", "ozellikler",
    // it
    "servizi", "i-nostri-servizi", "cosa-facciamo", "soluzioni", "prodotti", "funzionalita",
    // es
    "servicios", "nuestros-servicios", "soluciones", "productos", "funcionalidades", "caracteristicas",
    // fr
    "nos-services", "prestations", "produits", "fonctionnalites",
    // de
    "leistungen", "dienstleistungen", "unsere-leistungen", "losungen", "loesungen", "produkte", "funktionen",
    // pt
    "servicos", "nossos-servicos", "solucoes", "produtos",
    // nl
    "diensten", "onze-diensten", "oplossingen", "producten", "functies",
  ],
  work: [
    // en
    "portfolio", "work", "our-work", "projects", "our-projects", "case-studies", "case-study", "clients",
    "our-clients", "customers", "showcase", "references", "success-stories",
    // tr
    "referanslar", "referanslarimiz", "projeler", "projelerimiz", "portfolyo", "calismalarimiz", "islerimiz",
    "musterilerimiz", "musteriler",
    // it
    "progetti", "i-nostri-progetti", "lavori", "i-nostri-lavori", "clienti", "casi-studio", "referenze",
    // es
    "proyectos", "trabajos", "clientes", "casos-de-exito", "portafolio",
    // fr
    "realisations", "nos-realisations", "projets", "etudes-de-cas", "nos-clients",
    // de
    "referenzen", "projekte", "kunden", "fallstudien",
    // pt
    "projetos", "trabalhos", "casos-de-sucesso",
    // nl
    "projecten", "referenties", "klanten", "cases",
  ],
  about: [
    // en
    "about", "about-us", "company", "who-we-are", "our-story", "team", "our-team",
    // tr
    "hakkimizda", "hakkinda", "kurumsal", "biz-kimiz", "ekibimiz", "ekip",
    // it
    "chi-siamo", "azienda", "chi-sono",
    // es
    "sobre-nosotros", "quienes-somos", "nosotros", "empresa",
    // fr
    "a-propos", "qui-sommes-nous", "entreprise", "equipe",
    // de
    "ueber-uns", "uber-uns", "unternehmen",
    // pt
    "sobre", "sobre-nos", "quem-somos",
    // nl
    "over-ons",
  ],
  contact: [
    // en
    "contact", "contact-us", "contacts", "get-in-touch", "get-a-quote", "quote", "request-a-quote",
    "book-a-call", "book-a-demo", "demo",
    // tr
    "iletisim", "bize-ulasin", "teklif-al", "teklif-iste",
    // it
    "contatti", "contattaci", "preventivo", "richiedi-preventivo",
    // es
    "contacto", "contactenos", "contactanos", "presupuesto",
    // fr
    "contactez-nous", "devis",
    // de
    "kontakt", "angebot", "anfrage",
    // pt
    "contato", "fale-conosco", "orcamento",
    // nl
    "offerte",
  ],
  pricing: [
    // en
    "pricing", "prices", "plans", "rates",
    // tr
    "fiyatlar", "fiyatlandirma", "paketler", "fiyat-listesi",
    // it
    "prezzi", "listino", "tariffe", "piani",
    // es
    "precios", "planes", "tarifas",
    // fr
    "tarifs", "prix", "offres",
    // de
    "preise", "preisliste", "tarife",
    // pt
    "precos", "planos",
    // nl
    "prijzen", "tarieven",
  ],
};

const SLUG_ROLE = new Map<string, PageRole>();
const LABEL_ROLE = new Map<string, PageRole>();
for (const [role, words] of Object.entries(ROLE_WORDS) as [PageRole, readonly string[]][]) {
  for (const w of words) {
    SLUG_ROLE.set(w, role);
    LABEL_ROLE.set(w.replace(/-/g, " "), role);
  }
}
// The heading forms a site writes that its slug does not spell.
for (const [label, role] of [
  ["about us", "about"], ["contact us", "contact"], ["get in touch", "contact"], ["our work", "work"],
  ["bize ulasin", "contact"], ["neler yapiyoruz", "offering"], ["kimiz", "about"],
] as const) LABEL_ROLE.set(label, role);

/** Schema types that say what a page is, whatever language it is in. */
const SCHEMA_ROLE: Record<string, { role: PageRole; detail: boolean }> = {
  aboutpage: { role: "about", detail: false },
  contactpage: { role: "contact", detail: false },
  service: { role: "offering", detail: true },
  product: { role: "offering", detail: true },
};

/** Two-letter locale segments (`/tr`, `/en-gb`), skipped when reading a path. */
const LOCALE_SEGMENT = /^[a-z]{2}(-[a-z]{2})?$/i;

/** Anchor texts that name no thing: "read more" is a link to a project, not the project's name. */
const GENERIC_ANCHORS = new Set([
  "read more", "learn more", "more", "details", "detail", "view", "view project", "view more", "see more",
  "see project", "discover", "discover more", "click here", "here", "next", "previous", "back",
  "devami", "devamini oku", "detaylar", "detay", "incele", "daha fazla", "tumunu gor", "projeyi incele",
  "scopri", "scopri di piu", "leggi", "leggi di piu", "dettagli", "ver mas", "leer mas", "saber mas",
  "en savoir plus", "voir", "voir plus", "lire la suite", "mehr", "mehr erfahren", "weiterlesen",
  "saiba mais", "ver mais", "leia mais", "lees meer", "meer", "bekijk",
]);

const MAX_HEADINGS = 12;
const MAX_LINKS = 24;
const MAX_TEXT = 600;
const MAX_STATED = 4;
const MAX_SENTENCE = 220;

function segmentsOf(url: string): string[] {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url;
  }
  return path
    .split("/")
    .filter(Boolean)
    .map((s) => {
      try {
        return fold(decodeURIComponent(s));
      } catch {
        return fold(s);
      }
    })
    .map((s) => s.replace(/\.(html?|php|aspx?)$/, ""))
    .filter((s) => !LOCALE_SEGMENT.test(s));
}

/** A heading or title, reduced to the form the label table holds. */
function labelOf(text: string): string {
  return fold(text).replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

function firstTitlePart(title: string | null): string | null {
  if (!title) return null;
  const part = title.split(/\s[|–—·-]\s|\s::?\s/)[0]?.trim();
  return part || null;
}

/**
 * The JSON-LD objects a page declares about itself: each block's top-level
 * object, array items and `@graph` members, and every object nested under
 * them when `deep` is set.
 *
 * Shallow for the page's role: an Organization block that lists what it
 * offers nests a `Service` under `makesOffer`, and that block is on every
 * page of the site, so a nested type says nothing about THIS page. Deep for
 * stated facts, because an address sits inside the organisation it belongs to.
 */
function jsonLdNodes(html: string, deep: boolean): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const walk = (node: unknown, depth: number): void => {
    if (Array.isArray(node)) {
      node.forEach((n) => walk(n, depth));
      return;
    }
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    out.push(record);
    if (Array.isArray(record["@graph"])) (record["@graph"] as unknown[]).forEach((n) => walk(n, depth));
    if (!deep) return;
    for (const [k, v] of Object.entries(record)) if (k !== "@graph" && v && typeof v === "object") walk(v, depth + 1);
  };
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      walk(JSON.parse(m[1].trim()), 0);
    } catch {
      // Malformed JSON-LD states nothing.
    }
  }
  return out;
}

function typesOf(node: Record<string, unknown>): string[] {
  const t = node["@type"];
  return (Array.isArray(t) ? t : t ? [t] : []).map((x) => String(x).toLowerCase());
}

/**
 * The page's role and how it was decided. Null for a page that is none of
 * them, which is most pages, and for any piece of writing.
 */
export function roleOf(
  url: string,
  opts: { h1?: string | null; title?: string | null; schemaTypes?: string[] } = {},
): { role: PageRole | "home"; roleFrom: SitePageExtract["roleFrom"]; detail: boolean } | null {
  let pathname = "/";
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url;
  }
  // A post is writing, whatever its slug says.
  if (POST_SEGMENTS.test(`${pathname.replace(/\/?$/, "/")}`)) return null;

  const segments = segmentsOf(url);
  if (segments.length === 0) return { role: "home", roleFrom: "root", detail: false };

  for (const t of (opts.schemaTypes ?? []).map((x) => x.toLowerCase())) {
    const hit = SCHEMA_ROLE[t];
    if (hit) return { role: hit.role, roleFrom: "schema", detail: hit.detail };
  }

  // The first two meaningful segments: `/hizmetler`, `/tr/hizmetler/web`,
  // `/company/about-us`. Deeper than that is a page inside a section, and its
  // section is what names it.
  for (let i = 0; i < Math.min(2, segments.length); i++) {
    const role = SLUG_ROLE.get(segments[i]);
    if (role) return { role, roleFrom: "path", detail: segments.length > i + 1 };
  }

  for (const candidate of [opts.h1, firstTitlePart(opts.title ?? null)]) {
    if (!candidate) continue;
    const role = LABEL_ROLE.get(labelOf(candidate));
    if (role) return { role, roleFrom: "heading", detail: false };
  }
  return null;
}

/**
 * The page's main text as lines, one per block element, so a contact page's
 * "Adres: ..." and "Telefon: ..." - which carry no full stop between them -
 * stay two statements instead of one run-on.
 */
function textLines(mainHtml: string): string[] {
  return decodeEntities(
    mainHtml
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|li|h[1-6]|div|section|address|td|th|dd|dt|blockquote|figcaption)\s*>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .split(/\n+/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/**
 * Statements to test: a short line whole, a long one by sentence. Whole
 * where it fits because a full stop is not always a sentence end - "Moda
 * Cad. No:1" is one address, and splitting it keeps half of it.
 */
function sentencesOf(lines: string[]): string[] {
  return lines
    .flatMap((l) => (l.length <= MAX_SENTENCE ? [l] : l.split(/(?<=[.!?])\s+/)))
    .map((s) => s.trim())
    .filter((s) => s.length >= 12);
}

const YEAR = /\b(1[89]\d\d|20\d\d)\b/;
/** Words that make a year a founding year, folded, in the ROLE_LANGUAGES. */
const FOUNDED =
  /\b(founded|established|since|kuruldu|kurulan|kurulus|kurulusumuzdan|beri|fondat[aoie]|fondazione|dal|seit|gegrundet|depuis|fondee?|creee?|desde|fundad[ao]|opgericht|sinds)\b|\best\.\s*(1[89]|20)\d\d/;
/** A count followed, within two words, by people, folded. */
const TEAM =
  /\b\d{1,5}\+?\s+(?:[\p{L}-]+\s+){0,2}?(employees|people|staff|team members|specialists|experts|engineers|developers|designers|professionals|kisi|kisilik|calisan|calisanimiz|uzman|uzmanimiz|personel|persone|dipendenti|professionisti|collaboratori|mitarbeiter|mitarbeitende|experten|employes|personnes|collaborateurs|empleados|personas|profesionales|expertos|funcionarios|pessoas|profissionais|medewerkers|mensen)\b/u;
/** Phrases that put a business somewhere, folded. */
const LOCATION =
  /\b(based in|headquartered in|located in|offices? in|merkezli|merkezimiz|ofisimiz|adres|adresimiz|address|con sede|sede a|sede in|indirizzo|mit sitz in|anschrift|basee a|situee? a|adresse|con sede en|ubicad[ao] en|direccion|sediad[ao] em|endereco|gevestigd in)\b/;

/** Founding, team and location sentences, only as the page states them. */
export function statedFacts(mainHtml: string, html: string, now = new Date()): StatedFact[] {
  const out: StatedFact[] = [];
  const seen = new Set<string>();
  const add = (kind: StatedFact["kind"], text: string) => {
    const clean = text.replace(/\s+/g, " ").trim().slice(0, MAX_SENTENCE);
    const key = `${kind}:${fold(clean)}`;
    if (!clean || seen.has(key) || out.length >= MAX_STATED) return;
    seen.add(key);
    out.push({ kind, text: clean });
  };

  // Structured data first: it is the site stating the fact on purpose.
  for (const node of jsonLdNodes(html, true)) {
    const founding = node.foundingDate;
    if (typeof founding === "string" && YEAR.test(founding)) add("founded", `Founding date in the site's structured data: ${founding}`);
    const employees = node.numberOfEmployees;
    const count =
      typeof employees === "number" || typeof employees === "string"
        ? String(employees)
        : employees && typeof employees === "object"
          ? String((employees as Record<string, unknown>).value ?? (employees as Record<string, unknown>).minValue ?? "")
          : "";
    if (count && /\d/.test(count)) add("team", `Number of employees in the site's structured data: ${count}`);
    const address = node.address;
    if (address && typeof address === "object" && typesOf(address as Record<string, unknown>).includes("postaladdress")) {
      const a = address as Record<string, unknown>;
      const country = typeof a.addressCountry === "object" && a.addressCountry ? (a.addressCountry as Record<string, unknown>).name : a.addressCountry;
      const parts = [a.addressLocality, a.addressRegion, country].filter((p): p is string => typeof p === "string" && p.trim() !== "");
      if (parts.length) add("location", `Address in the site's structured data: ${parts.join(", ")}`);
    }
  }

  // An <address> element is the page saying where the business is.
  const addressEl = html.match(/<address\b[^>]*>([\s\S]*?)<\/address>/i)?.[1];
  if (addressEl) add("location", stripTags(addressEl));

  const year = now.getUTCFullYear();
  for (const sentence of sentencesOf(textLines(mainHtml))) {
    const f = fold(sentence);
    const y = f.match(YEAR);
    if (y && Number(y[1]) <= year && FOUNDED.test(f)) add("founded", sentence);
    else if (TEAM.test(f)) add("team", sentence);
    else if (LOCATION.test(f)) add("location", sentence);
  }
  return out;
}

function headingsIn(mainHtml: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of mainHtml.matchAll(/<h([23])\b[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    const text = stripTags(m[2]);
    if (text.length < 2 || text.length > 120 || seen.has(fold(text))) continue;
    // "Our services" over a list of services is the list's label, not an item in it.
    if (LABEL_ROLE.has(labelOf(text))) continue;
    seen.add(fold(text));
    out.push(text);
    if (out.length >= MAX_HEADINGS) break;
  }
  return out;
}

function linksIn(mainHtml: string, pageUrl: string, opts: { external: boolean }): SiteLink[] {
  const out: SiteLink[] = [];
  const seen = new Set<string>();
  let pageHost = "";
  try {
    pageHost = new URL(pageUrl).hostname.replace(/^www\./, "");
  } catch {
    return out;
  }
  for (const m of mainHtml.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const href = decodeEntities(m[1].match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i)?.slice(1).find((v) => v !== undefined) ?? "").trim();
    if (!href || href.startsWith("#") || /^(mailto|tel|sms|javascript):/i.test(href)) continue;
    let abs: URL;
    try {
      abs = new URL(href, pageUrl);
    } catch {
      continue;
    }
    if (abs.protocol !== "http:" && abs.protocol !== "https:") continue;
    abs.hash = "";
    const sameSite = abs.hostname.replace(/^www\./, "") === pageHost;
    if (!sameSite && !opts.external) continue;
    // A link to the page itself, or to the root, names nothing.
    if (sameSite && (abs.pathname === "/" || abs.href.replace(/\/$/, "") === pageUrl.replace(/#.*$/, "").replace(/\/$/, ""))) continue;
    const text = decode(m[2].replace(/<[^>]*>/g, " "));
    if (text.length < 2 || text.length > 120 || GENERIC_ANCHORS.has(labelOf(text))) continue;
    const key = abs.href;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text, url: abs.href });
    if (out.length >= MAX_LINKS) break;
  }
  return out;
}

/**
 * The part of one fetched page the writer can use, or null when the page is
 * not the home, services, portfolio, about, contact or pricing page.
 *
 * `h1` and `title` may be passed when the caller already parsed them; they
 * are read off the HTML otherwise.
 */
export function extractSitePage(
  html: string,
  url: string,
  opts: { h1?: string | null; title?: string | null; now?: Date } = {},
): SitePageExtract | null {
  if (!html) return null;
  const main = extractMainContent(html).html;
  const h1 = opts.h1 ?? (() => {
    const m = main.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i) ?? html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
    return m ? stripTags(m[1]) || null : null;
  })();
  const title = opts.title ?? (() => {
    const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return m ? stripTags(m[1]) || null : null;
  })();
  const schemaTypes = jsonLdNodes(html, false).flatMap(typesOf);
  const decided = roleOf(url, { h1, title, schemaTypes });
  if (!decided) return null;

  const { role, roleFrom, detail } = decided;
  // The page's own heading is its name, already kept; the text starts after it.
  const bodyText = stripTags(main);
  const mainText = h1 && bodyText.startsWith(h1) ? bodyText.slice(h1.length).trim() : bodyText;
  const index = !detail && (role === "offering" || role === "work" || role === "pricing");
  const extract: SitePageExtract = {
    v: 1,
    role,
    roleFrom,
    detail,
    name: h1 || firstTitlePart(title),
    headings: index ? headingsIn(main) : [],
    links:
      role === "offering" && !detail
        ? linksIn(main, url, { external: false })
        : role === "work"
          // A portfolio names its projects by linking them, and the link is
          // often to the live app or the client's site, not to a page here.
          ? linksIn(main, url, { external: true }).slice(0, detail ? 6 : MAX_LINKS)
          : [],
    text: role === "about" ? mainText.slice(0, MAX_TEXT) : "",
    stated: role === "about" || role === "contact" || role === "home" ? statedFacts(main, html, opts.now) : [],
  };
  return extract;
}
