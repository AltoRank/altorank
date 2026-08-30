"use client";

import { useEffect } from "react";
import { motion } from "framer-motion";

interface OnboardingSpotlightProps {
  targetRect: DOMRect;
  targetSelector: string;
  onClickOutside: () => void;
  onTargetClick: () => void;
}

const PAD = 8;
const RADIUS = 12;

export function OnboardingSpotlight({
  targetRect,
  targetSelector,
  onClickOutside,
  onTargetClick,
}: OnboardingSpotlightProps) {
  // Elevate the target element above the overlay so it's actually clickable
  useEffect(() => {
    const el = document.querySelector<HTMLElement>(targetSelector);
    if (!el) return;

    const prev = {
      position: el.style.position,
      zIndex: el.style.zIndex,
      pointerEvents: el.style.pointerEvents,
    };

    el.style.position = "relative";
    el.style.zIndex = "201";
    el.style.pointerEvents = "auto";

    const handleClick = () => onTargetClick();
    el.addEventListener("click", handleClick, { once: true });

    return () => {
      el.style.position = prev.position;
      el.style.zIndex = prev.zIndex;
      el.style.pointerEvents = prev.pointerEvents;
      el.removeEventListener("click", handleClick);
    };
  }, [targetSelector, onTargetClick]);

  const x = targetRect.left - PAD;
  const y = targetRect.top - PAD;
  const w = targetRect.width + PAD * 2;
  const h = targetRect.height + PAD * 2;

  return (
    <motion.div
      className="fixed inset-0 z-[200]"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      onClick={onClickOutside}
    >
      <svg className="absolute inset-0 w-full h-full">
        <defs>
          <mask id="spotlight-mask">
            <rect width="100%" height="100%" fill="white" />
            <rect
              x={x}
              y={y}
              width={w}
              height={h}
              rx={RADIUS}
              fill="black"
            />
          </mask>
        </defs>
        <rect
          width="100%"
          height="100%"
          fill="oklch(0.17 0.008 80 / 0.6)"
          mask="url(#spotlight-mask)"
        />
      </svg>

      {/* Pulsing ring around cutout */}
      <motion.div
        className="absolute rounded-[12px] pointer-events-none"
        style={{
          left: x,
          top: y,
          width: w,
          height: h,
          boxShadow: "0 0 0 4px var(--accent-soft)",
        }}
        animate={{
          boxShadow: [
            "0 0 0 4px var(--accent-soft)",
            "0 0 0 8px transparent",
            "0 0 0 4px var(--accent-soft)",
          ],
        }}
        transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
      />
    </motion.div>
  );
}
