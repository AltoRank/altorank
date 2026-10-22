// ---------------------------------------------------------------------------
// Keeping focus inside the checkout sheet while it is open
// ---------------------------------------------------------------------------
//
// The sheet is role="dialog" aria-modal, but until this the page behind it
// stayed in the Tab order, focus never moved in, and closing it left focus
// on the body. The shared Dialog (components/ui/dialog.tsx) traps Tab with a
// keydown listener, which cannot work here: Stripe's form is a cross-origin
// iframe, so a Tab pressed inside it never reaches our document, and outside
// it the sheet's only focusable element is Close. So the page behind is made
// inert instead: nothing beside the sheet can take focus or be read out, and
// Tab can only move between Close and Stripe's own fields.

/** What the sheet needs from an element: ours, or a test's stand-in. */
interface Holdable {
  hasAttribute(name: string): boolean;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

interface Focusable {
  focus(options?: FocusOptions): void;
  isConnected?: boolean;
}

/**
 * Make everything beside `root` inert, move focus to `first`, and return
 * the function that undoes both and gives focus back to `opener` (the
 * button that opened the sheet). An element that was inert already is left
 * as it was, so closing never wakes something another modal put to sleep.
 */
export function holdFocus(
  root: Holdable & { parentElement: { children: ArrayLike<Holdable> } | null },
  first: Focusable | null,
  opener: Focusable | null,
): () => void {
  const held: Holdable[] = [];
  for (const el of Array.from(root.parentElement?.children ?? [])) {
    if (el === root || el.hasAttribute("inert")) continue;
    el.setAttribute("inert", "");
    held.push(el);
  }
  first?.focus();
  return () => {
    // Awake first: an inert element cannot take focus.
    for (const el of held) el.removeAttribute("inert");
    if (opener && opener.isConnected !== false) opener.focus({ preventScroll: true });
  };
}
