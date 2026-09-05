"use client";

import { useEffect } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Table, TableRow, TableCell, TableHeader } from "@tiptap/extension-table";
import { ArticleImage } from "@/lib/editor/image-node";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Show a proposed HTML fragment the way the editor would hold it
// ---------------------------------------------------------------------------
//
// A proposal comes from the model. Rendering it with innerHTML would trust it;
// parsing it through the editor's own schema drops every tag and attribute
// the schema does not know, which is the same filter the accepted version
// passes through on insert. So the preview is a read-only editor, and what
// you see is exactly what Accept would put in the document.

/** The schema the article editor uses, minus the interactive node views. */
export const ARTICLE_SCHEMA_EXTENSIONS = [
  StarterKit.configure({ link: { openOnClick: false } }),
  Table.configure({ resizable: false }),
  TableRow,
  TableHeader,
  TableCell,
  ArticleImage,
];

export function HtmlPreview({ html, className }: { html: string; className?: string }) {
  const editor = useEditor({
    extensions: ARTICLE_SCHEMA_EXTENSIONS,
    content: html,
    editable: false,
    immediatelyRender: false,
    editorProps: { attributes: { class: "focus:outline-none" } },
  });

  useEffect(() => {
    if (editor && editor.getHTML() !== html) editor.commands.setContent(html, { emitUpdate: false });
  }, [editor, html]);

  return (
    <div
      className={cn(
        "text-[12.5px] leading-[1.55] [&_h2]:mt-3 [&_h2]:text-[14px] [&_h2]:font-semibold [&_h3]:mt-2 [&_h3]:text-[13px] [&_h3]:font-semibold [&_p]:my-1.5 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4 [&_a]:text-accent-ink [&_a]:underline [&_img]:my-2 [&_img]:max-h-32 [&_img]:rounded-[6px] [&_strong]:font-semibold [&_em]:italic",
        className,
      )}
    >
      <EditorContent editor={editor} />
    </div>
  );
}
