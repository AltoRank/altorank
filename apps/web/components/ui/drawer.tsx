"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Icons } from "./icons";
import { cn } from "@/lib/utils";

interface DrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  /** Rendered in the header row, right of the title. */
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

/**
 * A panel that slides in from the right and leaves the page visible.
 *
 * `Dialog` is for one decision; this is for a workspace within a page. The
 * research drawer sits beside the keyword list and the calendar so what it
 * schedules can be seen landing.
 */
export function Drawer({ open, onOpenChange, title, description, actions, children, className }: DrawerProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("keydown", onKeyDown);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = prev;
    };
  }, [open, onOpenChange]);

  if (!mounted) return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className="fixed inset-0 z-[200] bg-black/30"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={() => onOpenChange(false)}
          />
          <motion.aside
            role="dialog"
            aria-modal="true"
            aria-label={title}
            className={cn(
              "fixed z-[201] top-0 right-0 h-full w-full max-w-[640px] bg-bg border-l border-line shadow-xl flex flex-col outline-none",
              className,
            )}
            initial={{ x: 40, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 40, opacity: 0 }}
            transition={{ type: "spring", damping: 32, stiffness: 380 }}
          >
            <div className="flex items-start justify-between px-5 pt-5 pb-3 border-b border-line">
              <div className="min-w-0">
                <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
                {description && <p className="text-[13px] text-ink-3 mt-1">{description}</p>}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {actions}
                <button
                  type="button"
                  onClick={() => onOpenChange(false)}
                  aria-label="Close"
                  className="w-7 h-7 rounded-md inline-grid place-items-center text-ink-3 hover:text-ink hover:bg-panel-2 transition-colors cursor-pointer -mr-1"
                >
                  <Icons.x size={14} />
                </button>
              </div>
            </div>
            <div className="flex-1 min-h-0 flex flex-col">{children}</div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>,
    document.body,
  );
}
