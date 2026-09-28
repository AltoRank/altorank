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
//   datelineHtml       the published and updated dates, written in at publish
//                      time, when they are known (lib/publishing/core.ts)
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

const TERMS = new Map<SensitiveKind, string>();

/**
 * The kind's words in every supported language, as a fresh global regex over
 * `fold`ed text. Fresh on every call: a shared /g regex carries `lastIndex`
 * from one caller into the next, and `matchAll` starts where it was left.
 */
function termsFor(kind: SensitiveKind): RegExp {
  let source = TERMS.get(kind);
  if (!source) {
    const alternatives = [...new Set(supportedLocales().flatMap((l) => l.sensitiveTerms[kind]))];
    source = `(?<![\\p{L}\\p{N}])(?:${alternatives.join("|")})(?![\\p{L}\\p{N}])`;
    TERMS.set(kind, source);
  }
  return new RegExp(source, "gu");
}

/** Lower-case, Turkish I's as one, accents off: how the word lists are written. */
function fold(text: string): string {
  return foldMarks(foldCase(text));
}

/** The words of each kind a text uses, as written in the folded text. */
function matchKinds(text: string): Map<SensitiveKind, string[]> {
  const folded = fold(text);
  const out = new Map<SensitiveKind, string[]>();
  for (const kind of SENSITIVE_KINDS) {
    const found = [...new Set([...folded.matchAll(termsFor(kind))].map((m) => m[0]))];
    if (found.length) out.set(kind, found);
  }
  return out;
}

/** The kind with the most distinct words, earlier in SENSITIVE_KINDS on a tie. */
function strongest(found: Map<SensitiveKind, string[]>): [SensitiveKind, string[]] | null {
  let best: [SensitiveKind, string[]] | null = null;
  for (const kind of SENSITIVE_KINDS) {
    const words = found.get(kind);
    if (words && (!best || words.length > best[1].length)) best = [kind, words];
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
 * under their name - when the profile names the field at least twice. The
 * profile fields read are the ones a person confirms
 * in the wizard - name, description, what it sells, who it serves. Words are
 * matched in every supported language (a Turkish site's profile is often in
 * English); a keyword in a language the contract does not describe is not
 * recognised, and `basis` says so rather than calling the topic safe.
 */
export function sensitiveTopicOf(input: {
  keyword: string;
  title?: string | null;
  profile?: unknown;
  language?: string | null;
}): { topic: SensitiveTopic | null; basis: string } {
  const locale = resolveLocale(input.language);
  const p = (input.profile && typeof input.profile === "object" ? input.profile : {}) as Record<string, unknown>;
  const business = [p.name, p.description, ...strings(p.offerings), ...strings(p.audiences)]
    .filter((x): x is string => typeof x === "string")
    .join(" \n ");
  const topicText = [input.keyword, input.title ?? ""].join(" \n ");

  const basis =
    `Read the keyword${input.title ? ", the title" : ""} and the business profile (name, description, offerings, audiences) ` +
    `against the health, legal, financial and safety word lists for ${SUPPORTED_LANGUAGE_LIST}.` +
    (locale.supported ? "" : ` ${locale.name} has no word list, so a topic written only in ${locale.name} is not recognised.`);

  const fromTopic = strongest(matchKinds(topicText));
  if (fromTopic) {
    return { topic: { kind: fromTopic[0], evidence: `the topic names ${quoteList(fromTopic[1])}` }, basis };
  }
  // Two distinct words for the business, one for the topic: a profile is
  // long, and one passing "legal" in an agency's description ("legal pages")
  // is not a law firm. A clinic's profile names its field several times.
  const fromBusiness = strongest(matchKinds(business));
  if (fromBusiness && fromBusiness[1].length >= 2) {
    return {
      topic: { kind: fromBusiness[0], evidence: `the business profile names ${quoteList(fromBusiness[1])}` },
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
 * The published and updated dates, as a line for the top of a sensitive
 * article, written at publish time - the only moment both are known. The
 * updated date is shown only when it is a different day from the first
 * publish. Null for an article that is not sensitive, or in a language
 * without the wording.
 */
export function datelineHtml(
  trust: ArticleTrust | null | undefined,
  language: string | null | undefined,
  dates: { publishedAt: string; modifiedAt: string },
): string | null {
  const locale = resolveLocale(language);
  if (!trust?.sensitive || !locale.supported) return null;
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
