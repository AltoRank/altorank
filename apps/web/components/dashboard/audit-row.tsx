"use client";

import { useState } from "react";
import { StatusPill, Icons } from "@/components/ui";
import type { DomainAudit } from "@/lib/types";
import {
  affectedPageCount,
  auditDuration,
  formatPageSpeed,
  issueLabel,
  issueSeverity,
  issueUrl,
  pagespeedRows,
  sortIssues,
  type Severity,
} from "@/lib/audit/issue-display";

/**
 * One audit, and everything the run recorded about it.
 *
 * The row used to be the whole story: a score, two counts and a pill. Every
 * issue was already on the page - `getWorkspaceAudits` selects `*`, and the
 * counts beside it were computed by reading the array - so "14 errors" was
 * rendered from the very list that would have said which fourteen. Expanding
 * costs no extra query; it only stops discarding what was already fetched.
 */

function scoreColor(score: number | null): string {
  if (score === null) return "text-ink-3";
  if (score >= 80) return "text-green-600";
  if (score >= 50) return "text-yellow-600";
  return "text-red-600";
}

function auditStatus(a: DomainAudit): { status: string; label: string } {
  if (a.status === "running") return { status: "run", label: "Running" };
  if (a.status === "failed") return { status: "error", label: "Failed" };
  return { status: "on", label: "Completed" };
}

const SEVERITY_STYLE: Record<Severity, string> = {
  error: "text-red-600 border-red-600/30 bg-red-600/[0.06]",
  warning: "text-yellow-600 border-yellow-600/30 bg-yellow-600/[0.06]",
  info: "text-ink-3 border-line bg-panel",
};

export function AuditRow({ audit }: { audit: DomainAudit }) {
  const [open, setOpen] = useState(false);

  const date = new Date(audit.started_at).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const { status, label } = auditStatus(audit);
  const completed = audit.status === "completed";

  const issues = audit.issues ?? [];
  const errors = issues.filter((i) => issueSeverity(i) === "error").length;
  const warnings = issues.filter((i) => issueSeverity(i) === "warning").length;

  // Every issue carries the page it was found on, so the crawl's own reach is
  // not recorded but its findings are attributable. Counted distinctly, since
  // one page with six problems is one page.
  const affectedPages = affectedPageCount(issues);
  const speed = pagespeedRows(audit.pagespeed as Record<string, unknown> | null);
  const ran = auditDuration(audit);

  return (
    <>
      <tr
        className="cursor-pointer hover:[&>td]:bg-panel"
        onClick={() => setOpen(!open)}
      >
        <td className="px-3.5 py-3 border-b border-line-soft font-mono text-xs text-ink-2">
          <button
            type="button"
            aria-expanded={open}
            aria-label={open ? `Hide details for the audit of ${date}` : `Show details for the audit of ${date}`}
            onClick={(e) => {
              // The row is clickable too; without this the button's click
              // bubbles to it and the two toggles cancel out.
              e.stopPropagation();
              setOpen(!open);
            }}
            className="mr-2 inline-flex align-middle text-ink-3 hover:text-ink"
          >
            <Icons.caretDown
              size={12}
              className={`transition-transform ${open ? "" : "-rotate-90"}`}
            />
          </button>
          {date}
        </td>
        <td
          className={`px-3.5 py-3 border-b border-line-soft text-right font-mono text-sm font-semibold ${scoreColor(
            completed && typeof audit.overall_score === "number" ? audit.overall_score : null,
          )}`}
        >
          {completed && typeof audit.overall_score === "number" ? audit.overall_score : "—"}
        </td>
        <td className="px-3.5 py-3 border-b border-line-soft text-right font-mono text-xs text-ink-2">
          {audit.pages_crawled}
        </td>
        <td className="px-3.5 py-3 border-b border-line-soft text-right">
          {completed ? (
            <span className="font-mono text-xs">
              {errors > 0 && <span className="text-red-600">{errors} errors</span>}
              {errors > 0 && warnings > 0 && <span className="text-ink-3"> · </span>}
              {warnings > 0 && <span className="text-yellow-600">{warnings} warnings</span>}
              {errors === 0 && warnings === 0 && <span className="text-green-600">None</span>}
            </span>
          ) : (
            <span className="text-ink-3">—</span>
          )}
        </td>
        <td className="px-3.5 py-3 border-b border-line-soft">
          <StatusPill status={status} label={label} />
        </td>
      </tr>

      {open && (
        <tr>
          <td colSpan={5} className="border-b border-line-soft bg-panel/40 px-3.5 py-4">
            <div className="flex flex-wrap gap-x-8 gap-y-2 font-mono text-[11.5px] text-ink-3">
              <span>
                Crawled <span className="text-ink-2">{audit.pages_crawled}</span>{" "}
                {audit.pages_crawled === 1 ? "page" : "pages"}
              </span>
              {affectedPages > 0 && (
                <span>
                  <span className="text-ink-2">{affectedPages}</span> with findings
                </span>
              )}
              {ran && (
                <span>
                  Took <span className="text-ink-2">{ran}</span>
                </span>
              )}
              <span>
                Started{" "}
                <span className="text-ink-2">
                  {new Date(audit.started_at).toLocaleTimeString("en-US", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </span>
            </div>

            {speed.length > 0 && (
              <div className="mt-4">
                <h4 className="mb-2 font-mono text-[10.5px] font-medium uppercase tracking-[0.08em] text-ink-3">
                  PageSpeed
                </h4>
                <div className="flex flex-wrap gap-x-6 gap-y-2">
                  {speed.map((f) => (
                    <div key={f.key} className="min-w-[110px]">
                      <div className="font-mono text-[13px] text-ink">
                        {formatPageSpeed(f.value, f.unit)}
                      </div>
                      <div className="text-[11px] text-ink-3">{f.label}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-4">
              <h4 className="mb-2 font-mono text-[10.5px] font-medium uppercase tracking-[0.08em] text-ink-3">
                {issues.length > 0
                  ? `${issues.length} ${issues.length === 1 ? "issue" : "issues"}`
                  : "Issues"}
              </h4>

              {issues.length === 0 ? (
                <p className="text-[12.5px] text-ink-3">
                  {completed
                    ? "Nothing flagged on any page the crawler reached."
                    : audit.status === "running"
                      ? "The crawl is still running."
                      : "The run failed before it recorded any findings."}
                </p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {sortIssues(issues).map((issue, i) => {
                      const severity = issueSeverity(issue);
                      const url = issueUrl(issue);
                      return (
                        <li
                          key={`${issue.type}-${url}-${i}`}
                          className="rounded-[7px] border border-line bg-bg px-3 py-2"
                        >
                          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                            <span
                              className={`rounded-[4px] border px-1.5 py-px font-mono text-[10px] uppercase tracking-[0.06em] ${SEVERITY_STYLE[severity]}`}
                            >
                              {severity}
                            </span>
                            <span className="text-[12.5px] font-medium text-ink">
                              {issueLabel(issue.type)}
                            </span>
                            {url && (
                              <a
                                href={url}
                                target="_blank"
                                rel="noopener noreferrer nofollow"
                                onClick={(e) => e.stopPropagation()}
                                className="truncate font-mono text-[11px] text-accent-ink hover:underline"
                                title={url}
                              >
                                {url}
                              </a>
                            )}
                          </div>
                          <div className="mt-1 text-[12.5px] text-ink-2">{issue.message}</div>
                          {issue.details && (
                            <div className="mt-0.5 font-mono text-[11px] text-ink-3">
                              {issue.details}
                            </div>
                          )}
                        </li>
                      );
                    })}
                </ul>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
