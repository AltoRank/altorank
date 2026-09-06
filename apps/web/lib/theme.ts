// ---------------------------------------------------------------------------
// Light and dark: one attribute, one storage key, one inline script
// ---------------------------------------------------------------------------
//
// The palette in app/globals.css is remapped under `:root[data-theme="dark"]`,
// and under `prefers-color-scheme: dark` for a root that has not been given a
// theme. So the only job here is deciding which value `data-theme` gets and
// putting it on <html> before the first paint.
//
// The init script is a string, inlined by the root layout, because a React
// effect runs after hydration and a page that paints light and then snaps to
// dark is the one thing every theme toggle is judged on. It is also tested as
// a string: the test runs it against a fake window and checks the attribute.
//
// Every localStorage access is inside try/catch. A private window or blocked
// site data throws on access rather than returning null, and a theme that
// cannot be remembered is a far better outcome than a sidebar that does not
// render (see the collapsed-state note in components/dashboard/sidebar.tsx).

export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "altorank_theme";
export const THEME_ATTRIBUTE = "data-theme";

/** A stored value wins when it is one of the two themes; anything else defers to the system. */
export function resolveTheme(stored: string | null | undefined, prefersDark: boolean): Theme {
  if (stored === "dark" || stored === "light") return stored;
  return prefersDark ? "dark" : "light";
}

/**
 * Runs before paint. Reads the stored preference, falls back to the system
 * setting, stamps the result on <html>. Anything that throws leaves the page
 * with no attribute, which the CSS treats as "follow the system".
 */
export const THEME_INIT_SCRIPT = [
  "(function(){try{",
  `var s=null;try{s=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});}catch(e){}`,
  'var d=!!(window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches);',
  'var t=(s==="dark"||s==="light")?s:(d?"dark":"light");',
  `document.documentElement.setAttribute(${JSON.stringify(THEME_ATTRIBUTE)},t);`,
  "}catch(e){}})();",
].join("");

/** What <html> currently says, or null before the script has run (or on the server). */
export function currentTheme(): Theme | null {
  if (typeof document === "undefined") return null;
  const v = document.documentElement.getAttribute(THEME_ATTRIBUTE);
  return v === "dark" || v === "light" ? v : null;
}

/** Stamp and persist. Persistence is best effort. */
export function applyTheme(theme: Theme): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute(THEME_ATTRIBUTE, theme);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* preference simply will not persist */
  }
}
