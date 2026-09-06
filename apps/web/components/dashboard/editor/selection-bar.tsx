"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getHTMLFromFragment, type Editor } from "@tiptap/react";
import { toast } from "sonner";
import { rewriteFieldAction } from "@/app/actions/editor-ai";
import type { MicroAction } from "@/lib/ai/micro";
import { AiActionMenu, ProposalCard } from "./ai-menu";
import { HtmlPreview } from "./html-preview";
import { useEditorAi } from "./editor-ai-context";

// ---------------------------------------------------------------------------
// Select text, get the six actions
// ---------------------------------------------------------------------------
//
// Positioned by hand from the selection's coordinates rather than through
// Tiptap's BubbleMenu: that one needs a floating-ui setup this repo does not
// have, and a bar that sits above the selection is a dozen lines. The
// selection is sent as HTML so a link or image inside it comes back intact;
// the result replaces exactly the selected range, and only when accepted.
// `insertContentAt` parses the HTML through the editor's own schema, which is
// the sanitiser: anything the schema does not know is dropped.

type Pending = { from: number; to: number; before: string; after: string };

export function SelectionBar({ editor, container }: { editor: Editor | null; container: React.RefObject<HTMLDivElement | null> }) {
  const { articleId, outline, onBodyChange } = useEditorAi();
  const [range, setRange] = useState<{ from: number; to: number } | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const busyRef = useRef(false);

  const place = useCallback(() => {
    if (!editor || !container.current) return;
    // Keep the bar while a request is in flight even if focus moves.
    if (busyRef.current) return;
    const { from, to, empty } = editor.state.selection;
    if (empty || editor.state.doc.textBetween(from, to, " ").trim().length === 0) {
      setRange(null);
      return;
    }
    const start = editor.view.coordsAtPos(from);
    const box = container.current.getBoundingClientRect();
    setRange({ from, to });
    setPos({
      top: start.top - box.top + container.current.scrollTop - 40,
      left: Math.max(8, start.left - box.left),
    });
  }, [editor, container]);

  useEffect(() => {
    if (!editor) return;
    editor.on("selectionUpdate", place);
    return () => {
      editor.off("selectionUpdate", place);
    };
  }, [editor, place]);

  const run = async (action: MicroAction, prompt?: string) => {
    if (!editor || !range) return;
    const slice = editor.state.doc.slice(range.from, range.to);
    const before = getHTMLFromFragment(slice.content, editor.schema);
    busyRef.current = true;
    setBusy(true);
    try {
      const res = await rewriteFieldAction({
        articleId,
        field: "selection",
        action,
        text: before,
        prompt,
        outline,
      });
      if (!res.ok) throw new Error(res.error);
      setPending({ ...range, before, after: res.text });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Rewrite failed");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const accept = () => {
    if (!editor || !pending) return;
    editor
      .chain()
      .insertContentAt({ from: pending.from, to: pending.to }, pending.after, { updateSelection: false })
      .run();
    onBodyChange();
    setPending(null);
    setRange(null);
  };

  if (!editor) return null;

  return (
    <>
      {range && pos && !pending && (
        <div
          className="absolute z-10 flex items-center gap-1 rounded-[8px] border border-line bg-bg px-1.5 py-1 shadow-[0_8px_24px_rgba(0,0,0,0.08)]"
          style={{ top: pos.top, left: pos.left }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <span className="px-1 text-[11px] text-ink-3">{busy ? "Rewriting…" : "Selection"}</span>
          <AiActionMenu onAction={run} busy={busy} />
        </div>
      )}
      {pending && pos && (
        <div className="absolute z-10 w-[min(560px,90%)]" style={{ top: pos.top + 40, left: pos.left }}>
          <ProposalCard
            className="bg-bg shadow-[0_12px_32px_rgba(0,0,0,0.12)]"
            before={pending.before}
            after={pending.after}
            acceptLabel="Replace selection"
            renderValue={(v) => <HtmlPreview html={v} />}
            onAccept={accept}
            onDiscard={() => {
              setPending(null);
              setRange(null);
            }}
          />
        </div>
      )}
    </>
  );
}
