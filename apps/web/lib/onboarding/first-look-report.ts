// ---------------------------------------------------------------------------
// The site report a person reads while the first draft is written
// ---------------------------------------------------------------------------
//
// The first look measures a lot on its way to a keyword list - whether AI
// assistants can read the site, what Lighthouse thinks of it, what the crawl
// found wrong, what the homepage says about itself - and until now all of it
// went into `domain_audits` and stayed there. The run screen showed five
// phase lines and a spinner for the two to four minutes the draft takes.
//
// This turns that row into something to read during the wait. It is a
// mapping, not a measurement: nothing here fetches a page or calls a provider.
// The row is written by `analyseDomain` in the keywords phase, so the report
// appears on the screen's next poll, before the draft starts.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuditIssue } from "@/lib/types";
import type { ReadinessFinding, ReadinessResult } from "@/lib/audit/agent-readiness";
import type { PageFacts } from "@/lib/audit/page-facts";

export interface ReportFinding {
  check: ReadinessFinding["check"];
  passed: boolean;
  severity: ReadinessFinding["severity"];
  detail: string;
  inconclusive: boolean;
}

export type ReportSpeed =
  | {
      ok: true;
      strategy: "mobile";
      performance: number;
      accessibility: number | null;
      bestPractices: number | null;
      seo: number | null;
      lcpMs: number;
      fcpMs: number;
      tbtMs: number;
      cls: number;
      speedIndexMs: number;
    }
  | { ok: false; detail: string };

export interface ReportIssueGroup {
  type: AuditIssue["type"];
  severity: AuditIssue["severity"];
  count: number;
  /** One instance, so the group is concrete. */
  example: string;
}

export interface ReportExistingPage {
  url: string;
  title: string | null;
  techIssueCount: number;
}

export interface FirstLookReport {
  auditedAt: string;
  pagesCrawled: number;
  /** The crawl's on-page score, 0-100, or null when nothing was crawled. */
  onPageScore: number | null;
  readiness: { score: number; partial: boolean; error: string | null; findings: ReportFinding[] } | null;
  speed: ReportSpeed | null;
  page: PageFacts | null;
  issues: ReportIssueGroup[];
  /** From the pages phase, when it has run: what the existing pages need. */
  existingPages: { checked: number; withIssues: number; worst: ReportExistingPage[] } | null;
}

/** The `domain_audits` columns the report reads. */
export interface AuditRowForReport {
  completed_at: string | null;
  started_at?: string | null;
  pages_crawled: number | null;
  overall_score: number | null;
  issues: unknown;
  pagespeed: unknown;
  readiness: unknown;
  page_facts?: unknown;
}

export interface SitePageForReport {
  url: string;
  title: string | null;
  tech_issue_count: number | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

function speedFrom(raw: unknown): ReportSpeed | null {
  if (!isRecord(raw)) return null;
  // `analyseDomain` stores the Lighthouse result as a plain object, or
  // `{ unavailable: <why> }` when it did not run (before 2026-09-11, `{}`).
  if (typeof raw.performanceScore === "number") {
    const n = (k: string) => (typeof raw[k] === "number" ? (raw[k] as number) : 0);
    const opt = (k: string) => (typeof raw[k] === "number" ? (raw[k] as number) : null);
    return {
      ok: true,
      strategy: "mobile",
      performance: n("performanceScore"),
      accessibility: opt("accessibilityScore"),
      bestPractices: opt("bestPracticesScore"),
      seo: opt("seoScore"),
      lcpMs: n("largestContentfulPaint"),
      fcpMs: n("firstContentfulPaint"),
      tbtMs: n("totalBlockingTime"),
      cls: n("cumulativeLayoutShift"),
      speedIndexMs: n("speedIndex"),
    };
  }
  if (typeof raw.unavailable === "string") return { ok: false, detail: raw.unavailable };
  return null;
}

function readinessFrom(raw: unknown): FirstLookReport["readiness"] {
  if (!isRecord(raw)) return null;
  const r = raw as Partial<ReadinessResult>;
  const findings = Array.isArray(r.findings) ? r.findings : [];
  return {
    score: typeof r.score === "number" ? r.score : 0,
    partial: Boolean(r.partial),
    error: typeof r.error === "string" ? r.error : null,
    findings: findings
      .filter((f): f is ReadinessFinding => isRecord(f) && typeof (f as ReadinessFinding).check === "string")
      .map((f) => ({ check: f.check, passed: Boolean(f.passed), severity: f.severity, detail: f.detail ?? "", inconclusive: Boolean(f.inconclusive) })),
  };
}

/** Issues grouped by type, worst first, so forty missing alts are one line. */
export function groupIssues(raw: unknown): ReportIssueGroup[] {
  if (!Array.isArray(raw)) return [];
  const rank = { error: 0, warning: 1, info: 2 } as const;
  const groups = new Map<string, ReportIssueGroup>();
  for (const v of raw) {
    if (!isRecord(v) || typeof v.type !== "string") continue;
    const issue = v as unknown as AuditIssue;
    const g = groups.get(issue.type);
    if (g) {
      g.count++;
      if (rank[issue.severity] < rank[g.severity]) g.severity = issue.severity;
    } else {
      groups.set(issue.type, { type: issue.type, severity: issue.severity, count: 1, example: issue.message });
    }
  }
  return [...groups.values()].sort((a, b) => rank[a.severity] - rank[b.severity] || b.count - a.count);
}

/** Pure, so a stored row can be checked against the screen without a database. */
export function reportFromAudit(row: AuditRowForReport, pages: SitePageForReport[] | null = null): FirstLookReport {
  const facts = isRecord(row.page_facts) ? (row.page_facts as unknown as PageFacts) : null;
  const existingPages =
    pages && pages.length
      ? {
          checked: pages.length,
          withIssues: pages.filter((p) => (p.tech_issue_count ?? 0) > 0).length,
          worst: [...pages]
            .filter((p) => (p.tech_issue_count ?? 0) > 0)
            .sort((a, b) => (b.tech_issue_count ?? 0) - (a.tech_issue_count ?? 0))
            .slice(0, 5)
            .map((p) => ({ url: p.url, title: p.title, techIssueCount: p.tech_issue_count ?? 0 })),
        }
      : null;
  return {
    auditedAt: row.completed_at ?? row.started_at ?? new Date(0).toISOString(),
    pagesCrawled: row.pages_crawled ?? 0,
    onPageScore: typeof row.overall_score === "number" ? row.overall_score : null,
    readiness: readinessFrom(row.readiness),
    speed: speedFrom(row.pagespeed),
    page: facts,
    issues: groupIssues(row.issues),
    existingPages,
  };
}

const AUDIT_COLUMNS = "completed_at, started_at, pages_crawled, overall_score, issues, pagespeed, readiness";

/**
 * The latest completed audit for a workspace, as a report, or null when none
 * has finished yet. `since` narrows to audits written for this run, so an
 * old workspace re-running onboarding does not show last month's numbers
 * while this run's are still being measured.
 *
 * Read through whichever client the caller holds; the user's client sees the
 * row through the account-membership policy, the same one that shows the run.
 */
export async function loadFirstLookReport(
  supabase: SupabaseClient,
  workspaceId: string,
  since?: string | null,
): Promise<FirstLookReport | null> {
  const query = (columns: string) => {
    let q = supabase
      .from("domain_audits")
      .select(columns)
      .eq("workspace_id", workspaceId)
      .eq("status", "completed")
      .order("completed_at", { ascending: false })
      .limit(1);
    if (since) q = q.gte("completed_at", since);
    return q.maybeSingle();
  };
  // The `page_facts` column arrived with migration 087. An install that has
  // not applied it yet still gets the rest of the report.
  let { data, error } = await query(`${AUDIT_COLUMNS}, page_facts`);
  if (error) ({ data, error } = await query(AUDIT_COLUMNS));
  if (error || !data) return null;

  const { data: pages } = await supabase
    .from("site_pages")
    .select("url, title, tech_issue_count")
    .eq("workspace_id", workspaceId)
    .not("tech_checked_at", "is", null)
    .order("tech_issue_count", { ascending: false })
    .limit(200);

  return reportFromAudit(data as unknown as AuditRowForReport, (pages as SitePageForReport[] | null) ?? null);
}
