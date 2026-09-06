"use client";

import { useCallback, useEffect, useState } from "react";
import type { Editor } from "@tiptap/react";
import { Button } from "@/components/ui/button";
import { useDismiss } from "./ai-menu";

// ---------------------------------------------------------------------------
// Editor mode: click a link, edit its URL
// ---------------------------------------------------------------------------
//
// Replaces the window.prompt the toolbar's link button used. Opens where the
// link is, applies to the whole link (extendMarkRange), and can also unlink.
// Only in Editor mode: in Review the document is read-only and a click on a
// link should not open an input.

export function LinkPopover({
  editor,
  container,
  enabled,
}: {
  editor: Editor | null;
  container: React.RefObject<HTMLDivElement | null>;
  enabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [href, setHref] = useState("");
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss(open, close);

  useEffect(() => {
    if (!editor || !enabled) return;
    const onSelection = () => {
      if (!editor.isActive("link") || !container.current) {
        setOpen(false);
        return;
      }
      const attrs = editor.getAttributes("link");
      const { from } = editor.state.selection;
      const coords = editor.view.coordsAtPos(from);
      const box = container.current.getBoundingClientRect();
      setHref(typeof attrs.href === "string" ? attrs.href : "");
      setPos({ top: coords.bottom - box.top + container.current.scrollTop + 6, left: Math.max(8, coords.left - box.left) });
      setOpen(true);
    };
    editor.on("selectionUpdate", onSelection);
    return () => {
      editor.off("selectionUpdate", onSelection);
    };
  }, [editor, enabled, container]);

  // Gated on `enabled` here rather than by closing in an effect: leaving
  // Editor mode hides it at once, and the next selection repositions it.
  if (!editor || !enabled || !open || !pos) return null;

  const apply = () => {
    const url = href.trim();
    if (!url) return;
    const full = /^(https?:\/\/|mailto:|\/)/i.test(url) ? url : `https://${url}`;
    editor.chain().focus().extendMarkRange("link").setLink({ href: full }).run();
    setOpen(false);
  };

  return (
    <div
      ref={ref}
      className="absolute z-10 flex items-center gap-1.5 rounded-[8px] border border-line bg-bg p-1.5 shadow-[0_8px_24px_rgba(0,0,0,0.08)]"
      style={{ top: pos.top, left: pos.left }}
    >
      <input
        value={href}
        onChange={(e) => setHref(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            apply();
          }
        }}
        aria-label="Link URL"
        placeholder="https://…"
        className="w-[280px] rounded-[6px] border border-line bg-bg px-2 py-1 font-mono text-[12px] focus:outline-0 focus:border-accent"
      />
      <Button size="sm" variant="accent" onClick={apply} disabled={!href.trim()}>
        Edit URL
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          editor.chain().focus().extendMarkRange("link").unsetLink().run();
          setOpen(false);
        }}
      >
        Unlink
      </Button>
    </div>
  );
}
