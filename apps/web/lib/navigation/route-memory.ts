// ---------------------------------------------------------------------------
// The app path shown before this one, in this tab
// ---------------------------------------------------------------------------
//
// `document.referrer` is the page that loaded the app, and a client-side
// navigation does not change it: every editor opened from the Articles list
// would say it came from wherever the visit began. components/route-memory.tsx
// writes each path the tab shows here; `pathBefore` reads the one before.
//
// Kept in sessionStorage: this tab only, gone with it, never sent anywhere.
// What leaves the browser is a word made from it (lib/onboarding/step-props.ts
// `openedFrom`), never the path.

export interface RouteMemory {
  current: string | null;
  previous: string | null;
}

const KEY = "altorank.route";
const EMPTY: RouteMemory = { current: null, previous: null };

/** The memory after the tab shows `pathname`. The same path again changes nothing (a reload, a re-render). */
export function rememberPath(memory: RouteMemory, pathname: string): RouteMemory {
  if (memory.current === pathname) return memory;
  return { current: pathname, previous: memory.current };
}

/**
 * The path shown before `here`. The page's effect and the memory's run in the
 * same commit in either order, so both are answered: already moved on to
 * `here` (the one before is `previous`), or not yet (it is `current`).
 */
export function pathBefore(memory: RouteMemory, here: string): string | null {
  return memory.current === here ? memory.previous : memory.current;
}

export function readRouteMemory(): RouteMemory {
  try {
    const raw = typeof sessionStorage === "undefined" ? null : sessionStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<RouteMemory>) : null;
    return {
      current: typeof parsed?.current === "string" ? parsed.current : null,
      previous: typeof parsed?.previous === "string" ? parsed.previous : null,
    };
  } catch {
    return EMPTY;
  }
}

export function writeRouteMemory(memory: RouteMemory): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(memory));
  } catch {
    // Storage refused (a private window, a full quota): `from` falls back to the referrer.
  }
}
