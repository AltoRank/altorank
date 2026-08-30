"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Icons } from "./icons";
import { cn } from "@/lib/utils";

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  className,
}: DialogProps) {
  const [mounted, setMounted] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => setMounted(true), []);

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  // Focus trap + ESC
  useEffect(() => {
    if (!open) return;

    previousFocusRef.current = document.activeElement as HTMLElement;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close();
        return;
      }

      if (e.key === "Tab" && panelRef.current) {
        const focusable = panelRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (focusable.length === 0) return;

        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener("keydown", onKeyDown);

    // Auto-focus first input after animation settles
    const timer = setTimeout(() => {
      const firstInput = panelRef.current?.querySelector<HTMLElement>(
        "input, select, textarea"
      );
      if (firstInput) firstInput.focus();
      else panelRef.current?.focus();
    }, 100);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      clearTimeout(timer);
      previousFocusRef.current?.focus();
    };
  }, [open, close]);

  // Lock body scroll
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!mounted) return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            className="fixed inset-0 z-[200] bg-black/40"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={close}
          />

          {/* Panel */}
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label={title}
            tabIndex={-1}
            className={cn(
              "fixed z-[201] top-1/2 left-1/2 w-full max-w-[480px] -translate-x-1/2 -translate-y-1/2",
              "bg-bg border border-line rounded-xl shadow-xl outline-none",
              className
            )}
            initial={{ opacity: 0, scale: 0.96, y: "-48%" }}
            animate={{ opacity: 1, scale: 1, y: "-50%" }}
            exit={{ opacity: 0, scale: 0.96, y: "-48%" }}
            transition={{ type: "spring", damping: 30, stiffness: 400 }}
          >
            {/* Header */}
            <div className="flex items-start justify-between px-5 pt-5 pb-0">
              <div>
                <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
                {description && (
                  <p className="text-[13px] text-ink-3 mt-1">{description}</p>
                )}
              </div>
              <button
                onClick={close}
                className="w-7 h-7 rounded-md inline-grid place-items-center text-ink-3 hover:text-ink hover:bg-panel-2 transition-colors cursor-pointer -mr-1 -mt-1"
              >
                <Icons.x size={14} />
              </button>
            </div>

            {/* Body */}
            <div className="px-5 py-4">{children}</div>
          </motion.div>
        </>
      )}
    </AnimatePresence>,
    document.body
  );
}
