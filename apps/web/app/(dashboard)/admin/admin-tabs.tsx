"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * One Operations section, two panes: what the machine costs, and who is using
 * it. Same shape as settings-tabs.tsx, for the same reason: two sidebar
 * entries for one operator concept would be clutter, and every tab here is a
 * real link.
 */
const TABS = [
  { label: "Costs", href: "/admin" },
  { label: "Users", href: "/admin/users" },
];

export function AdminTabs() {
  const pathname = usePathname();
  return (
    <div className="px-8 flex items-center border-b border-line bg-bg">
      {TABS.map((tab) => {
        const active = tab.href === "/admin" ? pathname === "/admin" : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={cn(
              "px-3.5 py-2.5 text-[13px] border-b-2 -mb-px transition-colors",
              active ? "text-ink border-b-ink font-medium" : "text-ink-3 border-transparent hover:text-ink",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
