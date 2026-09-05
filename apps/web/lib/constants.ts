export const APP_NAME = "AltoRank";
export const APP_DESCRIPTION =
  "SEO and AI-search content that nothing publishes without you. Keyword research, drafting, and review, a workspace per site or per client.";

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
  /** Built but not ready to be relied on: shown, labelled, not clickable. */
  soon?: boolean;
};

export const DASHBOARD_NAV: NavGroup[] = [
  {
    group: "Overview",
    items: [
      { id: "dashboard", label: "Dashboard", href: "/dashboard", icon: "dashboard" },
    ],
  },
  {
    group: "Content",
    items: [
      // Review is the first thing that wants attention, so it is a state of
      // Articles rather than a section beside it (2026-09-02).
      { id: "articles", label: "Articles", href: "/articles", icon: "articles" },
      { id: "calendar", label: "Calendar", href: "/content", icon: "calendar" },
      // Rewrites of pages that already rank, each waiting for a yes.
      { id: "improvements", label: "Improvements", href: "/improvements", icon: "refresh" },
      { id: "keywords", label: "Keywords", href: "/keywords", icon: "keywords" },
      { id: "voice", label: "Brand Voice", href: "/voice", icon: "voice" },
      { id: "linking", label: "Linking", href: "/linking", icon: "link" },
      // Under "Agency" until 2026-08-30, which is exactly backwards:
      // connecting a CMS is onboarding step 4 for a solo founder, the least
      // agency-specific job in the product.
      { id: "integrations", label: "Integrations", href: "/connect", icon: "integrations" },
    ],
  },
  {
    group: "Growth",
    items: [
      { id: "backlinks", label: "Backlinks", href: "/backlinks", icon: "backlinks" },
      { id: "audits", label: "Site audits", href: "/audits", icon: "search" },
      { id: "readiness", label: "Agent readiness", href: "/readiness", icon: "sparkle" },
      { id: "geo", label: "AI visibility", href: "/geo", icon: "trend", soon: true },
      { id: "reports", label: "Reports", href: "/reports", icon: "reports", soon: true },
    ],
  },
  // Named "Agency" until 2026-08-30. Billing and Settings are account chrome
  // that every tier needs, and the label made ordinary controls read as
  // features of the top rung - the exact question it prompted was "is the
  // agency section displayed to everyone?". Team is genuinely multi-seat, but
  // one mislabel does not earn a group of its own.
  // Team and Billing are panes inside Settings now (settings-tabs.tsx), not
  // nav entries: three sidebar items for one concept was the clutter, and
  // "Account" as a group name never described anything the group did.
  {
    group: "Account",
    items: [
      // The roster is account management, not a daily section: the sidebar
      // switcher is where a workspace is chosen (2026-09-02).
      { id: "workspaces", label: "Your sites", href: "/workspaces", icon: "clients" },
      { id: "settings", label: "Settings", href: "/settings", icon: "settings" },
    ],
  },
  // Its own group, so an operator can see at a glance that this is staff
  // tooling and not something a customer is looking at. The whole group
  // disappears for everyone else, and /admin 404s rather than trusting the
  // nav to hide it (2026-09-02).
  {
    group: "Admin only",
    items: [{ id: "admin", label: "Operations", href: "/admin", icon: "trend" }],
  },
];

export const STATUS_META: Record<string, { label: string; cls: string }> = {
  live: { label: "Live", cls: "s-ok" },
  review: { label: "In review", cls: "s-warn" },
  // Signed off, not yet sent. Both are article states the database allows
  // (migration 013) that had no label, so the pill printed the raw value.
  approved: { label: "Approved", cls: "s-ok" },
  archived: { label: "Archived", cls: "s-idle" },
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
  stored: { label: "Stored", cls: "s-draft" },
  planned: { label: "Planned", cls: "s-idle" },
  shipped: { label: "Shipped", cls: "s-ok" },
};

export const AVATAR_COLORS = [
  "av-c1", "av-c2", "av-c3", "av-c4",
  "av-c5", "av-c6", "av-c7", "av-c8",
] as const;

export type AvatarColor = (typeof AVATAR_COLORS)[number];

// Mirrors OSS_REPO_PUBLIC / OSS_REPO_URL in apps/marketing/src/constants.ts,
// which is the source of truth and carries the history. Flipped true
// 2026-08-30 when github.com/AltoRank/altorank went public. Change both.
export const OSS_REPO_PUBLIC = true;
export const OSS_REPO_URL = "https://github.com/AltoRank/altorank";
export const MARKETING_URL = "https://altorank.co";
