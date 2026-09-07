"use client";

import { usePathname } from "next/navigation";
import { PageHead } from "@/components/ui";
import { SubtitleSkeleton } from "@/components/ui/skeleton";

/**
 * The title of the Settings tab being loaded, from the pathname.
 *
 * `settings/loading.tsx` is the nearest Suspense boundary for all eleven
 * Settings routes, and it hardcoded `title="Settings"` - so nine of them
 * introduced themselves by the wrong name and then swapped it: "Settings"
 * became "Billing", "Team", "Search Console". The rule the primitives were
 * written to (`components/ui/skeleton.tsx`) is that text known before the data
 * is text rather than a bar, and a tab's title is known from its URL, which is
 * exactly how `SettingsTabs` next door already picks the active tab.
 *
 * Longest match wins, so `/settings/api-keys/agent-api` is not answered by
 * `/settings/api-keys`.
 */
const TITLES: ReadonlyArray<readonly [string, string]> = [
  ["/settings/api-keys/agent-api", "Agent API"],
  ["/settings/api-keys", "API keys"],
  ["/settings/audience", "Audience & Competitors"],
  ["/settings/search-console", "Search Console"],
  ["/settings/articles", "Articles"],
  ["/settings/keywords", "Keywords"],
  ["/settings/blog", "Blog"],
  ["/settings/team", "Team"],
  ["/settings/billing", "Billing"],
  // `/settings/refresh` and `/settings` both title themselves "Settings",
  // which is the fallback below.
];

export function settingsLoadingTitle(pathname: string): string {
  for (const [href, title] of TITLES) if (pathname.startsWith(href)) return title;
  return "Settings";
}

export function SettingsLoadingHead() {
  return <PageHead title={settingsLoadingTitle(usePathname() ?? "")} subtitle={<SubtitleSkeleton width="w-72" />} />;
}
