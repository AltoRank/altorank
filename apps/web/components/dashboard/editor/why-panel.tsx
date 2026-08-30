import type { ScoringCheck } from "@/lib/seo/scoring";

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
  volume: number;
  difficulty: number | null;
  intent: string | null;
  checks: ScoringCheck[] | null;
  seoScore: number;
};

/**
 * NULL difficulty means nobody measured it, which is not the same as easy.
 * Rendering it as 0 has bitten this repo repeatedly: the difficulty scale
 * colours anything under 25 green, so an unmeasured keyword reads as trivially
 * winnable. Em dash, always.
 */
function Metric({ label, value }: { label: string; value: number | string | null }) {
  const unknown = value === null || value === undefined;
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <span className="text-[12px] text-ink-3">{label}</span>
      <span
        className={`font-mono text-[12.5px] tabular-nums ${unknown ? "text-ink-4" : "text-ink"}`}
        title={unknown ? "Not measured" : undefined}
      >
        {unknown ? "—" : value}
      </span>
    </div>
  );
}

export function WhyPanel({
  reasons,
  score,
  volume,
  difficulty,
  intent,
  checks,
  seoScore,
}: Props) {
  const failed = checks?.filter((c) => !c.passed) ?? [];
  const passed = checks?.filter((c) => c.passed) ?? [];

  return (
    <div className="flex flex-col gap-4">
      {reasons && reasons.length > 0 ? (
        <div>
          <div className="mb-2 text-[12px] text-ink-3">
            The queue picked this keyword because:
          </div>
          <ol className="flex flex-col gap-1.5">
            {reasons.map((reason, i) => (
              <li key={i} className="flex gap-2 text-[12.5px] leading-relaxed text-ink-2">
                <span className="mt-[3px] font-mono text-[10px] tabular-nums text-ink-4">
                  {i + 1}
                </span>
                <span>{reason}</span>
              </li>
            ))}
          </ol>
          {score !== null && (
            <p className="mt-2.5 text-[11.5px] leading-relaxed text-ink-4">
              Composite score {score.toFixed(1)}, which is only meaningful against
              the other candidates in the same run.
            </p>
          )}
        </div>
      ) : (
        <p className="text-[12.5px] leading-relaxed text-ink-3 italic">
          No selection rationale recorded. Either you chose this keyword yourself,
          or the draft predates rationale being kept with the article.
        </p>
      )}

      <div className="border-t border-line-soft pt-3">
        <Metric label="Search volume" value={volume ? volume.toLocaleString() : null} />
        <Metric label="Difficulty" value={difficulty} />
        <Metric label="Intent" value={intent} />
      </div>

      {checks && checks.length > 0 && (
        <div className="border-t border-line-soft pt-3">
          <div className="mb-2 flex items-baseline justify-between">
            <span className="text-[12px] text-ink-3">On-page checks</span>
            <span className="font-mono text-[11.5px] tabular-nums text-ink-3">
              {passed.length}/{checks.length} passed
            </span>
          </div>

          {/* Failures first: they are the only ones that change a decision. */}
          <ul className="flex flex-col gap-1.5">
            {[...failed, ...passed].map((check) => (
              <li key={check.name} className="flex gap-2 text-[12px] leading-snug">
                <span
                  aria-hidden="true"
                  className={`mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full ${
                    check.passed ? "bg-ok" : "bg-warn"
                  }`}
                />
                <span className="flex-1">
                  <span className={check.passed ? "text-ink-3" : "text-ink"}>
                    {check.name}
                  </span>
                  {check.note && (
                    <span className="block text-[11.5px] text-ink-4">{check.note}</span>
                  )}
                </span>
                <span className="sr-only">{check.passed ? "passed" : "needs attention"}</span>
              </li>
            ))}
          </ul>

          <p className="mt-3 text-[11.5px] leading-relaxed text-ink-4">
            {seoScore > 0
              ? "These checks are what the score is made of. The weights are in lib/seo/scoring.ts."
              : "Score this article to populate the checks."}
          </p>
        </div>
      )}
    </div>
  );
}
