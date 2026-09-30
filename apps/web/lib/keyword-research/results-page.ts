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

/**
 * The page type of a results page. `term` and `named` (the business's
 * competitors and search rivals) only serve the navigational rule: a phrase
 * naming another business, without asking for alternatives or a review, is
 * a search for that business.
 *
 * `kinds` are the results judge's reading of each result, in order. When
 * given (one per result), they decide every result's kind and the word lists
 * are not consulted; `basis` says which was used. The judge reads a title in
 * any language; the lists read two.
 *
 * The tally, the same whichever read the results:
 *   more than half are business-built pages      service / local (needs a page)
 *     (service, product, shop, category, kit,
 *      location, directory)
 *   more than half are tools/portals/jobs/courses other
 *   more than half are not about the search       other
 *   two or more articles                          editorial, or mixed with 3+ pages
 *   one article, the rest mostly forum/video      editorial (nobody has written it yet)
 *   fewer than two articles, 2+ pages             service / local
 *   otherwise                                     other
 */
export function readResultsPage(
  organic: ReadonlyArray<ResultsPageEntry>,
  options: { term?: string; named?: readonly string[]; kinds?: ReadonlyArray<ResultKind> } = {},
): ResultsPageReading {
  const judged = Boolean(options.kinds && options.kinds.length === organic.length);
  const results: ClassifiedResult[] = organic.map((r, i) => ({
    url: r.url, host: hostOf(unwrapUrl(r.url)), rank: typeof r.rank === "number" ? r.rank : i + 1,
    // An article or a thread that carries none of the phrase's subject words
    // is about something else, whoever read it: the judge's kinds get the
    // same check the word lists do. Without it a phrase nobody writes about
    // (a rival's compound name) came back as other people's unrelated
    // articles, and the judge's generous "article" qualified it.
    kind: ((kind: ResultKind) => (kind === "editorial" || kind === "discussion") && options.term && !aboutTerm(r, options.term) ? "offtopic" : kind)(
      judged ? options.kinds![i] : classifyResult(r),
    ),
  }));
  const counts: Record<ResultKind, number> = { editorial: 0, commercial: 0, directory: 0, discussion: 0, utility: 0, offtopic: 0 };
  for (const r of results) counts[r.kind]++;
  const editorialUrls = results.filter((r) => r.kind === "editorial").sort((a, b) => a.rank - b.rank).map((r) => r.url);
  const n = results.length;
  const basis = judged ? "judge" : "urls";
  const said = (type: PageType, extra = "", owner?: string, why?: ResultsPageReading["why"]): ResultsPageReading => ({
    type, results, counts, editorialUrls, basis, ...(owner ? { owner } : {}), ...(why ? { why } : {}),
    summary: `Of ${n} results: ${counts.editorial} editorial, ${counts.commercial} service/product, ${counts.directory} listings, ${counts.discussion} forum/video/paper, ${counts.utility} tool/portal/course${counts.offtopic ? `, ${counts.offtopic} not about this search` : ""}${extra}.`,
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
  if (!asksAbout && topCount >= 3 && counts.editorial < 3) return said("navigational", `; ${topCount} are ${topHost}'s own pages`, topHost);
  const namedHit = namedIn(term, options.named ?? []);
  if (!asksAbout && namedHit) return said("navigational", `; the phrase names ${namedHit}`, namedHit);
  const first = results.find((r) => r.rank === Math.min(...results.map((x) => x.rank)));
  if (!asksAbout && first && first.kind === "commercial" && compactTerm.length >= 6) {
    const s = stem(first.host);
    if (s.length >= 6 && (s.includes(compactTerm) || compactTerm.includes(s)) && counts.editorial < 2) return said("navigational", `; the first result is ${first.host}, the business the phrase names`, first.host);
  }

  // A page mostly about other things: nobody writes about this phrase, and
  // no page of any kind is won by it (a rival's name nobody searches for).
  const about = judged ? n - counts.offtopic : options.term ? organic.filter((r) => aboutTerm(r, options.term!)).length : n;
  if (about * 2 < n) return said("other", `; ${n - about} of ${n} are not about this search at all`, undefined, "offtopic");

  const pages = counts.commercial + counts.directory;
  const pageType = (): PageType => (counts.directory > counts.commercial ? "local" : "service");
  if (pages * 2 > n) return said(pageType());
  if (counts.utility * 2 > n) return said("other", "", undefined, "utility");
  if (counts.editorial >= 2) return pages >= 3 ? said("mixed") : said("editorial");
  // Forums, videos and papers answering an informational question: nobody
  // has written the article yet, and an article is what would win it.
  if (counts.editorial >= 1 && counts.editorial + counts.discussion >= Math.ceil(n / 2) && pages <= 2) return said("editorial", "; the rest is discussion an article would answer");
  if (pages >= 2 && pages >= counts.utility) return said(pageType());
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
