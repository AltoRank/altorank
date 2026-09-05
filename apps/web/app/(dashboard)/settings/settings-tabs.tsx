"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * One Settings section, one row of tabs.
 *
 * Team and Billing were separate sidebar entries in a group named Account,
 * which put three nav items on screen for one concept. They are settings;
 * they live under Settings.
 *
 * The six tabs before them are the onboarding wizard's screens, made
 * permanent: every answer given during setup has to be changeable later, in
 * the same words, or the wizard is a one-way door. Each is about the
 * workspace the sidebar switcher is on; Team and Billing are about the
 * account. Every one of these is a real link.
 */
const TABS = [
  { label: "General", href: "/settings" },
  { label: "Audience & Competitors", href: "/settings/audience" },
  { label: "Search Console", href: "/settings/search-console" },
  { label: "Articles", href: "/settings/articles" },
  { label: "Keywords", href: "/settings/keywords" },
  { label: "Blog", href: "/settings/blog" },
  { label: "Team", href: "/settings/team" },
  { label: "Billing", href: "/settings/billing" },
  { label: "API keys", href: "/settings/api-keys" },
  { label: "Improvements", href: "/settings/refresh" },
];

export function SettingsTabs() {
  const pathname = usePathname();
  return (
    <div className="px-8 flex items-center border-b border-line bg-bg overflow-x-auto">
      {TABS.map((tab) => {
        const active =
          tab.href === "/settings" ? pathname === "/settings" : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={cn(
              "px-3.5 py-2.5 text-[13px] border-b-2 -mb-px transition-colors whitespace-nowrap",
              active
                ? "text-ink border-b-ink font-medium"
                : "text-ink-3 border-transparent hover:text-ink",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
