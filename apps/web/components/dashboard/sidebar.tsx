"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { APP_NAME, DASHBOARD_NAV } from "@/lib/constants";
import { Icons } from "@/components/ui/icons";
import { Avatar } from "@/components/ui/avatar";
import { useWorkspace } from "@/components/dashboard/workspace-context";

const iconMap: Record<string, (p?: { size?: number }) => React.ReactNode> = Icons;

type SidebarProps = {
  badges?: Record<string, number>;
  userName?: string;
  userInitials?: string;
  memberCount?: number;
};

export function Sidebar({ badges, userName = "User", userInitials = "U", memberCount = 1 }: SidebarProps) {
  const pathname = usePathname();
  const { workspaces, active: ws, setActiveId } = useWorkspace();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const switcherRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!switcherOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (switcherRef.current && !switcherRef.current.contains(e.target as Node)) {
        setSwitcherOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [switcherOpen]);

  return (
    <aside className="w-[var(--sidebar-w)] bg-panel border-r border-line flex flex-col min-h-0">
      {/* Brand */}
      <div className="h-[var(--topbar-h)] px-4 flex items-center gap-2.5 border-b border-line">
        <div className="w-[26px] h-[26px] rounded-[7px] bg-ink text-bg grid place-items-center font-mono font-medium text-[13px] relative">
          AR
          <span className="absolute -right-[3px] -bottom-[3px] w-2 h-2 rounded-full bg-accent border-2 border-panel" />
        </div>
        <span className="font-semibold tracking-[-0.01em] text-[15px]">{APP_NAME}</span>
        <button className="ml-auto w-[26px] h-[26px] rounded-[6px] text-ink-3 grid place-items-center hover:bg-panel-2 hover:text-ink">
          <Icons.caretUpDown size={14} />
        </button>
      </div>

      {/* Workspace switcher */}
      {ws && (
        <div className="px-3 pt-2.5 pb-3 border-b border-line relative" ref={switcherRef}>
          <button
            onClick={() => setSwitcherOpen((o) => !o)}
            className="w-full flex items-center gap-[9px] px-[9px] py-[7px] bg-bg border border-line rounded-[7px] text-[13px] text-left hover:bg-panel-2"
          >
            <Avatar initials={ws.initials} color={ws.color} />
            <span className="flex-1 min-w-0">
              <div className="font-medium text-ink truncate">{ws.name}</div>
              <div className="text-[11px] text-ink-3">{ws.domain}</div>
            </span>
            <span className={cn("text-ink-3 shrink-0 transition-transform", switcherOpen && "rotate-180")}>
              <Icons.caretUpDown size={14} />
            </span>
          </button>

          {switcherOpen && workspaces.length > 1 && (
            <div className="absolute left-3 right-3 top-full mt-1 z-50 bg-bg border border-line rounded-[8px] shadow-lg overflow-hidden">
              {workspaces.map((w) => (
                <button
                  key={w.id}
                  onClick={() => {
                    setActiveId(w.id);
                    setSwitcherOpen(false);
                  }}
                  className={cn(
                    "w-full flex items-center gap-[9px] px-[9px] py-[7px] text-[13px] text-left hover:bg-panel-2",
                    w.id === ws.id && "bg-accent-soft"
                  )}
                >
                  <Avatar initials={w.initials} color={w.color} />
                  <span className="flex-1 min-w-0">
                    <div className="font-medium text-ink truncate">{w.name}</div>
                    <div className="text-[11px] text-ink-3">{w.domain}</div>
                  </span>
                  {w.id === ws.id && (
                    <span className="text-accent-ink shrink-0">
                      <Icons.check size={14} />
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-2 pt-2 pb-3 scroll">
        {DASHBOARD_NAV.map((group) => (
          <div key={group.group} className="pt-2.5 pb-1 px-1.5">
            <div className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-4 px-2 pb-1.5">
              {group.group}
            </div>
            {group.items.map((item) => {
              const IconFn = iconMap[item.icon];
              const isActive = pathname === item.href || pathname.startsWith(item.href + "/");
              const badgeValue = badges?.[item.id] ?? item.badge;
              return (
                <Link
                  key={item.id}
                  href={item.href}
                  className={cn(
                    "flex items-center gap-2.5 px-2.5 py-[7px] rounded-[6px] text-ink-2 text-[13.5px] w-full relative",
                    "hover:bg-panel-2 hover:text-ink [&:hover_.ic-wrap]:text-ink-2",
                    isActive && "bg-accent-soft text-accent-ink font-medium [&_.ic-wrap]:text-accent-ink"
                  )}
                >
                  <span className="ic-wrap text-ink-3 shrink-0">
                    {IconFn ? IconFn({ size: 16 }) : null}
                  </span>
                  <span>{item.label}</span>
                  {badgeValue != null && badgeValue > 0 && (
                    <span className="ml-auto min-w-[20px] px-1.5 bg-ink text-bg rounded-[10px] font-mono text-[10.5px] font-medium text-center">
                      {badgeValue}
                    </span>
                  )}
                  {item.tagNew && (
                    <span className="ml-auto px-1.5 py-px bg-accent-soft text-accent-ink rounded font-mono text-[9.5px] font-semibold tracking-[0.04em] uppercase">
                      New
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div className="border-t border-line px-3 py-2.5 flex items-center gap-2.5 text-[12.5px] text-ink-2">
        <div className="flex items-center gap-[9px] flex-1 min-w-0">
          <Avatar initials={userInitials} color="av-c5" round />
          <span className="flex-1 min-w-0">
            <div className="font-medium text-ink truncate">{userName}</div>
            <div className="text-[11px] text-ink-3">Owner · {memberCount} members</div>
          </span>
        </div>
        <button className="w-[26px] h-[26px] rounded-[6px] border-transparent bg-transparent text-ink-3 grid place-items-center hover:bg-panel-2 hover:text-ink">
          <Icons.settings size={14} />
        </button>
      </div>
    </aside>
  );
}
