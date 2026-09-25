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
// Years are never charted. The bars take the site's brand colour when one is
// set and `currentColor` (the publishing theme's text colour) otherwise, and
// the SVG carries role, label and title so a screen reader gets the same
// numbers a sighted reader does.
//
// How numbers, units and "from … to …" are written is language-dependent -
// "%42'den %61'e", "1.500,50 TL", "12 saat" - and comes from the locale
// contract, as do the chart's caption and aria-label. A language the contract
// does not describe gets no chart: a number whose separators cannot be read
// with certainty is not charted, and a chart labelled in English inside a
// Turkish article is the failure this step would otherwise add.

import { splitSections, stripTags, escapeHtml, escapeAttr, truncate } from "./html";
import {
  resolveLocale,
  parseNumber as parseLocaleNumber,
  formatNumber,
  phrasePattern,
  type SupportedLocale,
  type TimeUnit,
} from "@/lib/i18n/locale";

export interface InfographicOptions {
  /** `workspace_output_settings.infographics`; defaults on. */
  enabled?: boolean;
  /** Upper bound per article. Two is plenty; more reads as decoration. */
  max?: number;
  language?: string | null;
  /** `workspace_output_settings.brand_color`: the bar fill. Without one the bars take the page's text colour. */
  brandColor?: string | null;
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

const TIME_UNITS: TimeUnit[] = ["hours", "minutes", "seconds", "days", "weeks", "months", "years"];
/** Units that mean the same thing in every language. */
const NEUTRAL_UNITS = ["ms", "GB", "MB", "TB", "kg", "g", "km", "m", "x"];
const CURRENCY_SYMBOL: Record<string, string> = { "€": "€", $: "$", "£": "£", "₺": "₺" };

interface UnitRules {
  measure: RegExp;
  measureWithPeriod: RegExp;
  normalise: (unit: string) => string;
}

const UNIT_RULES = new Map<string, UnitRules>();

/**
 * The regexes and unit mapping for one language, built once from the
 * contract. A number with a currency symbol or (where the language writes it
 * so) a % before it, or a unit after it.
 */
function unitRules(locale: SupportedLocale): UnitRules {
  const cached = UNIT_RULES.get(locale.code);
  if (cached) return cached;
  const n = locale.numbers;
  const timeWords = TIME_UNITS.flatMap((u) => n.timeUnits[u]);
  const after = [
    "%",
    ...(n.percentWordsAfter.length ? [phrasePattern(n.percentWordsAfter)] : []),
    ...(n.symbolAfter ? ["€", "\\$", "£", "₺"] : []),
    ...n.currencyAfter,
    ...timeWords,
    ...NEUTRAL_UNITS,
  ];
  const before = `[€$£₺${n.percentSignBefore ? "%" : ""}]`;
  const measureSource = String.raw`(?:(${before})\s?(${n.digits})|(${n.digits})\s?(${after.join("|")})(?![\p{L}]))`;

  const normalise = (unit: string): string => {
    const u = locale.lower(unit.trim());
    if (!u) return "";
    if (u === "%" || n.percentWordsAfter.includes(u.replace(/\s+/g, " "))) return "%";
    if (CURRENCY_SYMBOL[u]) return CURRENCY_SYMBOL[u];
    if (/^(tl|try|lira)$/.test(u)) return "₺";
    if (/^(eur|euros?)$/.test(u)) return "€";
    if (/^(usd|dollari|dólares|dollars?|dolar)$/.test(u)) return "$";
    if (u === "avro") return "€";
    for (const t of TIME_UNITS) {
      if (n.timeUnits[t].some((w) => new RegExp(`^(?:${w})$`, "iu").test(u))) return t;
    }
    return u;
  };

  const rules: UnitRules = {
    measure: new RegExp(measureSource, "giu"),
    measureWithPeriod: new RegExp(`${measureSource}(?:\\s*${n.perPeriod})?`, "giu"),
    normalise,
  };
  UNIT_RULES.set(locale.code, rules);
  return rules;
}

function isYear(value: number, unit: string): boolean {
  return !unit && value >= 1900 && value <= 2100 && Number.isInteger(value);
}

/**
 * Every (value, unit) stated in a piece of plain text, read with the rules of
 * `language`. Nothing for a language the contract does not describe.
 */
export function extractMeasures(
  text: string,
  language?: string | null,
): { value: number; unit: string; index: number }[] {
  const locale = resolveLocale(language);
  if (!locale.supported) return [];
  const { measure, normalise } = unitRules(locale);
  const out: { value: number; unit: string; index: number }[] = [];
  for (const m of text.matchAll(new RegExp(measure.source, measure.flags))) {
    const unit = normalise(m[1] ?? m[4] ?? "");
    const value = parseLocaleNumber(m[2] ?? m[3], locale);
    if (value === null || value < 0) continue;
    if (isYear(value, unit)) continue;
    out.push({ value, unit, index: m.index ?? 0 });
  }
  return out;
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
export function chartFromList(listHtml: string, language?: string | null): ChartSpec | null {
  const locale = resolveLocale(language);
  if (!locale.supported) return null;
  const { measureWithPeriod } = unitRules(locale);
  const items = [...listHtml.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => stripTags(m[1]));
  if (items.length < 3) return null;

  const data: Datum[] = [];
  let unit: string | null = null;
  for (const item of items) {
    const measures = extractMeasures(item, locale.code);
    if (measures.length !== 1) return null;
    const [m] = measures;
    if (unit === null) unit = m.unit;
    if (m.unit !== unit) return null;
    // The label is what is left once the figure goes, minus the period
    // qualifier that rides with it ("€9 per month" -> "€9"): it is the same
    // for every item, so it belongs in the caption, not in each bar.
    const label = item
      .replace(new RegExp(measureWithPeriod.source, measureWithPeriod.flags), " ")
      .replace(/\s+/g, " ")
      .replace(/^[\s:–-]+|[\s:,;–-]+$/g, "")
      .trim();
    if (!label) return null;
    data.push({ label: truncate(label, 40), value: m.value });
  }
  if (unit === null || !comparable(data.map((d) => d.value))) return null;
  return { unit, data, source: items.join("; ") };
}

/**
 * "from 42% to 61%": two bars. Where the sentence has words for the two ends
 * ("from", "to"; "da", "a") the bars take them; where the direction is in a
 * suffix ("%42'den %61'e") they take the contract's "before" and "after".
 */
export function chartFromBeforeAfter(sentence: string, language?: string | null): ChartSpec | null {
  const locale = resolveLocale(language);
  if (!locale.supported) return null;
  const { normalise } = unitRules(locale);
  const m = sentence.match(locale.numbers.beforeAfter);
  if (!m?.groups) return null;
  const g = m.groups;
  const unitA = normalise(g.ca ?? g.ua ?? "");
  const unitB = normalise(g.cb ?? g.ub ?? "");
  // One side may omit the unit ("from 42 to 61%"); both stated and different
  // is not a comparison.
  const unit = unitA || unitB;
  if (!unit || (unitA && unitB && unitA !== unitB)) return null;
  const before = parseLocaleNumber(g.a, locale);
  const after = parseLocaleNumber(g.b, locale);
  if (before === null || after === null || before === after) return null;
  if (isYear(before, unit) || isYear(after, unit)) return null;
  if (!comparable([before, after])) return null;
  return {
    unit,
    data: [
      { label: g.from ?? locale.labels.before, value: before },
      { label: g.to ?? locale.labels.after, value: after },
    ],
    source: sentence.trim(),
  };
}

function formatValue(value: number, unit: string, locale: SupportedLocale): string {
  const num = formatNumber(value, locale);
  if (unit === "€" || unit === "$" || unit === "£" || unit === "₺") {
    return locale.numbers.symbolAfter ? `${num} ${unit}` : `${unit}${num}`;
  }
  if (unit === "%") return locale.numbers.formatPercent(num);
  if ((TIME_UNITS as string[]).includes(unit)) return `${num} ${locale.numbers.timeUnitLabels[unit as TimeUnit]}`;
  return unit ? `${num} ${unit}` : num;
}

/**
 * A horizontal bar chart. Fixed geometry, no external library, sized to the
 * article column and scaled by the viewBox. Text is real text so it can be
 * selected and read aloud.
 */
export function renderBarChart(spec: ChartSpec, language?: string | null, brandColor?: string | null): string {
  const locale = resolveLocale(language);
  // A chart is only drawn for a language the contract describes; a direct
  // caller with any other gets the English-free minimum, the numbers alone.
  const labels = locale.supported ? locale.labels : null;
  const fmt = (d: Datum) => (locale.supported ? formatValue(d.value, spec.unit, locale) : String(d.value));
  // Validated again here: this string lands inside an attribute of markup that
  // is stored and re-rendered, and the SVG allowlist trusts what this writes.
  const fill = brandColor && /^#[0-9a-fA-F]{6}$/.test(brandColor) ? brandColor : "currentColor";
  const width = 600;
  const rowHeight = 32;
  const labelWidth = 180;
  const valueWidth = 90;
  const padding = 12;
  const height = padding * 2 + spec.data.length * rowHeight;
  const barMax = width - labelWidth - valueWidth - padding * 2;
  const max = Math.max(...spec.data.map((d) => d.value));

  const description = spec.data.map((d) => `${d.label} ${fmt(d)}`).join(", ");
  const rows = spec.data
    .map((d, i) => {
      const y = padding + i * rowHeight;
      const w = max > 0 ? Math.max(2, Math.round((d.value / max) * barMax)) : 2;
      return (
        `<text x="${labelWidth - 8}" y="${y + rowHeight / 2 + 4}" text-anchor="end" font-size="13">${escapeHtml(d.label)}</text>` +
        `<rect x="${labelWidth}" y="${y + 6}" width="${w}" height="${rowHeight - 12}" rx="3" fill="${fill}" opacity="${i === 0 ? 0.85 : 0.6}"></rect>` +
        `<text x="${labelWidth + w + 8}" y="${y + rowHeight / 2 + 4}" font-size="13">${escapeHtml(fmt(d))}</text>`
      );
    })
    .join("");

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" role="img" ` +
    `aria-label="${escapeAttr(labels ? labels.barChart(description) : description)}" style="max-width:${width}px;font-family:system-ui,sans-serif">` +
    `<title>${escapeHtml(description)}</title>${rows}</svg>`;

  return (
    `<figure class="infographic">${svg}` +
    `<figcaption>${labels ? `${escapeHtml(labels.figuresFrom)} ` : ""}“${escapeHtml(truncate(spec.source, 160))}”</figcaption></figure>`
  );
}

export function addInfographics(
  html: string,
  opts: InfographicOptions = {},
): { html: string; added: number } {
  if (opts.enabled === false) return { html, added: 0 };
  const max = opts.max ?? 2;
  if (max <= 0) return { html, added: 0 };
  const locale = resolveLocale(opts.language);
  if (!locale.supported) return { html, added: 0 };
  const { intro, sections } = splitSections(html);
  let added = 0;

  const bodies = sections.map((s) => {
    if (added >= max) return s.body;
    // One figure per section, and none in a section that already has one.
    if (/<figure\b[^>]*class=["'][^"']*\binfographic\b/i.test(s.body)) return s.body;

    // Lists first: the labels are explicit, so the chart is exact.
    const list = [...s.body.matchAll(/<(ul|ol)\b[^>]*>[\s\S]*?<\/\1>/gi)].find(
      (m) => chartFromList(m[0], locale.code) !== null,
    );
    if (list && list.index !== undefined) {
      const spec = chartFromList(list[0], locale.code)!;
      const at = list.index + list[0].length;
      added++;
      return s.body.slice(0, at) + "\n" + renderBarChart(spec, opts.language, opts.brandColor) + "\n" + s.body.slice(at);
    }

    for (const p of s.body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
      const text = stripTags(p[1]);
      const sentence = text.split(/(?<=[.!?])\s+/).find((sen) => locale.numbers.beforeAfter.test(sen));
      if (!sentence) continue;
      const spec = chartFromBeforeAfter(sentence, locale.code);
      if (!spec || p.index === undefined) continue;
      const at = p.index + p[0].length;
      added++;
      return s.body.slice(0, at) + "\n" + renderBarChart(spec, opts.language, opts.brandColor) + "\n" + s.body.slice(at);
    }
    return s.body;
  });

  if (!added) return { html, added: 0 };
  return { html: intro + sections.map((s, i) => s.heading + bodies[i]).join(""), added };
}
