// ---------------------------------------------------------------------------
// The article's way out, as the browser sees it: opened, copied
// ---------------------------------------------------------------------------
//
// After the trial the funnel's question is whether the first article left
// the product: was it opened, was it copied out (the paste into the
// customer's own CMS is the value), was it approved (server-side,
// lib/articles/approve.ts). These two are the browser's half, sent through
// trackStep; the server finds the workspace from the article.

import { trackStep } from "./track-step";
import { currentViewport, openedFrom, type CopyFormat, type CopySurface } from "./step-props";
import { pathBefore, readRouteMemory } from "@/lib/navigation/route-memory";

/** What the editor knows about how it was reached; the browser's own by default. */
export interface OpenedEnv {
  pathname: string;
  referrer: string;
  origin: string;
  previous: (here: string) => string | null;
}

function browserEnv(): OpenedEnv | null {
  if (typeof window === "undefined") return null;
  return {
    pathname: window.location.pathname,
    referrer: typeof document === "undefined" ? "" : document.referrer,
    origin: window.location.origin,
    previous: (here) => pathBefore(readRouteMemory(), here),
  };
}

/** The editor opened `articleId`: once per article per place it was opened from. */
export function trackArticleOpened(articleId: string, env: OpenedEnv | null = browserEnv()): void {
  if (!env) return;
  const from = openedFrom(env.previous(env.pathname), env.referrer, env.origin);
  trackStep("article_opened", { articleId, props: { from, viewport: currentViewport() } });
}

/** The article went to the clipboard: once per article, format and button. Only after the write worked. */
export function trackArticleCopied(articleId: string, format: CopyFormat, surface: CopySurface): void {
  trackStep("article_copied", { articleId, props: { format, surface } });
}
