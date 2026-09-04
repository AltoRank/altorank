/**
 * What organic clicks would have cost to buy.
 *
 * The product measures clicks, positions and scores, and none of those is the
 * unit an agency invoices in. This is the one place that turns clicks into
 * money, so the dashboard, the article editor and the client report all
 * agree on the number and on when there is no number.
 *
 * The formula is deliberately naive: for every search term that sent clicks
 * in the window, clicks × the Google Ads cost-per-click we have on file for
 * that term, summed. It answers "what would this traffic have cost as ads?",
 * which is the framing clients already understand, and nothing more. Terms
 * with no CPC on file contribute nothing and are counted as uncovered, so the
 * caller can say how much of the traffic the estimate actually saw.
 *
 * Pure on purpose: no Supabase, no dates. The queries feed it rows; this
 * file never decides what a window is.
 */

/** One measured slice of traffic: a term and the clicks it sent. */
export type ClickRow = {
  /** The search query, or the article's target keyword for page-level rows. */
  term: string | null;
  clicks: number | null;
};

export type OrganicValue = {
  /**
   * Estimated value in USD, or null when there is nothing to estimate from.
   *
   * Null and zero are different findings. Null: no traffic was measured, or
   * none of the measured terms has a CPC on file. Zero: terms with a CPC were
   * measured and nobody clicked. Only the second one is a number about the
   * site, and only it is rendered as one.
   */
  value: number | null;
  /** Every click in the rows, valued or not. */
  clicks: number;
  /** Clicks on terms that had a CPC and so contributed to `value`. */
  valuedClicks: number;
  /** Distinct terms that contributed. */
  valuedTerms: number;
  /**
   * valuedClicks / clicks, or null when there were no clicks to cover. The
   * honest caveat beside the figure: an estimate covering a fifth of the
   * traffic should not be read as the whole of it.
   */
  coverage: number | null;
};

const UNMEASURED: OrganicValue = {
  value: null,
  clicks: 0,
  valuedClicks: 0,
  valuedTerms: 0,
  coverage: null,
};

/** Terms are matched case-insensitively and ignoring outer whitespace, which
 *  is how Search Console reports them and how research stores them. */
export function normaliseTerm(term: string): string {
  return term.trim().toLowerCase();
}

/**
 * Build the CPC lookup from keyword rows.
 *
 * Null and non-positive CPCs are dropped rather than stored as 0. A 0 would
 * count the term's clicks as valued-at-nothing, which turns "we do not know"
 * into "worth nothing" and drags the coverage figure up while the value stays
 * put. The research parser already defaults missing CPCs to 0, so this is the
 * line where that default is refused.
 */
export function cpcIndex(
  keywords: Iterable<{ term: string; cpc: number | string | null }>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const k of keywords) {
    // PostgREST returns `numeric` as a string; a CPC written by TypeScript is
    // a number. Both arrive here.
    const cpc = typeof k.cpc === "string" ? Number(k.cpc) : k.cpc;
    if (cpc === null || cpc === undefined || !Number.isFinite(cpc) || cpc <= 0) continue;
    out.set(normaliseTerm(k.term), cpc);
  }
  return out;
}

/**
 * Sum clicks × CPC over the rows.
 *
 * `rows` empty means nothing was measured and the answer is null, whatever
 * the CPC index holds. Rows with no CPC match are counted in `clicks` and
 * nowhere else.
 */
export function estimateOrganicValue(
  rows: Iterable<ClickRow>,
  cpcByTerm: Map<string, number>,
): OrganicValue {
  let measured = false;
  let clicks = 0;
  let valuedClicks = 0;
  let value = 0;
  const terms = new Set<string>();

  for (const row of rows) {
    measured = true;
    const n = row.clicks ?? 0;
    clicks += n;
    if (row.term === null || row.term === undefined) continue;
    const term = normaliseTerm(row.term);
    const cpc = cpcByTerm.get(term);
    if (cpc === undefined) continue;
    valuedClicks += n;
    value += n * cpc;
    terms.add(term);
  }

  if (!measured) return UNMEASURED;

  // Measured, but no term we could price. That is "no CPC data", not "$0",
  // and it is the common case on a workspace whose research predates the
  // cpc column.
  if (terms.size === 0) {
    return { value: null, clicks, valuedClicks: 0, valuedTerms: 0, coverage: clicks > 0 ? 0 : null };
  }

  return {
    // Two decimals is all the input has; summing floats past that is noise.
    value: Math.round(value * 100) / 100,
    clicks,
    valuedClicks,
    valuedTerms: terms.size,
    coverage: clicks > 0 ? valuedClicks / clicks : null,
  };
}

/**
 * Combine per-workspace estimates into one, for the all-workspaces view.
 *
 * Null propagates only when every part is null: three sites where one has a
 * priced estimate and two have none is a site-wide figure with two-thirds of
 * its traffic uncovered, which `coverage` says. Summing nulls as zeroes would
 * silently read the same.
 */
export function sumOrganicValues(parts: OrganicValue[]): OrganicValue {
  if (parts.length === 0) return UNMEASURED;
  let value: number | null = null;
  let clicks = 0;
  let valuedClicks = 0;
  let valuedTerms = 0;
  let measured = false;
  for (const p of parts) {
    if (p.value !== null) value = (value ?? 0) + p.value;
    // A part that measured nothing has coverage null AND clicks 0; a part
    // that measured and found nothing priced has coverage 0. Either way its
    // clicks count toward the whole.
    if (p.coverage !== null || p.clicks > 0 || p.value !== null) measured = true;
    clicks += p.clicks;
    valuedClicks += p.valuedClicks;
    valuedTerms += p.valuedTerms;
  }
  if (!measured) return UNMEASURED;
  return {
    value: value === null ? null : Math.round(value * 100) / 100,
    clicks,
    valuedClicks,
    valuedTerms,
    coverage: clicks > 0 ? valuedClicks / clicks : null,
  };
}

/**
 * The currency the number is in. DataForSEO quotes every CPC in US dollars
 * whatever the location, so this is USD for every workspace; the locale only
 * decides how a dollar amount is written (1,234 vs 1.234 vs 1 234).
 */
export const VALUE_CURRENCY = "USD";

/**
 * Turn a workspace `language` ("en", "en-gb", "pt-pt", "zh-tw") into a BCP 47
 * tag Intl accepts. The stored keys are lowercase; Intl canonicalises case
 * itself, but a key it has never heard of throws, and a formatter must not
 * take a page down over a locale string.
 */
export function valueLocale(language: string | null | undefined): string {
  if (!language) return "en";
  try {
    return Intl.getCanonicalLocales(language)[0] ?? "en";
  } catch {
    return "en";
  }
}

/**
 * Render a value for people. Null is an em dash, never "$0": "—" is the
 * agreed spelling of "not measured" across this product, and a zero here
 * would be read as a verdict on the site.
 *
 * Whole units above a hundred, cents below it: "$1,234" is what the eye
 * wants on a dashboard, and "$4.20" is what a single long-tail article is
 * actually worth this month.
 */
export function formatOrganicValue(
  value: number | null,
  language: string | null | undefined,
): string {
  if (value === null) return "—";
  const locale = valueLocale(language);
  const fraction = Math.abs(value) < 100 ? 2 : 0;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: VALUE_CURRENCY,
    minimumFractionDigits: fraction,
    maximumFractionDigits: fraction,
  }).format(value);
}

/**
 * The one-line explanation every surface attaches to the number. Written
 * once so the dashboard tooltip, the editor caption and the report footnote
 * cannot drift into three different formulas.
 */
export function describeOrganicValue(v: OrganicValue, window: number | string): string {
  // A day count on the live surfaces; a dated period on a report.
  const when = typeof window === "number" ? `the last ${window} days` : window;
  const base = `Estimate: clicks over ${when} × the Google Ads cost-per-click of the search term, summed, in US dollars.`;
  if (v.value === null) {
    return v.clicks > 0
      ? `${base} None of the terms that sent these ${v.clicks.toLocaleString()} clicks has a cost-per-click on file yet; run keyword research to fill it in.`
      : `${base} Nothing is measured yet.`;
  }
  const pct = v.coverage === null ? null : Math.round(v.coverage * 100);
  return pct === null
    ? `${base} Priced terms were shown and nobody clicked.`
    : `${base} Covers ${v.valuedClicks.toLocaleString()} of ${v.clicks.toLocaleString()} clicks (${pct}%) across ${v.valuedTerms} priced ${v.valuedTerms === 1 ? "term" : "terms"}; the rest have no cost-per-click on file.`;
}
