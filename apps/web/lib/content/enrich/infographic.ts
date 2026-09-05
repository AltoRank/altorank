// ---------------------------------------------------------------------------
// Step 5: a figure for numbers the text already states
// ---------------------------------------------------------------------------
//
// Conservative by design. The chart may only show numbers that are in the
// prose, with the labels the prose gives them, and it names the sentence or
// list it was drawn from in its caption. Two shapes qualify:
//
//   a list where three or more items each state exactly one number in the
//   same unit ("Basic: €9/month", "Pro: €29/month", ...)
//
//   a before/after pair in one sentence ("from 42% to 61%")
//
// Everything else - a paragraph with three unrelated percentages, a year and a
// price, a count and a ratio - is not clearly comparable and is left alone.
// Years are never charted. The SVG uses `currentColor` so it takes the
// publishing theme's text colour, and it carries role, label and title so a
// screen reader gets the same numbers a sighted reader does.

import { splitSections, stripTags, escapeHtml, escapeAttr, truncate } from "./html";
import { labelsFor } from "./labels";

export interface InfographicOptions {
  /** Upper bound per article. Two is plenty; more reads as decoration. */
  max?: number;
  language?: string | null;
}

export interface Datum {
  label: string;
  value: number;
}

export interface ChartSpec {
  unit: string;
  data: Datum[];
  /** The sentence or list the numbers came from, for the caption. */
  source: string;
}

const UNIT = String.raw`(%|percent|per cent|€|\$|£|hours?|hrs?|minutes?|mins?|seconds?|secs?|days?|weeks?|months?|years?|ms|GB|MB|TB|kg|g|km|m|x)`;
// A number with an optional unit before (currency) or after.
const NUMBER_WITH_UNIT = new RegExp(
  String.raw`(?:(€|\$|£)\s?(\d[\d.,]*)|(\d[\d.,]*)\s?${UNIT}(?![a-z]))`,
  "gi",
);

const NUMBER_WITH_UNIT_AND_QUALIFIER = new RegExp(
  `${NUMBER_WITH_UNIT.source}(?:\\s*(?:per|a|/|al|au|pro)\\s*(?:month|year|week|day|user|seat|mo|yr|mese|anno|mois|an|monat|jahr)\\b)?`,
  "gi",
);

function parseNumber(raw: string): number | null {
  // 1,200 and 1.200 are both a thousand-and-two-hundred in some locale and a
  // decimal in another. Only the unambiguous forms are accepted: a single
  // separator followed by exactly three digits is a thousands separator, a
  // single separator followed by one or two digits is a decimal point.
  const cleaned = raw.replace(/[.,](?=\d{3}(?:\D|$))/g, "");
  if (/[.,].*[.,]/.test(cleaned)) return null;
  const n = parseFloat(cleaned.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function isYear(value: number, unit: string): boolean {
  return !unit && value >= 1900 && value <= 2100 && Number.isInteger(value);
}

/** Every (value, unit) stated in a piece of plain text. */
export function extractMeasures(text: string): { value: number; unit: string; index: number }[] {
  const out: { value: number; unit: string; index: number }[] = [];
  for (const m of text.matchAll(NUMBER_WITH_UNIT)) {
    const unit = (m[1] ?? m[4] ?? "").toLowerCase();
    const value = parseNumber(m[2] ?? m[3]);
    if (value === null || value < 0) continue;
    if (isYear(value, unit)) continue;
    out.push({ value, unit: normaliseUnit(unit), index: m.index ?? 0 });
  }
  return out;
}

function normaliseUnit(unit: string): string {
  const u = unit.toLowerCase();
  if (u === "percent" || u === "per cent") return "%";
  if (/^hrs?$/.test(u)) return "hours";
  if (/^mins?$/.test(u)) return "minutes";
  if (/^secs?$/.test(u)) return "seconds";
  return u.replace(/s$/, "").replace(/^(hour|minute|second|day|week|month|year)$/, "$1s");
}

function comparable(values: number[]): boolean {
  if (values.length < 2) return false;
  const max = Math.max(...values);
  const min = Math.min(...values);
  if (max <= 0) return false;
  // Two orders of magnitude apart is not one chart, it is two facts.
  return min === 0 || max / Math.max(min, Number.EPSILON) <= 1000;
}

/**
 * A list where each of three or more items states exactly one number in one
 * shared unit. The label is the item's text with the number taken out.
 */
export function chartFromList(listHtml: string): ChartSpec | null {
  const items = [...listHtml.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => stripTags(m[1]));
  if (items.length < 3) return null;

  const data: Datum[] = [];
  let unit: string | null = null;
  for (const item of items) {
    const measures = extractMeasures(item);
    if (measures.length !== 1) return null;
    const [m] = measures;
    if (unit === null) unit = m.unit;
    if (m.unit !== unit) return null;
    // The label is what is left once the figure goes, minus the period
    // qualifier that rides with it ("€9 per month" -> "€9"): it is the same
    // for every item, so it belongs in the caption, not in each bar.
    const label = item
      .replace(NUMBER_WITH_UNIT_AND_QUALIFIER, " ")
      .replace(/\s+/g, " ")
      .replace(/^[\s:–-]+|[\s:,;–-]+$/g, "")
      .trim();
    if (!label) return null;
    data.push({ label: truncate(label, 40), value: m.value });
  }
  if (unit === null || !comparable(data.map((d) => d.value))) return null;
  return { unit, data, source: items.join("; ") };
}

const BEFORE_AFTER =
  /\b(?:from|da|de|von)\s+(€|\$|£)?\s?(\d[\d.,]*)\s?([%€$£]|percent|hours?|days?|weeks?|months?|minutes?|seconds?)?\s+(?:to|a|à|auf|bis)\s+(€|\$|£)?\s?(\d[\d.,]*)\s?([%€$£]|percent|hours?|days?|weeks?|months?|minutes?|seconds?)?/i;

/** "from 42% to 61%": two bars, labelled with the words the sentence used. */
export function chartFromBeforeAfter(sentence: string): ChartSpec | null {
  const m = sentence.match(BEFORE_AFTER);
  if (!m) return null;
  const unitA = normaliseUnit(m[1] ?? m[3] ?? "");
  const unitB = normaliseUnit(m[4] ?? m[6] ?? "");
  // One side may omit the unit ("from 42 to 61%"); both stated and different
  // is not a comparison.
  const unit = unitA || unitB;
  if (!unit || (unitA && unitB && unitA !== unitB)) return null;
  const before = parseNumber(m[2]);
  const after = parseNumber(m[5]);
  if (before === null || after === null || before === after) return null;
  if (isYear(before, unit) || isYear(after, unit)) return null;
  if (!comparable([before, after])) return null;
  return {
    unit,
    data: [
      { label: m[0].split(/\s+/)[0], value: before },
      { label: sentence.slice(m.index ?? 0).match(/\s(to|a|à|auf|bis)\s/i)?.[1] ?? "to", value: after },
    ],
    source: sentence.trim(),
  };
}

function formatValue(value: number, unit: string): string {
  const num = Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
  if (unit === "€" || unit === "$" || unit === "£") return `${unit}${num}`;
  if (unit === "%") return `${num}%`;
  return unit ? `${num} ${unit}` : num;
}

/**
 * A horizontal bar chart. Fixed geometry, no external library, sized to the
 * article column and scaled by the viewBox. Text is real text so it can be
 * selected and read aloud.
 */
export function renderBarChart(spec: ChartSpec, language?: string | null): string {
  const labels = labelsFor(language);
  const width = 600;
  const rowHeight = 32;
  const labelWidth = 180;
  const valueWidth = 90;
  const padding = 12;
  const height = padding * 2 + spec.data.length * rowHeight;
  const barMax = width - labelWidth - valueWidth - padding * 2;
  const max = Math.max(...spec.data.map((d) => d.value));

  const description = spec.data.map((d) => `${d.label} ${formatValue(d.value, spec.unit)}`).join(", ");
  const rows = spec.data
    .map((d, i) => {
      const y = padding + i * rowHeight;
      const w = max > 0 ? Math.max(2, Math.round((d.value / max) * barMax)) : 2;
      return (
        `<text x="${labelWidth - 8}" y="${y + rowHeight / 2 + 4}" text-anchor="end" font-size="13">${escapeHtml(d.label)}</text>` +
        `<rect x="${labelWidth}" y="${y + 6}" width="${w}" height="${rowHeight - 12}" rx="3" fill="currentColor" opacity="${i === 0 ? 0.85 : 0.6}"></rect>` +
        `<text x="${labelWidth + w + 8}" y="${y + rowHeight / 2 + 4}" font-size="13">${escapeHtml(formatValue(d.value, spec.unit))}</text>`
      );
    })
    .join("");

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" role="img" ` +
    `aria-label="${escapeAttr(`Bar chart: ${description}`)}" style="max-width:${width}px;font-family:system-ui,sans-serif">` +
    `<title>${escapeHtml(description)}</title>${rows}</svg>`;

  return (
    `<figure class="infographic">${svg}` +
    `<figcaption>${escapeHtml(labels.figuresFrom)} “${escapeHtml(truncate(spec.source, 160))}”</figcaption></figure>`
  );
}

export function addInfographics(
  html: string,
  opts: InfographicOptions = {},
): { html: string; added: number } {
  const max = opts.max ?? 2;
  if (max <= 0) return { html, added: 0 };
  const { intro, sections } = splitSections(html);
  let added = 0;

  const bodies = sections.map((s) => {
    if (added >= max) return s.body;
    // One figure per section, and none in a section that already has one.
    if (/<figure\b[^>]*class=["'][^"']*\binfographic\b/i.test(s.body)) return s.body;

    // Lists first: the labels are explicit, so the chart is exact.
    const list = [...s.body.matchAll(/<(ul|ol)\b[^>]*>[\s\S]*?<\/\1>/gi)].find(
      (m) => chartFromList(m[0]) !== null,
    );
    if (list && list.index !== undefined) {
      const spec = chartFromList(list[0])!;
      const at = list.index + list[0].length;
      added++;
      return s.body.slice(0, at) + "\n" + renderBarChart(spec, opts.language) + "\n" + s.body.slice(at);
    }

    for (const p of s.body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
      const text = stripTags(p[1]);
      const sentence = text.split(/(?<=[.!?])\s+/).find((sen) => BEFORE_AFTER.test(sen));
      if (!sentence) continue;
      const spec = chartFromBeforeAfter(sentence);
      if (!spec || p.index === undefined) continue;
      const at = p.index + p[0].length;
      added++;
      return s.body.slice(0, at) + "\n" + renderBarChart(spec, opts.language) + "\n" + s.body.slice(at);
    }
    return s.body;
  });

  if (!added) return { html, added: 0 };
  return { html: intro + sections.map((s, i) => s.heading + bodies[i]).join(""), added };
}
