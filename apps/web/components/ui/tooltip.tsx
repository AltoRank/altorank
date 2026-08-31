"use client";

import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "@/lib/utils";

// shadcn's tooltip is a thin wrapper over @radix-ui/react-tooltip, so this is
// that wrapper written against the tokens this app already uses rather than
// shadcn's own palette. Pulling in the shadcn CLI would have brought its
// tailwind config, its CSS variables and its `cn` helper alongside the three
// we already have, for one component.
//
// Radix is what does the work worth having: hover and focus both open it,
// Escape closes it, it is announced to screen readers, and it flips when it
// would run off the edge. A `title` attribute does none of that and never
// appears for keyboard users.

export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export function TooltipContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        sideOffset={sideOffset}
        className={cn(
          "z-50 overflow-hidden rounded-[6px] border border-line bg-ink px-2 py-1",
          "text-[12px] font-medium text-bg shadow-md",
          "animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out",
          "data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          className,
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}
