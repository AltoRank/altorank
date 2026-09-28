// ---------------------------------------------------------------------------
// Trust signals on a health, legal, financial or safety article
// ---------------------------------------------------------------------------
//
// A real signup's first article (2026-09-27, a physiotherapy clinic) was a
// health article with no author or reviewer, no disclaimer and no date - and
// an audit of it put trust at the bottom of the score. Google's raters hold
// "Your Money or Your Life" topics to the highest bar, and the reader of a
// clinic's article on which therapy to see for an injury is exactly who that
// bar is for. The clinic's about page named its physiotherapists; the writer
// was never told, and nothing added what the writer could not know.
//
// One decision, one place, stated with its evidence:
//
//   sensitiveTopicOf   is this article health, legal, financial or safety,
//                      read from the keyword, the title and the business
//                      profile, with the locale contract's word lists
//   chooseReviewer     the person on the site's own about or team page whose
//                      stated role fits the topic - never anyone else
//   buildTrust         the decision, the reviewer, the disclaimer, and what a
//                      person has to do before publishing
//   applyTrustBlock    the reviewer line at the top and the disclaimer at the
//                      end, in the article's language
//   datelineHtml       the published and updated dates, written into every
//                      article at publish time, when they are known
//                      (lib/publishing/core.ts)
//
// Nothing here invents a person. No reviewer found is said, in the review
// notes, as "add one before publishing". A language the locale contract does
// not describe gets no English line in its article: the note says what was
// not added and why.

import type { SiteFacts } from "@/lib/ai/types";
import {
  foldCase,
  foldMarks,
  resolveLocale,
  supportedLocales,
  SENSITIVE_KINDS,
  SUPPORTED_LANGUAGE_LIST,
  type SensitiveKind,
} from "@/lib/i18n/locale";
import { escapeHtml } from "@/lib/content/enrich/html";

export type { SensitiveKind };

export interface SensitiveTopic {
  kind: SensitiveKind;
  /** The words that decided it and where they were, for the reviewer. */
  evidence: string;
}

export interface ArticleTrust {
  /** Null when the article is not on a sensitive topic. */
  sensitive: SensitiveTopic | null;
  /** How the decision was made: what was read, with which word lists. Always set. */
  basis: string;
  /** The person the reviewer line names, from the site's own pages; null when none fits. */
  reviewer: { name: string; role: string; source: string } | null;
  /** The disclaimer written into the article; null when there is none to write. */
  disclaimer: string | null;
  /** What a person has to do or know before publishing. */
  notes: string[];
}

const KIND_NAME: Record<SensitiveKind, string> = {
  health: "health",
  legal: "legal",
  financial: "financial",
  safety: "safety",
};

const TERMS = new Map<string, string>();

/**
 * The kind's words in the given languages (every supported one by default),
 * as a fresh global regex over `fold`ed text. Fresh on every call: a shared
 * /g regex carries `lastIndex` from one caller into the next, and `matchAll`
 * starts where it was left.
 */
function termsFor(kind: SensitiveKind, codes?: readonly string[]): RegExp {
  const key = `${kind}:${codes ? [...codes].sort().join(",") : "*"}`;
  let source = TERMS.get(key);
  if (!source) {
    const locales = supportedLocales().filter((l) => !codes || codes.includes(l.code));
    const alternatives = [...new Set(locales.flatMap((l) => l.sensitiveTerms[kind]))];
    source = `(?<![\\p{L}\\p{N}])(?:${alternatives.join("|")})(?![\\p{L}\\p{N}])`;
    TERMS.set(key, source);
  }
  return new RegExp(source, "gu");
}

/**
 * Words on the lists that ordinary business and web writing uses in another
 * sense, folded, across the supported languages: "diagnose a traffic drop",
 * "symptoms of a penalty", "technical debt", "legal pages", "time savings",
 * "investing in content", "SEO poisoning", "site sağlığı", "yatırım
 * getirisi", "puntos de dolor". One of these alone does not make a topic
 * sensitive: it needs a word of the same kind that is not on this list, in
 * the topic or in the business profile. Stems that matched a different word
 * outright were narrowed in the lists instead: Italian "impost-" read
 * "impostazioni" (settings), Spanish "medic-" read "medición" (measurement),
 * German "steuer-" read "Steuerung" (control).
 *
 * Found 2026-09-28 in review: with every one of these deciding on its own,
 * an SEO agency whose profile says it "diagnoses" problems and fixes their
 * "symptoms" had a medical disclaimer written into every article.
 */
const WEAK: Record<SensitiveKind, RegExp> = {
  health:
    /^(?:diagnos\p{L}*|teshis\p{L}*|symptom\p{L}*|sintom\p{L}*|belirti\p{L}*|clinics?|clinical|clinica|cliniche|clinicas|clinique\p{L}*|klinik\p{L}*|saglik\p{L}*|gesundheit\p{L}*|dolor\p{L}*|douleur\p{L}*|schmerz\p{L}*|soins|sanitari\p{L}*)$/u,
  legal: /^(?:legal\p{L}*|juridique\p{L}*|gericht\p{L}*|juicio\p{L}*|diritto|heritage)$/u,
  financial:
    /^(?:debts?|dette\p{L}*|deuda\p{L}*|invest\p{L}*|yatirim\p{L}*|savings|risparmi\p{L}*|ahorro\p{L}*|epargne|sparen|birikim\p{L}*|crypto\p{L}*|krypto\p{L}*|kripto\p{L}*|credit\p{L}*|accounting|contador\p{L}*|fiscal\p{L}*|placement\p{L}*|assurance\p{L}*|retraite\p{L}*|pensione|pensioni)$/u,
  safety: /^(?:hazard\p{L}*|poison\p{L}*|first aid)$/u,
};

/** Lower-case, Turkish I's as one, accents off: how the word lists are written. */
function fold(text: string): string {
  return foldMarks(foldCase(text));
}

interface KindWords {
  /** Every distinct word of the kind the text uses. */
  all: string[];
  /** The ones that are not on WEAK: they decide on their own. */
  strong: string[];
}

/** The words of each kind a text uses, as written in the folded text, in the given languages. */
function matchKinds(text: string, codes?: readonly string[]): Map<SensitiveKind, KindWords> {
  const folded = fold(text);
  const out = new Map<SensitiveKind, KindWords>();
  for (const kind of SENSITIVE_KINDS) {
    const all = [...new Set([...folded.matchAll(termsFor(kind, codes))].map((m) => m[0]))];
    if (all.length) out.set(kind, { all, strong: all.filter((w) => !WEAK[kind].test(w)) });
  }
  return out;
}

/** Of the kinds `ok` accepts, the one with the most distinct words, earlier in SENSITIVE_KINDS on a tie. */
function strongest(
  found: Map<SensitiveKind, KindWords>,
  ok: (kind: SensitiveKind, words: KindWords) => boolean,
): [SensitiveKind, KindWords] | null {
  let best: [SensitiveKind, KindWords] | null = null;
  for (const kind of SENSITIVE_KINDS) {
    const words = found.get(kind);
    if (words && ok(kind, words) && (!best || words.all.length > best[1].all.length)) best = [kind, words];
  }
  return best;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

const quoteList = (words: string[]) => words.slice(0, 4).map((w) => `"${w}"`).join(", ");

/**
 * Whether the article is on a health, legal, financial or safety topic.
 *
 * The article's own topic first: the keyword and the title the writer is
 * given. Then the business: a clinic's or a law firm's article is read as
 * that professional's advice whatever its keyword, because it is published
 * under their name. The profile fields read are the ones a person confirms
 * in the wizard - name, description, what it sells, who it serves.
 *
 * Words are matched in the article's language and in English (a Turkish
 * site's profile is often in English), not in every language: "kinetic" is
 * not the French "kiné", "placement" is not the French for an investment,
 * and "investigate" is not the German "Invest". A language the contract does
 * not describe is read with every list, and `basis` says a topic written
 * only in it is not recognised.
 *
 *   - The topic decides with one word that means the field and nothing
 *     else ("physiotherapy", "divorce lawyer", "mortgage").
 *   - A word ordinary writing also uses in another sense (WEAK: "diagnose",
 *     "debt", "legal", "savings") decides only when the topic or the profile
 *     also has one that is not.
 *   - The profile alone decides with two distinct words of a kind, at least
 *     one of them not WEAK: one passing "legal pages" in an agency's
 *     description is not a law firm, and neither is "we diagnose problems
 *     and fix the symptoms".
 */
export function sensitiveTopicOf(input: {
  keyword: string;
  title?: string | null;
  profile?: unknown;
  language?: string | null;
}): { topic: SensitiveTopic | null; basis: string } {
  const locale = resolveLocale(input.language);
  const codes = locale.supported ? [...new Set([locale.code, "en"])] : undefined;
  const p = (input.profile && typeof input.profile === "object" ? input.profile : {}) as Record<string, unknown>;
  const business = [p.name, p.description, ...strings(p.offerings), ...strings(p.audiences)]
    .filter((x): x is string => typeof x === "string")
    .join(" \n ");
  const topicText = [input.keyword, input.title ?? ""].join(" \n ");

  const lists = locale.supported
    ? locale.code === "en"
      ? "the English health, legal, financial and safety word lists"
      : `the ${locale.name} and English health, legal, financial and safety word lists`
    : `the health, legal, financial and safety word lists for ${SUPPORTED_LANGUAGE_LIST}`;
  const basis =
    `Read the keyword${input.title ? ", the title" : ""} and the business profile (name, description, offerings, audiences) ` +
    `against ${lists}; a word that ordinary writing also uses in another sense ("diagnose", "debt", "legal") counts only ` +
    `next to one that does not.` +
    (locale.supported ? "" : ` ${locale.name} has no word list, so a topic written only in ${locale.name} is not recognised.`);

  const inTopic = matchKinds(topicText, codes);
  const inBusiness = matchKinds(business, codes);
  const fromTopic = strongest(
    inTopic,
    (kind, w) => w.strong.length > 0 || (inBusiness.get(kind)?.strong.length ?? 0) > 0,
  );
  if (fromTopic) {
    const [kind, w] = fromTopic;
    const backed = w.strong.length ? "" : ` (with ${quoteList(inBusiness.get(kind)!.strong)} in the business profile)`;
    return { topic: { kind, evidence: `the topic names ${quoteList(w.all)}${backed}` }, basis };
  }
  const fromBusiness = strongest(inBusiness, (_kind, w) => w.all.length >= 2 && w.strong.length > 0);
  if (fromBusiness) {
    return {
      topic: { kind: fromBusiness[0], evidence: `the business profile names ${quoteList(fromBusiness[1].all)}` },
      basis,
    };
  }
  return { topic: null, basis };
}

/**
 * The words for the business itself, taken out of a role before it is read:
 * a "Clinic Owner" or a "Practice Manager" runs the place, and that is not a
 * clinical role. "Clinic Director and Physiotherapist" still is.
 */
const WORKPLACE = /(?<![\p{L}])(?:clinics?|clinique|clinica|klinik\p{L}*|practice|praxis|firm|kanzlei|studio|office|ofis|bureau|cabinet)(?![\p{L}])/gu;

/**
 * The person on the site whose stated role fits the topic: a health role for
 * a health article, and so on, by the same word lists. Only people the
 * crawl found with a role; the first one the about page names wins.
 */
export function chooseReviewer(
  people: SiteFacts["people"],
  kind: SensitiveKind,
): { name: string; role: string; source: string } | null {
  for (const p of people) {
    if (!p.role) continue;
    if (termsFor(kind).test(fold(p.role).replace(WORKPLACE, " "))) return { name: p.name, role: p.role, source: p.source };
  }
  return null;
}

/** Everything the draft needs for trust, decided once before it is written. */
export function buildTrust(input: {
  keyword: string;
  title?: string | null;
  profile?: unknown;
  language?: string | null;
  people: SiteFacts["people"];
}): ArticleTrust {
  const locale = resolveLocale(input.language);
  const { topic, basis } = sensitiveTopicOf(input);
  if (!topic) {
    return {
      sensitive: null,
      basis,
      reviewer: null,
      disclaimer: null,
      notes: locale.supported
        ? []
        : [
            `Whether this is a health, legal, financial or safety topic was not checked for ${locale.name}: the word lists ` +
              `exist for ${SUPPORTED_LANGUAGE_LIST} only. If it is one, add a qualified reviewer and a disclaimer before publishing.`,
          ],
    };
  }

  const kind = KIND_NAME[topic.kind];
  const reviewer = chooseReviewer(input.people, topic.kind);
  const notes: string[] = [];
  if (reviewer) {
    notes.push(
      `This is a ${kind} topic (${topic.evidence}), so the draft names ${reviewer.name} (${reviewer.role}, from ${reviewer.source}) ` +
        `as its reviewer. Publish only once ${reviewer.name} has reviewed it; otherwise remove the line.`,
    );
  } else {
    const found = input.people.map((p) => (p.role ? `${p.name} (${p.role})` : p.name));
    notes.push(
      `No reviewer found on the site - add one before publishing. This is a ${kind} topic (${topic.evidence}), ` +
        (found.length
          ? `and the pages read name ${found.slice(0, 4).join(", ")}, none with a ${kind} role.`
          : "and no page read names a person with a role. Name the qualified person who checked it, on your about or team page."),
    );
  }
  if (!locale.supported) {
    notes.push(
      `No ${reviewer ? "reviewer line or " : ""}disclaimer was written into the article: their wording exists for ` +
        `${SUPPORTED_LANGUAGE_LIST} only. Add ${reviewer ? "them" : "one"} in ${locale.name} before publishing.`,
    );
  }
  return {
    sensitive: topic,
    basis,
    reviewer,
    disclaimer: locale.supported ? locale.labels.disclaimer[topic.kind] : null,
    notes,
  };
}

/** Fill a label's `{name}`-style holes, escaping each value. */
function fill(label: string, values: Record<string, string>): string {
  return escapeHtml(label).replace(/\{(\w+)\}/g, (m, key: string) => (key in values ? escapeHtml(values[key]) : m));
}

/**
 * The reviewer line at the top of the body and the disclaimer at the end,
 * before the call to action when there is one. Nothing for an article that is
 * not sensitive, or in a language without the wording. Idempotent.
 */
export function applyTrustBlock(
  html: string,
  trust: ArticleTrust | null | undefined,
  language?: string | null,
): { html: string; reviewer: boolean; disclaimer: boolean } {
  const locale = resolveLocale(language);
  if (!trust?.sensitive || !locale.supported) return { html, reviewer: false, disclaimer: false };
  let out = html;
  let reviewer = false;
  let disclaimer = false;
  if (trust.reviewer) {
    const line = fill(locale.labels.reviewedBy, { name: trust.reviewer.name, role: trust.reviewer.role });
    if (!out.includes(line)) {
      out = `<p class="article-reviewer"><em>${line}</em></p>\n${out.replace(/^\s+/, "")}`;
      reviewer = true;
    }
  }
  if (trust.disclaimer) {
    const text = escapeHtml(trust.disclaimer);
    if (!out.includes(text)) {
      const block = `<p class="article-disclaimer"><em>${text}</em></p>`;
      const cta = out.search(/<section\b[^>]*class=["'][^"']*\bcta\b/i);
      out = cta === -1 ? `${out.replace(/\s+$/, "")}\n${block}\n` : `${out.slice(0, cta)}${block}\n${out.slice(cta)}`;
      disclaimer = true;
    }
  }
  return { html: out, reviewer, disclaimer };
}

/** The trust decision stored on a draft's research, or null for anything else. */
export function storedTrust(research: unknown): ArticleTrust | null {
  const t = (research && typeof research === "object" ? (research as { trust?: unknown }).trust : null) as ArticleTrust | null;
  return t && typeof t === "object" && "sensitive" in t ? t : null;
}

/**
 * The published and updated dates, as a line for the top of the article,
 * written at publish time - the only moment both are known. On every
 * article, not only a sensitive one: a reader of any how-to should see how
 * old it is, and a visible date is what search engines and answer engines
 * read freshness from (decided 2026-09-28). The updated date is shown only
 * when it is a different day from the first publish. Null in a language
 * without the wording: an English dateline in a Turkish article is worse
 * than none.
 */
export function datelineHtml(
  language: string | null | undefined,
  dates: { publishedAt: string; modifiedAt: string },
): string | null {
  const locale = resolveLocale(language);
  if (!locale.supported) return null;
  const day = (iso: string) => {
    try {
      return new Intl.DateTimeFormat(locale.bcp47, { dateStyle: "long", timeZone: "UTC" }).format(new Date(iso));
    } catch {
      return iso.slice(0, 10);
    }
  };
  const published = day(dates.publishedAt);
  const updated = day(dates.modifiedAt);
  const parts = [fill(locale.labels.published, { date: published })];
  if (updated !== published) parts.push(fill(locale.labels.updated, { date: updated }));
  return `<p class="article-dates"><em>${parts.join(" · ")}</em></p>`;
}
