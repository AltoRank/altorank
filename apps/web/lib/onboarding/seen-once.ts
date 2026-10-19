// ---------------------------------------------------------------------------
// Say once that an element was actually on screen
// ---------------------------------------------------------------------------
//
// Rendered is not seen. Below lg the gate's price box sits under the article,
// so `gate_shown` (the box rendered) counts people who never scrolled to it.
// `offer_seen` waits for half of the box to be in the viewport, once, then
// stops watching. Without IntersectionObserver nothing is said: a guess would
// be the number this event exists to replace.

/** Half the element in view: the price and the button, not a sliver of border. */
export const SEEN_RATIO = 0.5;

type Observer = Pick<IntersectionObserver, "observe" | "disconnect">;
type ObserverCtor = new (callback: IntersectionObserverCallback, options?: IntersectionObserverInit) => Observer;

/** Calls `onSeen` the first time `el` is on screen. Returns the stop. */
export function observeSeenOnce(el: Element | null, onSeen: () => void, IO: ObserverCtor | undefined = globalThis.IntersectionObserver): () => void {
  if (!el || typeof IO !== "function") return () => undefined;
  let done = false;
  const io = new IO(
    (entries) => {
      if (done || !entries.some((e) => e.isIntersecting && e.intersectionRatio >= SEEN_RATIO)) return;
      done = true;
      io.disconnect();
      onSeen();
    },
    { threshold: SEEN_RATIO },
  );
  io.observe(el);
  return () => io.disconnect();
}
