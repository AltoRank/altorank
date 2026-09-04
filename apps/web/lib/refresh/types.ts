// ---------------------------------------------------------------------------
// Shared shapes for the content refresh engine
// ---------------------------------------------------------------------------
//
// One page, five reasons a rewrite might help, each read off numbers the
// product already stores. The evidence travels with the verdict so a reviewer
// sees why, and every field is `null` when it was not measured. "0 clicks"
// and "nobody measured clicks" are different facts and only one of them is a
// reason to rewrite a page.

export type Opportunity =
  /** Ranking 6-15 for a query with real impressions: page two, within reach. */
  | "almost_there"
  /** Top five, but far fewer clicks than that position usually earns. */
  | "ctr_gap"
  /** Position or clicks fell against the previous 28 days. */
  | "declining"
  /** Ranks for the query but is short, or has no heading that addresses it. */
  | "content_gap"
  /** Under 600 words and still getting impressions. */
  | "thin";

export const OPPORTUNITIES: Opportunity[] = [
  "almost_there",
  "ctr_gap",
  "declining",
  "content_gap",
  "thin",
];

export const OPPORTUNITY_LABELS: Record<Opportunity, string> = {
  almost_there: "Almost there",
  ctr_gap: "CTR gap",
  declining: "Declining",
  content_gap: "Content gap",
  thin: "Thin",
};

export interface Evidence {
  query: string | null;
  position: number | null;
  prev_position: number | null;
  clicks: number | null;
  prev_clicks: number | null;
  impressions: number | null;
  ctr: number | null;
  expected_ctr: number | null;
  word_count: number | null;
}

export interface Detection {
  opportunity: Opportunity;
  evidence: Evidence;
}

export type BriefStatus = "pending" | "ready" | "failed";

export interface RefreshCandidate {
  id: string;
  workspace_id: string;
  site_page_id: string | null;
  article_id: string | null;
  url: string;
  opportunity: Opportunity;
  evidence: Evidence;
  brief: string | null;
  brief_status: BriefStatus;
  dismissed_at: string | null;
  created_at: string;
}

export type TaskStatus = "scheduled" | "running" | "done" | "failed" | "cancelled";

export interface RefreshTask {
  id: string;
  candidate_id: string;
  workspace_id: string;
  scheduled_for: string;
  status: TaskStatus;
  error: string | null;
  created_at: string;
}

export type HunkKind = "unchanged" | "changed" | "added" | "removed";

export interface Hunk {
  id: string;
  kind: HunkKind;
  before: string | null;
  after: string | null;
}

export type HunkDecision = "accepted" | "rejected";

export interface ExecutionDecisions {
  decisions: Record<string, HunkDecision>;
  edited: Record<string, string>;
  /** Title and meta description are not blocks; they are decided here. */
  fields: { title?: HunkDecision; metaDescription?: HunkDecision };
}

export type ReviewStatus = "awaiting_review" | "pushed" | "rejected";

export interface ExecutionSide {
  html: string;
  title: string | null;
  metaDescription: string | null;
}

export interface ValidationIssue {
  code: string;
  message: string;
  severity: "warn" | "error";
}

export interface RefreshExecution {
  id: string;
  task_id: string;
  workspace_id: string;
  before: ExecutionSide | null;
  after: ExecutionSide | null;
  hunks: Hunk[];
  validation_issues: ValidationIssue[];
  review_status: ReviewStatus;
  decisions: ExecutionDecisions | Record<string, never>;
  pushed_at: string | null;
  published_url: string | null;
  created_at: string;
}
