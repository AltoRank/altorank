// ---------------------------------------------------------------------------
// Would ranking for this bring someone who might buy?
// ---------------------------------------------------------------------------
//
// Every filter before this one asks whether a keyword is *about* the business.
// None asks whether it is *for* the business. On 2026-09-08 qasimcode.com - a
// studio that builds appointment websites for clinics and salons - was given
// "Running a Business Without Websites in 2026", 1,600 searches a month, KD 0.
// It passed every gate we had: the words are on the site, the difficulty is
// winnable, the volume is real, `classifyIntent` calls it informational. It is
// also an article arguing against the thing they sell, and the person who
// searches it has already decided not to buy.
//
// Two shapes, kept apart because only one of them is unconditional.
//
//   absence      The query is about *not having* the subject: "without a
//                website", "no website", "instead of a website". Whoever types
//                it is not a buyer, whatever the business is, so this is a
//                skip rather than a penalty.
//
//   substitute   The query is about getting the subject *without paying for
//                it*: free, DIY, a template, build-it-yourself. Only a
//                misalignment when the business sells at a price - a company
//                whose own product is free or self-serve wants exactly these
//                terms - so it is conditional on the description saying so,
//                and it is a penalty rather than a refusal.
//
// Deliberately not a topic blocklist. It reads the subject nouns out of the
// customer's own profile and asks how the query relates to them, so it works
// for a business selling anything.

/**
 * Words that mean the searcher does not want the thing.
 *
 * Matched only when a subject noun follows within a word or two, because the
 * marker has to attach to the product to mean anything. "Business without
 * websites" is someone who will not buy; "booking without double bookings" is
 * a feature of what this business sells, and an earlier version of this file
 * refused both.
 */
const ABSENCE = ["without", "no", "instead of", "avoid", "not having", "never had"];

/** Slipped between the marker and the noun without changing the meaning. */
const FILLER = new Set(["a", "an", "the", "any", "your", "my", "own", "having", "need", "needing", "for"]);

/** Words that mean the searcher wants it, but not from anyone paid. */
const SUBSTITUTE = ["free", "diy", "yourself", "template", "templates", "builder", "builders"];

/** The description says money changes hands. */
const PAID_SIGNALS = [
  "price", "pricing", "priced", "fee", "fees", "cost", "monthly", "retainer",
  "package", "packages", "plan", "plans", "subscription", "quote", "paid",
];

export type FitVerdict =
  | { fit: "ok" }
  | { fit: "absence"; reason: string }
  | { fit: "substitute"; reason: string };

/**
 * How a keyword relates commercially to what the business sells.
 *
 * `subject` is the vocabulary of the thing sold (`subjectVocabulary`). A match
 * needs both halves: an absence word *and* a subject noun. "Without" alone is
 * not misaligned - "booking without double bookings" is a fine article for a
 * studio selling booking sites; "business without websites" is not.
 */
export function commercialFit(
  keyword: string,
  subject: Set<string> | null | undefined,
  description?: string | null,
): FitVerdict {
  if (!subject || subject.size === 0) return { fit: "ok" };
  const words = keyword.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!words.length) return { fit: "ok" };

  const isSubject = (w: string) =>
    [...subject].some((t) => t.length > 3 && (w === t || w.startsWith(t) || t.startsWith(w)));
  if (!words.some(isSubject)) return { fit: "ok" };

  // The marker has to reach the noun: at most two filler words between them.
  for (let i = 0; i < words.length; i++) {
    const one = words[i];
    const two = `${words[i]} ${words[i + 1] ?? ""}`.trim();
    const marker = ABSENCE.find((m) => m === one || m === two);
    if (!marker) continue;
    let j = i + marker.split(" ").length;
    let skipped = 0;
    while (j < words.length && FILLER.has(words[j]) && skipped < 2) {
      j++;
      skipped++;
    }
    if (j < words.length && isSubject(words[j])) {
      return {
        fit: "absence",
        reason: `about doing without what you sell ("${marker} ${words[j]}"), so it reaches people who have decided not to buy`,
      };
    }
  }

  const paid = PAID_SIGNALS.some((w) => (description ?? "").toLowerCase().includes(w));
  if (!paid) return { fit: "ok" };
  const sub = SUBSTITUTE.find((w) => words.includes(w));
  if (sub) {
    return {
      fit: "substitute",
      reason: `wants what you sell without paying for it ("${sub}"), and you sell it at a price`,
    };
  }
  return { fit: "ok" };
}
