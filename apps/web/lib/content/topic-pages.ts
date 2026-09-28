// ---------------------------------------------------------------------------
// The business's own service pages that match what an article is about
// ---------------------------------------------------------------------------
//
// A real signup's first article (2026-09-27, a physiotherapy clinic) compared
// two therapies the clinic sells. Its internal links went to two blog posts
// and the homepage; the clinic's own pages for those two services - crawled,
// in the site facts the writer was given - were not linked anywhere, and the
// closing call to action pointed at the homepage while the profile held the
// clinic's phone number. A reader who was convinced had nowhere to go.
//
// This picks, without a model, the offering pages whose names share a word
// with the article's keyword or title. The prompt lists them first and asks
// for one of them before any blog article (lib/ai/prompts.ts), and the call
// to action links the best one (lib/content/enrich/cta.ts). Every URL here is
// one the crawl fetched with a 2xx (lib/content/site-facts.ts); nothing is
// built from a word.
//
// Pure, and free of server imports: the prompt builder reads it too.

import type { SiteFacts } from "@/lib/ai/types";
import { foldCase, foldMarks } from "@/lib/i18n/locale";

/** Words that say nothing about a topic in the supported languages, folded. */
const STOP = new Set([
  "and", "the", "for", "with", "what", "which", "your", "best", "guide", "how", "near", "from", "vs", "versus",
  "ve", "ile", "icin", "nedir", "nasil", "e", "per", "con", "che", "come", "del", "della", "y", "para", "que",
  "como", "et", "pour", "avec", "und", "fur", "mit", "wie", "oder", "der", "die", "das",
]);

function words(text: string): string[] {
  return foldMarks(foldCase(text))
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((w) => w.length > 3 && !STOP.has(w));
}

/** Same word, or one a stem of the other ("physio" / "physiotherapy"), when both are long enough to mean it. */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 5 && long.startsWith(short);
}

function slugWords(url: string): string[] {
  try {
    return words(decodeURIComponent(new URL(url).pathname).replace(/[-_/]+/g, " "));
  } catch {
    return [];
  }
}

export interface TopicPage {
  name: string;
  url: string;
  /** Topic words the page's name or URL shares. */
  shared: string[];
}

/**
 * The business's offering pages that match the topic, most shared words
 * first, at most `limit`. Only offerings with a fetched URL: a service the
 * site names without a page of its own has nothing to link.
 */
export function matchingOfferings(
  facts: Pick<SiteFacts, "offerings"> | null | undefined,
  topic: { keyword: string; title?: string | null },
  limit = 3,
): TopicPage[] {
  if (!facts?.offerings.length) return [];
  const want = [...new Set([...words(topic.keyword), ...words(topic.title ?? "")])];
  if (!want.length) return [];
  const scored: Array<TopicPage & { score: number; order: number }> = [];
  facts.offerings.forEach((o, order) => {
    if (!o.url) return;
    const have = [...words(o.name), ...slugWords(o.url)];
    const shared = want.filter((w) => have.some((h) => sameWord(w, h)));
    if (shared.length) scored.push({ name: o.name, url: o.url, shared, score: shared.length, order });
  });
  return scored
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, limit)
    .map(({ name, url, shared }) => ({ name, url, shared }));
}

/**
 * The review note when the article matches service pages and links none of
 * them, or null. Read on the final HTML, after the call to action (which
 * links the first match unless the site switched it off).
 */
export function topicLinkNote(matches: TopicPage[], html: string): string | null {
  if (!matches.length) return null;
  const hrefs = [...html.matchAll(/<a\b[^>]*href=["']([^"']+)["']/gi)].map((m) => m[1].replace(/[#?].*$/, "").replace(/\/+$/, ""));
  const linked = matches.some((m) => hrefs.includes(m.url.replace(/[#?].*$/, "").replace(/\/+$/, "")));
  if (linked) return null;
  return (
    `The site has ${matches.length === 1 ? "a service page" : "service pages"} for this topic ` +
    `(${matches.map((m) => `${m.name}: ${m.url}`).join("; ")}) and the draft links none. ` +
    "Link the one the article is about before publishing."
  );
}

/** How a conversion URL reads as link text: a phone number, an address, or the page without its scheme. */
export function conversionLinkText(url: string): string {
  // A stray "%" is a URIError, and one bad address must not cost the
  // article its whole call to action: the text is then the address as saved.
  const decoded = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  if (/^tel:/i.test(url)) return decoded(url.slice(4)).trim();
  if (/^mailto:/i.test(url)) return decoded(url.slice(7)).replace(/\?.*$/, "").trim();
  return url.replace(/^https?:\/\/(?:www\.)?/i, "").replace(/\/+$/, "");
}
