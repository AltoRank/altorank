"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * Settings in three groups, each a row of tabs: the shape Outrank uses
 * (General Settings > Business / Audience and Competitors / Search Console;
 * Articles Settings > Articles / Keywords / Blog / Improvements), re-assessed
 * 2026-09-05. Ten tabs in one row read as a flat list of unrelated screens;
 * grouped, the first six are visibly the onboarding wizard made permanent
 * (every answer given during setup has to be changeable later, in the same
 * words), and Team / Billing / API keys are visibly about the account rather
 * than the site the sidebar switcher is on.
 *
 * Every one of these is a real link. "Article settings" is also reachable
 * from the Articles group in the sidebar, which is why the sidebar's General
 * settings entry is exact-match only.
 */
export const SETTINGS_GROUPS = [
  {
    id: "general",
    label: "General",
    tabs: [
      { label: "Business", href: "/settings", exact: true },
      { label: "Audience & Competitors", href: "/settings/audience" },
      { label: "Search Console", href: "/settings/search-console" },
    ],
  },
  {
    id: "articles",
    label: "Articles",
    tabs: [
      { label: "Articles", href: "/settings/articles" },
      { label: "Keywords", href: "/settings/keywords" },
      { label: "Blog", href: "/settings/blog" },
      { label: "Improvements", href: "/settings/refresh" },
    ],
  },
  {
    id: "account",
    label: "Account",
    tabs: [
      { label: "Team", href: "/settings/team" },
      { label: "Billing", href: "/settings/billing" },
      { label: "API keys", href: "/settings/api-keys" },
    ],
  },
] as const;

type Tab = { label: string; href: string; exact?: boolean };

function tabActive(pathname: string, tab: Tab): boolean {
  return tab.exact ? pathname === tab.href : pathname.startsWith(tab.href);
}

/** The group whose tab is on screen; General when the path is unknown. */
export function activeSettingsGroup(pathname: string) {
  return SETTINGS_GROUPS.find((g) => g.tabs.some((t) => tabActive(pathname, t))) ?? SETTINGS_GROUPS[0];
}

export function SettingsTabs() {
  const pathname = usePathname();
  const group = activeSettingsGroup(pathname);
  return (
    <div className="border-b border-line bg-bg">
      {/* Row 1: the groups. Each is a link to its first tab, so the row is
          navigation, not a filter. */}
      <div className="px-8 flex items-center gap-1 pt-2" role="tablist" aria-label="Settings sections">
        {SETTINGS_GROUPS.map((g) => {
          const active = g.id === group.id;
          return (
            <Link
              key={g.id}
              href={g.tabs[0].href}
              role="tab"
              aria-selected={active}
              className={cn(
                "px-2.5 py-1 rounded-[6px] text-[12px] font-mono uppercase tracking-[0.06em] transition-colors",
                active ? "bg-panel-2 text-ink" : "text-ink-4 hover:text-ink-2",
              )}
            >
              {g.label}
            </Link>
          );
        })}
      </div>
      {/* Row 2: the tabs of the group on screen. */}
      <div className="px-8 flex items-center overflow-x-auto">
        {group.tabs.map((tab) => {
          const active = tabActive(pathname, tab);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "px-3.5 py-2.5 text-[13px] border-b-2 -mb-px transition-colors whitespace-nowrap",
                active ? "text-ink border-b-ink font-medium" : "text-ink-3 border-transparent hover:text-ink",
              )}
            >
              {tab.label}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
