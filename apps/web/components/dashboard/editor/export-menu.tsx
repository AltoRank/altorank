"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Icons } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { renderMarkdownAction } from "@/app/actions/editor-ai";
import { DropMenu } from "./ai-menu";

// ---------------------------------------------------------------------------
// Export: Markdown, clipboard, file
// ---------------------------------------------------------------------------
//
// Markdown is rendered on the server by renderMarkdownAction, which goes
// through lib/publishing/export.ts and so through the same converter the git
// adapter commits with. HTML is what the editor holds. Neither reads the
// database for the body: they export what is on screen, unsaved edits
// included, because that is what the person is looking at.

export function ExportMenu({
  articleId,
  getHtml,
  title,
  metaDescription,
  featuredImageUrl,
}: {
  articleId: string;
  getHtml: () => string;
  title: string;
  metaDescription: string | null;
  featuredImageUrl: string | null;
}) {
  const [preview, setPreview] = useState<{ markdown: string; filename: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const markdown = async () => {
    setBusy(true);
    try {
      const res = await renderMarkdownAction({ articleId, html: getHtml(), title, metaDescription, featuredImageUrl });
      if (!res.ok) throw new Error(res.error);
      return res;
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text: string, done: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(done);
    } catch {
      toast.error("Could not reach the clipboard. Click into the page and try again.");
    }
  };

  const download = (text: string, filename: string) => {
    const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const guard = (fn: () => Promise<void>) => () =>
    fn().catch((err) => toast.error(err instanceof Error ? err.message : "Export failed"));

  return (
    <>
      <DropMenu
        label={busy ? "Exporting…" : "Export"}
        icon={<Icons.download size={13} />}
        disabled={busy}
        align="right"
        items={[
          {
            id: "md",
            label: "Export as Markdown",
            onSelect: guard(async () => {
              const r = await markdown();
              setPreview({ markdown: r.markdown, filename: r.filename });
            }),
          },
          {
            id: "copy-html",
            label: "Copy to clipboard: HTML",
            onSelect: guard(() => copy(getHtml(), "Copied the article as HTML.")),
          },
          {
            id: "copy-md",
            label: "Copy to clipboard: Markdown",
            onSelect: guard(async () => {
              const r = await markdown();
              await copy(r.markdown, "Copied the article as Markdown, front matter included.");
            }),
          },
          {
            id: "download",
            label: "Download .md",
            onSelect: guard(async () => {
              const r = await markdown();
              download(r.markdown, r.filename);
            }),
          },
        ]}
      />
      <Dialog
        open={preview !== null}
        onOpenChange={(o) => !o && setPreview(null)}
        title="Markdown export"
        description="Front matter included: this is the file a git publish would commit."
        className="max-w-[720px]"
      >
        {preview && (
          <>
            <pre className="max-h-[55vh] overflow-auto rounded-[8px] border border-line bg-panel p-3 font-mono text-[12px] leading-[1.5] whitespace-pre-wrap break-words">
              {preview.markdown}
            </pre>
            <div className="mt-3 flex justify-end gap-1.5">
              <Button size="sm" onClick={() => copy(preview.markdown, "Copied.")}>
                Copy
              </Button>
              <Button size="sm" variant="accent" onClick={() => download(preview.markdown, preview.filename)}>
                <Icons.download size={12} />
                Download {preview.filename}
              </Button>
            </div>
          </>
        )}
      </Dialog>
    </>
  );
}
