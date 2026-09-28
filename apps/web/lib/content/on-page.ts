// ---------------------------------------------------------------------------
// On-page rules the writer is told and this enforces: title, H1, FAQ
// ---------------------------------------------------------------------------
//
// A real signup's first article (2026-09-27, a physiotherapy clinic) had a
// 77-character title (Google shows about 60), no FAQ section although the
// results page for its keyword is full of questions, and its body opened with
// the title again as an <h1> - so the published page carried two H1s, the
// site's and ours. The prompt already asked for 50-60 characters; the model
// wrote a full sentence anyway. An instruction followed most of the time is
// not a rule, so each of these is decided or enforced here, without a model:
//
//   fitTitle            the title, cut to 60 characters at a clause boundary
//   removeTitleHeading  the body, without the title's <h1>
//   faqPlan             whether the article gets a FAQ section, and why
//
// Pure functions; lib/content/generate.ts applies them to every draft, and
// the publisher and the editor's re-score strip the H1 from drafts written
// before this (lib/publishing/core.ts, app/actions/seo.ts).

import { containsKeyword, foldCase, matchesAnyHeading, resolveLocale } from "@/lib/i18n/locale";
import { stripTags } from "@/lib/content/enrich/html";

/** Google cuts a title at about 600 pixels, which is about 60 characters. */
export const TITLE_MAX = 60;
/** Shorter than this, a clause is a fragment rather than a title. */
const TITLE_MIN = 20;

export interface FittedTitle {
  title: string;
  /** The title as the writer produced it. */
  original: string;
  /** What was done: nothing, a title the caller gave kept, a clause kept, a bracket dropped, the keyword itself, or a cut at a word. */
  rule: "kept" | "given" | "clause" | "bracket" | "keyword" | "word";
}

/** Clause separators a title is written with. The `?` and `!` stay with the clause they end. */
const SEPARATOR = /(\s*[:|–—]\s+|\s+-\s+|(?<=[?!])\s+)/u;

/**
 * The title, at most 60 characters, without a model.
 *
 * In order, the first rule that gives a title that fits and still carries
 * the keyword:
 *
 *   1. It fits: kept.
 *   2. Clauses. A long generated title is two or three clauses joined by a
 *      colon, a dash or a question mark ("Physiotherapy vs Athletic Therapy:
 *      Which One Fits Your Injury and Budget?"). The longest run of whole
 *      clauses that fits and names the keyword is a complete title, taken
 *      from the start, where the subject is, unless only a later run names
 *      the keyword. Cutting
 *      at a word instead leaves "... Which One Fits Your", a sentence that
 *      stops mid-thought in the result line.
 *   3. A bracket at the end ("(2026 Guide)"), dropped.
 *   4. The keyword, first letter capitalised. Always a complete phrase, and
 *      exactly what the page has to rank for.
 *   5. Only when the keyword itself is longer than 60: cut at the last word
 *      that fits.
 *
 * Regeneration by the model was the alternative. It costs a second call,
 * can come back long again, and is a different title every run; this is
 * free, the same every time, and says which rule it used so the reviewer can
 * write a better one.
 */
export function fitTitle(title: string, keyword: string, language?: string | null): FittedTitle {
  const original = title.replace(/\s+/g, " ").trim();
  if (original.length <= TITLE_MAX) return { title: original, original, rule: "kept" };
  const locale = resolveLocale(language);
  const hasKeyword = containsKeyword(original, keyword, locale);
  const ok = (t: string) =>
    t.length <= TITLE_MAX && t.length >= TITLE_MIN && (!hasKeyword || containsKeyword(t, keyword, locale));

  // Split into clauses and the separators between them.
  const parts = original.split(SEPARATOR);
  const clauses: string[] = [];
  const seps: string[] = [];
  parts.forEach((p, i) => (i % 2 === 0 ? clauses.push(p.trim()) : seps.push(p)));
  // The first clause names the subject ("Physiotherapy vs Athletic Therapy");
  // a later one is often a follow-up that means nothing alone ("Which One
  // Fits Your Injury and Budget?", "was hilft wirklich am besten?"). So a run
  // starting at the first clause wins, and a later run only when it carries
  // the keyword the first ones do not.
  let lead: string | null = null;
  let later: string | null = null;
  for (let a = 0; a < clauses.length; a++) {
    for (let b = a; b < clauses.length; b++) {
      if (a === 0 && b === clauses.length - 1) continue;
      let t = clauses[a];
      for (let k = a; k < b; k++) t += seps[k] + clauses[k + 1];
      t = t.replace(/[\s:|–—-]+$/u, "").trim();
      if (!ok(t)) continue;
      if (a === 0) {
        if (!lead || t.length > lead.length) lead = t;
      } else if (hasKeyword && (!later || t.length > later.length)) {
        later = t;
      }
    }
  }
  const best = lead ?? later;
  if (best) return { title: best, original, rule: "clause" };

  const unbracketed = original.replace(/\s*[([][^)\]]*[)\]]\s*$/u, "").trim();
  if (unbracketed !== original && ok(unbracketed)) return { title: unbracketed, original, rule: "bracket" };

  const kw = keyword.replace(/\s+/g, " ").trim();
  const upper = (s: string) => (locale.supported ? s.toLocaleUpperCase(locale.bcp47) : s.toUpperCase());
  const fromKeyword = kw ? upper(kw.charAt(0)) + kw.slice(1) : "";
  if (fromKeyword && fromKeyword.length <= TITLE_MAX) return { title: fromKeyword, original, rule: "keyword" };

  const source = fromKeyword || original;
  const cut = source.slice(0, TITLE_MAX + 1).replace(/\s+\S*$/u, "").replace(/[\s,;:|–—-]+$/u, "");
  // A keyword with no space in its first 60 characters has no word to cut
  // at, and the slice above keeps 61 of them.
  return { title: cut && cut.length <= TITLE_MAX ? cut : [...source].slice(0, TITLE_MAX).join(""), original, rule: "word" };
}

/**
 * The given title, kept, when the writer used it as given; null otherwise.
 * A title a person typed or an agent sent is theirs to shorten.
 */
export function givenTitleKept(given: string | null | undefined, written: string): FittedTitle | null {
  const norm = (t: string) => foldCase(t).replace(/\s+/g, " ").trim();
  if (!given?.trim() || norm(given) !== norm(written)) return null;
  const title = written.replace(/\s+/g, " ").trim();
  return { title, original: title, rule: "given" };
}

/** What the reviewer is told when the title was shortened, or a given one is long; or null. */
export function titleReviewNote(fitted: FittedTitle): string | null {
  if (fitted.rule === "given") {
    return fitted.title.length > TITLE_MAX
      ? `The title you gave is ${fitted.title.length} characters, and search results cut a title at about ${TITLE_MAX}. It was kept as given.`
      : null;
  }
  if (fitted.rule === "kept") return null;
  const how: Record<Exclude<FittedTitle["rule"], "kept" | "given">, string> = {
    clause: "kept the clauses that fit and name the keyword",
    bracket: "dropped the bracket at the end",
    keyword: "no clause fitted, so the keyword is the title",
    word: "cut at the last word that fits",
  };
  return (
    `Title shortened from ${fitted.original.length} to ${fitted.title.length} characters (${how[fitted.rule]}), ` +
    `because search results cut a title at about ${TITLE_MAX}. The writer's title was: "${fitted.original}".`
  );
}

/**
 * The body without the title's <h1>, and any other <h1> made an <h2>.
 *
 * Every destination renders the article's title as the page's H1 (the
 * payload carries it as its own field, lib/cms/types.ts), so an <h1> in the
 * body is a second one. With `title`, only a leading <h1> that says the
 * title is removed: a draft a person edited keeps a heading they wrote.
 */
export function removeTitleHeading(html: string, title?: string | null): { html: string; removed: boolean; demoted: number } {
  let removed = false;
  let out = html;
  const first = out.match(/^\s*(?:<(?:p|div)\b[^>]*>\s*<\/(?:p|div)>\s*)*<h1\b[^>]*>([\s\S]*?)<\/h1>\s*/i);
  const same = (a: string, b: string) => foldCase(a).replace(/\s+/g, " ").trim() === foldCase(b).replace(/\s+/g, " ").trim();
  if (first && (title === undefined || title === null || same(stripTags(first[1]), title))) {
    out = out.slice(first[0].length);
    removed = true;
  }
  let demoted = 0;
  out = out.replace(/<h1\b([^>]*)>([\s\S]*?)<\/h1>/gi, (_m, attrs: string, inner: string) => {
    demoted++;
    return `<h2${attrs}>${inner}</h2>`;
  });
  return { html: out, removed, demoted };
}

/** Whether the body has a FAQ section: an <h2> that says so in any supported language. */
export function hasFaqSection(html: string): boolean {
  return [...html.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)].some((m) => matchesAnyHeading("faq", stripTags(m[1])));
}

/** The review note when the plan asked for a FAQ and the draft has none, or null. */
export function faqReviewNote(plan: FaqPlan, html: string): string | null {
  if (!plan.include || hasFaqSection(html)) return null;
  return `No FAQ section, although ${plan.reason}. Add three to five of them, answered in a few sentences each, before publishing.`;
}

export interface FaqPlan {
  include: boolean;
  /** Why, in words the reviewer and the writer both read. */
  reason: string;
  /** How many questions people ask for this search, as research kept them. */
  questions: number;
}

/**
 * Whether this article gets a FAQ section.
 *
 * Decided from the results page and the brief, not left to the model: the
 * prompt used to ask for one only inside SITE PREFERENCES, which is written
 * only when the workspace has an output-settings row, and even then "when
 * useful questions remain" - the clinic article had neither. The FAQ schema
 * switch is not the input: it governs the structured data a FAQ ships with
 * (lib/publishing/schema.ts), and its setting says the visible text is the
 * same either way.
 *
 *   - Two or more questions people ask for this search (People Also Ask,
 *     after lib/ai/article-questions.ts kept the relevant ones): the results
 *     page shows readers want direct answers, so a guide gets the section.
 *   - A list article (round-up, resources, examples) does not: each item is
 *     its own section, and a FAQ under a list reads as a second article.
 */
export function faqPlan(input: { articleType?: string | null; questions: readonly string[] }): FaqPlan {
  const n = input.questions.length;
  if (input.articleType === "listicle") {
    return { include: false, reason: "a list article answers in its items, so it gets no separate FAQ", questions: n };
  }
  if (n < 2) {
    return {
      include: false,
      reason: n === 0 ? "the search results show no questions people ask for this search" : "the search results show only one question people ask for this search",
      questions: n,
    };
  }
  return { include: true, reason: `the search results show ${n} questions people ask for this search`, questions: n };
}
