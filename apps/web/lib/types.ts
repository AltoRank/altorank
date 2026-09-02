import type { AvatarColor } from "./constants";
import type { ScoringCheck } from "@/lib/seo/scoring";
import type { GitConfig } from "./cms/git";
import type { SearchIntent } from "./seo/intent";
import type { ArticleResearch } from "./seo/research";
import type { FactCheckReport } from "./ai/fact-check";

// === Agency ===
export type Agency = {
  id: string;
  name: string;
  slug: string;
  logo_url: string | null;
  report_email: string | null;
  custom_domain: string | null;
  accent_color: string | null;
  remove_branding: boolean;
  api_key: string | null;
  plan: "starter" | "growth" | "scale";
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  created_at: string;
};

export type AgencyMember = {
  id: string;
  agency_id: string;
  user_id: string;
  role: "owner" | "admin" | "editor";
  created_at: string;
};

// === Workspace (Client) ===
export type AIProviderType = "claude" | "openai";

export type Workspace = {
  /** Cron writes drafts for this workspace (opt-in; set by activation and by the signup flow). */
  auto_generate?: boolean;
  auto_generate_weekly_limit?: number | null;
  id: string;
  agency_id: string;
  name: string;
  domain: string;
  initials: string;
  color: AvatarColor;
  plan: string;
  status: "on" | "review" | "paused" | "setup";
  /** Domain rating 0-100. null when nobody has measured it: render as —, never 0. */
  dr: number | null;
  /** Publishing platform observed during analysis. null when undetermined. */
  detected_platform: string | null;
  detected_platform_at: string | null;
  /** Organic sessions/mo, preformatted. null when unmeasured: render —, never 0. */
  traffic: string | null;
  ai_provider: AIProviderType | null;
  ai_model: string | null;
  language: string;
  location_code: number;
  brand_style: Record<string, unknown>;
  created_at: string;
};

// === Article ===
export type ArticleStatus = "draft" | "drafting" | "review" | "approved" | "scheduled" | "live" | "error" | "archived";

export type Article = {
  id: string;
  workspace_id: string;
  title: string;
  slug: string;
  content: Record<string, unknown> | null; // Tiptap JSON
  keyword: string;
  status: ArticleStatus;
  approved_by: string | null;
  approved_at: string | null;
  seo_score: number;
  /** Citation readiness 0-100. null when not scored: render —, never 0. */
  aeo_score: number | null;
  aeo_checks: unknown;
  /** Search volume for the target keyword, captured when the draft was written.
   *  null when nothing supplied one: render —, never 0. */
  volume: number | null;
  position: number | null;
  word_count: number;
  cms: string | null;
  external_id: string | null;
  published_url: string | null;
  meta_description: string | null;
  ai_provider: string | null;
  generation_id: string | null;
  featured_image_url: string | null;
  replaces_article_id: string | null;
  scheduled_at: string | null;
  published_at: string | null;
  /** What the writer was given before drafting. Null for pre-015 articles. */
  research: ArticleResearch | null;
  fact_checks: FactCheckReport | null;
  search_intent: KeywordIntent | null;
  fact_check_verdict: FactCheckReport["verdict"] | null;
  /** Why the autonomous queue picked this keyword, captured at selection time.
   *  Null for manually created articles and anything predating migration 022. */
  selection_reasons: string[] | null;
  /** Composite recommendation score. Only meaningful against the other
   *  candidates in the same run, so the UI has to say so. */
  selection_score: number | null;
  /** NULL means not measured, which is not 0. Render an em dash, never zero. */
  keyword_difficulty: number | null;
  /** Full per-check breakdown from lib/seo/scoring.ts. */
  seo_checks: ScoringCheck[] | null;
  created_at: string;
  updated_at: string;
};

// === Keyword ===
// Aliased rather than redeclared: `SearchIntent` is what the classifier emits
// and what the DB check constraint allows, and two hand-maintained copies of
// the same union drift the moment one gains a member.
export type KeywordIntent = SearchIntent;
export type KeywordStatus = "new" | "planned" | "drafting" | "scheduled" | "shipped" | "error";

export type Keyword = {
  id: string;
  workspace_id: string;
  term: string;
  volume: number;
  /** 0-100, or null when no provider supplied one. Never defaulted to 0. */
  difficulty: number | null;
  intent: KeywordIntent;
  status: KeywordStatus;
  created_at: string;
};

// === Backlink ===
export type BacklinkStatus = "live" | "pending" | "negotiating" | "lost";

export type Backlink = {
  id: string;
  workspace_id: string;
  source_domain: string;
  /** Referring domain rating. null when unmeasured: exclude from averages. */
  source_dr: number | null;
  anchor_text: string;
  target_url: string;
  status: BacklinkStatus;
  discovered_at: string;
  source_url?: string | null;
  is_dofollow?: boolean | null;
  first_seen?: string | null;
  last_seen?: string | null;
};

// === Calendar ===
export type CalendarEntry = {
  id: string;
  workspace_id: string;
  article_id: string | null;
  keyword: string;
  scheduled_date: string;
  status: "done" | "run" | "scheduled" | "queue";
  created_at: string;
};

// === Integration ===
export type IntegrationTag = "CMS" | "Analytics" | "Data" | "Notify" | "Automate";

export type Integration = {
  id: string;
  name: string;
  tag: IntegrationTag;
  description: string;
  icon_key: string;
};

export type WorkspaceIntegration = {
  id: string;
  workspace_id: string;
  integration_id: string;
  config: Record<string, unknown>;
  connected_at: string;
};

// === Voice ===
export type VoiceProfile = {
  id: string;
  workspace_id: string;
  sample_text: string;
  rules: Record<string, unknown>;
  trained: boolean;
  created_at: string;
};

// === Report ===
export type Report = {
  id: string;
  workspace_id: string;
  period: string;
  articles_count: number;
  /** Organic sessions/mo, preformatted. null when unmeasured: render —, never 0. */
  traffic: string | null;
  keywords_count: number;
  status: string;
  url: string | null;
  created_at: string;
};

// === Invoice ===
export type Invoice = {
  id: string;
  agency_id: string;
  number: string;
  period: string;
  articles: number;
  amount: number;
  status: string;
  pdf_url: string | null;
  created_at: string;
};

// === User (from auth.users) ===
export type User = {
  id: string;
  name: string;
  email: string;
  role: "owner" | "admin" | "editor";
  avatar_url: string | null;
};

// === Generation Job ===
export type GenerationJobStatus = "pending" | "running" | "completed" | "failed";

export type GenerationJob = {
  id: string;
  workspace_id: string;
  article_id: string | null;
  status: GenerationJobStatus;
  ai_provider: string;
  prompt_config: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  tokens_used: number;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
};

// === Keyword Ranking (SERP history) ===
export type KeywordRanking = {
  id: string;
  keyword_id: string;
  /** Organic position. null when the domain was not in the results checked. */
  position: number | null;
  url: string | null;
  checked_at: string;
};

// === SEO Audit ===
export type SeoAudit = {
  id: string;
  article_id: string;
  score: number;
  checks: Record<string, unknown>;
  created_at: string;
};

// === CMS Config (discriminated union) ===
export type WordPressConfig = {
  type: "wordpress";
  siteUrl: string;
  username: string;
  applicationPassword: string;
};

export type ShopifyConfig = {
  type: "shopify";
  storeUrl: string;
  accessToken: string;
  blogId?: string;
};

export type MagentoConfig = {
  type: "magento";
  baseUrl: string;
  adminToken: string;
  storeCode?: string;
};

export type WebflowConfig = {
  type: "webflow";
  siteId: string;
  collectionId: string;
  apiToken: string;
};

export type GhostConfig = {
  type: "ghost";
  apiUrl: string;
  adminApiKey: string;
};

export type FramerConfig = {
  type: "framer";
  siteId: string;
  collectionId: string;
  apiToken: string;
};

export type WixConfig = {
  type: "wix";
  accountId: string;
  siteId: string;
  apiKey: string;
};

export type NotionConfig = {
  type: "notion";
  databaseId: string;
  integrationToken: string;
};

export type HubSpotConfig = {
  type: "hubspot";
  accessToken: string;
  blogId?: string;
};

export type WooCommerceConfig = {
  type: "woocommerce";
  siteUrl: string;
  username: string;
  applicationPassword: string;
};

export type WebhookConfig = {
  type: "webhook";
  url: string;
  secret?: string;
  headers?: Record<string, string>;
};

export type CMSConfig =
  | WordPressConfig
  | ShopifyConfig
  | MagentoConfig
  | WebflowConfig
  | GhostConfig
  | FramerConfig
  | WixConfig
  | NotionConfig
  | HubSpotConfig
  | WooCommerceConfig
  | WebhookConfig
  // Static sites built from a repository (Astro, Next, Hugo, Eleventy, Jekyll).
  // No CMS to talk to: the article becomes a committed Markdown file.
  | GitConfig;

// === Publishing Schedule ===
export type PublishingCadence = {
  id: string;
  workspace_id: string;
  timezone: string;
  days_of_week: number[];
  publish_time: string; // HH:MM
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

export type PublishLogEntry = {
  id: string;
  article_id: string;
  workspace_id: string;
  status: "success" | "error";
  error: string | null;
  triggered_by: "cron" | "manual";
  created_at: string;
};

// === Analytics Metric ===
export type AnalyticsMetric = {
  id: string;
  workspace_id: string;
  article_id: string | null;
  /** bing rows are daily site totals: query and page_url are always null. */
  source: "ga4" | "gsc" | "bing";
  metric_date: string;
  pageviews: number;
  sessions: number;
  clicks: number;
  impressions: number;
  ctr: number;
  avg_position: number | null;
  page_url: string | null;
  query: string | null;
  created_at: string;
};

// === Domain Audit ===
export type DomainAudit = {
  id: string;
  workspace_id: string;
  status: "running" | "completed" | "failed";
  pages_crawled: number;
  overall_score: number;
  issues: AuditIssue[];
  pagespeed: Record<string, unknown>;
  competitor_data: Record<string, unknown>;
  started_at: string;
  completed_at: string | null;
};

export type AuditIssue = {
  type: "broken_link" | "missing_meta" | "missing_alt" | "heading_hierarchy" | "slow_page" | "tls_chain" | "fetch_failed";
  severity: "error" | "warning" | "info";
  url: string;
  message: string;
  details?: string;
};

// === Backlink Exchange ===
export type BacklinkExchangeStatus =
  | "requested" | "matched" | "accepted" | "placed"
  | "verified" | "live" | "rejected" | "expired";

export type BacklinkExchange = {
  id: string;
  requester_agency_id: string;
  requester_workspace_id: string;
  target_url: string;
  target_keyword: string | null;
  target_topic: string | null;
  credits_offered: number;
  provider_agency_id: string | null;
  provider_workspace_id: string | null;
  provider_article_id: string | null;
  placement_url: string | null;
  anchor_text: string | null;
  relevance_score: number | null;
  suggested_placement: Record<string, unknown> | null;
  status: BacklinkExchangeStatus;
  matched_at: string | null;
  placed_at: string | null;
  verified_at: string | null;
  expires_at: string | null;
  created_at: string;
};

export type BacklinkCreditReason = "host_link" | "place_link" | "bonus" | "adjustment";

export type BacklinkCredit = {
  id: string;
  agency_id: string;
  amount: number;
  reason: BacklinkCreditReason;
  exchange_id: string | null;
  dr_at_time: number;
  created_at: string;
};

// === Operator audit: who opened whose account (migration 030) ===
export type AdminImpersonation = {
  id: string;
  operator_user_id: string;
  operator_email: string;
  target_user_id: string;
  target_email: string;
  started_at: string;
  ended_at: string | null;
  /** 'stopped' for a normal return; otherwise the error that ended the attempt. */
  end_reason: string | null;
};

// === Invite ===
export type Invite = {
  id: string;
  agency_id: string;
  email: string;
  role: "owner" | "admin" | "editor";
  token: string;
  invited_by: string;
  expires_at: string;
  accepted_at: string | null;
};
