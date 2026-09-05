import type { ScoringCheck } from "@/lib/seo/scoring";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * "Why does this draft exist?"
 *
 * The approval gate asks a person to decide whether an article ships. Until now
 * it asked that with almost no decision support: an aggregate SEO number, the
 * keyword, and its volume. The reviewer could see WHAT was written and not why,
 * so the honest answer to "should this publish?" was usually "I suppose so",
 * which is the failure mode a gate is supposed to prevent.
 *
 * Everything here was already computed and then discarded:
 *   - lib/seo/recommendations.ts builds ordered plain-language `reasons`, and is
 *     deliberately model-free so the ordering stays reproducible and explicable.
 *     They reached the reviewer only as reasons[0] inside an activity-log line.
 *   - lib/seo/scoring.ts computes 11 named checks with per-check notes.
 *     app/actions/seo.ts persisted only the aggregate.
 *
 * We tell people on the marketing site that our scoring is auditable rather
 * than a black box. This is where that has to be true, or it is just a claim.
 */

type Props = {
  reasons: string[] | null;
  score: number | null;
  volume: number | null;
  difficulty: number | null;
  intent: string | null;
  checks: ScoringCheck[] | null;
  seoScore: number;
  /** Citation readiness: whether an answer engine can quote this, which is a
   *  different question from whether Google will rank it. */
  aeoChecks: ScoringCheck[] | null;
  aeoScore: number | null;
};

/**
 * NULL difficulty means nobody measured it, which is not the same as easy.
 * Rendering it as 0 has bitten this repo repeatedly: the difficulty scale
 * colours anything under 25 green, so an unmeasured keyword reads as trivially
 * winnable. Em dash, always.
 */
/**
 * Check ids are code identifiers. A reviewer should not have to read
 * `quotableStatistics` and translate.
 */
const CHECK_LABEL: Record<string, string> = {
  keywordInTitle: "Keyword in title",
  titleLength: "Title length",
  keywordDensity: "Keyword density",
  headingStructure: "Heading structure",
  metaDescriptionLength: "Meta description",
  wordCount: "Word count",
  readability: "Readability",
  internalLinks: "Internal links",
  answerFirst: "Answers in the first paragraph",
  definitionBlock: "Standalone definition",
  quotableStatistics: "Quotable figures",
  sourcedClaims: "Figures carry a source",
  questionHeadings: "Question-shaped headings",
  scannableStructure: "Scannable paragraphs",
  comparisonTable: "Comparison table",
  outboundAuthority: "Outbound citations",
  summaryBox: "Key takeaways box",
};

function CheckList({
  title,
  checks,
  scored,
  footnote,
}: {
  title: string;
  checks: ScoringCheck[];
  scored: boolean;
  footnote: string;
}) {
  // Failures first: they are the only ones that change a decision. A check
  // that could not measure anything is neither: it sits last, hollow, and is
  // left out of the tally so "7/7 passed" and the score agree on what was
  // counted.
  const failed = checks.filter((c) => !c.passed && !c.unverified);
  const passed = checks.filter((c) => c.passed && !c.unverified);
  const unverified = checks.filter((c) => c.unverified);
  const counted = failed.length + passed.length;

  return (
    <div className="border-t border-line-soft pt-3">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-[12px] text-ink-3">{title}</span>
        <span className="font-mono text-[11.5px] tabular-nums text-ink-3">
          {passed.length}/{counted} passed
          {unverified.length > 0 && ` · ${unverified.length} not counted`}
        </span>
      </div>

      <ul className="flex flex-col gap-1.5">
        {[...failed, ...passed, ...unverified].map((check) => (
          <li key={check.name} className="flex gap-2 text-[12px] leading-snug">
            <span
              aria-hidden="true"
              className={`mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full ${
                check.unverified
                  ? "border border-ink-4 bg-transparent"
                  : check.passed
                    ? "bg-ok"
                    : "bg-warn"
              }`}
            />
            <span className="flex-1">
              <span className={check.passed || check.unverified ? "text-ink-3" : "text-ink"}>
                {CHECK_LABEL[check.name] ?? check.name}
              </span>
              {check.note && (
                <span className="block text-[11.5px] text-ink-4">{check.note}</span>
              )}
            </span>
            <span className="sr-only">
              {check.unverified ? "not counted" : check.passed ? "passed" : "needs attention"}
            </span>
          </li>
        ))}
      </ul>

      <p className="mt-3 text-[11.5px] leading-relaxed text-ink-4">
        {scored ? footnote : "Score this article to populate the checks."}
      </p>
    </div>
  );
}

/**
 * One metric as a dial: a ring that fills by value and colours by whether the
 * value is good news.
 *
 * These were three label/value rows. A number on its own does not say whether
 * 34 is a good difficulty or a bad one, so the reader had to already know the
 * scale. The ring encodes the judgement and the tooltip carries the scale, so
 * nothing is conveyed by colour alone.
 *
 * `value === null` is unmeasured, which is not zero and must not read as a
 * full or empty ring: it renders hollow with a dash.
 */
function Dial({
  label,
  value,
  display,
  pct,
  tone,
  explain,
}: {
  label: string;
  value: number | string | null;
  display: string;
  /** 0-100 fill. null when unmeasured. */
  pct: number | null;
  tone: "good" | "warn" | "bad" | "neutral";
  explain: string;
}) {
  const unknown = value === null || value === undefined;
  const ring =
    tone === "good"
      ? "var(--ok)"
      : tone === "warn"
        ? "var(--warn)"
        : tone === "bad"
          ? "var(--err)"
          : "var(--accent)";

  return (
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild>
        <div
          className="flex flex-col items-center gap-1 cursor-default"
          tabIndex={0}
          role="img"
          aria-label={`${label}: ${unknown ? "not measured" : display}`}
        >
          <div
            className="h-10 w-10 rounded-full grid place-items-center"
            style={{
              background: unknown
                ? "var(--panel-2)"
                : `conic-gradient(${ring} 0 ${pct ?? 0}%, var(--panel-2) ${pct ?? 0}% 100%)`,
            }}
          >
            <span className="h-[30px] w-[30px] rounded-full bg-bg grid place-items-center font-mono text-[11px] font-semibold tabular-nums">
              {unknown ? "—" : display}
            </span>
          </div>
          <span className="text-[10.5px] text-ink-3">{label}</span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-[220px] whitespace-normal text-left">
        {unknown ? "Nobody measured this. It is not zero." : explain}
      </TooltipContent>
    </Tooltip>
  );
}

/** Difficulty is inverted: low is the good news. */
function difficultyTone(d: number | null): "good" | "warn" | "bad" | "neutral" {
  if (d === null) return "neutral";
  if (d <= 20) return "good";
  if (d <= 45) return "warn";
  return "bad";
}

/** Volume has no ceiling, so the ring is a log-ish share of a 10k reference. */
function volumePct(v: number | null): number | null {
  if (v === null || v <= 0) return null;
  return Math.min(100, Math.round((Math.log10(v) / 4) * 100));
}


export function WhyPanel({
  reasons,
  score,
  volume,
  difficulty,
  intent,
  checks,
  seoScore,
  aeoChecks,
  aeoScore,
}: Props) {

  return (
    <TooltipProvider>
    <div className="flex flex-col gap-4">
      {/* The numbered rationale lived here as prose. It repeated what the
          dials below already show - volume, difficulty, score - in sentences,
          so the reader read the same three facts twice. The dials carry the
          numbers; the reasons ride in their tooltip, where they are available
          without occupying the panel. */}

      <div className="border-t border-line-soft pt-3">
        {/* Manual articles and anything predating migration 022 have no
            rationale. Saying so is the point: inventing one, or silently
            showing nothing, are both worse than admitting it. */}
        {(!reasons || reasons.length === 0) && (
          <div className="mb-2 text-[11.5px] text-ink-4">
            No selection rationale recorded for this draft.
          </div>
        )}
        {score !== null && reasons && reasons.length > 0 && (
          <Tooltip delayDuration={150}>
            <TooltipTrigger asChild>
              <div className="mb-2 text-[11.5px] text-ink-4 cursor-default underline decoration-dotted underline-offset-2 w-fit">
                Why this keyword
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-[260px] whitespace-normal text-left">
              {reasons.join(" · ")}
              {` — composite ${score.toFixed(1)}, only meaningful against the other candidates in the same run.`}
            </TooltipContent>
          </Tooltip>
        )}
        <div className="flex items-start justify-around gap-2 py-1">
          <Dial
            label="Volume"
            value={volume}
            display={
              volume === null
                ? "—"
                : volume >= 1000
                  ? `${Math.round(volume / 100) / 10}k`
                  : String(volume)
            }
            pct={volumePct(volume)}
            tone={volume === null ? "neutral" : volume >= 1000 ? "good" : "warn"}
            explain={
              volume === null
                ? ""
                : `${volume.toLocaleString()} searches a month for this exact term, from DataForSEO. Higher is more traffic on the table, and usually more competition for it.`
            }
          />
          <Dial
            label="Difficulty"
            value={difficulty}
            display={difficulty === null ? "—" : String(difficulty)}
            pct={difficulty}
            tone={difficultyTone(difficulty)}
            explain={
              difficulty === null
                ? ""
                : `${difficulty}/100 organic difficulty. Under 20 is winnable at low authority, 20-45 needs some, above 45 usually needs links this site does not have yet. Green here means easy, not good.`
            }
          />
          <Dial
            label="Intent"
            value={intent}
            display={intent ? intent.slice(0, 4) : "—"}
            pct={intent ? 100 : null}
            tone={
              intent === "transactional" || intent === "commercial" ? "good" : "neutral"
            }
            explain={
              intent
                ? `Classified as ${intent}. Commercial and transactional queries are closer to a sale; informational ones build topical coverage. Derived from the SERP shape and a per-language lexicon, no model call.`
                : ""
            }
          />
        </div>
      </div>

      {checks && checks.length > 0 && (
        <CheckList
          title="On-page checks"
          checks={checks}
          scored={seoScore > 0}
          footnote="Whether Google will rank it."
        />
      )}

      {/* The second score answers the question the product is actually about.
          On-page checks are about ranking in a list of links; these are about
          whether an answer engine can lift a passage and quote it. */}
      {aeoChecks && aeoChecks.length > 0 && (
        <CheckList
          title="Citation readiness"
          checks={aeoChecks}
          scored={aeoScore !== null}
          footnote="Whether an AI answer can quote it."
        />
      )}

    </div>
    </TooltipProvider>
  );
}
