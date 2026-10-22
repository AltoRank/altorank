// ---------------------------------------------------------------------------
// Other businesses' brands, kept out of a business's own article
// ---------------------------------------------------------------------------
//
// The research hands the writer the results page, related searches and the
// rivals on the profile, and all of them are full of other businesses' names.
// A first draft of 2026-10-22 for a skincare store told its readers that four
// rival brands "come up often in that search": true of the research, and the
// last thing a store wants on its own blog. A brand's article names other
// brands only when it is a comparison or an alternatives piece, which the
// brief or the keyword says it is.
//
// Two parts: whether this article may name them at all, and, when it may
// not, which related searches are someone else's brand so the prompt does not
// offer them as "terms to cover". The known names are the profile's rivals
// and the hosts the research itself saw (ranking pages, the AI Overview's
// sources, every host the source review classified). A brand none of those name
// is left to the prompt's rule. Pure.

import type { ArticleResearch } from "./research";
import { bareHost, brandLabel } from "./source-classes";

/** A keyword, title or instruction that asks for a comparison. */
const COMPARISON = /\b(?:vs\.?|versus|alternatives?|alternativ[aeo]n?|compar(?:e|ed|es|ing|isons?)|confronto|vergleich|competitors?)\b/i;

export interface BrandContext {
  keyword: string;
  title?: string | null;
  articleSubtype?: string | null;
  instructions?: string | null;
  /** `OutputPrefs.mentionSimilarProducts`: the owner asked for products to be compared. */
  mentionSimilarProducts?: boolean;
}

/** May this article name other businesses' brands and products? */
export function mayNameOtherBrands(ctx: BrandContext): boolean {
  if (ctx.mentionSimilarProducts === true) return true;
  if (ctx.articleSubtype === "comparison") return true;
  return [ctx.keyword, ctx.title, ctx.instructions].some((t) => Boolean(t) && COMPARISON.test(t!));
}

const fold = (s: string) =>
  s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/ı/g, "i");
const squash = (s: string) => fold(s).replace(/[^\p{L}\p{N}]/gu, "");
const tokens = (s: string) => fold(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/**
 * The names other businesses go by, as the research knows them, squashed
 * ("babobotanicals"). A name the article's own keyword contains is a topic
 * word, not a brand to avoid ("eczema" for eczema.org on an eczema article),
 * and the business's own name is its own.
 */
export function knownBrandNames(
  research: ArticleResearch,
  opts: { keyword: string; ownDomain?: string | null },
): Set<string> {
  const review = research.sourceReview;
  const own = squash(brandLabel(bareHost(opts.ownDomain ?? review?.ownDomain ?? "")));
  const keyword = squash(opts.keyword);
  const raw = [
    ...(review?.rivals ?? []).map((r) => (/\.[a-z]{2,}$/i.test(bareHost(r)) ? brandLabel(r) : r)),
    ...research.competitors.map((c) => brandLabel(c.domain || c.url)),
    ...(research.aiOverview?.citations ?? []).map((c) => brandLabel(c.domain || c.url)),
    ...(review?.classes ?? []).filter((c) => c.class !== "own").map((c) => brandLabel(c.host)),
  ];
  const names = new Set<string>();
  for (const r of raw) {
    const name = squash(r ?? "");
    if (name.length < 4 || name === own || keyword.includes(name)) continue;
    names.add(name);
  }
  return names;
}

/** Does this search name one of `brands`, as a run of whole words? */
export function namesKnownBrand(term: string, brands: ReadonlySet<string>): boolean {
  if (!brands.size) return false;
  const t = tokens(term);
  for (let i = 0; i < t.length; i++) {
    let run = "";
    // A brand is at most four words ("la roche posay").
    for (let j = i; j < Math.min(t.length, i + 4); j++) {
      run += t[j];
      if (brands.has(run)) return true;
    }
  }
  return false;
}
