"use client";

import type { HealthCheckResult, HealthIssue } from "@/lib/tools/types";
import { EmailGate } from "./email-gate";

function ScoreBadge({ score }: { score: number }) {
  let color = "oklch(0.4 0.1 155)";
  let bg = "oklch(0.95 0.03 155)";
  if (score < 50) {
    color = "oklch(0.45 0.15 25)";
    bg = "oklch(0.95 0.03 25)";
  } else if (score < 80) {
    color = "oklch(0.45 0.1 85)";
    bg = "oklch(0.95 0.03 85)";
  }

  return (
    <div
      className="flex h-20 w-20 items-center justify-center rounded-full text-2xl font-bold"
      style={{ color, backgroundColor: bg }}
    >
      {score}
    </div>
  );
}

function SeverityIcon({ severity }: { severity: HealthIssue["severity"] }) {
  switch (severity) {
    case "error":
      return (
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[oklch(0.95_0.03_25)] text-[oklch(0.5_0.15_25)]">
          <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </span>
      );
    case "warning":
      return (
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[oklch(0.95_0.03_85)] text-[oklch(0.5_0.12_85)]">
          <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M12 9v4m0 4h.01" />
          </svg>
        </span>
      );
    case "info":
      return (
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[oklch(0.95_0.01_265)] text-[oklch(0.5_0.1_265)]">
          <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M12 16v-4m0-4h.01" />
          </svg>
        </span>
      );
    case "pass":
      return (
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[oklch(0.95_0.03_155)] text-[oklch(0.45_0.12_155)]">
          <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M5 12l5 5L20 7" />
          </svg>
        </span>
      );
  }
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-line bg-bg px-4 py-3">
      <div className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-3">
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold text-ink">{value}</div>
    </div>
  );
}

export function HealthResult({ result }: { result: HealthCheckResult }) {
  const errors = result.issues.filter((i) => i.severity === "error");
  const warnings = result.issues.filter((i) => i.severity === "warning");
  const passes = result.issues.filter((i) => i.severity === "pass");
  const infos = result.issues.filter((i) => i.severity === "info");

  return (
    <div className="mt-8 space-y-6">
      {/* Score + stats */}
      <div className="rounded-xl border border-line bg-bg p-6">
        <div className="flex items-center gap-6">
          <ScoreBadge score={result.score} />
          <div className="flex-1">
            <h3 className="text-lg font-semibold tracking-[-0.015em] text-ink">
              SEO Health Score
            </h3>
            <p className="mt-0.5 text-sm text-ink-2 break-all">{result.url}</p>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Word count" value={result.wordCount.toLocaleString()} />
          <Stat label="Images" value={result.imageCount} />
          <Stat label="Int. links" value={result.internalLinks} />
          <Stat label="Ext. links" value={result.externalLinks} />
        </div>
      </div>

      {/* PageSpeed */}
      {result.pageSpeed && (
        <div className="rounded-xl border border-line bg-bg p-5">
          <h3 className="mb-3 text-sm font-semibold tracking-[-0.005em]">
            Core Web Vitals (Mobile)
          </h3>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat
              label="Performance"
              value={`${result.pageSpeed.performanceScore}/100`}
            />
            <Stat
              label="LCP"
              value={`${(result.pageSpeed.lcp / 1000).toFixed(1)}s`}
            />
            <Stat label="CLS" value={result.pageSpeed.cls.toFixed(3)} />
            <Stat
              label="TBT"
              value={`${Math.round(result.pageSpeed.tbt)}ms`}
            />
          </div>
        </div>
      )}

      {/* Issues */}
      <div className="rounded-xl border border-line bg-bg p-5">
        <h3 className="mb-1 text-sm font-semibold tracking-[-0.005em]">
          Audit Results
        </h3>
        <p className="mb-4 text-xs text-ink-3">
          {errors.length} errors, {warnings.length} warnings, {passes.length} passed
        </p>

        <div className="space-y-2">
          {[...errors, ...warnings, ...infos, ...passes].map((issue, i) => (
            <div
              key={i}
              className="flex items-start gap-2.5 rounded-lg border border-line-soft px-3 py-2.5"
            >
              <SeverityIcon severity={issue.severity} />
              <div className="flex-1">
                <p className="text-sm text-ink">{issue.message}</p>
                {issue.details && (
                  <p className="mt-0.5 text-xs text-ink-3">{issue.details}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Headings */}
      {(result.headings.h1.length > 0 || result.headings.h2.length > 0) && (
        <div className="rounded-xl border border-line bg-bg p-5">
          <h3 className="mb-3 text-sm font-semibold tracking-[-0.005em]">
            Heading Structure
          </h3>
          {result.headings.h1.map((h, i) => (
            <div key={`h1-${i}`} className="mb-1 flex items-center gap-2">
              <span className="rounded bg-accent-soft px-1.5 py-[1px] font-mono text-[10px] text-accent-ink">
                H1
              </span>
              <span className="text-sm text-ink">{h}</span>
            </div>
          ))}
          {result.headings.h2.map((h, i) => (
            <div key={`h2-${i}`} className="mb-1 flex items-center gap-2 pl-4">
              <span className="rounded bg-panel-2 px-1.5 py-[1px] font-mono text-[10px] text-ink-3">
                H2
              </span>
              <span className="text-[13px] text-ink-2">{h}</span>
            </div>
          ))}
        </div>
      )}

      {/* Email gate */}
      <EmailGate
        toolSlug="seo-health-checker"
        label="Email me this report"
        description="Get the full SEO health report delivered to your inbox."
        context={{ url: result.url, score: result.score }}
        emailSubject={`SEO Health Report: ${result.url}`}
        emailBody={`<h2 style="color:#1a1a1a;">SEO Health Score: ${result.score}/100</h2><p style="color:#666;">${result.url}</p><p style="color:#666;">${errors.length} errors, ${warnings.length} warnings, ${passes.length} checks passed.</p><p style="color:#999;font-size:13px;">Generated with AltoRank's free SEO Health Checker.</p>`}
      />
    </div>
  );
}
