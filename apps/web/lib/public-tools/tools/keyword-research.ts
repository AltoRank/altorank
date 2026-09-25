// ---------------------------------------------------------------------------
// Keyword research: the seed's numbers, plus related keywords with theirs
// ---------------------------------------------------------------------------
//
// Two DataForSEO Labs calls, in parallel, for the chosen country:
//   - keyword_suggestions: longer searches that contain the seed, and the
//     seed's own metrics (include_seed_keyword);
//   - related_keywords (depth 1): Google's "related searches" for the seed,
//     which reach phrasings that do not contain it.
// Merged, deduplicated and cut to the 50 with the most volume. One call
// failing still answers from the other; both failing is `upstream`.

import { z } from "zod";
import { defineTool } from "../types";
import { dataforseoLive } from "../data";
import { ToolError } from "../errors";
import { kv, table, text, type Block, type KvItem } from "../blocks";
import { countryInput, requiredText } from "../fields";
import { COUNTRIES } from "../locations";
import {
  byVolumeDesc,
  dedupeRows,
  fmtInt,
  fmtUsd,
  toRow,
  type LabsKeywordData,
  type LabsRelatedResult,
  type LabsSuggestionsResult,
} from "../labs";

const SLUG = "keyword-research";
export const MAX_ROWS = 50;

export const keywordResearch = defineTool({
  slug: SLUG,
  kind: "data",
  input: z.object({
    keyword: requiredText("a seed keyword", 100),
    country: countryInput,
  }),
  perIpLimit: { limit: 5, windowMs: 60 * 60 * 1000 },
  // keyword_suggestions (<=50 rows) + related_keywords (depth 1), with headroom.
  estimateCents: 4,
  async run({ keyword, country }) {
    const loc = COUNTRIES[country];
    const seed = keyword.toLowerCase();
    const base = { location_code: loc.locationCode, language_code: loc.languageCode };

    const [sugg, rel] = await Promise.allSettled([
      dataforseoLive<LabsSuggestionsResult>(SLUG, "/dataforseo_labs/google/keyword_suggestions/live", {
        ...base,
        keyword: seed,
        include_seed_keyword: true,
        limit: MAX_ROWS,
        order_by: ["keyword_info.search_volume,desc"],
      }),
      dataforseoLive<LabsRelatedResult>(SLUG, "/dataforseo_labs/google/related_keywords/live", {
        ...base,
        keyword: seed,
        depth: 1,
        include_seed_keyword: true,
        limit: 20,
      }),
    ]);
    if (sugg.status === "rejected" && rel.status === "rejected") {
      throw sugg.reason instanceof ToolError ? sugg.reason : new ToolError("upstream", "The keyword data is unavailable right now. Try again later.");
    }

    const suggestions = sugg.status === "fulfilled" ? sugg.value[0] : undefined;
    const related = rel.status === "fulfilled" ? rel.value[0] : undefined;
    const seedData: LabsKeywordData | null | undefined = suggestions?.seed_keyword_data ?? related?.seed_keyword_data;

    const rows = dedupeRows([
      ...(suggestions?.items ?? []).map(toRow),
      ...(related?.items ?? []).filter((i) => (i.depth ?? 1) > 0).map((i) => toRow(i.keyword_data)),
    ])
      .filter((r) => r.keyword.toLowerCase() !== seed)
      .sort(byVolumeDesc)
      .slice(0, MAX_ROWS);

    const blocks: Block[] = [];
    if (seedData) {
      const s = toRow(seedData);
      const trend = seedData.keyword_info?.search_volume_trend?.yearly;
      const items: KvItem[] = [
        { label: "Monthly searches", value: `${fmtInt(s.volume)} (average, modelled)`, status: "info" },
        { label: "Keyword difficulty", value: s.difficulty === null ? "—" : `${s.difficulty} / 100`, status: "info" },
        { label: "Cost per click", value: s.cpc === null ? "—" : `${fmtUsd(s.cpc)} (USD)`, status: "info" },
        { label: "Search intent", value: s.intent ?? "—", status: "info" },
      ];
      if (typeof trend === "number") items.push({ label: "Change over a year", value: `${trend > 0 ? "+" : ""}${trend}%`, status: "info" });
      blocks.push(kv(items, `"${keyword}" in ${loc.name}`));
    } else {
      blocks.push(kv([{ label: "Seed keyword", value: `no data for "${keyword}" in ${loc.name}`, status: "warn" }], `"${keyword}" in ${loc.name}`));
    }

    if (rows.length) {
      blocks.push(
        table(
          ["Keyword", "Monthly searches", "Difficulty", "CPC (USD)", "Intent"],
          rows.map((r) => [r.keyword, r.volume, r.difficulty, r.cpc === null ? null : Number(r.cpc.toFixed(2)), r.intent]),
          `Related keywords (${rows.length})`,
        ),
      );
    } else {
      blocks.push(text(`No related keywords with data in ${loc.name}. Try a broader or more common phrasing of the seed.`, "Related keywords"));
    }
    if (sugg.status === "rejected" || rel.status === "rejected") {
      blocks.push(text("One of the two keyword lookups failed, so this list is shorter than usual. Run it again for the full set.", "Partial result"));
    }
    blocks.push(
      text(
        "Modelled estimates from DataForSEO, a third-party provider, not Google's own figures. Volume is a rounded monthly average; difficulty is the provider's 0-100 score, useful for comparing keywords here, not across tools. A dash means the provider has no figure.",
        "About these numbers",
      ),
    );
    return blocks;
  },
});
