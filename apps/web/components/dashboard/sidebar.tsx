"use client";

import Image from "next/image";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn, plural } from "@/lib/utils";
import { APP_NAME, DASHBOARD_NAV, type NavItem } from "@/lib/constants";
import { Icons } from "@/components/ui/icons";
import { AccountMenu } from "@/components/dashboard/account-menu";
import { WorkspaceSwitcher } from "@/components/dashboard/workspace-switcher";
import { ThemeToggle } from "@/components/dashboard/theme-toggle";
import { useOnboarding } from "@/components/onboarding/use-onboarding";
import type { SiteAllowance } from "@/lib/workspaces/slots";

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
  /** How many sites the plan allows, for the switcher's Add row. Null renders a dash. */
  siteAllowance?: SiteAllowance;
};

export function Sidebar({ badges, hidden = [], userName = "Account", userInitials = "A", memberCount, role, quota, siteAllowance = null }: SidebarProps) {
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
  const [collapsedPref, setCollapsedPref] = useState(false);
  useEffect(() => {
    try {
      if (localStorage.getItem("sidebar_collapsed") === "1") setCollapsedPref(true);
    } catch {
      /* private window or blocked site data: stay expanded */
    }
  }, []);

  // Below `md` the sidebar is a slide-over opened from the top bar. A drawer
  // is never a rail: the collapsed preference is a desktop preference and
  // stays put for when the window is wide again.
  const [mobileOpen, setMobileOpen] = useState(false);
  const collapsed = collapsedPref && !mobileOpen;
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileOpen(false);
    };
    // Crossing back to the desktop layout with the drawer open would leave a
    // static sidebar rendered in its drawer state.
    const mq = window.matchMedia("(min-width: 768px)");
    const onChange = () => {
      if (mq.matches) setMobileOpen(false);
    };
    document.addEventListener("keydown", onKey);
    mq.addEventListener("change", onChange);
    return () => {
      document.removeEventListener("keydown", onKey);
      mq.removeEventListener("change", onChange);
    };
  }, [mobileOpen]);

  // Sub-item groups are open by default; only what a person closed is
  // remembered, so a new group ships expanded. Restored after mount for the
  // same hydration reason as `collapsed`.
  const [closedGroups, setClosedGroups] = useState<string[]>([]);
  useEffect(() => {
    try {
      const raw = localStorage.getItem("sidebar_closed_groups");
      if (raw) setClosedGroups(JSON.parse(raw));
    } catch {
      /* stay open */
    }
  }, []);
  function toggleGroup(id: string) {
    setClosedGroups((prev) => {
      const next = prev.includes(id) ? prev.filter((g) => g !== id) : [...prev, id];
      try {
        localStorage.setItem("sidebar_closed_groups", JSON.stringify(next));
      } catch {
        /* preference simply will not persist */
      }
      return next;
    });
  }

  function toggleCollapsed() {
    setCollapsedPref((prev) => {
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
    {/* Mobile top bar: the site switcher and the way into the drawer. Gone
        from md up, where the sidebar itself carries both. */}
    <div className="md:hidden h-[var(--topbar-h)] shrink-0 flex items-center gap-2 border-b border-line bg-panel px-3">
      <button
        type="button"
        onClick={() => setMobileOpen(true)}
        aria-label="Open menu"
        aria-expanded={mobileOpen}
        aria-controls="dashboard-sidebar"
        className="w-[34px] h-[34px] -ml-1 rounded-[6px] text-ink-2 grid place-items-center hover:bg-panel-2 hover:text-ink"
      >
        <Icons.menu size={18} />
      </button>
      <div className="w-[26px] h-[26px] rounded-[7px] bg-mark grid place-items-center relative shrink-0">
        <Image src="/brand/altorank-mark-white.svg" alt="" width={15} height={15} priority />
        <span className="absolute -right-[3px] -bottom-[3px] w-2 h-2 rounded-full bg-accent border-2 border-panel" />
      </div>
      <div className="flex-1 min-w-0">
        <WorkspaceSwitcher inline allowance={siteAllowance} />
      </div>
    </div>
    {mobileOpen && (
      <div className="md:hidden fixed inset-0 z-[200] bg-black/30" onClick={() => setMobileOpen(false)} />
    )}
    <aside
      id="dashboard-sidebar"
      className={cn(
        "bg-panel border-r border-line flex flex-col min-h-0 duration-150",
        // Slide-over below md; the static column from md up.
        "fixed inset-y-0 left-0 z-[201] w-[var(--sidebar-w)] transition-transform md:static md:translate-x-0 md:transition-[width]",
        mobileOpen ? "translate-x-0" : "-translate-x-full",
        collapsed ? "md:w-[56px]" : "md:w-[var(--sidebar-w)]",
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
                className="w-[26px] h-[26px] rounded-[7px] bg-mark grid place-items-center relative hover:opacity-80"
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
            <div className="w-[26px] h-[26px] rounded-[7px] bg-mark grid place-items-center relative shrink-0">
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
                  className="ml-auto w-[26px] h-[26px] rounded-[6px] text-ink-3 hidden md:grid place-items-center hover:bg-panel-2 hover:text-ink"
                >
                  {/* An arrow pointing at the edge it collapses toward. The
                      caretUpDown that was here reads as "switch", which is what
                      it originally meant on the workspace picker. */}
                  <Icons.arrowLeft size={14} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">Collapse sidebar</TooltipContent>
            </Tooltip>
            <button
              type="button"
              onClick={() => setMobileOpen(false)}
              aria-label="Close menu"
              className="ml-auto w-[26px] h-[26px] rounded-[6px] text-ink-3 grid md:hidden place-items-center hover:bg-panel-2 hover:text-ink"
            >
              <Icons.x size={14} />
            </button>
          </>
        )}
      </div>

      {/* The workspace switcher lived here and is gone deliberately. Its
          selection changed nothing on any page: the one consumer was the
          Google connect button, which now carries its own workspace picker.
          A control whose effect is invisible teaches people the app ignores
          them. */}
      {/* Navigation */}
      <nav
        className="flex-1 overflow-y-auto px-2 pt-2 pb-3 scroll"
        // Any link in the drawer is a navigation, and the drawer has no reason
        // to outlive one.
        onClick={(e) => {
          if (mobileOpen && (e.target as HTMLElement).closest("a")) setMobileOpen(false);
        }}
      >
        <div className="hidden md:block">
          <WorkspaceSwitcher collapsed={collapsed} allowance={siteAllowance} />
        </div>
        {DASHBOARD_NAV.map((group) => {
          const items = group.items
            .map((item) => (item.children ? { ...item, children: item.children.filter((c) => !hidden.includes(c.id)) } : item))
            .filter((item) => !hidden.includes(item.id) && !(item.children && item.children.length === 0));
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
              if (item.children) {
                const childActive = item.children.some((c) => isActivePath(pathname, c));
                // Collapsed there is no room for a tree: the children become
                // the rail, so every page stays one click away and the
                // parent's icon does not pretend to be a page.
                if (collapsed) {
                  return item.children.map((child) => (
                    <NavLeaf key={child.id} item={child} pathname={pathname} collapsed badge={badges?.[child.id] ?? child.badge} />
                  ));
                }
                const open = childActive || !closedGroups.includes(item.id);
                const IconFn = iconMap[item.icon];
                const childBadge = item.children.reduce((n, c) => n + (badges?.[c.id] ?? c.badge ?? 0), 0);
                return (
                  <div key={item.id}>
                    <button
                      type="button"
                      onClick={() => toggleGroup(item.id)}
                      aria-expanded={open}
                      aria-controls={`nav-${item.id}`}
                      className={cn(
                        "flex w-full items-center gap-2.5 rounded-[6px] px-2.5 py-[7px] text-[13.5px] text-ink-2",
                        "hover:bg-panel-2 hover:text-ink [&:hover_.ic-wrap]:text-ink-2",
                        childActive && !open && "text-ink font-medium",
                      )}
                    >
                      <span className="ic-wrap text-ink-3 shrink-0">{IconFn ? IconFn({ size: 16 }) : null}</span>
                      <span className="flex-1 text-left">{item.label}</span>
                      {!open && childBadge > 0 && (
                        <span className="bg-ink text-bg font-mono font-medium text-center min-w-[20px] px-1.5 rounded-[10px] text-[10.5px]">
                          {childBadge}
                        </span>
                      )}
                      <span className={cn("text-ink-4 transition-transform", open ? "rotate-0" : "-rotate-90")}>
                        <Icons.caretDown size={12} />
                      </span>
                    </button>
                    {open && (
                      <div id={`nav-${item.id}`} className="ml-[13px] border-l border-line pl-2 mt-0.5 mb-1">
                        {item.children.map((child) => (
                          <NavLeaf key={child.id} item={child} pathname={pathname} collapsed={false} badge={badges?.[child.id] ?? child.badge} nested />
                        ))}
                      </div>
                    )}
                  </div>
                );
              }
              return <NavLeaf key={item.id} item={item} pathname={pathname} collapsed={collapsed} badge={badges?.[item.id] ?? item.badge} />;
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
            {/* Without a plan the meter is the month's free drafts, and the
                line is a button, not a status: "No active plan" told people
                something and asked nothing (the first outside signup left
                without ever seeing a plan). Pluralised off the limit, which
                went 1 -> 7 on 2026-09-06 and left this reading "Free draft"
                above "0 / 7". */}
            <span>{quota.noPlan ? plural(quota.limit, "free draft") : "Articles this month"}</span>
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

      {/* Footer: the account block opens upward into the account menu, which
          took over the guide, settings and sign-out icon buttons that used to
          sit unlabelled beside the name. */}
      <div
        className={cn(
          "border-t border-line py-2 flex items-center",
          collapsed ? "flex-col gap-1" : "pr-2",
        )}
      >
        <div className="flex-1 min-w-0">
          <AccountMenu
            userName={userName}
            userInitials={userInitials}
            subtitle={
              [
                role ? role.charAt(0).toUpperCase() + role.slice(1) : null,
                typeof memberCount === "number" ? plural(memberCount, "member") : null,
              ]
                .filter(Boolean)
                .join(" · ") || null
            }
            collapsed={collapsed}
            openGuide={onboarding?.openGuide}
          />
        </div>
        {/* Light or dark. Persisted per browser; the root layout's inline
            script applies it before paint (lib/theme.ts). */}
        <ThemeToggle />
      </div>
    </aside>
    </TooltipProvider>
  );
}

function isActivePath(pathname: string, item: NavItem): boolean {
  if (item.exact) return pathname === item.href;
  return pathname === item.href || pathname.startsWith(item.href + "/");
}

/**
 * One nav row. Shared by top-level items and the children of an expandable
 * group so the two cannot drift in look or behaviour.
 */
function NavLeaf({
  item,
  pathname,
  collapsed,
  badge,
  nested = false,
}: {
  item: NavItem;
  pathname: string;
  collapsed: boolean;
  badge?: number;
  nested?: boolean;
}) {
  const IconFn = iconMap[item.icon];
  const isActive = isActivePath(pathname, item);

  // Listed so the shape of the product is visible, not clickable because it
  // does not work yet (2026-09-02).
  if (item.soon) {
    return (
      <div
        title="Being built. Listed so you know it is coming, not because it works yet."
        className="flex cursor-not-allowed items-center gap-2.5 rounded-[7px] px-2.5 py-[7px] text-[13px] text-ink-4"
      >
        <span className="ic-wrap shrink-0 text-ink-4">{IconFn ? IconFn({ size: 16 }) : null}</span>
        {!collapsed && (
          <>
            <span className="flex-1">{item.label}</span>
            <span className="font-mono text-[9.5px] uppercase tracking-[0.08em] text-ink-4">soon</span>
          </>
        )}
      </div>
    );
  }

  const link = (
    <Link
      href={item.href}
      aria-label={collapsed ? item.label : undefined}
      aria-current={isActive ? "page" : undefined}
      className={cn(
        "flex items-center gap-2.5 rounded-[6px] text-ink-2 w-full relative",
        nested ? "py-[5px] text-[13px]" : "py-[7px] text-[13.5px]",
        collapsed ? "justify-center px-0" : "px-2.5",
        "hover:bg-panel-2 hover:text-ink [&:hover_.ic-wrap]:text-ink-2",
        isActive && "bg-accent-soft text-accent-ink font-medium [&_.ic-wrap]:text-accent-ink",
      )}
    >
      <span className="ic-wrap text-ink-3 shrink-0">{IconFn ? IconFn({ size: nested ? 14 : 16 }) : null}</span>
      {!collapsed && <span>{item.label}</span>}
      {badge != null && badge > 0 && (
        <span
          className={cn(
            "bg-ink text-bg font-mono font-medium text-center",
            collapsed
              // Collapsed there is no room for a count, so it becomes a dot:
              // still says "something here", without pretending to be legible
              // at 6px.
              ? "absolute top-1 right-1 w-1.5 h-1.5 rounded-full"
              : "ml-auto min-w-[20px] px-1.5 rounded-[10px] text-[10.5px]",
          )}
        >
          {collapsed ? "" : badge}
        </span>
      )}
      {item.tagNew && !collapsed && (
        <span className="ml-auto px-1.5 py-px bg-accent-soft text-accent-ink rounded font-mono text-[9.5px] font-semibold tracking-[0.04em] uppercase">
          New
        </span>
      )}
    </Link>
  );

  // The label is the only thing that tells these icons apart, so collapsing
  // without a tooltip makes the nav unusable rather than compact. Radix gives
  // hover AND keyboard focus, which `title` never does.
  return collapsed ? (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right">
        {item.label}
        {item.tagNew ? " · New" : ""}
      </TooltipContent>
    </Tooltip>
  ) : (
    link
  );
}
