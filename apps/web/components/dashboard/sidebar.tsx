"use client";

import Image from "next/image";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn, plural } from "@/lib/utils";
import { APP_NAME, DASHBOARD_NAV } from "@/lib/constants";
import { Icons } from "@/components/ui/icons";
import { Avatar } from "@/components/ui/avatar";
import { WorkspaceSwitcher } from "@/components/dashboard/workspace-switcher";
import { useOnboarding } from "@/components/onboarding/use-onboarding";
import { signOut } from "@/app/actions/auth";

const iconMap: Record<string, (p?: { size?: number }) => React.ReactNode> = Icons;

type SidebarProps = {
  badges?: Record<string, number>;
  /**
   * Nav ids to leave out, decided from real rows by the layout rather than
   * from a flag in here. A feature reappears on its own the moment it has
   * something to show, so nothing has to be remembered and switched back on.
   */
  hidden?: string[];
  userName?: string;
  userInitials?: string;
  memberCount?: number;
  /** From agency_members. Null hides the line rather than asserting "Owner". */
  role?: string | null;
  /** Metered article usage. Null (unmetered) renders no bar. */
  quota?: { used: number; limit: number; noPlan: boolean } | null;
};

export function Sidebar({ badges, hidden = [], userName = "Account", userInitials = "A", memberCount, role, quota }: SidebarProps) {
  const pathname = usePathname();
  // Null if the provider is ever absent; the button just does not render.
  const onboarding = useOnboarding();

  // Remembered per browser. Wrapped because a private window or blocked site
  // data throws on access rather than returning null, and a sidebar that
  // cannot render is a worse outcome than one that forgets.
  /**
   * Restored after mount, deliberately.
   *
   * A lazy initializer that reads localStorage renders `true` on the client
   * while the server rendered `false`, and React does not treat that as a
   * cosmetic difference: it is a hydration mismatch, and the whole tree stops
   * being interactive. Every button in the app silently did nothing.
   *
   * That was a trade made to satisfy react-hooks/set-state-in-effect. It was
   * the wrong trade - the lint rule is about an avoidable extra render, and the
   * alternative broke the page - so the effect is back, and it only sets state
   * when there is a stored preference that differs from the server's.
   */
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try {
      if (localStorage.getItem("sidebar_collapsed") === "1") setCollapsed(true);
    } catch {
      /* private window or blocked site data: stay expanded */
    }
  }, []);

  function toggleCollapsed() {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("sidebar_collapsed", next ? "1" : "0");
      } catch {
        /* preference simply will not persist */
      }
      return next;
    });
  }

  return (
    <TooltipProvider>
    <aside
      className={cn(
        "bg-panel border-r border-line flex flex-col min-h-0 transition-[width] duration-150",
        collapsed ? "w-[56px]" : "w-[var(--sidebar-w)]",
      )}
    >
      {/* Brand */}
      <div
        className={cn(
          "h-[var(--topbar-h)] flex items-center border-b border-line",
          // Collapsed there is 56px of room. The old header asked for 94: two
          // 26px controls, a gap and px-4 either side, so the mark itself was
          // the thing squeezed out - the one element that should never go.
          collapsed ? "px-0 justify-center" : "px-4 gap-2.5",
        )}
      >
        {collapsed ? (
          // The mark IS the control when collapsed. A separate button has
          // nowhere to sit, and clicking the logo to open a collapsed rail is
          // the behaviour people already expect.
          <Tooltip delayDuration={200}>
            <TooltipTrigger asChild>
              <button
                onClick={toggleCollapsed}
                aria-label="Expand sidebar"
                aria-expanded={false}
                className="w-[26px] h-[26px] rounded-[7px] bg-ink grid place-items-center relative hover:opacity-80"
              >
                <Image
                  src="/brand/altorank-mark-white.svg"
                  alt=""
                  width={15}
                  height={15}
                  priority
                />
                <span className="absolute -right-[3px] -bottom-[3px] w-2 h-2 rounded-full bg-accent border-2 border-panel" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">Expand sidebar</TooltipContent>
          </Tooltip>
        ) : (
          <>
            <div className="w-[26px] h-[26px] rounded-[7px] bg-ink grid place-items-center relative shrink-0">
              {/* The real mark, shipped by scripts/generate-brand.mjs. */}
              <Image
                src="/brand/altorank-mark-white.svg"
                alt=""
                width={15}
                height={15}
                priority
              />
              <span className="absolute -right-[3px] -bottom-[3px] w-2 h-2 rounded-full bg-accent border-2 border-panel" />
            </div>
            <span className="font-semibold tracking-[-0.01em] text-[15px]">{APP_NAME}</span>
            <Tooltip delayDuration={200}>
              <TooltipTrigger asChild>
                <button
                  onClick={toggleCollapsed}
                  aria-label="Collapse sidebar"
                  aria-expanded
                  className="ml-auto w-[26px] h-[26px] rounded-[6px] text-ink-3 grid place-items-center hover:bg-panel-2 hover:text-ink"
                >
                  {/* An arrow pointing at the edge it collapses toward. The
                      caretUpDown that was here reads as "switch", which is what
                      it originally meant on the workspace picker. */}
                  <Icons.arrowLeft size={14} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">Collapse sidebar</TooltipContent>
            </Tooltip>
          </>
        )}
      </div>

      {/* The workspace switcher lived here and is gone deliberately. Its
          selection changed nothing on any page: the one consumer was the
          Google connect button, which now carries its own workspace picker.
          A control whose effect is invisible teaches people the app ignores
          them. */}
      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-2 pt-2 pb-3 scroll">
        <WorkspaceSwitcher collapsed={collapsed} />
        {DASHBOARD_NAV.map((group) => {
          const items = group.items.filter((item) => !hidden.includes(item.id));
          // A group heading with nothing under it is worse than no group.
          if (items.length === 0) return null;
          return (
          <div key={group.group} className="pt-2.5 pb-1 px-1.5">
            {!collapsed && (
              <div className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-4 px-2 pb-1.5">
                {group.group}
              </div>
            )}
            {items.map((item) => {
              const IconFn = iconMap[item.icon];
              const isActive = pathname === item.href || pathname.startsWith(item.href + "/");
              const badgeValue = badges?.[item.id] ?? item.badge;
              const link = (
                <Link
                  key={item.id}
                  href={item.href}
                  aria-label={collapsed ? item.label : undefined}
                  className={cn(
                    "flex items-center gap-2.5 py-[7px] rounded-[6px] text-ink-2 text-[13.5px] w-full relative",
                    collapsed ? "justify-center px-0" : "px-2.5",
                    "hover:bg-panel-2 hover:text-ink [&:hover_.ic-wrap]:text-ink-2",
                    isActive && "bg-accent-soft text-accent-ink font-medium [&_.ic-wrap]:text-accent-ink"
                  )}
                >
                  <span className="ic-wrap text-ink-3 shrink-0">
                    {IconFn ? IconFn({ size: 16 }) : null}
                  </span>
                  {!collapsed && <span>{item.label}</span>}
                  {badgeValue != null && badgeValue > 0 && (
                    <span
                      className={cn(
                        "bg-ink text-bg font-mono font-medium text-center",
                        collapsed
                          // Collapsed there is no room for a count, so it
                          // becomes a dot: still says "something here", without
                          // pretending to be legible at 6px.
                          ? "absolute top-1 right-1 w-1.5 h-1.5 rounded-full"
                          : "ml-auto min-w-[20px] px-1.5 rounded-[10px] text-[10.5px]",
                      )}
                    >
                      {collapsed ? "" : badgeValue}
                    </span>
                  )}
                  {item.tagNew && !collapsed && (
                    <span className="ml-auto px-1.5 py-px bg-accent-soft text-accent-ink rounded font-mono text-[9.5px] font-semibold tracking-[0.04em] uppercase">
                      New
                    </span>
                  )}
                </Link>
              );

              // The label is the only thing that tells these icons apart, so
              // collapsing without a tooltip makes the nav unusable rather than
              // compact. Radix gives hover AND keyboard focus, which `title`
              // never does.
              return collapsed ? (
                <Tooltip key={item.id} delayDuration={200}>
                  <TooltipTrigger asChild>{link}</TooltipTrigger>
                  <TooltipContent side="right">
                    {item.label}
                    {item.tagNew ? " · New" : ""}
                  </TooltipContent>
                </Tooltip>
              ) : (
                link
              );
            })}
          </div>
          );
        })}
      </nav>

      {/* Usage. The pricing page sells an included volume per month; this is
          the running count against it, always one glance away and linking to
          the page where the number can be changed. Hidden when unmetered:
          self-host and operator accounts have no ceiling to draw. */}
      {quota && !collapsed && (
        <Link
          href="/settings/billing"
          className="block border-t border-line px-4 py-2.5 hover:bg-panel-2"
        >
          <div className="flex items-baseline justify-between text-[11px] text-ink-3 mb-1.5">
            {/* Without a plan the meter is the free draft, and the line is a
                button, not a status: "No active plan" told people something
                and asked nothing (the first outside signup left without ever
                seeing a plan). */}
            <span>{quota.noPlan ? "Free draft" : "Articles this month"}</span>
            <span className="font-mono tabular-nums">{`${quota.used} / ${quota.limit}`}</span>
          </div>
          <div className="h-1 rounded-full bg-panel-2 overflow-hidden">
            <div
              className={cn(
                "h-full rounded-full",
                quota.used >= quota.limit ? "bg-err" : "bg-accent",
              )}
              style={{ width: `${Math.min(100, (quota.used / Math.max(1, quota.limit)) * 100)}%` }}
            />
          </div>
          {quota.noPlan && (
            <div className="mt-2 rounded-[6px] bg-accent px-2.5 py-1.5 text-center text-[11.5px] font-medium text-white">
              Choose a plan
            </div>
          )}
        </Link>
      )}

      {/* Footer */}
      <div
        className={cn(
          "border-t border-line py-2.5 text-[12.5px] text-ink-2 flex gap-2.5",
          collapsed ? "px-0 flex-col items-center" : "px-3 items-center",
        )}
      >
        <div className="flex items-center gap-[9px] flex-1 min-w-0">
          <Avatar initials={userInitials} color="av-c5" round />
          {!collapsed && (
            <span className="flex-1 min-w-0">
              <div className="font-medium text-ink truncate">{userName}</div>
              {(role || typeof memberCount === "number") && (
                <div className="text-[11px] text-ink-3">
                  {[
                    role ? role.charAt(0).toUpperCase() + role.slice(1) : null,
                    typeof memberCount === "number" ? plural(memberCount, "member") : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
              )}
            </span>
          )}
        </div>
        <>
            {/* Reopens the setup checklist. Lived in the topbar until the
                topbar went; "Skip setup" is still the only way to hide it, so
                there has to be a way back. */}
            {onboarding && (
              <Tooltip delayDuration={200}>
                <TooltipTrigger asChild>
                  <button
                    onClick={onboarding.openGuide}
                    aria-label="Open the setup guide"
                    className="w-[26px] h-[26px] rounded-[6px] text-ink-3 grid place-items-center hover:bg-panel-2 hover:text-ink"
                  >
                    <Icons.help size={14} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">Setup guide</TooltipContent>
              </Tooltip>
            )}
            {/* Had no onClick at all. It is a settings button beside an account
                name, so it goes to settings. */}
            <Link
              href="/settings"
              aria-label="Settings"
              className="w-[26px] h-[26px] rounded-[6px] text-ink-3 grid place-items-center hover:bg-panel-2 hover:text-ink"
            >
              <Icons.settings size={14} />
            </Link>
            <Tooltip delayDuration={200}>
              <TooltipTrigger asChild>
                <button
                  onClick={() => signOut()}
                  aria-label="Sign out"
                  className="w-[26px] h-[26px] rounded-[6px] text-ink-3 grid place-items-center hover:bg-panel-2 hover:text-ink"
                >
                  <Icons.signOut size={14} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">Sign out</TooltipContent>
            </Tooltip>
        </>
      </div>
    </aside>
    </TooltipProvider>
  );
}
