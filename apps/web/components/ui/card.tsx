import { cn } from "@/lib/utils";

/**
 * A titled panel. The body is padded by default.
 *
 * It used to be the other way round: `{children}` rendered flush and every
 * caller was expected to pay for its own inset. Tables did that for free
 * through their cell padding, so the omission was invisible on most pages and
 * silently wrong on the rest - the Billing cards put a plain div in a Card and
 * shipped copy touching the border, 18px out of line with the title directly
 * above it, and the Password card on Settings did the same. A default that is
 * only correct for one kind of child is not a default.
 *
 * So: padded unless told otherwise. `flush` is for children that must reach
 * the edges - tables, full-bleed toolbars with their own border, grids whose
 * cells carry the padding - or that already inset themselves.
 */
export function Card({
  title,
  meta,
  className,
  bodyClassName,
  flush = false,
  children,
}: {
  title?: string;
  meta?: React.ReactNode;
  className?: string;
  /** Extra classes for the body wrapper. Ignored when `flush`. */
  bodyClassName?: string;
  /** Render children edge to edge, with no body padding. */
  flush?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("bg-bg border border-line rounded-lg overflow-hidden", className)}>
      {title && (
        <div className="px-[18px] py-3.5 border-b border-line-soft flex items-center gap-2.5">
          <h3 className="m-0 text-sm font-semibold tracking-[-0.005em]">{title}</h3>
          {meta && <div className="ml-auto text-ink-3 text-xs">{meta}</div>}
        </div>
      )}
      {/* 18px matches the title's inset, so body copy lines up with the
          heading it sits under rather than starting to the left of it. */}
      {flush ? children : <div className={cn("p-[18px]", bodyClassName)}>{children}</div>}
    </div>
  );
}
