"use client";

import { motion } from "framer-motion";
import { Button } from "@/components/ui";
import type { TooltipPosition } from "./onboarding-steps";

interface OnboardingTooltipProps {
  targetRect: DOMRect;
  position: TooltipPosition;
  stepIndex: number;
  totalSteps: number;
  title: string;
  description: string;
  actionLabel: string;
  /** Close the explainer. Reading it is not doing it, so nothing is ticked. */
  onClose: () => void;
  onNext: () => void;
  isLastStep: boolean;
}

const GAP = 12;
const ARROW = 8;
const TOOLTIP_W = 280;
const EDGE_MARGIN = 16;

interface TooltipStyle {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
  transform?: string;
  arrowOffset?: number; // px from left edge of tooltip to arrow center
}

function getStyle(rect: DOMRect, position: TooltipPosition): TooltipStyle {
  switch (position) {
    case "right":
      return {
        top: rect.top + rect.height / 2,
        left: rect.right + GAP + ARROW,
        transform: "translateY(-50%)",
      };
    case "left":
      return {
        top: rect.top + rect.height / 2,
        right: window.innerWidth - rect.left + GAP + ARROW,
        transform: "translateY(-50%)",
      };
    case "bottom": {
      const center = rect.left + rect.width / 2;
      const halfW = TOOLTIP_W / 2;
      const vw = window.innerWidth;

      // Would overflow right
      if (center + halfW > vw - EDGE_MARGIN) {
        const left = vw - EDGE_MARGIN - TOOLTIP_W;
        return {
          top: rect.bottom + GAP + ARROW,
          left,
          arrowOffset: center - left,
        };
      }
      // Would overflow left
      if (center - halfW < EDGE_MARGIN) {
        const left = EDGE_MARGIN;
        return {
          top: rect.bottom + GAP + ARROW,
          left,
          arrowOffset: center - left,
        };
      }
      return {
        top: rect.bottom + GAP + ARROW,
        left: center,
        transform: "translateX(-50%)",
      };
    }
    case "top": {
      const center = rect.left + rect.width / 2;
      const halfW = TOOLTIP_W / 2;
      const vw = window.innerWidth;

      if (center + halfW > vw - EDGE_MARGIN) {
        const left = vw - EDGE_MARGIN - TOOLTIP_W;
        return {
          bottom: window.innerHeight - rect.top + GAP + ARROW,
          left,
          arrowOffset: center - left,
        };
      }
      if (center - halfW < EDGE_MARGIN) {
        const left = EDGE_MARGIN;
        return {
          bottom: window.innerHeight - rect.top + GAP + ARROW,
          left,
          arrowOffset: center - left,
        };
      }
      return {
        bottom: window.innerHeight - rect.top + GAP + ARROW,
        left: center,
        transform: "translateX(-50%)",
      };
    }
  }
}

function getInitialOffset(position: TooltipPosition) {
  switch (position) {
    case "right":
      return { x: -8, opacity: 0 };
    case "left":
      return { x: 8, opacity: 0 };
    case "bottom":
      return { y: -8, opacity: 0 };
    case "top":
      return { y: 8, opacity: 0 };
  }
}

function ArrowSvg({ position, offset }: { position: TooltipPosition; offset?: number }) {
  const base =
    "absolute w-0 h-0 border-[8px] border-transparent";

  // When clamped, use exact px offset instead of 50%
  const hPos = offset != null
    ? { left: `${offset}px`, transform: "translateX(-50%)" }
    : { left: "50%", transform: "translateX(-50%)" };

  switch (position) {
    case "right":
      return (
        <span
          className={`${base} border-r-bg -left-[16px] top-1/2 -translate-y-1/2`}
          style={{ filter: "drop-shadow(-1px 0 0 var(--line))" }}
        />
      );
    case "left":
      return (
        <span
          className={`${base} border-l-bg -right-[16px] top-1/2 -translate-y-1/2`}
          style={{ filter: "drop-shadow(1px 0 0 var(--line))" }}
        />
      );
    case "bottom":
      return (
        <span
          className={`${base} border-b-bg -top-[16px]`}
          style={{ ...hPos, filter: "drop-shadow(0 -1px 0 var(--line))" }}
        />
      );
    case "top":
      return (
        <span
          className={`${base} border-t-bg -bottom-[16px]`}
          style={{ ...hPos, filter: "drop-shadow(0 1px 0 var(--line))" }}
        />
      );
  }
}

export function OnboardingTooltip({
  targetRect,
  position,
  stepIndex,
  totalSteps,
  title,
  description,
  actionLabel,
  onClose,
  onNext,
  isLastStep,
}: OnboardingTooltipProps) {
  const { arrowOffset, ...style } = getStyle(targetRect, position);
  const initial = getInitialOffset(position);

  return (
    <motion.div
      className="fixed z-[201] max-w-[280px] bg-bg border border-line rounded-lg shadow-xl p-4"
      style={style}
      initial={initial}
      animate={{ x: 0, y: 0, opacity: 1 }}
      exit={initial}
      transition={{ type: "spring", damping: 25, stiffness: 300 }}
    >
      <ArrowSvg position={position} offset={arrowOffset} />
      <p className="text-[10px] font-mono uppercase tracking-widest text-ink-3 mb-1.5">
        Step {stepIndex + 1} of {totalSteps}
      </p>
      <p className="text-[13px] font-semibold text-ink mb-1">{title}</p>
      <p className="text-[12.5px] text-ink-2 leading-relaxed mb-2">
        {description}
      </p>
      <p className="text-[12px] text-accent-ink font-medium mb-3">
        {actionLabel}
      </p>
      <div className="flex items-center gap-2 justify-end">
        {/* Neither of these ticks the step. "Done" used to, and that is how an
            empty account came to be told it was all set up. The checklist is
            counted from the tables now; this is just an explainer. */}
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
        {!isLastStep && (
          <Button variant="accent" size="sm" onClick={onNext}>
            Next step
          </Button>
        )}
      </div>
    </motion.div>
  );
}
