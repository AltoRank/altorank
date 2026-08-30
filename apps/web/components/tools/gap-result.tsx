"use client";

import { useState } from "react";
import type { KeywordGapResult } from "@/lib/tools/types";
import { EmailGate } from "./email-gate";

const INTENT_LABELS: Record<string, string> = {
  info: "Informational",
  commercial: "Commercial",
  transactional: "Transactional",
  navigational: "Navigational",
};

const INTENT_COLORS: Record<string, string> = {
  info: "bg-[oklch(0.95_0.02_265)] text-[oklch(0.45_0.1_265)]",
  commercial: "bg-[oklch(0.95_0.03_155)] text-[oklch(0.4_0.1_155)]",
  transactional: "bg-[oklch(0.95_0.03_85)] text-[oklch(0.45_0.1_85)]",
  navigational: "bg-panel-2 text-ink-3",
};

function formatVolume(vol: number): string {
  if (vol >= 1000000) return `${(vol / 1000000).toFixed(1)}M`;
  if (vol >= 1000) return `${(vol / 1000).toFixed(1)}K`;
  return String(vol);
}

export function GapResult({ result }: { result: KeywordGapResult }) {
  const FREE_LIMIT = 10;
  const freeGaps = result.gaps.slice(0, FREE_LIMIT);
  const gatedGaps = result.gaps.slice(FREE_LIMIT);
  const [unlocked, setUnlocked] = useState(false);

  const visibleGaps = unlocked
    ? result.gaps
    : freeGaps;

  return (
    <div className="mt-8 space-y-6">
      {/* Summary */}
      <div className="rounded-xl border border-line bg-bg p-5">
        <div className="flex flex-wrap gap-4">
          <div>
            <div className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-3">
              Your domain
            </div>
            <div className="text-sm font-medium text-ink">
              {result.yourDomain}
            </div>
          </div>
          <div className="h-8 w-px bg-line" />
          <div>
            <div className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-3">
              Competitors
            </div>
            <div className="text-sm text-ink-2">
              {result.competitorDomains.join(", ")}
            </div>
          </div>
          <div className="h-8 w-px bg-line" />
          <div>
            <div className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-3">
              Gaps found
            </div>
            <div className="text-lg font-semibold text-ink">
              {result.totalGapsFound.toLocaleString()}
            </div>
          </div>
        </div>
      </div>

      {/* Gaps table */}
      {visibleGaps.length > 0 && (
        <div className="rounded-xl border border-line bg-bg">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left">
                  <th className="px-4 py-3 font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-3">
                    Keyword
                  </th>
                  <th className="px-4 py-3 text-right font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-3">
                    Volume
                  </th>
                  <th className="px-4 py-3 text-right font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-3">
                    KD
                  </th>
                  <th className="px-4 py-3 text-right font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-3">
                    CPC
                  </th>
                  <th className="px-4 py-3 font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-3">
                    Intent
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibleGaps.map((gap, i) => (
                  <tr
                    key={i}
                    className="border-b border-line-soft last:border-b-0"
                  >
                    <td className="px-4 py-2.5 font-medium text-ink">
                      {gap.keyword}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-[12px] text-ink-2">
                      {formatVolume(gap.volume)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-[12px] text-ink-2">
                      {typeof gap.difficulty === "number" ? gap.difficulty : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-[12px] text-ink-2">
                      ${gap.cpc.toFixed(2)}
                    </td>
                    <td className="px-4 py-2.5">
                      <span
                        className={`rounded-full px-2 py-[1px] font-mono text-[10px] ${INTENT_COLORS[gap.intent] ?? INTENT_COLORS.info}`}
                      >
                        {INTENT_LABELS[gap.intent] ?? gap.intent}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* No gaps */}
      {result.gaps.length === 0 && (
        <div className="rounded-xl border border-line bg-bg p-6 text-center">
          <p className="text-sm text-ink-2">
            No keyword gaps found. This could mean the domains have very different keyword profiles,
            or the competitor data isn't available yet.
          </p>
        </div>
      )}

      {/* Email gate for remaining gaps */}
      {!unlocked && gatedGaps.length > 0 && (
        <EmailGate
          toolSlug="keyword-gap-analyzer"
          label={`Unlock all ${result.totalGapsFound} keyword gaps`}
          description={`You're seeing the top ${FREE_LIMIT}. Enter your email to unlock all ${result.totalGapsFound} gaps + CSV export.`}
          context={{
            yourDomain: result.yourDomain,
            competitors: result.competitorDomains,
          }}
          emailSubject={`Keyword Gap Analysis: ${result.yourDomain}`}
          emailBody={`<h2 style="color:#1a1a1a;">Keyword Gap Analysis</h2><p style="color:#666;">${result.yourDomain} vs ${result.competitorDomains.join(", ")}</p><p style="color:#666;">${result.totalGapsFound} keyword gaps found.</p><p style="color:#999;font-size:13px;">Generated with AltoRank's free Keyword Gap Analyzer.</p>`}
          onSuccess={() => setUnlocked(true)}
        />
      )}
    </div>
  );
}
