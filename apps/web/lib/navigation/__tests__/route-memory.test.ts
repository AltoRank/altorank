import { afterEach, describe, expect, it, vi } from "vitest";
import { pathBefore, readRouteMemory, rememberPath, writeRouteMemory, type RouteMemory } from "../route-memory";

// The app path before this one, for article_opened's `from`. The page's
// effect and the memory's run in one commit in either order.

const EMPTY: RouteMemory = { current: null, previous: null };

describe("rememberPath / pathBefore", () => {
  it("answers the page before, whether the memory has moved on yet or not", () => {
    const onArticles = rememberPath(rememberPath(EMPTY, "/dashboard"), "/articles");
    // The editor's effect ran first: the memory is still on the Articles page.
    expect(pathBefore(onArticles, "/content/a1")).toBe("/articles");
    // The memory's effect ran first: it has moved on to the editor.
    expect(pathBefore(rememberPath(onArticles, "/content/a1"), "/content/a1")).toBe("/articles");
  });

  it("does not move on a reload of the same page", () => {
    const m = rememberPath(rememberPath(EMPTY, "/articles"), "/content/a1");
    expect(rememberPath(m, "/content/a1")).toBe(m);
    expect(pathBefore(m, "/content/a1")).toBe("/articles");
  });

  it("has no page before the first one in a tab", () => {
    expect(pathBefore(EMPTY, "/content/a1")).toBeNull();
    expect(pathBefore(rememberPath(EMPTY, "/content/a1"), "/content/a1")).toBeNull();
  });
});

describe("readRouteMemory / writeRouteMemory", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps the memory in this tab's storage", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("sessionStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
    writeRouteMemory({ current: "/content/a1", previous: "/articles" });
    expect(readRouteMemory()).toEqual({ current: "/content/a1", previous: "/articles" });
  });

  it("reads empty, and writes nothing, when storage is refused or holds junk", () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });
    expect(readRouteMemory()).toEqual(EMPTY);
    expect(() => writeRouteMemory({ current: "/a", previous: null })).not.toThrow();
    vi.stubGlobal("sessionStorage", { getItem: () => '{"current":5}', setItem: () => undefined });
    expect(readRouteMemory()).toEqual(EMPTY);
  });
});
