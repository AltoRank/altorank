import type { AuditIssue, DomainAudit } from "@/lib/types";

/**
 * Turning what an audit recorded into what the expanded row shows.
 *
 * Separate from the component because this is the part that can be wrong:
 * two of these exist to paper over a real inconsistency in how issues are
 * written, and a unit test is the only place that is currently stated.
 */

export type Severity = "error" | "warning" | "info";

/**
 * The checks in lib/audit/checks.ts write `url`; the audit worker's own
 * fetch-failure issue writes `page` (app/api/audit/route.ts). Read both, so
 * the one issue that explains why an audit came back empty still names the
 * site it failed on instead of rendering nothing.
 */
export function issueUrl(issue: AuditIssue): string {
  return issue.url ?? (issue as { page?: string }).page ?? "";
}

/**
 * Same split, on severity. `AuditIssue` declares "error" | "warning" | "info",
 * and the checks honour it, but the fetch-failure issue is written with
 * "high". Left unmapped it counts as neither an error nor a warning, so a site
 * that could not be fetched at all reported "None" in the issues column - the
 * most reassuring possible summary of a total failure.
 */
export function issueSeverity(issue: AuditIssue): Severity {
  switch (issue.severity as string) {
    case "error":
    case "high":
    case "critical":
      return "error";
    case "warning":
    case "medium":
      return "warning";
    default:
      return "info";
  }
}

const SEVERITY_RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

/**
 * Errors first. An audit is read top-down, and the thing that breaks a page
 * outranks the thing that weakens it. Ties keep the order the crawl found
 * them in, which groups issues by page for free.
 */
export function sortIssues(issues: AuditIssue[]): AuditIssue[] {
  return [...issues].sort(
    (a, b) => SEVERITY_RANK[issueSeverity(a)] - SEVERITY_RANK[issueSeverity(b)],
  );
}

/** Pages carrying at least one finding. One page with six problems is one page. */
export function affectedPageCount(issues: AuditIssue[]): number {
  return new Set(issues.map(issueUrl).filter(Boolean)).size;
}

/** "missing_alt" reads as a column name; "Missing alt" reads as a finding. */
export function issueLabel(type: string): string {
  const words = type.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** How long the run took, or null while it is still going. */
export function auditDuration(audit: Pick<DomainAudit, "started_at" | "completed_at">): string | null {
  if (!audit.completed_at) return null;
  const ms =
    new Date(audit.completed_at).getTime() - new Date(audit.started_at).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

/** PageSpeed reports milliseconds for timings and a unitless number for CLS. */
export type PageSpeedUnit = "ms" | "score" | "raw";

export const PAGESPEED_FIELDS: { key: string; label: string; unit: PageSpeedUnit }[] = [
  { key: "performanceScore", label: "Performance", unit: "score" },
  { key: "firstContentfulPaint", label: "First contentful paint", unit: "ms" },
  { key: "largestContentfulPaint", label: "Largest contentful paint", unit: "ms" },
  { key: "totalBlockingTime", label: "Total blocking time", unit: "ms" },
  { key: "speedIndex", label: "Speed index", unit: "ms" },
  { key: "cumulativeLayoutShift", label: "Cumulative layout shift", unit: "raw" },
];

export function formatPageSpeed(value: number, unit: PageSpeedUnit): string {
  if (unit === "score") return String(Math.round(value));
  // CLS is a ratio, and rounding it to a whole number would print every real
  // score as 0.
  if (unit === "raw") return value.toFixed(3);
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`;
}

/**
 * The PageSpeed fields this audit actually has. The column is a free-form
 * jsonb that is `{}` whenever the API was unconfigured, over quota, or could
 * not analyse the site, so every field is checked rather than assumed.
 */
export function pagespeedRows(
  pagespeed: Record<string, unknown> | null | undefined,
): { key: string; label: string; unit: PageSpeedUnit; value: number }[] {
  const source = pagespeed ?? {};
  return PAGESPEED_FIELDS.flatMap((f) => {
    const value = source[f.key];
    return typeof value === "number" && Number.isFinite(value)
      ? [{ ...f, value }]
      : [];
  });
}
