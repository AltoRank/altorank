import { describe, it, expect } from "vitest";
import { resolveTheme, THEME_INIT_SCRIPT, THEME_STORAGE_KEY, THEME_ATTRIBUTE } from "@/lib/theme";

/**
 * Runs the inline script against a fake browser. The script is what the root
 * layout inlines verbatim, so this is the code that decides whether a page
 * flashes light before going dark.
 *
 * `Function` here evaluates our own constant, not input: it is the only way
 * to execute a string the layout ships as a <script> body.
 */
function runInit(opts: {
  stored?: string | null;
  prefersDark?: boolean;
  storageThrows?: boolean;
  noMatchMedia?: boolean;
}) {
  const attrs: Record<string, string> = {};
  const document = {
    documentElement: {
      setAttribute(name: string, value: string) {
        attrs[name] = value;
      },
    },
  };
  const localStorage = {
    getItem(key: string) {
      if (opts.storageThrows) throw new Error("SecurityError: access denied");
      return key === THEME_STORAGE_KEY ? (opts.stored ?? null) : null;
    },
  };
  const window = opts.noMatchMedia
    ? {}
    : { matchMedia: (q: string) => ({ matches: q.includes("dark") ? Boolean(opts.prefersDark) : false }) };

  // The script only reaches these three globals, so they are the whole world.
  const run = Function("window", "document", "localStorage", THEME_INIT_SCRIPT);
  run(window, document, localStorage);
  return attrs[THEME_ATTRIBUTE];
}

describe("resolveTheme", () => {
  it("honours a stored choice and ignores garbage", () => {
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("blue", true)).toBe("dark");
    expect(resolveTheme(null, false)).toBe("light");
    expect(resolveTheme(undefined, true)).toBe("dark");
  });
});

describe("THEME_INIT_SCRIPT", () => {
  it("stamps the stored theme on <html>", () => {
    expect(runInit({ stored: "dark", prefersDark: false })).toBe("dark");
    expect(runInit({ stored: "light", prefersDark: true })).toBe("light");
  });

  it("falls back to the system preference when nothing is stored", () => {
    expect(runInit({ stored: null, prefersDark: true })).toBe("dark");
    expect(runInit({ stored: null, prefersDark: false })).toBe("light");
  });

  it("survives a localStorage that throws, and still follows the system", () => {
    // Private windows and blocked site data throw on access rather than
    // returning null; the page must still get a theme.
    expect(runInit({ storageThrows: true, prefersDark: true })).toBe("dark");
    expect(runInit({ storageThrows: true, prefersDark: false })).toBe("light");
  });

  it("never throws, even without matchMedia", () => {
    expect(() => runInit({ stored: null, noMatchMedia: true })).not.toThrow();
    expect(runInit({ stored: null, noMatchMedia: true })).toBe("light");
  });

  it("is a single self-invoking statement safe to inline", () => {
    expect(THEME_INIT_SCRIPT.startsWith("(function(){")).toBe(true);
    expect(THEME_INIT_SCRIPT.endsWith("})();")).toBe(true);
    expect(THEME_INIT_SCRIPT).not.toContain("</script");
  });
});
