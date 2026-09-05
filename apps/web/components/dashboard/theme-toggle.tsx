"use client";

import { useSyncExternalStore } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { applyTheme, currentTheme, THEME_ATTRIBUTE, type Theme } from "@/lib/theme";

/**
 * Light/dark switch for the sidebar footer.
 *
 * The theme lives on <html> as `data-theme`, stamped by the root layout's
 * inline script before React runs. That attribute is the store: this
 * subscribes to it with a MutationObserver and reads it back, so the icon
 * always shows what the page is actually doing, including when another tab
 * of the app flips it. The server snapshot is null (it knows nothing about
 * this browser), which is why the first paint shows a neutral icon rather
 * than a guess that would hydrate against the wrong one.
 */
function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: [THEME_ATTRIBUTE] });
  return () => observer.disconnect();
}

const serverSnapshot = (): Theme | null => null;

export function ThemeToggle({ className }: { className?: string }) {
  const theme = useSyncExternalStore(subscribe, currentTheme, serverSnapshot);

  const next: Theme = theme === "dark" ? "light" : "dark";
  const label = theme === null ? "Switch theme" : theme === "dark" ? "Switch to light" : "Switch to dark";

  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => applyTheme(next)}
          aria-label={label}
          data-testid="theme-toggle"
          className={
            className ??
            "w-[26px] h-[26px] rounded-[6px] text-ink-3 grid place-items-center hover:bg-panel-2 hover:text-ink"
          }
        >
          {theme === "dark" ? <SunIcon /> : <MoonIcon />}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

// Inline rather than added to components/ui/icons.tsx: another track is
// editing that file and two icons are not worth a merge conflict.
function SunIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}
