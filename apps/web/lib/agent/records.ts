// ---------------------------------------------------------------------------
// What an agent sees of a record
// ---------------------------------------------------------------------------
//
// The dashboard rows carry columns an agent has no use for (Tiptap JSON,
// research payloads, selection scores) and lack the two things it does need:
// a link to hand a human, and a statement of what it may do next. These
// projections add `editor_url` and `allowed_mutations` and leave the heavy
// columns to their own endpoints.
//
// Nulls stay null. A missing measurement is "—" to a person and null to a
// machine; it is never 0 in either place.

import type { Article, Keyword, Workspace } from "@/lib/types";
import { articleMutations, keywordMutations, type AllowedMutations, type ArticleMutationContext } from "./mutations";
import { valueLabel, type HumanPresentation } from "./envelope";

export const STATUS_LABELS: Record<Article["status"], string> = {
  draft: "Draft",
  drafting: "Being written",
  review: "Awaiting review",
  approved: "Approved",
  scheduled: "Scheduled",
  live: "Published",
  error: "Generation failed",
  archived: "Archived",
};

export const WORKSPACE_STATUS_LABELS: Record<Workspace["status"], string> = {
  on: "Active",
  review: "In review",
  paused: "Paused",
  setup: "Setting up",
};

export type AgentArticle = {
  id: string;
  workspace_id: string;
  title: string;
  slug: string;
  keyword: string | null;
  status: Article["status"];
  status_label: string;
  seo_score: number | null;
  aeo_score: number | null;
  volume: number | null;
  keyword_difficulty: number | null;
  word_count: number | null;
  fact_check_verdict: string | null;
  published_url: string | null;
  scheduled_at: string | null;
  published_at: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
  /** Where a human reviews, edits, approves and publishes this article. */
  editor_url: string;
  allowed_mutations: AllowedMutations;
};

export function toAgentArticle(a: Article, baseUrl: string, context: ArticleMutationContext = {}): AgentArticle {
  return {
    id: a.id,
    workspace_id: a.workspace_id,
    title: a.title,
    slug: a.slug,
    keyword: a.keyword ?? null,
    status: a.status,
    status_label: STATUS_LABELS[a.status] ?? a.status,
    // seo_score defaults to 0 in the schema, which for an unwritten draft
    // means "not scored". Nothing scores 0 once it is written.
    seo_score: a.status === "draft" || a.status === "drafting" ? null : a.seo_score,
    aeo_score: a.aeo_score ?? null,
    volume: a.volume ?? null,
    keyword_difficulty: a.keyword_difficulty ?? null,
    word_count: a.word_count > 0 ? a.word_count : null,
    fact_check_verdict: a.fact_check_verdict ?? null,
    published_url: a.published_url ?? null,
    scheduled_at: a.scheduled_at ?? null,
    published_at: a.published_at ?? null,
    approved_at: a.approved_at ?? null,
    created_at: a.created_at,
    updated_at: a.updated_at,
    editor_url: `${baseUrl}/content/${a.id}`,
    allowed_mutations: articleMutations(a, context),
  };
}

export type AgentKeyword = {
  id: string;
  workspace_id: string;
  term: string;
  volume: number | null;
  difficulty: number | null;
  intent: Keyword["intent"];
  status: Keyword["status"];
  /** The day its article is planned for, when it is on the plan and unwritten. */
  planned_for: string | null;
  created_at: string;
  allowed_mutations: AllowedMutations;
};

export function toAgentKeyword(k: Keyword, plannedFor: string | null = null): AgentKeyword {
  return {
    id: k.id,
    workspace_id: k.workspace_id,
    term: k.term,
    volume: k.volume ?? null,
    difficulty: k.difficulty ?? null,
    intent: k.intent,
    status: k.status,
    planned_for: plannedFor,
    created_at: k.created_at,
    allowed_mutations: keywordMutations(k),
  };
}

export type AgentWorkspace = {
  id: string;
  name: string;
  domain: string | null;
  status: Workspace["status"];
  status_label: string;
  language: string;
  location_code: number | null;
  ai_provider: string | null;
  auto_generate: boolean;
  detected_platform: string | null;
  domain_rating: number | null;
  created_at: string;
  dashboard_url: string;
};

export function toAgentWorkspace(w: Workspace, baseUrl: string): AgentWorkspace {
  return {
    id: w.id,
    name: w.name,
    domain: w.domain || null,
    status: w.status,
    status_label: WORKSPACE_STATUS_LABELS[w.status] ?? w.status,
    language: w.language ?? "en",
    location_code: w.location_code ?? null,
    ai_provider: w.ai_provider ?? null,
    auto_generate: Boolean(w.auto_generate),
    detected_platform: w.detected_platform ?? null,
    domain_rating: w.dr ?? null,
    created_at: w.created_at,
    dashboard_url: `${baseUrl}/workspaces/${w.id}`,
  };
}

/** The workspace as a settings sheet a person can read. */
export function workspaceHuman(
  w: AgentWorkspace,
  integrations: { id: string; name: string; connected: boolean }[],
): HumanPresentation {
  return {
    title: w.name,
    summary_instructions:
      "Describe this site's setup in one short paragraph: what it is, whether AltoRank " +
      "may write drafts on its own, and which integrations are connected. Mention " +
      "anything unmeasured as unknown, not zero.",
    sections: [
      {
        label: "Site",
        items: [
          { field: "domain", label: "Domain", value_label: valueLabel(w.domain) },
          {
            field: "status",
            label: "Status",
            value_label: w.status_label,
            available_options: (Object.keys(WORKSPACE_STATUS_LABELS) as Workspace["status"][]).map((s) => ({
              label: WORKSPACE_STATUS_LABELS[s],
              selected: s === w.status,
            })),
          },
          { field: "detected_platform", label: "Platform", value_label: valueLabel(w.detected_platform) },
          {
            field: "domain_rating",
            label: "Domain rating",
            value_label: valueLabel(w.domain_rating),
            description: "0-100 authority estimate. Unknown until measured.",
          },
        ],
      },
      {
        label: "Writing",
        items: [
          { field: "language", label: "Content language", value_label: w.language },
          { field: "ai_provider", label: "Model provider", value_label: valueLabel(w.ai_provider) },
          {
            field: "auto_generate",
            label: "Scheduled drafts",
            value_label: w.auto_generate ? "On" : "Off",
            description: "Whether AltoRank writes drafts into the review queue on a schedule.",
          },
        ],
      },
      {
        label: "Integrations",
        items: integrations.map((i) => ({
          field: `integration.${i.id}`,
          label: i.name,
          value_label: i.connected ? "Connected" : "Not connected",
        })),
      },
    ],
  };
}
