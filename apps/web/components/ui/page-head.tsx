import Link from "next/link";
import { cn } from "@/lib/utils";
import { Icons } from "./icons";

type PageHeadProps = {
  title: string;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  /** Detail pages only: renders a back arrow before the title. */
  backHref?: string;
  backLabel?: string;
  className?: string;
};

/**
 * One row, the same height as the sidebar's brand row, so the page title sits
 * on the line as the logo instead of below a bar that repeated it.
 *
 * What this replaced cost three rows before any content: a topbar whose
 * breadcrumb read "Workspaces" directly above an h1 reading "Workspaces", an
 * eyebrow above that h1, and a subtitle under it. On a 900px screen that is
 * roughly 120px of chrome to say one word three times.
 *
 * The `eyebrow` prop is gone rather than optional. Of the seventeen pages that
 * set one, "Reports" sat above the heading "Reports" and "Integrations" above
 * "Integrations"; the rest were category labels for a page you had already
 * chosen from the nav. This is the same rule the marketing site adopted in
 * August ("no decorative eyebrow labels above headings"), finally applied to
 * the app. Anything in an eyebrow that carried real state - a count, a running
 * job - moved into `subtitle`, which now renders inline.
 */
export function PageHead({
  title,
  subtitle,
  actions,
  backHref,
  backLabel = "Back",
  className,
}: PageHeadProps) {
  return (
    <div
      className={cn(
        "h-[var(--topbar-h)] shrink-0 px-8 border-b border-line flex items-center gap-4",
        className
      )}
    >
      {backHref && (
        // An arrow, not "Back to articles". On a detail page one control
        // earns the width; the sentence does not.
        <Link
          href={backHref}
          aria-label={backLabel}
          className="shrink-0 w-[26px] h-[26px] -ml-1.5 rounded-[6px] text-ink-3 grid place-items-center hover:bg-panel-2 hover:text-ink"
        >
          <Icons.arrowLeft size={15} />
        </Link>
      )}

      <h1 className="text-[20px] font-semibold tracking-[-0.018em] m-0 truncate">
        {title}
      </h1>

      {subtitle && (
        // Hidden on narrow screens rather than wrapped: wrapping would give
        // back the row this whole change removes.
        <div className="hidden md:flex min-w-0 items-center gap-3 text-[13px] text-ink-3 whitespace-nowrap overflow-hidden">
          {subtitle}
        </div>
      )}

      {actions && <div className="ml-auto flex gap-2 shrink-0">{actions}</div>}
    </div>
  );
}

export function DotSep() {
  return <span className="w-[3px] h-[3px] rounded-full bg-ink-4 shrink-0" />;
}

export function EyebrowCode({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono px-[7px] py-0.5 bg-panel-2 rounded text-ink-2">
      {children}
    </span>
  );
}
