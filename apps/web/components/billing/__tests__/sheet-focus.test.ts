import { describe, expect, it } from "vitest";
import { holdFocus } from "../sheet-focus";

// The checkout sheet is role="dialog" aria-modal, and until this the page
// behind it stayed in the Tab order and focus was left on the body when it
// closed. Stand-ins for the body's children: the sheet's portal and what is
// beside it.

function node(name: string, attrs: string[] = []) {
  const set = new Set(attrs);
  return {
    name,
    hasAttribute: (a: string) => set.has(a),
    setAttribute: (a: string) => void set.add(a),
    removeAttribute: (a: string) => void set.delete(a),
    inert: () => set.has("inert"),
  };
}

function focusable() {
  const calls: unknown[] = [];
  return { calls, isConnected: true, focus: (options?: unknown) => void calls.push(options ?? null) };
}

function page(...beside: ReturnType<typeof node>[]) {
  const sheet = { ...node("sheet"), parentElement: null as null | { children: ReturnType<typeof node>[] } };
  const body = { children: [...beside, sheet] };
  sheet.parentElement = body;
  return sheet;
}

describe("holdFocus", () => {
  it("makes everything beside the sheet inert, and never the sheet itself", () => {
    const app = node("app");
    const announcer = node("announcer");
    const sheet = page(app, announcer);
    holdFocus(sheet, null, null);
    expect(app.inert()).toBe(true);
    expect(announcer.inert()).toBe(true);
    expect(sheet.inert()).toBe(false);
  });

  it("moves focus to Close when the sheet opens", () => {
    const close = focusable();
    holdFocus(page(node("app")), close, null);
    expect(close.calls).toHaveLength(1);
  });

  it("wakes the page and gives focus back to the button that opened it", () => {
    const app = node("app");
    const opener = focusable();
    const release = holdFocus(page(app), focusable(), opener);
    expect(opener.calls).toHaveLength(0);
    release();
    expect(app.inert()).toBe(false);
    // Back where it was, without scrolling the page to the button.
    expect(opener.calls).toEqual([{ preventScroll: true }]);
  });

  it("leaves inert what was inert before it opened", () => {
    const asleep = node("other-modal", ["inert"]);
    const release = holdFocus(page(asleep), null, null);
    release();
    expect(asleep.inert()).toBe(true);
  });

  it("does not focus an opener that has left the page", () => {
    const opener = { ...focusable(), isConnected: false };
    holdFocus(page(node("app")), null, opener)();
    expect(opener.calls).toHaveLength(0);
  });
});
