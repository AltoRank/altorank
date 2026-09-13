/** Words that carry no targeting signal, so two terms differing only by these are one target. */
const STOPWORDS = new Set([
  "a", "an", "the", "for", "and", "or", "of", "to", "in", "on", "with", "is", "are", "my", "your",
  // "website about design" and "website design" are one results page.
  // qasimcode.com was given both, and both were scheduled.
  "about",
]);

/**
 * Collapse a keyword to the target it actually competes for.
 *
 * "agency seo", "agency for seo" and "seo for agencies" are one query with one
 * set of results. Deduping on the raw string treats them as three, and an
 * unattended run will happily write all three, splitting the ranking across
 * pages that cannibalise each other. That is worse than writing nothing: it
 * spends budget to compete with yourself.
 *
 * Caught in a live run, where the cron wrote "agency seo" and then "agency for
 * seo" on consecutive firings.
 *
 * Deliberately crude. Real stemming would need a dictionary per language and
 * this has to work across 36 locales; dropping stopwords, folding common plural
 * endings and sorting catches the overwhelmingly common case, which is word
 * order and connecting words.
 */
export function normalizeTarget(term: string): string {
  return term
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t && !STOPWORDS.has(t))
    .map((t) =>
      t.endsWith("ies") && t.length > 4
        ? `${t.slice(0, -3)}y`
        : t.endsWith("es") && t.length > 4
          ? t.slice(0, -2)
          : t.endsWith("s") && !t.endsWith("ss") && t.length > 3
            ? t.slice(0, -1)
            : t,
    )
    // Agent and verbal-noun endings, after the plural fold so "writers" has
    // already become "writer": "content writing" and "content writer" are one
    // results page, and the queue planned both (2026-09-04). The stem must
    // keep at least four letters, or "user" is "us" and "thing" is "th".
    .map((t) =>
      t.endsWith("ing") && t.length > 6
        ? t.slice(0, -3)
        : t.endsWith("er") && t.length > 5
          ? t.slice(0, -2)
          : t,
    )
    // A silent final "e", after the folds above so they have already run.
    // Without it the folds only half-work and the halves never meet:
    // "websites" folded to "websit" while "website" stayed "website", and
    // "creating" folded to "creat" while "create" stayed "create". So
    // qasimcode.com kept "website design" and "website design websites" as two
    // targets, and "create business websites" and "creating business websites"
    // as two more - four calendar slots for two queries.
    .map((t) => (t.endsWith("e") && t.length > 4 ? t.slice(0, -1) : t))
    // One target, not one target per repetition. "business ideas for small
    // businesses" folds to business/idea/small/business, which is the same
    // query as "idea for small businesses" said twice; both were stored, both
    // were scheduled.
    .filter((t, i, all) => all.indexOf(t) === i)
    .sort()
    .join(" ");
}
