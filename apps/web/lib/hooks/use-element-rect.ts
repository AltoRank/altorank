"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export function useElementRect(selector: string | null) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const mutationObserverRef = useRef<MutationObserver | null>(null);
  const rafRef = useRef<number>(0);

  const measure = useCallback((el: Element) => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      setRect(el.getBoundingClientRect());
    });
  }, []);

  useEffect(() => {
    if (!selector) {
      setRect(null);
      return;
    }

    let cleanupListeners: (() => void) | null = null;

    function attach(el: Element) {
      // Stop watching for the element — we found it
      mutationObserverRef.current?.disconnect();
      mutationObserverRef.current = null;

      measure(el);

      observerRef.current = new ResizeObserver(() => measure(el));
      observerRef.current.observe(el);

      const onScroll = () => measure(el);
      window.addEventListener("scroll", onScroll, true);
      window.addEventListener("resize", onScroll);

      cleanupListeners = () => {
        observerRef.current?.disconnect();
        window.removeEventListener("scroll", onScroll, true);
        window.removeEventListener("resize", onScroll);
      };
    }

    const el = document.querySelector(selector);
    if (el) {
      attach(el);
    } else {
      // Element doesn't exist yet (e.g. navigating to a new page).
      // Watch for it to appear in the DOM.
      mutationObserverRef.current = new MutationObserver(() => {
        const found = document.querySelector(selector);
        if (found) {
          attach(found);
        }
      });
      mutationObserverRef.current.observe(document.body, {
        childList: true,
        subtree: true,
      });
    }

    return () => {
      mutationObserverRef.current?.disconnect();
      mutationObserverRef.current = null;
      cleanupListeners?.();
      cancelAnimationFrame(rafRef.current);
    };
  }, [selector, measure]);

  return rect;
}
