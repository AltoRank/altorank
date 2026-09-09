"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { Icons } from "@/components/ui/icons";
import { Avatar } from "@/components/ui/avatar";
import { signOut } from "@/app/actions/auth";
import posthog from "posthog-js";

type Item =
  | { kind: "link"; label: string; href: string; icon: keyof typeof Icons }
  | {
      kind: "action";
      label: string;
      onSelect: () => void;
      icon: keyof typeof Icons;
    };

type AccountMenuProps = {
  userName: string;
  userInitials: string;
  userId?: string;
  userEmail?: string;
  userProfileName?: string;
  /** Second line under the name; null renders nothing rather than a guess. */
  subtitle: string | null;
  collapsed: boolean;
  /** Reopens the setup checklist. Absent when the provider is. */
  openGuide?: () => void;
};

/**
 * The account block at the foot of the sidebar, opening upward into a menu.
 *
 * It replaces three 26px icon buttons (guide, settings, sign out) that sat in a
 * row beside the name and had no labels except on hover. Every destination
 * here is a page that exists: Team and Billing are the Settings tabs, and
 * invoices is the card on the Billing page. Nothing is listed that the app
 * cannot do; a menu entry for a feature we do not have would be a claim.
 *
 * Hand-rolled rather than a dropdown library: one menu, one trigger, and the
 * only behaviours that matter are click-outside, Escape, and closing on
 * navigation. Focus returns to the trigger on close so keyboard users are not
 * dropped at the top of the document.
 */
export function AccountMenu({
  userName,
  userInitials,
  userId,
  userEmail,
  userProfileName,
  subtitle,
  collapsed,
  openGuide,
}: AccountMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const pathname = usePathname();
  const identifiedUserId = useRef<string | null>(null);

  useEffect(() => {
    if (!userId || identifiedUserId.current === userId) return;
    if (identifiedUserId.current) posthog.reset();

    posthog.identify(userId, {
      ...(userEmail ? { email: userEmail } : {}),
      ...(userProfileName ? { name: userProfileName } : {}),
    });
    identifiedUserId.current = userId;
  }, [userEmail, userId, userProfileName]);

  // Close on route change; the menu is a launcher, not a place to stay.
  // Derived during render rather than in an effect so there is no extra pass.
  const [openedAt, setOpenedAt] = useState(pathname);
  if (openedAt !== pathname) {
    setOpenedAt(pathname);
    setOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const items: Item[] = [
    {
      kind: "link",
      label: "Invite users",
      href: "/settings/team",
      icon: "team",
    },
    {
      kind: "link",
      label: "Manage subscription",
      href: "/settings/billing",
      icon: "billing",
    },
    {
      kind: "link",
      label: "View invoices",
      href: "/settings/billing#invoices",
      icon: "articles",
    },
    { kind: "link", label: "Settings", href: "/settings", icon: "settings" },
    ...(openGuide
      ? [
          {
            kind: "action",
            label: "Setup guide",
            onSelect: openGuide,
            icon: "help",
          } satisfies Item,
        ]
      : []),
    {
      kind: "action",
      label: "Log out",
      onSelect: () => {
        posthog.reset();
        signOut();
      },
      icon: "signOut",
    },
  ];

  return (
    <div ref={rootRef} className={cn("relative", collapsed ? "px-0" : "px-2")}>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="Account"
          className={cn(
            "absolute bottom-full mb-1.5 z-30 min-w-[220px] rounded-[10px] border border-line bg-panel shadow-lg p-1.5",
            collapsed ? "left-full ml-2 bottom-0" : "left-2 right-2",
          )}
        >
          {items.map((item) => {
            const Icon = Icons[item.icon];
            const cls =
              "flex w-full items-center gap-3 rounded-[7px] px-2.5 py-2 text-[13px] text-ink hover:bg-panel-2 focus:bg-panel-2 focus:outline-none";
            return item.kind === "link" ? (
              <Link
                key={item.label}
                role="menuitem"
                href={item.href}
                className={cls}
              >
                <Icon size={15} />
                {item.label}
              </Link>
            ) : (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
                className={cls}
              >
                <Icon size={15} />
                {item.label}
              </button>
            );
          })}
        </div>
      )}

      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={collapsed ? `Account menu for ${userName}` : undefined}
        className={cn(
          "flex w-full items-center gap-[9px] rounded-[8px] text-left text-[12.5px] text-ink-2 hover:bg-panel-2",
          collapsed ? "justify-center p-1.5" : "px-2 py-1.5",
          open && "bg-panel-2",
        )}
      >
        <Avatar initials={userInitials} color="av-c5" round />
        {!collapsed && (
          <>
            <span className="flex-1 min-w-0">
              <div className="font-medium text-ink truncate">{userName}</div>
              {subtitle && (
                <div className="text-[11px] text-ink-3 truncate">
                  {subtitle}
                </div>
              )}
            </span>
            <span
              className={cn(
                "text-ink-3 transition-transform",
                open && "rotate-180",
              )}
            >
              <Icons.caretDown size={14} />
            </span>
          </>
        )}
      </button>
    </div>
  );
}
