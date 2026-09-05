// The public shape of an agent-readiness result: nine checks, each pass, fail
// or unknown, with one line of evidence and one line of fix.
//
// Pure functions only. The checker (lib/audit/agent-readiness.ts) decides
// what it saw; this module decides how that is said to a stranger who did not
// ask for a scoring model. Two rules from POSITIONING.md are load-bearing:
//
//   1. Nothing here says anything the checker did not observe.
//   5. Unknown is unknown. A check that did not finish, or whose answer the
//      server refused, is neither a fail nor a zero. It is left out of the
//      score and labelled so.

import {
  scoreFindings,
  type ReadinessCheckId,
  type ReadinessFinding,
  type ReadinessResult,
} from "@/lib/audit/agent-readiness";

export type PublicCheckStatus = "pass" | "fail" | "unknown";

export interface PublicCheck {
  id: ReadinessCheckId;
  label: string;
  status: PublicCheckStatus;
  /** What the checker observed, in its own words. Empty when unknown. */
  evidence: string;
  /** One line on what would turn a fail into a pass. Empty when it passed. */
  fix_summary: string;
}

export interface PublicCheckData {
  domain: string;
  /** Severity-weighted 0-100 over the checks that completed. Null when none did. */
  score: number | null;
  checks: PublicCheck[];
  passed: number;
  /** How many of the nine checks reached a pass or fail. */
  known: number;
  total: number;
  /** True when the run stopped at its deadline before every check ran. */
  partial: boolean;
  checked_at: string;
  share_url: string;
  /** Set when the site could not be checked at all (unreachable, 4xx homepage). */
  error?: string;
}

export const APP_URL = "https://app.altorank.co";

export const AGENT_GUIDANCE =
  "Each check is pass, fail or unknown. Unknown means the check did not " +
  "complete or the server's answer was inconclusive; it is not a failure and " +
  "it does not lower the score. The score is severity-weighted over the checks " +
  "that completed and is null when none did. Evidence is what AltoRank " +
  "observed on the site's public configuration at checked_at; re-run before " +
  "quoting it later. The checker reads only the homepage, /robots.txt, " +
  "/sitemap.xml and /llms.txt.";

/** Order, label and fix line for every check, keyed by the checker's id. */
export const CHECK_META: Record<ReadinessCheckId, { label: string; fix: string }> = {
  robots_reachable: {
    label: "robots.txt reachable",
    fix: "Publish a robots.txt at the site root so crawlers get explicit guidance.",
  },
  ai_crawlers_allowed: {
    label: "AI crawlers allowed",
    fix: "Remove the Disallow rules that block the listed AI crawlers, or scope them to paths that should stay private.",
  },
  sitemap: {
    label: "Sitemap declared",
    fix: "Add a Sitemap: line to robots.txt pointing at an XML sitemap that returns 200.",
  },
  structured_data: {
    label: "Structured data on the homepage",
    fix: "Add JSON-LD to the homepage describing the page and the organisation behind it.",
  },
  entity_schema: {
    label: "Organization schema",
    fix: "Add an Organization or LocalBusiness JSON-LD block with name, url and logo so the site resolves as an entity.",
  },
  machine_readable: {
    label: "Machine-readable copy",
    fix: "Serve a plain-text /llms.txt listing the site's key pages, or offer a markdown version of each page.",
  },
  title_meta: {
    label: "Title and meta description",
    fix: "Give the homepage a title and a meta description.",
  },
  single_h1: {
    label: "Single h1",
    fix: "Use exactly one h1 on the homepage.",
  },
  content_signals: {
    label: "Content signals",
    fix: "Optional: add a Content-Signal line to robots.txt stating your ai-train, search and ai-input preferences.",
  },
};

export const CHECK_ORDER = Object.keys(CHECK_META) as ReadinessCheckId[];

export function shareUrlFor(domain: string, appUrl: string = APP_URL): string {
  return `${appUrl}/check/${encodeURIComponent(domain)}`;
}

function statusOf(finding: ReadinessFinding | undefined): PublicCheckStatus {
  if (!finding || finding.inconclusive) return "unknown";
  return finding.passed ? "pass" : "fail";
}

/**
 * Nine checks out, whatever came in. A finding the checker never produced
 * (deadline) or flagged inconclusive (server refused) is unknown; the score
 * is computed over the rest with the checker's own weights, so a complete
 * run scores exactly what the dashboard and the CLI would say.
 */
export function shapePublicCheck(
  result: ReadinessResult,
  checkedAt: Date,
  appUrl: string = APP_URL,
): PublicCheckData {
  const byId = new Map(result.findings.map((f) => [f.check, f]));
  const checks: PublicCheck[] = CHECK_ORDER.map((id) => {
    const finding = byId.get(id);
    const status = statusOf(finding);
    return {
      id,
      label: CHECK_META[id].label,
      status,
      evidence: status === "unknown" ? (finding?.detail ?? "") : finding!.detail,
      fix_summary: status === "fail" ? CHECK_META[id].fix : "",
    };
  });

  const known = result.findings.filter((f) => !f.inconclusive);
  const passed = checks.filter((c) => c.status === "pass").length;

  return {
    domain: result.domain,
    score: known.length ? scoreFindings(known) : null,
    checks,
    passed,
    known: known.length,
    total: CHECK_ORDER.length,
    partial: Boolean(result.partial),
    checked_at: checkedAt.toISOString(),
    share_url: shareUrlFor(result.domain, appUrl),
    ...(result.error ? { error: result.error } : {}),
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Short date for the badge and the share page: "4 Sep 2026". Hand-rolled so
 * it does not depend on which ICU the runtime shipped with. */
export function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * The badge says only what was measured. "7/9" when all nine ran; "7/8
 * checked" when one could not be decided, so the missing check is visible
 * rather than counted against the site.
 */
export function badgeText(data: Pick<PublicCheckData, "passed" | "known" | "total" | "checked_at" | "error">): string {
  if (data.error || data.known === 0) return "AI-readiness check by AltoRank";
  const missing = data.total - data.known;
  const ratio =
    missing === 0
      ? `${data.passed}/${data.total}`
      : `${data.passed}/${data.known}, ${missing} not checked`;
  const when = shortDate(data.checked_at);
  return when ? `AI-readiness: ${ratio} · checked ${when}` : `AI-readiness: ${ratio}`;
}

/** Wording for the score tier. Descriptive, not a promise. */
export function scoreLabel(score: number | null): string {
  if (score === null) return "Not measured";
  if (score >= 85) return "Readable";
  if (score >= 70) return "Mostly readable";
  if (score >= 50) return "Partly readable";
  return "Hard to read";
}
