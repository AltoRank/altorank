// ---------------------------------------------------------------------------
// AI visibility: is this brand named when an AI answers the buying question?
// ---------------------------------------------------------------------------
//
// The product could measure whether a site is *readable* by agents and could
// generate content for it, but nothing measured whether any of it worked. Agent
// readiness is an input; being named in the answer is the outcome. Without this
// half, the GEO claim rests on a proxy.
//
// The answers come from the consumer products themselves (lib/geo/surfaces.ts)
// and are sampled: the same prompt rarely returns the same brands twice
// (SparkToro/Gumshoe, Jan 2026), so a mention rate is a proportion estimated
// from many answers, and it is reported with the interval that says how much
// those answers can tell. Thirty answers that never name the brand still allow
// a true rate near 10%.

export type AiEngine = "chat_gpt" | "claude" | "gemini" | "perplexity" | "google_ai_mode";

export interface AiCitation {
  title: string;
  url: string;
  domain: string;
}

export interface VisibilityResult {
  prompt: string;
  engine: AiEngine;
  model: string;
  /** The answer text. Empty on legacy rows, which did not keep it. */
  answer: string;
  /** The brand name appears in the answer text. */
  mentioned: boolean;
  /** The brand's own domain appears in the citations. */
  cited: boolean;
  citations: AiCitation[];
  /** Cited domains that are not the brand's own: sources, not rivals. */
  competitorDomains: string[];
  /** Brands the surface reported the answer as naming, the brand's own left out. */
  brands: string[];
  /** The searches the model ran to ground its answer. */
  fanOutQueries: string[];
  costUsd: number;
  error?: string;
}

/** Strip to a registrable-ish host so "www.x.com" and "x.com/a" compare equal. */
export function toDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Does the answer name this brand?
 *
 * Word-boundary matched so "Alto" does not fire on "Palo Alto" and a two-letter
 * brand does not match half the alphabet. Case-insensitive because models
 * reformat capitalisation freely.
 */
export function mentionsBrand(text: string, brand: string): boolean {
  const needle = brand.trim();
  if (needle.length < 2) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, "iu").test(text);
}

const bareDomain = (d: string) => d.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "").toLowerCase();

function isOwn(domain: string, own: string): boolean {
  return Boolean(own) && (domain === own || domain.endsWith(`.${own}`));
}

/**
 * The yes/no facts about one answer. The answer, its citations and the brands
 * the surface reported are what was collected; this decides what they mean for
 * one brand, so a stored answer can be re-read if the rule changes.
 */
export function classifyAnswer(options: {
  answer: string;
  citations: AiCitation[];
  brands: string[];
  brandName: string;
  brandDomain: string;
}): Pick<VisibilityResult, "mentioned" | "cited" | "competitorDomains" | "brands"> {
  const own = bareDomain(options.brandDomain);
  const ownName = options.brandName.trim().toLowerCase();
  // The domain is a name too: an answer that says "altorank.co" named it.
  const mentioned =
    mentionsBrand(options.answer, options.brandName) || (own.length > 3 && options.answer.toLowerCase().includes(own));
  return {
    mentioned,
    cited: options.citations.some((c) => isOwn(c.domain, own)),
    competitorDomains: [...new Set(options.citations.map((c) => c.domain).filter((d) => !isOwn(d, own)))],
    brands: options.brands.filter((b) => b.trim().toLowerCase() !== ownName),
  };
}

/**
 * Wilson score interval for k successes in n trials, as percentages.
 *
 * Not the normal approximation: at the rates this measures (near zero) that
 * interval runs below 0% and says nothing at k = 0, which is the case that
 * matters most. z = 1.96 is 95%.
 */
export function wilsonInterval(k: number, n: number, z = 1.96): { low: number; high: number } {
  if (n <= 0) return { low: 0, high: 100 };
  const p = k / n;
  const z2 = z * z;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  const pct = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 1000) / 10;
  return { low: pct(centre - half), high: pct(centre + half) };
}

export interface VisibilitySummary {
  probesRun: number;
  probesFailed: number;
  /** Share of successful answers that named the brand. */
  mentionRate: number;
  /** 95% interval around the mention rate: how much this many answers can tell. */
  mentionInterval: { low: number; high: number };
  /** Share of successful answers that cited the brand's own domain. */
  citationRate: number;
  /** Cited domains ranked by how often they appear, brand excluded. Sources, not rivals. */
  topCompetitors: Array<{ domain: string; citations: number; shareOfVoice: number }>;
  /** Brands named in the answers, ranked by how many answers named them. */
  topBrands: Array<{ brand: string; answers: number; rate: number }>;
  totalCostUsd: number;
}

/**
 * The brands each answer named.
 *
 * The ChatGPT app reports them as entities; Gemini and AI Mode do not, so a
 * brand any answer in the set was reported naming counts for the others when
 * their text names it too. The answer is what decides, never the domain list:
 * Wikipedia and Reddit are cited constantly and compete with nobody.
 */
function brandsPerAnswer(results: VisibilityResult[]): string[][] {
  const known = new Map<string, string>();
  for (const r of results) for (const b of r.brands) if (!known.has(b.toLowerCase())) known.set(b.toLowerCase(), b);
  return results.map((r) => {
    // One spelling per brand across the set, so "HubSpot" and "Hubspot" from
    // two answers are counted as one rival.
    const named = new Map(r.brands.map((b) => [b.toLowerCase(), known.get(b.toLowerCase())!]));
    if (r.answer) {
      for (const [key, brand] of known) if (!named.has(key) && mentionsBrand(r.answer, brand)) named.set(key, brand);
    }
    return [...named.values()];
  });
}

/**
 * Roll answers up into the numbers a client actually asks about.
 *
 * Rates are computed over answers that came back, not over samples planned. A
 * surface timing out is missing data, and counting it as "not mentioned" would
 * quietly report a worse position than the evidence supports, which is the
 * class of mistake this codebase keeps having to undo.
 */
export function summariseVisibility(results: VisibilityResult[]): VisibilitySummary {
  const ok = results.filter((r) => !r.error);
  const failed = results.length - ok.length;

  const domainCounts = new Map<string, number>();
  for (const r of ok) {
    for (const d of r.competitorDomains) {
      domainCounts.set(d, (domainCounts.get(d) ?? 0) + 1);
    }
  }

  const totalCompetitorCitations = [...domainCounts.values()].reduce((a, b) => a + b, 0);

  const topCompetitors = [...domainCounts.entries()]
    .map(([domain, citations]) => ({
      domain,
      citations,
      shareOfVoice: totalCompetitorCitations
        ? Math.round((citations / totalCompetitorCitations) * 1000) / 10
        : 0,
    }))
    .sort((a, b) => b.citations - a.citations)
    .slice(0, 15);

  const rate = (n: number) => (ok.length ? Math.round((n / ok.length) * 1000) / 10 : 0);

  const brandCounts = new Map<string, number>();
  for (const named of brandsPerAnswer(ok)) for (const b of named) brandCounts.set(b, (brandCounts.get(b) ?? 0) + 1);
  const topBrands = [...brandCounts.entries()]
    .map(([brand, answers]) => ({ brand, answers, rate: rate(answers) }))
    .sort((a, b) => b.answers - a.answers)
    .slice(0, 15);

  const mentioned = ok.filter((r) => r.mentioned).length;

  return {
    probesRun: ok.length,
    probesFailed: failed,
    mentionRate: rate(mentioned),
    mentionInterval: wilsonInterval(mentioned, ok.length),
    citationRate: rate(ok.filter((r) => r.cited).length),
    topCompetitors,
    topBrands,
    totalCostUsd: Math.round(results.reduce((s, r) => s + r.costUsd, 0) * 10000) / 10000,
  };
}
