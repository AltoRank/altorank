// ---------------------------------------------------------------------------
// DataForSEO fetchers for the Content Brief pipeline
// ---------------------------------------------------------------------------

import { post } from "./client";
import { dedupePermutations } from "./keywords";

// ── SERP Advanced ──────────────────────────────────────────────────────────

type DFSSerpAdvancedItem = {
  type: string;
  rank_group: number;
  title: string;
  url: string;
  description: string;
  domain: string;
  breadcrumb: string | null;
  extra?: {
    word_count?: number | null;
  };
  /** Present on `ai_overview`: the rendered answer Google is showing. */
  markdown?: string | null;
  /** Present on `ai_overview`: the pages that answer cites. */
  references?: Array<{
    domain?: string | null;
    url?: string | null;
    title?: string | null;
    source?: string | null;
  }> | null;
  items?: Array<{
    type: string;
    title: string;
    description?: string;
  }>;
};

type SerpAdvancedResult = {
  keyword: string;
  items: DFSSerpAdvancedItem[] | null;
};

/**
 * What Google's own AI answer says for this query, and which pages it cites.
 *
 * This arrives in the SERP call we already pay for and used to be dropped on the
 * floor. For a product whose claim is AI visibility, it is the most direct
 * evidence available of what an AI answer currently contains and who it trusts:
 * the writer can see the ground already covered, and the specific competitors
 * that have to be displaced to earn a citation.
 *
 * null when the SERP has no AI Overview, which is a real and common state, not
 * an error. Never synthesise one.
 */
export type AiOverview = {
  markdown: string;
  citations: Array<{ domain: string; url: string; title: string }>;
};

export type SerpData = {
  organic: Array<{
    /** Google's own rank for this result. NOT the `position` field, which is
     *  DataForSEO's page-layout column ("left"/"right") and not a rank at all. */
    rank: number | null;
    title: string;
    url: string;
    description: string;
    domain: string;
    wordCount: number | null;
  }>;
  peopleAlsoAsk: string[];
  aiOverview: AiOverview | null;
};

export async function fetchAdvancedSerp(
  keyword: string,
  locale: { languageCode: string; locationCode: number },
): Promise<SerpData> {
  const response = await post<SerpAdvancedResult>(
    "/serp/google/organic/live/advanced",
    [
      {
        keyword,
        location_code: locale.locationCode,
        language_code: locale.languageCode,
      },
    ],
  );

  const organic: SerpData["organic"] = [];
  const peopleAlsoAsk: string[] = [];
  let aiOverview: AiOverview | null = null;

  for (const task of response.tasks) {
    if (!task.result) continue;

    for (const result of task.result) {
      if (!result.items) continue;

      for (const item of result.items) {
        if (item.type === "organic" && organic.length < 10) {
          organic.push({
            rank: typeof item.rank_group === "number" ? item.rank_group : null,
            title: item.title,
            url: item.url,
            description: item.description ?? "",
            domain: item.domain,
            wordCount: item.extra?.word_count ?? null,
          });
        }

        if (item.type === "people_also_ask" && item.items) {
          for (const paa of item.items) {
            if (paa.title) peopleAlsoAsk.push(paa.title);
          }
        }

        if (item.type === "ai_overview" && item.markdown) {
          aiOverview = {
            markdown: item.markdown,
            citations: (item.references ?? [])
              .filter((r) => r.url)
              .map((r) => ({
                domain: r.domain ?? "",
                url: r.url ?? "",
                title: r.title ?? r.source ?? "",
              })),
          };
        }
      }
    }
  }

  return { organic, peopleAlsoAsk, aiOverview };
}

// ── Related Keywords ───────────────────────────────────────────────────────

type DFSKeywordForKeywordItem = {
  keyword: string;
  /** Present on the flat shape. */
  search_volume?: number | null;
  competition_index?: number | null;
  /** Present on the wrapped shape. */
  keyword_info?: {
    search_volume: number | null;
    competition: number | null;
  };
};

/**
 * `keywords_for_keywords` returns its keywords as the `result` array itself,
 * NOT wrapped in a `result[].items` array the way the SERP endpoints do.
 *
 * This was previously typed and parsed as the wrapped shape, so the parser hit
 * `if (!result.items) continue` on every entry and the function always returned
 * an empty list: a live call returning 1,460 keywords produced zero. Both
 * shapes are accepted here so the fix does not depend on the response never
 * changing back.
 */
type KeywordsForKeywordsResult = DFSKeywordForKeywordItem & {
  items?: DFSKeywordForKeywordItem[] | null;
};

export type RelatedKeyword = {
  keyword: string;
  searchVolume: number | null;
  competition: number | null;
};

/** Rows the writer is shown per keyword. The list is truncated to this. */
const RELATED_PER_KEYWORD = 30;

/**
 * DataForSEO's own ceiling on `keywords` in one `keywords_for_keywords` task.
 *
 * The endpoint documents 20 and rejects the task above it. The cap is the
 * reason to batch at all: the charge is levied per TASK, not per keyword and
 * not per returned row - measured 2026-09-07, $0.0900 flat on tasks that came
 * back with 1, 2, 4 and 100 rows (research/round4-2026-09-07 §4). Seven
 * separate one-keyword tasks are therefore seven charges for work one task
 * could have done.
 *
 * NOT MEASURED: the price of a task carrying twenty keywords rather than one.
 * Every price on record for this endpoint is flat per task, and the 20-keyword
 * cap only makes sense if the task is the billing unit, but the first real
 * batched run should be checked against `provider_spend` before the saving
 * below is treated as banked.
 */
export const MAX_SEEDS_PER_TASK = 20;

/** Words that shape a phrase without naming its subject; ignored when matching. */
const FILLER = new Set([
  "for", "the", "in", "of", "and", "a", "an", "to", "with", "is", "on", "or", "&",
  "vs", "my", "your", "best", "top",
]);

/** Content words of a query, lowercased and order-insensitive. */
function contentWords(term: string): string[] {
  return term
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !FILLER.has(w));
}

/**
 * How much a returned idea has to do with one of the seeds that bought it.
 *
 * 0 means "nothing this seed asked about appears in it". Used only to split a
 * merged multi-seed response back into per-seed lists; see the note on
 * `fetchRelatedKeywordsBatch` for why that split has to be inferred at all.
 */
function affinity(row: string, seedWords: string[]): number {
  if (!seedWords.length) return 0;
  const words = new Set(contentWords(row));
  let hit = 0;
  for (const w of seedWords) if (words.has(w)) hit++;
  return hit / seedWords.length;
}

/** One phrasing per idea, highest demand first, capped. */
function shortlist(rows: RelatedKeyword[]): RelatedKeyword[] {
  // One phrasing per idea, BEFORE the slice - which is the whole point.
  //
  // This call is $0.0900, 97.8% of what DataForSEO costs per draft, and it
  // buys 30 rows of which lib/ai/prompts.ts shows the writer the top 20. Over
  // 25 production articles, 0-50% of those 20 slots were re-phrasings of each
  // other: "ai for management" spent 11 of its 20 on "ai management", "ai in
  // management", "ai and management", "ai manage", "artificial intelligence
  // and management" and five more, all at identical volumes; "home ai system"
  // spent 5 on one vendor pairing. Deduping the 1,460 rows before taking 30
  // costs nothing and, on the measured lists, delivers up to twice the
  // distinct concepts for the same $0.09.
  //
  // Deduping after the slice would not work: the duplicates ARE the top rows,
  // so they would be removed and nothing would take their place.
  const distinct = dedupePermutations(
    rows.map((r) => ({ ...r, volume: r.searchVolume ?? 0 })),
  );

  // Highest demand first: the list is truncated, so an arbitrary 30 from an
  // alphabetical 1,460 would mostly be noise.
  return distinct
    .sort((a, b) => b.volume - a.volume)
    .slice(0, RELATED_PER_KEYWORD)
    .map(({ volume: _volume, ...rest }) => rest);
}

function toRelated(item: DFSKeywordForKeywordItem): RelatedKeyword {
  return {
    keyword: item.keyword,
    // Volume and competition sit at the top level on the flat shape and
    // under `keyword_info` on the wrapped one.
    searchVolume: item.keyword_info?.search_volume ?? item.search_volume ?? null,
    competition: item.keyword_info?.competition ?? item.competition_index ?? null,
  };
}

/**
 * Related keywords for several seeds, for the price of one lookup.
 *
 * WHY: `keywords_for_keywords` is billed per task and the app sent one keyword
 * per task. A signup writes seven drafts, so it bought seven tasks - $0.63,
 * 33% of the whole measured $1.929 signup bill and 75% of its DataForSEO half,
 * for thirteen usable rows in total (round4 §4, W2). The fan-out knows all
 * seven keywords before it dispatches anything, so one task can serve the week.
 *
 * WHAT IS NOT KNOWN, and how this handles it. A multi-seed response has never
 * been observed on this account. Two layouts are possible and this reads both:
 *
 *  - GROUPED: `result[]` carries one entry per requested seed, each with its
 *    own `items[]`. Then attribution is the API's, and it is used verbatim.
 *  - MERGED (what a one-seed call returns today - rows ARE `result[]`): one
 *    flat pool with nothing saying which seed produced which row.
 *
 * On the merged layout the split back to per-seed lists is inferred, by the
 * only evidence in the payload: a row belongs to a seed when it contains that
 * seed's content words. A row that matches no seed is dropped rather than
 * spread over all of them - the writer's twenty slots are the scarce thing
 * here, and a term with nothing to do with the keyword is worse than a short
 * list. Ordering, deduping and the 30-row cap are unchanged, so a seed whose
 * ideas all contain it - the normal case for this endpoint, which expands a
 * phrase - gets the same list it got from its own task.
 *
 * A seed can legitimately come back with nothing: `fairnote` got zero rows for
 * its own $0.09 in the measured run. That is reported, not re-bought.
 *
 * Keys are the caller's own strings, so a caller reads its list back with the
 * term it asked about and never has to guess at the normalisation.
 */
export async function fetchRelatedKeywordsBatch(
  keywords: string[],
  locale: { languageCode: string; locationCode: number },
): Promise<Map<string, RelatedKeyword[]>> {
  const out = new Map<string, RelatedKeyword[]>();

  // De-duplicated for the wire, but every caller string gets an answer: two
  // plan entries for the same term must not turn into two paid seeds.
  const wanted: string[] = [];
  const byNormalised = new Map<string, string[]>();
  for (const raw of keywords) {
    const term = raw.trim();
    if (!term) continue;
    out.set(raw, []);
    const key = term.toLowerCase();
    const existing = byNormalised.get(key);
    if (existing) existing.push(raw);
    else {
      byNormalised.set(key, [raw]);
      wanted.push(term);
    }
  }
  if (!wanted.length) return out;

  for (let i = 0; i < wanted.length; i += MAX_SEEDS_PER_TASK) {
    const seeds = wanted.slice(i, i + MAX_SEEDS_PER_TASK);
    const response = await post<KeywordsForKeywordsResult>(
      "/keywords_data/google_ads/keywords_for_keywords/live",
      [
        {
          keywords: seeds,
          location_code: locale.locationCode,
          language_code: locale.languageCode,
        },
      ],
    );

    const seedByKey = new Map(seeds.map((s) => [s.toLowerCase(), s]));
    /** seed -> its rows, when the payload says which seed a row belongs to. */
    const grouped = new Map<string, RelatedKeyword[]>();
    const pool: RelatedKeyword[] = [];
    const seenInPool = new Set<string>();

    for (const task of response.tasks) {
      if (!task.result) continue;

      for (const result of task.result) {
        // The grouped layout: an entry that both names a seed we asked for and
        // carries its own `items[]`. Anything else is a row in the merged pool.
        const owner =
          Array.isArray(result.items) && typeof result.keyword === "string"
            ? seedByKey.get(result.keyword.toLowerCase())
            : undefined;
        const items = Array.isArray(result.items) ? result.items : [result];

        for (const item of items) {
          if (!item?.keyword) continue;
          const term = item.keyword.toLowerCase();
          if (owner) {
            if (term === owner.toLowerCase()) continue;
            const bucket = grouped.get(owner) ?? [];
            if (!bucket.some((r) => r.keyword.toLowerCase() === term)) bucket.push(toRelated(item));
            grouped.set(owner, bucket);
            continue;
          }
          if (seenInPool.has(term)) continue;
          seenInPool.add(term);
          pool.push(toRelated(item));
        }
      }
    }

    for (const seed of seeds) {
      const own = grouped.get(seed);
      let rows: RelatedKeyword[];
      if (own) {
        rows = own;
      } else if (seeds.length === 1) {
        // Exactly what a single-keyword call has always returned: the whole
        // pool minus the seed itself. No inference, because none is needed.
        rows = pool.filter((r) => r.keyword.toLowerCase() !== seed.toLowerCase());
      } else {
        const seedWords = contentWords(seed);
        rows = pool.filter(
          (r) => r.keyword.toLowerCase() !== seed.toLowerCase() && affinity(r.keyword, seedWords) > 0,
        );
      }
      const list = shortlist(rows);
      for (const original of byNormalised.get(seed.toLowerCase()) ?? []) out.set(original, list);
    }
  }

  return out;
}

export async function fetchRelatedKeywords(
  keyword: string,
  locale: { languageCode: string; locationCode: number },
): Promise<RelatedKeyword[]> {
  const batch = await fetchRelatedKeywordsBatch([keyword], locale);
  return batch.get(keyword) ?? [];
}
