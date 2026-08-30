export const APP_NAME = "AltoRank";
export const APP_DESCRIPTION =
  "Agency SEO automation. AI-powered content, keyword research, and backlinks — managed across all your clients.";

export const NAV_LINKS = [
  { label: "How it works", href: "/#how-it-works" },
  { label: "Features", href: "/#features" },
  { label: "Tools", href: "/tools" },
  { label: "Pricing", href: "/pricing" },
  { label: "Blog", href: "/blog" },
] as const;

export type NavGroup = {
  group: string;
  items: readonly NavItem[];
};

export type NavItem = {
  id: string;
  label: string;
  href: string;
  icon: string;
  badge?: number;
  tagNew?: boolean;
};

export const DASHBOARD_NAV: NavGroup[] = [
  {
    group: "Overview",
    items: [
      { id: "dashboard", label: "Dashboard", href: "/dashboard", icon: "dashboard" },
      { id: "clients", label: "Clients", href: "/clients", icon: "clients" },
    ],
  },
  {
    group: "Content",
    items: [
      { id: "articles", label: "Articles", href: "/articles", icon: "articles" },
      { id: "calendar", label: "Calendar", href: "/content", icon: "calendar" },
      { id: "keywords", label: "Keywords", href: "/keywords", icon: "keywords" },
      { id: "voice", label: "Brand Voice", href: "/voice", icon: "voice", tagNew: true },
    ],
  },
  {
    group: "Growth",
    items: [
      { id: "backlinks", label: "Backlinks", href: "/backlinks", icon: "backlinks" },
      { id: "audits", label: "Audits", href: "/audits", icon: "search", tagNew: true },
      { id: "readiness", label: "Agent readiness", href: "/readiness", icon: "search", tagNew: true },
      { id: "geo", label: "AI visibility", href: "/geo", icon: "trend", tagNew: true },
      { id: "integrations", label: "Integrations", href: "/connect", icon: "integrations" },
      { id: "reports", label: "Reports", href: "/reports", icon: "reports" },
    ],
  },
  {
    group: "Agency",
    items: [
      { id: "team", label: "Team", href: "/settings/team", icon: "team" },
      { id: "billing", label: "Billing", href: "/settings/billing", icon: "billing" },
      { id: "settings", label: "Settings", href: "/settings", icon: "settings" },
    ],
  },
];

export const STATUS_META: Record<string, { label: string; cls: string }> = {
  live: { label: "Live", cls: "s-ok" },
  review: { label: "In review", cls: "s-warn" },
  drafting: { label: "Drafting", cls: "s-run" },
  scheduled: { label: "Scheduled", cls: "s-idle" },
  error: { label: "Failed", cls: "s-err" },
  draft: { label: "Draft", cls: "s-draft" },
  on: { label: "Publishing", cls: "s-ok" },
  paused: { label: "Paused", cls: "s-draft" },
  setup: { label: "Setup", cls: "s-idle" },
  done: { label: "Published", cls: "s-ok" },
  run: { label: "Drafting", cls: "s-run" },
  queue: { label: "Queued", cls: "s-idle" },
  pending: { label: "Pending", cls: "s-warn" },
  negotiating: { label: "Negotiating", cls: "s-run" },
  lost: { label: "Lost", cls: "s-err" },
  new: { label: "New", cls: "s-idle" },
  planned: { label: "Planned", cls: "s-idle" },
  shipped: { label: "Shipped", cls: "s-ok" },
};

export const AVATAR_COLORS = [
  "av-c1", "av-c2", "av-c3", "av-c4",
  "av-c5", "av-c6", "av-c7", "av-c8",
] as const;

export type AvatarColor = (typeof AVATAR_COLORS)[number];
