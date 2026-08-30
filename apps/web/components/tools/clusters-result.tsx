"use client";

import { useState } from "react";
import type { KeywordClusterResult } from "@/lib/tools/types";
import { EmailGate } from "./email-gate";

function formatVolume(vol: number): string {
  if (vol >= 1000000) return `${(vol / 1000000).toFixed(1)}M`;
  if (vol >= 1000) return `${(vol / 1000).toFixed(1)}K`;
  return String(vol);
}

export function ClustersResult({ result }: { result: KeywordClusterResult }) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set([0]));
  const [unlocked, setUnlocked] = useState(false);

  const toggle = (i: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  // Show cluster names + themes free, gate full keyword lists
  const showKeywords = unlocked;

  return (
    <div className="mt-8 space-y-6">
      {/* Summary */}
      <div className="rounded-xl border border-line bg-bg p-5">
        <div className="flex flex-wrap gap-4">
          <div>
            <div className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-3">
              Clusters
            </div>
            <div className="text-lg font-semibold text-ink">
              {result.clusters.length}
            </div>
          </div>
          <div className="h-8 w-px bg-line" />
          <div>
            <div className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-3">
              Total keywords
            </div>
            <div className="text-lg font-semibold text-ink">
              {result.totalKeywords}
            </div>
          </div>
          <div className="h-8 w-px bg-line" />
          <div>
            <div className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-3">
              Total volume
            </div>
            <div className="text-lg font-semibold text-ink">
              {formatVolume(result.totalVolume)}
            </div>
          </div>
        </div>
      </div>

      {/* Clusters */}
      <div className="space-y-3">
        {result.clusters.map((cluster, i) => (
          <div
            key={i}
            className="rounded-xl border border-line bg-bg"
          >
            <button
              type="button"
              onClick={() => toggle(i)}
              className="flex w-full items-center gap-3 p-4 text-left transition-colors hover:bg-panel"
            >
              <svg
                className={`h-3.5 w-3.5 shrink-0 text-ink-3 transition-transform ${expanded.has(i) ? "rotate-90" : ""}`}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="m9 6 6 6-6 6" />
              </svg>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h4 className="text-sm font-semibold text-ink">
                    {cluster.name}
                  </h4>
                  <span className="rounded-full bg-accent-soft px-1.5 py-[1px] font-mono text-[10px] text-accent-ink">
                    {cluster.keywords.length} kw
                  </span>
                  <span className="rounded-full bg-panel-2 px-1.5 py-[1px] font-mono text-[10px] text-ink-3">
                    {formatVolume(cluster.totalVolume)} vol
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-ink-2">{cluster.theme}</p>
              </div>
              <span className="shrink-0 rounded-full border border-line px-2 py-[2px] font-mono text-[10px] text-ink-3">
                {cluster.suggestedPageType}
              </span>
            </button>

            {expanded.has(i) && (
              <div className="border-t border-line-soft px-4 py-3">
                {showKeywords ? (
                  <div className="flex flex-wrap gap-2">
                    {cluster.keywords.map((kw, j) => (
                      <span
                        key={j}
                        className="inline-flex items-center gap-1.5 rounded-full border border-line bg-panel px-2.5 py-[3px] text-[12px] text-ink-2"
                      >
                        {kw.keyword}
                        {kw.volume > 0 && (
                          <span className="rounded-full bg-accent-soft px-1.5 py-[1px] font-mono text-[10px] text-accent-ink">
                            {formatVolume(kw.volume)}
                          </span>
                        )}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-ink-3">
                    {cluster.keywords.length} keywords — unlock with email below
                  </p>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Email gate */}
      {!unlocked && result.clusters.length > 0 && (
        <EmailGate
          toolSlug="keyword-cluster-mapper"
          label="Unlock full keyword lists"
          description="Enter your email to see all keywords in each cluster and export the data."
          context={{ seeds: result.seedKeywords }}
          emailSubject={`Keyword Clusters: ${result.seedKeywords.join(", ")}`}
          emailBody={`<h2 style="color:#1a1a1a;">Keyword Clusters</h2><p style="color:#666;">Seeds: ${result.seedKeywords.join(", ")}</p><p style="color:#666;">${result.clusters.length} clusters, ${result.totalKeywords} total keywords, ${formatVolume(result.totalVolume)} total volume.</p>${result.clusters.map((c) => `<p style="margin-top:12px;"><strong style="color:#1a1a1a;">${c.name}</strong> <span style="color:#999;">(${c.suggestedPageType})</span><br/><span style="color:#666;">${c.keywords.map((k) => k.keyword).join(", ")}</span></p>`).join("")}`}
          onSuccess={() => setUnlocked(true)}
        />
      )}
    </div>
  );
}
