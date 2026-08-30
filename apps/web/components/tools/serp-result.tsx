"use client";

import type { SerpAnalysisResult } from "@/lib/tools/types";
import { EmailGate } from "./email-gate";

export function SerpResult({ result }: { result: SerpAnalysisResult }) {
  return (
    <div className="mt-8 space-y-6">
      {/* Summary stats */}
      <div className="rounded-xl border border-line bg-bg p-5">
        <div className="flex flex-wrap items-center gap-4">
          <div>
            <div className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-3">
              Keyword
            </div>
            <div className="text-lg font-semibold text-ink">
              {result.keyword}
            </div>
          </div>
          <div className="h-8 w-px bg-line" />
          <div>
            <div className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-3">
              Locale
            </div>
            <div className="text-sm text-ink-2">{result.locale}</div>
          </div>
          {result.avgWordCount && (
            <>
              <div className="h-8 w-px bg-line" />
              <div>
                <div className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-3">
                  Avg. word count
                </div>
                <div className="text-sm font-medium text-ink">
                  {result.avgWordCount.toLocaleString()} words
                </div>
              </div>
            </>
          )}
          <div className="h-8 w-px bg-line" />
          <div>
            <div className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-3">
              Results
            </div>
            <div className="text-sm text-ink-2">{result.organic.length}</div>
          </div>
        </div>
      </div>

      {/* AI Insights */}
      {result.aiInsights && (
        <div className="rounded-xl border border-accent-soft bg-panel p-5">
          <h3 className="mb-2 text-sm font-semibold tracking-[-0.005em]">
            AI Analysis
          </h3>
          <p className="text-sm leading-relaxed text-ink-2">
            {result.aiInsights}
          </p>
        </div>
      )}

      {/* Organic results table */}
      <div className="rounded-xl border border-line bg-bg p-5">
        <h3 className="mb-4 text-sm font-semibold tracking-[-0.005em]">
          Top Results
        </h3>
        <div className="space-y-3">
          {result.organic.map((item) => (
            <div
              key={item.position}
              className="flex gap-3 rounded-lg border border-line-soft p-3"
            >
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-panel-2 font-mono text-[11px] font-medium text-ink-2">
                {item.position}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <h4 className="truncate text-sm font-medium text-ink">
                    {item.title}
                  </h4>
                  {item.wordCount && (
                    <span className="shrink-0 rounded-full bg-accent-soft px-1.5 py-[1px] font-mono text-[10px] text-accent-ink">
                      {item.wordCount.toLocaleString()} words
                    </span>
                  )}
                </div>
                <p className="mt-0.5 truncate text-xs text-ink-3">
                  {item.domain}
                </p>
                {item.description && (
                  <p className="mt-1 line-clamp-2 text-[12.5px] leading-relaxed text-ink-2">
                    {item.description}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* People Also Ask */}
      {result.peopleAlsoAsk.length > 0 && (
        <div className="rounded-xl border border-line bg-bg p-5">
          <h3 className="mb-3 text-sm font-semibold tracking-[-0.005em]">
            People Also Ask
          </h3>
          <div className="space-y-2">
            {result.peopleAlsoAsk.map((q, i) => (
              <div
                key={i}
                className="flex items-center gap-2 rounded-lg bg-panel px-3 py-2.5 text-sm text-ink-2"
              >
                <svg
                  className="h-3.5 w-3.5 shrink-0 text-ink-3"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <circle cx="12" cy="12" r="10" />
                  <path d="M9 9a3 3 0 015.12-2.13A3 3 0 0112 13v1m0 4h.01" />
                </svg>
                {q}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Email gate */}
      <EmailGate
        toolSlug="serp-analyzer"
        label="Email me this analysis"
        description="Get the full SERP analysis with AI insights delivered to your inbox."
        context={{ keyword: result.keyword }}
        emailSubject={`SERP Analysis: ${result.keyword}`}
        emailBody={`<h2 style="color:#1a1a1a;">SERP Analysis: ${result.keyword}</h2><p style="color:#666;">Locale: ${result.locale} | ${result.organic.length} results analyzed${result.avgWordCount ? ` | Avg. word count: ${result.avgWordCount}` : ""}</p>${result.aiInsights ? `<p style="color:#666;margin-top:16px;">${result.aiInsights}</p>` : ""}<p style="color:#999;font-size:13px;margin-top:16px;">Generated with AltoRank's free SERP Analyzer.</p>`}
      />
    </div>
  );
}
