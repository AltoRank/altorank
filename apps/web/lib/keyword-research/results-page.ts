// ---------------------------------------------------------------------------
// What a results page is, read from the page itself, without a model
// ---------------------------------------------------------------------------
//
// The results judge used to ask a model two questions at once: who is
// searching, and what kind of page wins the search. The second is observable.
// Every stored result carries a URL, a title, a snippet and a domain; a blog
// post, a clinic's service page, a directory listing and a forum thread look
// different in exactly those fields. Asking a model for it made "not
// editorial" and "needs a page" depend on its wording (a SERP of step-by-step
// guides was called "not editorial" because none of them compared products),
// and at temperature 1 the same page flipped between runs.
//
// So the page type is decided here, in code, from the results; the model is
// asked only who the searcher is (./opportunity.ts). Every rule below is a
// fact about a URL or a title, and the counts it decides on are written into
// the verdict's reason, so a wrong call can be read and argued with.

import { brandAliases } from "./seeds";

export type ResultKind =
  /** An article, guide, explainer, list, comparison or reference page. */
  | "editorial"
  /** A business's own service, product, pricing, booking, location or home page. */
  | "commercial"
  /** A listing of businesses: a directory, a map, a review aggregator, a business profile. */
  | "directory"
  /** A forum thread, social post, video or research paper: informational, not an article, not a page to build. */
  | "discussion"
  /** A tool, portal, course, job listing, store or dictionary: nothing an article or a landing page wins. */
  | "utility"
  /** A page that is not about the phrase at all (junk results for a phrase nobody writes about). */
  | "offtopic";

export type PageType =
  /** At least two editorial results, and they outweigh the commercial ones: an article wins it. */
  | "editorial"
  /** Editorial results hold the top alongside commercial ones: an article can win it. */
  | "mixed"
  /** Mostly businesses' own service/product pages: a landing page wins it. */
  | "service"
  /** Mostly directories and business listings: a local landing page wins it. */
  | "local"
  /** One business's own pages and profiles: the searcher is looking for that business. */
  | "navigational"
  /** Tools, portals, courses, jobs or noise: neither an article nor a page wins it. */
  | "other";

export interface ResultsPageEntry {
  url: string;
  title?: string;
  description?: string;
  rank?: number | null;
  domain?: string;
}

export interface ClassifiedResult {
  url: string;
  host: string;
  rank: number;
  kind: ResultKind;
  /** What the page is, finer than `kind`. */
  page: PageKind;
  /** Who said so: the page itself (`certainPageKind`), the results judge, or the word lists. */
  by: "code" | "judge" | "urls";
}

export interface ResultsPageReading {
  type: PageType;
  results: ClassifiedResult[];
  counts: Record<ResultKind, number>;
  /** The editorial results, best-ranked first: the evidence an approval cites. */
  editorialUrls: string[];
  /** For "navigational": the host the page belongs to. */
  owner?: string;
  /** One sentence with the counts, for the verdict's reason. */
  summary: string;
  /** Who read the kinds: the results judge, or the URL and title word lists. */
  basis: "judge" | "urls";
  /**
   * For "other", which rule said so: most results are not about the search,
   * most are tools or portals, or too few are articles and the rest is a mix.
   * Only the last is a search an article might still win (the planner's
   * floor, lib/seo/recommendations.ts).
   */
  why?: "offtopic" | "utility" | "few_articles";
  /** The page kinds of the top results (`PAGE_RULE_TOP`), for the verdict and the log. */
  pages: Record<PageKind, number>;
  /** How many results the page itself decided (`certainPageKind`), overriding the judge where it had read one. */
  decidedByCode: number;
  /**
   * Set when a threshold of the page-type rule decided the type
   * (`NEEDS_PAGE_MIN_PAGES`, `NOT_EDITORIAL_MIN_PAGES`), not the tally.
   */
  rule?: "needs_page" | "not_editorial";
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
};
const hostIs = (host: string, list: readonly string[]) => list.some((h) => host === h || host.endsWith(`.${h}`));

/** Forums, social posts, video and research: informational pages that are not articles. */
const DISCUSSION_HOSTS = [
  "reddit.com", "quora.com", "eksisozluk.com", "technopat.net", "justanswer.com", "stackexchange.com", "stackoverflow.com",
  "youtube.com", "youtu.be", "vimeo.com", "tiktok.com", "pinterest.com", "x.com", "twitter.com", "threads.net",
  "pubmed.ncbi.nlm.nih.gov", "pmc.ncbi.nlm.nih.gov", "ncbi.nlm.nih.gov", "sciencedirect.com", "link.springer.com",
  "semanticscholar.org", "researchgate.net", "scribd.com", "academia.edu", "jstor.org", "wiley.com", "tandfonline.com",
];
/** Social networks: a post is discussion, a profile or company page is a listing. */
const SOCIAL_HOSTS = ["facebook.com", "instagram.com", "linkedin.com"];
const SOCIAL_POST = /\/(groups|posts?|videos?|reels?|p|watch|pulse|feed|photos?|story|stories)\//;
/** Directories, maps, review aggregators, booking platforms and "request a quote" marketplaces. */
const DIRECTORY_HOSTS = [
  "yelp.com", "yelp.ca", "yelp.co.uk", "yellowpages.com", "yellowpages.ca", "mapquest.com", "tripadvisor.com", "healthgrades.com",
  "ratemds.com", "trustpilot.com", "foursquare.com", "clutch.co", "goodfirms.co", "sortlist.com", "maps.google.com", "google.com",
  "bing.com", "janeapp.com", "armut.com", "sikayetvar.com", "thumbtack.com", "angi.com", "houzz.com", "zocdoc.com",
];
/** A host that is a listing by its name: a finder, a directory, a map, "near", yellow pages, a local 211 line. */
const DIRECTORY_HOST_WORD = /(finder|directory|listings?|near\.|near[a-z]*\.|(^|\.)[a-z]*maps?\.|yellow|pages\.|(^|\.)211\.|providersearch|findhealth)/;
/** A path that is a listing entry: a business profile, a company page, a detail page. */
const DIRECTORY_PATH = /\/(bus|biz|business|businessdetails(\.aspx)?|companies|company-profile|firmalar|firma|listing|listings|detail|profile|providers?|directory|find-a-[a-z-]+|find-an-[a-z-]+|clinic-profile)(\/|$)|businessdetails/;

/** Tools, courses, jobs, stores and portals. */
const UTILITY_HOSTS = [
  "apps.apple.com", "play.google.com", "udemy.com", "coursera.org", "btkakademi.gov.tr", "kariyer.net", "indeed.com",
  "glassdoor.com", "secretcv.com", "hepsiburada.com", "trendyol.com", "n11.com", "nadirkitap.com", "amazon.com", "amazon.com.tr",
  "tureng.com", "cambridge.org", "dictionary.com", "merriam-webster.com", "wiktionary.org", "sites.google.com",
  "learn.microsoft.com", "developers.google.com", "developer.android.com", "developer.apple.com", "github.com", "npmjs.com",
];
/** Health and general reference publishers whose pages are articles whatever the path says. */
const REFERENCE_HOSTS = [
  "wikipedia.org", "healthline.com", "webmd.com", "my.clevelandclinic.org", "clevelandclinic.org", "mayoclinic.org", "nhs.uk",
  "nhsinform.scot", "medicalnewstoday.com", "verywellhealth.com", "radiopaedia.org", "healthdirect.gov.au",
  "medlineplus.gov", "hopkinsmedicine.org", "investopedia.com", "hubspot.com",
];

const ARTICLE_SEGMENT = new Set([
  "blog", "blogs", "article", "articles", "post", "posts", "news", "insights", "guide", "guides", "learn", "resources",
  "library", "health-library", "healthbeat", "health", "encyclopedia", "health-encyclopedia", "wiki", "faq", "faqs",
  "expert-advice", "patient-information", "patient-education", "aftercareinformation", "magazine", "stories", "journal",
  "yazi", "yazilar", "makale", "makaleler", "rehber", "haber", "haberler", "icerik", "bilgi", "research-reviews",
  "topics", "newsletter", "blog-detay", "blog-detail", "help-center", "help", "academy-blog",
  "live-well", "health-wellness", "recovery", "knowledge", "kb", "tips", "question", "questions", "education", "ressources",
]);
const SERVICE_SEGMENT = new Set([
  "services", "service", "our-services", "hizmet", "hizmetler", "hizmetlerimiz", "cozum", "cozumler", "cozumlerimiz",
  "urun", "urunler", "urunlerimiz", "product", "products", "pricing", "prices", "fiyat", "fiyatlar", "fiyatlarimiz",
  "contact", "contact-us", "iletisim", "book", "booking", "book-online", "appointment", "locations", "location", "clinic",
  "clinics", "treatments", "treatment", "conditions", "condition", "practitioners", "practitioner", "team", "our-team",
  "about", "about-us", "hakkimizda", "category", "kategori", "shop", "store", "magaza",
  "therapies", "programs", "features", "ozellikler", "solutions", "demo", "patient-info", "client-information", "department", "departments",
]);
const PORTAL = /\b(login|log in|sign in|giriş|portal|sorgula|sorgulama|başvuru|basvuru|e-devlet)\b/i;
const COURSE = /\b(course|courses|kurs|kursu|eğitimi|egitimi|özel ders|ozel ders|bootcamp|sertifika programı|academy|akademi|internship)\b/i;
const JOBS = /\b(iş ilanları|is ilanlari|jobs?|careers?|kariyer|hiring|vacanc(y|ies))\b/i;
/** A snippet that opens with a date is a post: "Mar 28, 2024 —", "31 Tem 2026 —", "2 days ago —". */
const DATED = /^\s*(\p{L}{3,9}\.? \d{1,2}, \d{4}|\d{1,2} \p{L}{3,9}\.? \d{4}|\d{1,2}[./]\d{1,2}[./]\d{2,4}|\d+ (days?|hours?|gün|saat) (ago|önce))\s*[—–-]/u;
const PAPER = /\bcited by \d+|\bby [A-Z]{1,3} [A-Z][a-z]+ · \d{4}/i;
const QUESTION_WORD = /^(what|how|why|when|where|which|who|does|do|can|should|is|are|will|ne|nedir|nasıl|neden|niçin|hangi)\b/i;
const ARTICLE_TITLE = /(\?|\b(guide|tips|explained|exercises|stretches|causes|symptoms|signs|vs\.?|versus|difference|differences|timeline|protocol|what to expect|checklist|benefits|myths|alternatives|compared|comparison|review|reviews|steps|templates|examples|list|ideas|rehber|rehberi|nedir|nasıl|neden|nelerdir|adım|adımda|en iyi|best|top \d+|karşılaştırma|farkı|farkları|avantajları|özellikleri)\b|^\d+\s|\b\d+\+? (best|ways|tips|exercises|steps|reasons|things|signs)\b)/i;
const COMMERCIAL_TITLE = /\b(book (online|now|an?)|appointment|near me|call us|get a quote|teklif al|fiyat teklifi|randevu|hemen ara|free consultation|request a demo|demo talep)\b/i;
const TOOL_TITLE = /\b(builder|generator|calculator|converter|template|oluşturucu|oluşturma aracı|hesaplama|hesaplayıcı|online tool|free tool)\b/i;
const PRICE_SLUG = /^(pricing|prices?|fiyat|fiyatlar|fiyatlari|fiyatlari\d*|ucret|ucretler|ucretleri|cost|costs|rates|tarifeler)$/;
const PHONE = /(\+?\d[\d ().-]{8,}\d)/;
/** A phrase asking ABOUT a business (its alternatives, reviews, price), not for it. */
export const COMPARISON_ASK = /\b(alternative|alternatives|alternatifi|alternatifleri|alternativa|vs|versus|review|reviews|yorum|yorumları|karşılaştırma|compare|comparison|rakip|rakipleri|pricing|fiyat|fiyatları|opinioni|recensioni|confronto|prezzi|prezzo)\b/i;
const COMPARISON = COMPARISON_ASK;

function slugWords(path: string): string[] {
  const last = path.split("/").filter(Boolean).pop() ?? "";
  return last.replace(/\.(html?|php|aspx?)$/, "").split(/[-_+]+/).filter((w) => w && !/^\d+$/.test(w));
}

/**
 * The page a result really is. Google shows some foreign-language results
 * through its translation proxy ("translate.google.com/translate?u=<page>");
 * the page is the one in `u`, not a Google page.
 */
export function unwrapUrl(url: string): string {
  try {
    const u = new URL(url);
    if (/(^|\.)translate\.goog(le\.com)?$/.test(u.hostname) || (u.hostname.endsWith("google.com") && u.pathname.startsWith("/translate"))) {
      const inner = u.searchParams.get("u");
      if (inner && /^https?:\/\//.test(inner)) return inner;
    }
  } catch {
    // not a URL: classified as it is
  }
  return url;
}

/** One result's kind, from its URL, title and snippet. */
export function classifyResult(raw: ResultsPageEntry): ResultKind {
  const r = { ...raw, url: unwrapUrl(raw.url) };
  const host = hostOf(r.url);
  let path = "";
  try {
    path = decodeURIComponent(new URL(r.url).pathname).toLowerCase();
  } catch {
    path = "";
  }
  const title = (r.title ?? "").trim();
  const desc = (r.description ?? "").trim();
  const segs = path.split("/").filter(Boolean);

  if (hostIs(host, DISCUSSION_HOSTS)) return "discussion";
  if (hostIs(host, SOCIAL_HOSTS)) return SOCIAL_POST.test(path + "/") ? "discussion" : "directory";
  if (hostIs(host, UTILITY_HOSTS)) return "utility";
  if (hostIs(host, DIRECTORY_HOSTS) || DIRECTORY_HOST_WORD.test(host) || DIRECTORY_PATH.test(path)) return "directory";
  if (/\.pdf$/.test(path)) return PAPER.test(desc) ? "discussion" : "editorial";
  if (PAPER.test(desc)) return "discussion";
  if (hostIs(host, REFERENCE_HOSTS)) return "editorial";
  if (/(^|\.)gov(\.[a-z]{2})?$|\.gov\./.test(host) && PORTAL.test(`${title} ${path}`)) return "utility";
  if (/^(docs|developer|developers)\./.test(host)) return "utility";
  if (TOOL_TITLE.test(title) && !ARTICLE_TITLE.test(title)) return "utility";
  if (COURSE.test(title) || /\/(course|courses|kurs|egitim|egitimler|academy)\//.test(path)) return "utility";
  if (JOBS.test(title) && !ARTICLE_TITLE.test(title)) return "utility";

  let ed = 0;
  let com = 0;
  if (DATED.test(desc)) ed += 2;
  if (/^(blog|blogs|guide|guides|learn|help|news|magazine|insights)\./.test(host)) ed += 2;
  if (segs.some((s) => ARTICLE_SEGMENT.has(s))) ed += 2;
  if (/\/(19|20)\d\d\/\d{1,2}\//.test(path)) ed += 2;
  const words = slugWords(path);
  if (words.length >= 5) ed += 1;
  if (words.length && QUESTION_WORD.test(words.join(" "))) ed += 1;
  if (QUESTION_WORD.test(title)) ed += 1;
  if (ARTICLE_TITLE.test(title)) ed += 1;

  if (!segs.length) com += 3;
  if (words.some((w) => PRICE_SLUG.test(w)) && !segs.some((s) => ARTICLE_SEGMENT.has(s))) com += 2;
  else if (SERVICE_SEGMENT.has(segs[0]) || (segs.length > 1 && SERVICE_SEGMENT.has(segs[segs.length - 2]))) com += 2;
  if (COMMERCIAL_TITLE.test(title) || COMMERCIAL_TITLE.test(desc)) com += 1;
  if (PHONE.test(title) || /^\s*(phone|tel|call)|\(\d{3}\) \d{3}-\d{4}|\+90 ?\d{3}/i.test(desc)) com += 2;
  if (words.length && words.length <= 3 && ed === 0) com += 1;

  if (ed >= 2 && ed > com) return "editorial";
  if (com >= 2 && com >= ed) return "commercial";
  if (ed > com) return "editorial";
  if (com > ed) return "commercial";
  return words.length >= 4 ? "editorial" : "commercial";
}

// ---------------------------------------------------------------------------
// What each result page IS, read from that page, never from its host
// ---------------------------------------------------------------------------
//
// The results judge names a kind for every result, and until 2026-10-01 its
// word was final. It read clinics' service pages, a clinic's home page and a
// directory listing as articles, and a search whose results were nine
// providers' pages was planned as a first article in three runs of three.
// Some kinds can be read off the page for certain - a home page has no path,
// a booking page sits under /book/, a listing sits on a listing platform, a
// post sits under /blog/ - and those are decided here, whatever the judge
// said. Everything else is the judge's call: a signal that is only likely (a
// slug ending in "-treatment", a place named in a title) is not certain, and
// overruling the judge on it read real articles as providers' pages.
//
// Per page, not per host: a clinic or an agency publishes articles too (both
// topics a customer published from us had mostly providers' hosts and article
// pages), so a provider's blog post is an article and its /services/ page is
// not, on the same host.

/** What a result page is, for the page-type rule. Finer than `ResultKind`: a shop's page and a clinic's page are refused differently. */
export type PageKind =
  /** An article, guide, explainer, list, comparison, reference or news page, whoever publishes it. */
  | "article"
  /** One business's home, service, booking, contact, pricing or location page. */
  | "service_or_local"
  /** A listing of businesses: a directory, a marketplace, a review platform, a social profile. */
  | "directory"
  /** A page selling a product: a shop's product, category or catalogue page. */
  | "product"
  /** A tool, portal, login, course, job listing, app-store page or dictionary. */
  | "portal"
  /** A forum thread, social post, video or research paper. */
  | "discussion"
  /** Not about the search at all. */
  | "offtopic"
  /** A page of the site being planned for. */
  | "own";
export const PAGE_KINDS: readonly PageKind[] = ["article", "service_or_local", "directory", "product", "portal", "discussion", "offtopic", "own"];

/**
 * The page-type rule's thresholds, counted over the top `PAGE_RULE_TOP`
 * results.
 *
 * - `NEEDS_PAGE_MIN_PAGES` or more pages built to sell or to list a provider
 *   (a home, service, booking, pricing or location page, a listing, a
 *   shop's product page): a landing page wins the search, whatever the
 *   judge made of the rest.
 * - `NOT_EDITORIAL_MIN_PAGES` or more tools and portals: neither an article
 *   nor a landing page wins it.
 *
 * Tuned on stored results pages of the train cases only (lib/evals, the
 * `page-type` decision, 2026-10-01/02); a held-out case is scored once, never
 * tuned on. At 5 the rule refused labelled article searches whose ten results
 * split five lists and guides to five providers' pages (the labels call an
 * even split an article search); at 6 it refused none and caught 25 of 26
 * labelled landing-page searches. The eval reports every qualified label
 * left one page short of it by the pages' own reading (`qualifiedAtEdge`).
 * Shop pages count as built pages, not as "not editorial": every shop-heavy
 * page in the labels is one a product or offer page wins. The tools-or-portals
 * threshold decided one train search, rightly (five tools or portals, labelled
 * not editorial); it is set at half the page.
 */
export const NEEDS_PAGE_MIN_PAGES = 6;
export const NOT_EDITORIAL_MIN_PAGES = 5;
/** How many results the rule counts: the first page of results. */
export const PAGE_RULE_TOP = 10;

/** Shops and marketplaces selling products: a page there is a product page. */
const SHOP_HOSTS = [
  "amazon.com", "amazon.com.tr", "amazon.ca", "amazon.co.uk", "ebay.com", "etsy.com", "hepsiburada.com", "trendyol.com", "n11.com",
  "nadirkitap.com", "ikea.com", "walmart.com", "bestbuy.com", "homedepot.com",
];
/**
 * A path segment that is a blog, news or guide section: a page under it is
 * an article whoever publishes it. Stricter than `ARTICLE_SEGMENT`: a
 * clinic's /faq/ or /help/ page is not an article.
 */
const ARTICLE_SECTION = new Set([
  "blog", "blogs", "article", "articles", "post", "posts", "news", "insights", "guide", "guides", "learn", "resources",
  "library", "health-library", "healthbeat", "encyclopedia", "health-encyclopedia", "wiki", "patient-education",
  "patient-information", "aftercareinformation", "magazine", "journal", "newsletter", "stories",
  "yazi", "yazilar", "makale", "makaleler", "rehber", "haber", "haberler", "blog-detay", "blog-detail", "academy-blog",
  "ratgeber", "magazin", "wissen", "aktuelles", "neuigkeiten", "tipps", "notizie", "articoli", "guida", "guide-pratiche",
  "approfondimenti", "consigli",
]);
/** A blog or news section, also as a compound ("seller-blog", "satici-blogu"). */
const isArticleSection = (segment: string) => ARTICLE_SECTION.has(segment) || /(^|-)(blog|blogs|blogu|news|magazine)(-|$)/.test(segment);
/** A path segment that is a business's own service, booking, contact, team or location section. */
const SERVICE_SECTION = /^((.+-)?(services?|treatments?|therapies|leistungen|servizi|hizmet(ler(imiz)?|leri)?)|our-services|book|booking|book-online|appointments?|randevu|contact|contact-us|contacts|iletisim|kontakt|contatti|locations?|clinics|standorte?|sedi|cozum|cozumler|cozumlerimiz|solutions|patient-info|client-information|about|about-us|hakkimizda|uber-uns|ueber-uns|chi-siamo|team|our-team|practitioners?|pricing|prices|preise|prezzi|listino|fiyat|fiyatlar|tarife|fees)$/;
/** A path segment that is a shop's catalogue: a page under it sells a product. */
const PRODUCT_SECTION = /^(shop|store|product|products|prodotto|prodotti|produkt|produkte|urun|urunler|urunlerimiz|collections?|cart|negozio|magaza|catalog|catalogo|katalog)$/;
/** The last word of a page's slug that makes it a price list: "brake-repair-prices", "fiyatlari". */
const PRICE_WORD = /^(pricing|prices|fiyat|fiyatlar|fiyatlari|ucret|ucretler|ucretleri|prezzi|listino|preise|preisliste|tariffe|tarifeler)$/;
/**
 * A title that ranks or counts options: "Top 10 ...", "20 Best ...",
 * "Denver 10+ Garages", "Best ... Companies", "En İyi ... Şirketler".
 * A written list of providers is an article whoever publishes it (the
 * judge read such lists on agencies' sites as directories, 2026-10-01).
 */
const COUNTED_TITLE = /(\btop\s*\d{1,3}\b|\b\d{1,3}\+?\s+(best|en iyi|migliori|beste[nr]?|top)\b|\b(best|en iyi|migliori|beste[nr]?)\s+\d{1,3}\b|^\d{1,3}\+?\s|\s\d{1,3}\+\s)/iu;
const BEST_PLURAL = /\b(best|en iyi)\b[^|]*\b\p{L}{3,}(s|ler|lar|leri|lari)\b/iu;
const SERVICE_PLURAL = /\b(services|solutions|hizmetler|hizmetleri|cozumler|cozumleri)\b/iu;
/** A language prefix (/en/, /en-ca/, /tr/): a path of only that is the home page. */
const LANGUAGE_SEGMENT = /^[a-z]{2}([-_][a-z]{2})?$/;
/** A dated path: /2023/04/11/... */
const DATED_PATH = /\/(19|20)\d\d\/\d{1,2}\//;
/** The most words a page's slug has when the page is named for a section ("brake-services", "brake-repair-prices"); an article's slug is longer. */
const SHORT_SLUG_WORDS = 3;
/** A snippet with a telephone number or a call to call: a business's own page. */
const PHONE_SNIPPET = /^\s*(phone|tel|call)\b|\(\d{3}\) ?\d{3}-\d{4}|\b\d{3}-\d{3}-\d{4}\b|\+90 ?\d{3}|\+39 ?\d{2,3}|\+49 ?\d{2,4}/i;
/**
 * A site's home page: no path, or a language prefix alone. Certain not to be
 * an article, but a forum's, a listing's or a portal's home page is not a
 * provider's: `readResultsPage` lets the judge's reading of one stand, and
 * overrules only its "article".
 */
export function isHomePage(url: string): boolean {
  const { segs } = pathOf(unwrapUrl(url));
  return !segs.length || (segs.length === 1 && LANGUAGE_SEGMENT.test(segs[0]));
}

function pathOf(url: string): { path: string; segs: string[] } {
  try {
    const path = decodeURIComponent(new URL(url).pathname).toLowerCase();
    return { path, segs: path.split("/").filter(Boolean) };
  } catch {
    return { path: "", segs: [] };
  }
}

/**
 * What a result page is, when the page itself says so for certain; null when
 * only reading it can tell (the judge's call). In this order, first match wins:
 *
 *   the site's own host                                   own
 *   a forum, video or paper host; a cited-by snippet      discussion
 *   a social network: a post / a profile                  discussion / directory
 *   a blog/news/guide section; a blog host; a dated path  article
 *   a shop or marketplace host                            product (unless titled as an article)
 *   an app store, course, jobs or dictionary host         portal
 *   a directory host, name or listing path                directory
 *   a reference publisher                                 article
 *   a PDF                                                 the judge's call
 *   the home page (no path, or a language prefix only)    service_or_local (`isHomePage`)
 *   a shop's catalogue section                            product
 *   a title ranking or counting options ("10 best ...")   article
 *   a title asking a question or naming an article
 *     ("guide", "tips", "vs" ...)                         the judge's call
 *   a service, booking, contact, team, pricing or
 *     location section, or a one-segment page named for
 *     one ("/brake-services", "/brake-repair-prices")     service_or_local
 *   a phone number or a booking call in the title         service_or_local
 *
 * A section is a path segment before the page's own slug. A service word
 * ending a longer or deeper slug ("/conditions/<x>-treatments",
 * "/<a-five-word-title>-treatment") says nothing about what the page is
 * (until 2026-10-02 it overruled the judge's "article" on such posts). A
 * blog section is read before a shop's or a portal's host, so a marketplace's
 * or a course site's own articles are articles. A place named in a title
 * ("... in Denver") is left to the judge: "in" and a capitalised word is also
 * English title case and every German noun.
 */
export function certainPageKind(raw: ResultsPageEntry, options: { domain?: string | null } = {}): PageKind | null {
  const url = unwrapUrl(raw.url);
  const host = hostOf(url);
  if (!host) return null;
  const own = options.domain ? options.domain.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0] : "";
  if (own && (host === own || host.endsWith(`.${own}`))) return "own";
  const { path, segs } = pathOf(url);
  const title = (raw.title ?? "").trim();
  const desc = (raw.description ?? "").trim();
  const sections = segs.slice(0, -1);
  const articleTitle = ARTICLE_TITLE.test(title) || QUESTION_WORD.test(title);

  if (hostIs(host, DISCUSSION_HOSTS) || PAPER.test(desc)) return "discussion";
  if (hostIs(host, SOCIAL_HOSTS)) return SOCIAL_POST.test(path + "/") ? "discussion" : "directory";
  if (sections.some(isArticleSection) || /^(blog|blogs|news|magazine|insights|guides?)\./.test(host) || DATED_PATH.test(path)) return "article";
  // A shop's page titled as an article (a glossary entry, a "how to" page) is the judge's call.
  if (hostIs(host, SHOP_HOSTS)) return articleTitle ? null : "product";
  if (hostIs(host, UTILITY_HOSTS)) return "portal";
  if (hostIs(host, DIRECTORY_HOSTS) || DIRECTORY_HOST_WORD.test(host) || DIRECTORY_PATH.test(path)) return "directory";
  if (hostIs(host, REFERENCE_HOSTS)) return "article";
  // A document is never a provider's page or a shop's, wherever it is filed.
  if (/\.pdf$/.test(path)) return null;
  const page = segs.length && LANGUAGE_SEGMENT.test(segs[0]) ? segs.slice(1) : segs;
  if (isHomePage(url)) return "service_or_local";
  if (sections.some((s) => PRODUCT_SECTION.test(s))) return "product";
  const folded = fold(title);
  if (COUNTED_TITLE.test(folded) || (BEST_PLURAL.test(folded) && !SERVICE_PLURAL.test(folded))) return "article";
  if (articleTitle) return null;
  // A page named for a service section: one segment, at most `SHORT_SLUG_WORDS` words.
  const short = page.length === 1 && slugWords(path).length <= SHORT_SLUG_WORDS;
  if (sections.some((s) => SERVICE_SECTION.test(s)) || (short && SERVICE_SECTION.test(page[0]))) return "service_or_local";
  // A price list: a price section, or a one-segment page whose slug ends in a price word ("/brake-repair-prices").
  if (sections.some((s) => PRICE_WORD.test(s)) || (page.length === 1 && PRICE_WORD.test(slugWords(path).pop() ?? ""))) return "service_or_local";
  if (PHONE.test(title) || PHONE_SNIPPET.test(desc) || COMMERCIAL_TITLE.test(title)) return "service_or_local";
  return null;
}

/** The judge's word for a result, as a page kind. */
export const JUDGE_PAGE_KIND: Record<JudgeKind, PageKind> = {
  article: "article",
  service: "service_or_local",
  local: "service_or_local",
  product: "product",
  directory: "directory",
  tool: "portal",
  portal: "portal",
  jobs: "portal",
  course: "portal",
  dictionary: "portal",
  forum: "discussion",
  video: "discussion",
  paper: "discussion",
  offtopic: "offtopic",
};
/** The word lists' reading of a result (`classifyResult`), as a page kind. */
const RESULT_PAGE_KIND: Record<ResultKind, PageKind> = {
  editorial: "article",
  commercial: "service_or_local",
  directory: "directory",
  discussion: "discussion",
  utility: "portal",
  offtopic: "offtopic",
};
/** A page kind in the coarser tally `readResultsPage` decides the page type on. */
const PAGE_RESULT_KIND: Record<PageKind, ResultKind> = {
  article: "editorial",
  service_or_local: "commercial",
  own: "commercial",
  product: "commercial",
  directory: "directory",
  portal: "utility",
  discussion: "discussion",
  offtopic: "offtopic",
};

/** Words that say what kind of search it is, not what it is about. */
const MODIFIERS = new Set([
  "alternative", "alternatives", "alternatifi", "alternatifleri", "best", "top", "near", "review", "reviews", "versus",
  "free", "online", "cheap", "price", "pricing", "cost", "nedir", "nasil", "nasıl", "neden", "fiyat", "fiyatlari", "fiyatları",
  "what", "how", "why", "with", "from", "for", "and", "the", "ile", "için", "icin", "ve", "en", "iyi",
]);
const fold = (text: string) => text.toLocaleLowerCase("tr").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ı/g, "i");

/**
 * Whether a result is about the phrase at all: its URL, title or snippet
 * carries one of the phrase's subject words. Matched on word boundaries:
 *
 * - a short word (5 letters or fewer) as the start of a word in the text
 *   ("crm" finds "CRMs");
 * - a longer word, or an inflection of it: a word in the text that starts
 *   with its stem ("squealing" finds "squeals", "invoicing" finds
 *   "invoices") - unless the word is a compound of two words the text uses
 *   on their own ("fieldcrm" on a page with "field" and "crm"), which then
 *   has to be written as the compound;
 * - a compound written apart only by a space, a dot or a hyphen ("field crm",
 *   "fieldcrm.net").
 *
 * It matched anywhere in the text until 2026-09-30, letters glued across
 * punctuation: a rival's compound name ("<word>crm alternatives") read four
 * unrelated "<Word> (CRM)" pages as about it, and qualified a search
 * nobody writes about. A phrase nobody writes about comes back as other
 * people's unrelated pages, which are not evidence of an editorial search.
 */
export function aboutTerm(r: ResultsPageEntry, term: string): boolean {
  const words = fold(term).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !MODIFIERS.has(w));
  if (!words.length) return true;
  const url = unwrapUrl(r.url);
  const text = fold(`${url} ${r.title ?? ""} ${r.description ?? ""}`);
  const tokens = text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const tokenSet = new Set(tokens);
  return words.some((w) => {
    if (w.length <= 5) return tokens.some((t) => t.startsWith(w));
    const compound = [...Array(w.length - 5).keys()].some((i) => tokenSet.has(w.slice(0, i + 3)) && tokenSet.has(w.slice(i + 3)));
    const stem = w.slice(0, Math.max(4, w.length - 3));
    if (!compound && tokens.some((t) => t.startsWith(stem))) return true;
    const apart = new RegExp(`(^|[^\\p{L}\\p{N}])${[...w].map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[ .-]?")}`, "u");
    return apart.test(text);
  });
}

const stem = (value: string) => value.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/.]/)[0].replace(/[^\p{L}\p{N}]/gu, "");

/**
 * What the results judge calls each result (lib/keyword-research/opportunity.ts):
 * the words it is given, finer than `ResultKind` so a shop page and a clinic's
 * booking page are both named for what they are. `JUDGE_KIND` folds them.
 */
export const JUDGE_KINDS = [
  "article", "service", "product", "local", "directory", "tool", "portal", "jobs", "course", "forum", "video", "paper", "dictionary", "offtopic",
] as const;
export type JudgeKind = (typeof JUDGE_KINDS)[number];
export const JUDGE_KIND: Record<JudgeKind, ResultKind> = {
  article: "editorial",
  service: "commercial",
  product: "commercial",
  local: "directory",
  directory: "directory",
  tool: "utility",
  portal: "utility",
  jobs: "utility",
  course: "utility",
  dictionary: "utility",
  forum: "discussion",
  video: "discussion",
  paper: "discussion",
  offtopic: "offtopic",
};

/**
 * The languages the URL-and-title word lists above were written for. In any
 * other language they cannot tell a shop's category page from a guide (a
 * shop's category pages read as nine articles of ten, 2026-09-30), so a page
 * type read from them alone is not trusted there: see `readResultsPage`.
 */
export const LEXICON_LANGUAGES: ReadonlySet<string> = new Set(["en", "tr"]);

/** "6 providers' pages, 1 listing, 2 articles": the page kinds that are there, most first. */
export function describePageKinds(pages: Record<PageKind, number>): string {
  const words: Record<PageKind, [string, string]> = {
    article: ["article", "articles"],
    service_or_local: ["provider's own page", "providers' own pages"],
    directory: ["listing", "listings"],
    product: ["shop page", "shop pages"],
    portal: ["tool or portal", "tools or portals"],
    discussion: ["forum, video or paper", "forum, video or paper results"],
    offtopic: ["result not about this search", "results not about this search"],
    own: ["page of your site", "pages of your site"],
  };
  const parts = PAGE_KINDS.filter((k) => pages[k] > 0).sort((a, b) => pages[b] - pages[a]).map((k) => `${pages[k]} ${words[k][pages[k] === 1 ? 0 : 1]}`);
  return parts.length ? parts.join(", ") : "no results";
}

/**
 * The page type of a results page. `term` and `named` (the business's
 * competitors and search rivals) only serve the navigational rule: a phrase
 * naming another business, without asking for alternatives or a review, is
 * a search for that business.
 *
 * Each result's kind, first that applies:
 *   1. what the page itself says for certain (`certainPageKind`: the home
 *      page, a /services/ or /book/ path, a listing platform, a /blog/ post,
 *      the site's own host ...), whatever the judge said - except that a
 *      result the judge calls off-topic stays off-topic, and a home page the
 *      judge calls anything but an article keeps the judge's word;
 *   2. `judged`: the results judge's word for it (one per result, in order),
 *      or `kinds`, the same already folded;
 *   3. the URL-and-title word lists (`classifyResult`), which read two
 *      languages; `basis` says whether the judge or the lists filled in.
 *
 * The page-type rule, on the top `PAGE_RULE_TOP` results, after the
 * navigational and off-topic checks:
 *   NEEDS_PAGE_MIN_PAGES+ providers' own pages or listings   service / local (needs a page)
 *   NOT_EDITORIAL_MIN_PAGES+ shop or portal pages            other
 * and otherwise the tally, the same whoever read the results:
 *   more than half are business-built pages      service / local (needs a page)
 *     (service, product, shop, category, kit,
 *      location, directory)
 *   more than half are tools/portals/jobs/courses other
 *   more than half are not about the search       other
 *   two or more articles                          editorial, or mixed with 3+ pages
 *   one article, the rest mostly forum/video      editorial (nobody has written it yet)
 *   fewer than two articles, 2+ pages             service / local
 *   otherwise                                     other
 *
 * `pageRule: false` reads the page as it was read before the rule (the
 * judge's or the lists' word final, no thresholds): what the eval compares
 * against, and what a verdict's log says the rule changed.
 */
export function readResultsPage(
  organic: ReadonlyArray<ResultsPageEntry>,
  options: {
    term?: string;
    named?: readonly string[];
    kinds?: ReadonlyArray<ResultKind>;
    judged?: ReadonlyArray<JudgeKind>;
    /** The site being planned for: a result on it is its own page. */
    domain?: string | null;
    pageRule?: boolean;
  } = {},
): ResultsPageReading {
  const rule = options.pageRule !== false;
  const judgedWords = options.judged && options.judged.length === organic.length ? options.judged : null;
  const folded = !judgedWords && options.kinds && options.kinds.length === organic.length ? options.kinds : null;
  const judged = Boolean(judgedWords || folded);
  let decidedByCode = 0;
  const results: ClassifiedResult[] = organic.map((r, i) => {
    const reader: PageKind | null = judgedWords ? JUDGE_PAGE_KIND[judgedWords[i]] ?? null : folded ? RESULT_PAGE_KIND[folded[i]] ?? null : null;
    const certain = rule ? certainPageKind(r, { domain: options.domain }) : null;
    let page: PageKind;
    let by: ClassifiedResult["by"];
    const kept = reader === "offtopic" || (certain === "service_or_local" && reader && reader !== "article" && isHomePage(r.url));
    if (certain && (certain === "own" || !kept)) {
      page = certain; by = "code";
      if (certain !== reader) decidedByCode++;
    } else if (reader) {
      page = reader; by = "judge";
    } else {
      page = RESULT_PAGE_KIND[classifyResult(r)]; by = "urls";
    }
    // An article or a thread that carries none of the phrase's subject words
    // is about something else, whoever read it: the judge's kinds get the
    // same check the word lists do. Without it a phrase nobody writes about
    // (a rival's compound name) came back as other people's unrelated
    // articles, and the judge's generous "article" qualified it.
    if ((page === "article" || page === "discussion") && options.term && !aboutTerm(r, options.term)) page = "offtopic";
    return { url: r.url, host: hostOf(unwrapUrl(r.url)), rank: typeof r.rank === "number" ? r.rank : i + 1, kind: PAGE_RESULT_KIND[page], page, by };
  });
  const counts: Record<ResultKind, number> = { editorial: 0, commercial: 0, directory: 0, discussion: 0, utility: 0, offtopic: 0 };
  for (const r of results) counts[r.kind]++;
  const pages = Object.fromEntries(PAGE_KINDS.map((k) => [k, 0])) as Record<PageKind, number>;
  for (const r of [...results].sort((a, b) => a.rank - b.rank).slice(0, PAGE_RULE_TOP)) pages[r.page]++;
  const editorialUrls = results.filter((r) => r.kind === "editorial").sort((a, b) => a.rank - b.rank).map((r) => r.url);
  const n = results.length;
  const basis = judged ? "judge" : "urls";
  const said = (type: PageType, extra = "", owner?: string, why?: ResultsPageReading["why"], decided?: ResultsPageReading["rule"]): ResultsPageReading => ({
    type, results, counts, editorialUrls, basis, pages, decidedByCode, ...(owner ? { owner } : {}), ...(why ? { why } : {}), ...(decided ? { rule: decided } : {}),
    summary: `Of ${n} results: ${describePageKinds(pages)}${decidedByCode ? ` (${decidedByCode} read from the page itself)` : ""}${extra}.`,
  });

  // Navigational: one business owns the page. Its own site holds three
  // results, or its site ranks first and the phrase names it. Directories and
  // discussion hosts never "own" a page: they list everyone.
  const term = (options.term ?? "").toLowerCase();
  const compactTerm = term.replace(/[^\p{L}\p{N}]/gu, "");
  const asksAbout = COMPARISON.test(term);
  const byHost = new Map<string, number>();
  for (const r of results) if (r.kind === "editorial" || r.kind === "commercial") byHost.set(r.host, (byHost.get(r.host) ?? 0) + 1);
  const [topHost, topCount] = [...byHost.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
  // One business holding three results is a search for it when the phrase
  // names it ("acme login"); otherwise it is one provider among the
  // providers of a local search ("<service> <city>"), and the page-type rule
  // reads the page first.
  //
  // A phrase "names" a business when it carries the whole name ("acme login"
  // on acme.example), or when it is the name's start and the host spells it
  // out (an exact-match domain, "<service><city>.example"). The second is a
  // guess: on a page the rule reads as `NEEDS_PAGE_MIN_PAGES`+ providers'
  // pages it is a generic service search one provider bought the domain for,
  // and the rule decides it (it used to park such a search for good, as a
  // search for a business).
  const crowded = rule && pages.service_or_local + pages.directory + pages.product >= NEEDS_PAGE_MIN_PAGES;
  const names = (s: string) => compactTerm.includes(s) || (!crowded && compactTerm.length >= 6 && s.includes(compactTerm));
  const holder = stem(topHost);
  const namesHolder = holder.length >= 4 && names(holder);
  const heldByOne = !asksAbout && topCount >= 3 && counts.editorial < 3;
  if (heldByOne && (!rule || namesHolder)) return said("navigational", `; ${topCount} are ${topHost}'s own pages`, topHost);
  const namedHit = namedIn(term, options.named ?? []);
  if (!asksAbout && namedHit) return said("navigational", `; the phrase names ${namedHit}`, namedHit);
  const first = results.find((r) => r.rank === Math.min(...results.map((x) => x.rank)));
  if (!asksAbout && first && first.kind === "commercial" && compactTerm.length >= 6) {
    const s = stem(first.host);
    if (s.length >= 6 && names(s) && counts.editorial < 2) return said("navigational", `; the first result is ${first.host}, the business the phrase names`, first.host);
  }

  // A page mostly about other things: nobody writes about this phrase, and
  // no page of any kind is won by it (a rival's name nobody searches for).
  const about = judged ? n - counts.offtopic : options.term ? organic.filter((r) => aboutTerm(r, options.term!)).length : n;
  if (about * 2 < n) return said("other", `; ${n - about} of ${n} are not about this search at all`, undefined, "offtopic");

  const pageType = (): PageType => (counts.directory > counts.commercial ? "local" : "service");
  if (rule) {
    const built = pages.service_or_local + pages.directory + pages.product;
    if (built >= NEEDS_PAGE_MIN_PAGES) return said(pages.directory > pages.service_or_local + pages.product ? "local" : "service", `; ${built} pages built to sell or list a provider decide it`, undefined, undefined, "needs_page");
    if (pages.portal >= NOT_EDITORIAL_MIN_PAGES) return said("other", `; ${pages.portal} tools or portals decide it`, undefined, "utility", "not_editorial");
    if (heldByOne) return said("navigational", `; ${topCount} are ${topHost}'s own pages`, topHost);
  }
  const built = counts.commercial + counts.directory;
  if (built * 2 > n) return said(pageType());
  if (counts.utility * 2 > n) return said("other", "", undefined, "utility");
  if (counts.editorial >= 2) return built >= 3 ? said("mixed") : said("editorial");
  // Forums, videos and papers answering an informational question: nobody
  // has written the article yet, and an article is what would win it.
  if (counts.editorial >= 1 && counts.editorial + counts.discussion >= Math.ceil(n / 2) && built <= 2) return said("editorial", "; the rest is discussion an article would answer");
  if (built >= 2 && built >= counts.utility) return said(pageType());
  return said("other", "", undefined, "few_articles");
}

/** Words that, left over beside a business's name, still mean "take me to it". */
const NAVIGATION_WORDS = new Set([
  "login", "log", "in", "signin", "sign", "support", "help", "homepage", "website", "site", "official", "account", "dashboard",
  "contact", "near", "me", "address", "phone", "number", "hours", "opening", "open", "directions", "map", "email",
  "location", "locations", "app", "download", "book", "booking", "portal",
  "giris", "iletisim", "adres", "telefon", "accedi", "accesso", "assistenza", "connexion", "anmelden",
]);
const nameTokens = (value: string) => fold(value).replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/).filter(Boolean);

/**
 * The business a phrase names, as whole words: one of `named`'s aliases
 * (lib/keyword-research/seeds.ts `brandAliases`: host, label, label without
 * a product suffix) appearing in the phrase word for word, whatever else the
 * phrase says. "acme alternatives" and "acme pos login" name acme.com;
 * "field service crm" does not name fieldservicecrm.com, because a name
 * built from generic words is only named when it is typed as the name.
 */
export function rivalNamed(term: string, named: readonly string[]): string | null {
  return namedMatch(term, named, false);
}

/**
 * The business a phrase is a search FOR: it names one (`rivalNamed`) and
 * every other word is navigation ("login", "near me", "contact"). A phrase
 * asking about a business (alternatives, a review, its price) is not.
 *
 * Whole words, not a substring, since 2026-09-30: matched inside the phrase
 * with its spaces removed, a rival whose domain is a service plus a city
 * ("<service><city>.example") turned the site's own core search "<service> <city>"
 * into "the phrase names a business you compete with", and parked it for
 * good before any judge saw it. A name built from generic words is left to
 * the judge's "navigation" stage and the results page.
 */
export function namedIn(term: string, named: readonly string[]): string | null {
  if (COMPARISON_ASK.test(term)) return null;
  return namedMatch(term, named, true);
}

function namedMatch(term: string, named: readonly string[], navigationOnly: boolean): string | null {
  const query = nameTokens(term);
  for (const business of named) {
    for (const alias of brandAliases(business)) {
      const words = nameTokens(alias);
      if (!words.length || words.join("").length < 4) continue;
      for (let i = 0; i + words.length <= query.length; i++) {
        if (!words.every((w, j) => query[i + j] === w)) continue;
        const rest = [...query.slice(0, i), ...query.slice(i + words.length)];
        if (!navigationOnly || rest.every((w) => NAVIGATION_WORDS.has(w))) return words.join(" ");
      }
    }
  }
  return null;
}
