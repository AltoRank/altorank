"use client";

import { usePathname } from "next/navigation";
import { Icons } from "@/components/ui/icons";
import { SearchInput } from "@/components/ui/search-input";
import { Button, IconButton } from "@/components/ui/button";

function getBreadcrumbs(pathname: string): string[] {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return ["Dashboard"];
  return segments.map((s) => s.charAt(0).toUpperCase() + s.slice(1).replace(/-/g, " "));
}

export function Topbar() {
  const pathname = usePathname();
  const crumbs = getBreadcrumbs(pathname);

  return (
    <div className="h-[var(--topbar-h)] px-6 border-b border-line flex items-center gap-3.5">
      {/* Breadcrumbs */}
      <div className="flex items-center gap-1.5 text-[13px] text-ink-3">
        {crumbs.map((c, i) => (
          <span key={i} className="flex items-center gap-1.5">
            {i > 0 && <span className="text-ink-4">/</span>}
            <span className={i === crumbs.length - 1 ? "text-ink font-medium" : ""}>{c}</span>
          </span>
        ))}
      </div>

      {/* Search */}
      <div className="flex-1 max-w-[360px] ml-5">
        <SearchInput placeholder="Search articles, keywords, clients…" shortcut="⌘K" />
      </div>

      {/* Actions */}
      <div className="ml-auto flex items-center gap-1.5">
        <IconButton ghost title="Help">
          <Icons.help size={14} />
        </IconButton>
        <IconButton ghost title="Notifications">
          <Icons.bell size={14} />
        </IconButton>
        <Button variant="accent" size="sm">
          <Icons.sparkle size={13} />
          Queue content
        </Button>
      </div>
    </div>
  );
}
