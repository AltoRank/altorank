// ---------------------------------------------------------------------------
// Keyword Gap Analyzer pipeline
// ---------------------------------------------------------------------------

import { findKeywordGaps } from "@/lib/seo/gap-data";
import { getLocale } from "@/lib/seo/locales";
import type { KeywordGapResult } from "./types";

export async function generateKeywordGap(
  yourDomain: string,
  competitorDomains: string[],
  locale?: string,
): Promise<KeywordGapResult> {
  const loc = getLocale(locale ?? "en");

  const { gaps, totalGapsFound } = await findKeywordGaps(
    yourDomain,
    competitorDomains,
    { languageCode: loc.languageCode, locationCode: loc.locationCode },
  );

  return {
    yourDomain,
    competitorDomains,
    gaps,
    totalGapsFound,
  };
}
