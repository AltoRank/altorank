"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * One Settings section, three panes.
 *
 * Team and Billing were separate sidebar entries in a group named Account,
 * which put three nav items on screen for one concept and begged the question
 * of what the settings icon at the very bottom was for. They are settings;
 * they live under Settings. Unlike the tab bar this replaces on the old
 * Articles page, every one of these is a real link.
 */
const TABS = [
  { label: "General", href: "/settings" },
  { label: "Team", href: "/settings/team" },
  { label: "Billing", href: "/settings/billing" },
  { label: "API keys", href: "/settings/api-keys" },
];

export function SettingsTabs() {
  const pathname = usePathname();
  return (
    <div className="px-8 flex items-center border-b border-line bg-bg">
      {TABS.map((tab) => {
        const active =
          tab.href === "/settings" ? pathname === "/settings" : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={cn(
              "px-3.5 py-2.5 text-[13px] border-b-2 -mb-px transition-colors",
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
