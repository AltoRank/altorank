"use client";

import { useSyncExternalStore } from "react";

/**
 * Whether a media query matches now, kept current as the window changes.
 * The server has no viewport and says no, and so does a browser without
 * matchMedia: a caller's `false` branch is the one every first paint gets.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia?.(query);
      list?.addEventListener?.("change", onChange);
      return () => list?.removeEventListener?.("change", onChange);
    },
    () => window.matchMedia?.(query).matches ?? false,
    () => false,
  );
}
