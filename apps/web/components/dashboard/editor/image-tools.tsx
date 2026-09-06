"use client";

import { useRef, useState } from "react";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { toast } from "sonner";
import { Icons } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  regenerateImageAction,
  uploadArticleImageAction,
  discardProposedImageAction,
} from "@/app/actions/editor-ai";
import { surroundingParagraph } from "@/lib/editor/proposals";
import { useEditorAi } from "./editor-ai-context";

// ---------------------------------------------------------------------------
// Images: the featured one and every one in the body
// ---------------------------------------------------------------------------
//
// Upload · Download · Regenerate · Ask AI · Remove, the same five on both. A
// regenerated or uploaded image is a proposal shown beside the current one;
// Accept swaps it in (staged), Discard deletes the file it made. Remove is
// immediate but staged like everything else: nothing reaches the database
// until Save.

type Proposal = { url: string; path: string };

/** The five actions and the proposal card, shared by both image kinds. */
function useImageActions(opts: {
  articleId: string;
  currentUrl: string | null;
  context: string;
  onAccept: (url: string) => void;
}) {
  const [busy, setBusy] = useState<"regenerate" | "upload" | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [asking, setAsking] = useState(false);
  const [prompt, setPrompt] = useState("");

  const regenerate = async (instruction?: string) => {
    setBusy("regenerate");
    try {
      const res = await regenerateImageAction({ articleId: opts.articleId, context: opts.context, instruction });
      if (!res.ok) throw new Error(res.error);
      if (proposal) void discardProposedImageAction({ articleId: opts.articleId, path: proposal.path });
      setProposal({ url: res.url, path: res.path });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Image generation failed");
    } finally {
      setBusy(null);
      setAsking(false);
      setPrompt("");
    }
  };

  const upload = async (file: File) => {
    setBusy("upload");
    try {
      const fd = new FormData();
      fd.set("articleId", opts.articleId);
      fd.set("file", file);
      const res = await uploadArticleImageAction(fd);
      if (!res.ok) throw new Error(res.error);
      if (proposal) void discardProposedImageAction({ articleId: opts.articleId, path: proposal.path });
      setProposal({ url: res.url, path: res.path });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(null);
    }
  };

  const download = async () => {
    if (!opts.currentUrl) return;
    try {
      // Fetch first: a cross-origin `download` attribute is ignored by
      // browsers, so a plain link would only open the image.
      const blob = await (await fetch(opts.currentUrl)).blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = opts.currentUrl.split("/").pop()?.split("?")[0] || "image";
      a.click();
      URL.revokeObjectURL(a.href);
    } catch {
      window.open(opts.currentUrl, "_blank", "noopener");
    }
  };

  const accept = () => {
    if (!proposal) return;
    opts.onAccept(proposal.url);
    setProposal(null);
  };
  const discard = () => {
    if (!proposal) return;
    void discardProposedImageAction({ articleId: opts.articleId, path: proposal.path });
    setProposal(null);
  };

  return { busy, proposal, asking, setAsking, prompt, setPrompt, regenerate, upload, download, accept, discard };
}

function ImageToolbar({
  a,
  hasImage,
  onRemove,
  className,
}: {
  a: ReturnType<typeof useImageActions>;
  hasImage: boolean;
  onRemove: () => void;
  className?: string;
}) {
  // The file input lives here, not in the hook: an object that carries a ref
  // reads as a ref to the React Compiler, and every `a.busy` became an error.
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <div className={cn("flex flex-wrap items-center gap-1", className)}>
      <input
        ref={fileRef}
        type="file"
        accept="image/webp,image/png,image/jpeg"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void a.upload(f);
          e.target.value = "";
        }}
      />
      <Tool icon={<Icons.upload size={12} />} label={a.busy === "upload" ? "Uploading…" : "Upload"} onClick={() => fileRef.current?.click()} disabled={!!a.busy} />
      <Tool icon={<Icons.download size={12} />} label="Download" onClick={a.download} disabled={!hasImage || !!a.busy} />
      <Tool icon={<Icons.refresh size={12} />} label={a.busy === "regenerate" ? "Generating…" : "Regenerate"} onClick={() => a.regenerate()} disabled={!!a.busy} />
      <Tool icon={<Icons.sparkle size={12} />} label="Ask AI" onClick={() => a.setAsking((v) => !v)} disabled={!!a.busy} active={a.asking} />
      <Tool icon={<Icons.x size={12} />} label="Remove" onClick={onRemove} disabled={!hasImage || !!a.busy} />
      {a.asking && (
        <div className="mt-1 flex w-full items-center gap-1.5">
          <input
            autoFocus
            value={a.prompt}
            onChange={(e) => a.setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && a.prompt.trim()) {
                e.preventDefault();
                void a.regenerate(a.prompt.trim());
              }
            }}
            placeholder="Describe the image you want"
            aria-label="Image instruction"
            className="flex-1 rounded-[6px] border border-line bg-bg px-2 py-1 text-[12.5px] focus:outline-0 focus:border-accent"
          />
          <Button size="sm" variant="accent" disabled={!a.prompt.trim() || !!a.busy} onClick={() => a.regenerate(a.prompt.trim())}>
            Generate
          </Button>
        </div>
      )}
    </div>
  );
}

function Tool({ icon, label, onClick, disabled, active }: { icon: React.ReactNode; label: string; onClick: () => void; disabled?: boolean; active?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex items-center gap-1 rounded-[6px] px-2 py-1 text-[11.5px] text-ink-2 hover:bg-panel-2 hover:text-ink disabled:opacity-40 disabled:pointer-events-none",
        active && "bg-panel-2 text-ink",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function ImageProposal({ current, proposed, onAccept, onDiscard }: { current: string | null; proposed: string; onAccept: () => void; onDiscard: () => void }) {
  return (
    <div className="mt-2 rounded-[8px] border border-accent-soft bg-accent-soft/40 p-2.5">
      <div className="grid grid-cols-2 gap-2">
        <figure className="m-0">
          <figcaption className="mb-1 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-4">Current</figcaption>
          {current ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={current} alt="" className="aspect-[3/2] w-full rounded-[6px] object-cover opacity-70" />
          ) : (
            <div className="grid aspect-[3/2] w-full place-items-center rounded-[6px] bg-panel-2 text-[11.5px] text-ink-4">No image</div>
          )}
        </figure>
        <figure className="m-0">
          <figcaption className="mb-1 font-mono text-[10px] uppercase tracking-[0.08em] text-accent-ink">Proposed</figcaption>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={proposed} alt="" className="aspect-[3/2] w-full rounded-[6px] object-cover" />
        </figure>
      </div>
      <div className="mt-2 flex justify-end gap-1.5">
        <Button size="sm" variant="ghost" onClick={onDiscard}>
          Discard
        </Button>
        <Button size="sm" variant="accent" onClick={onAccept}>
          <Icons.check size={12} />
          Use this image
        </Button>
      </div>
    </div>
  );
}

// --- Featured image ------------------------------------------------------------

export function FeaturedImage({
  articleId,
  url,
  onChange,
}: {
  articleId: string;
  url: string | null;
  /** Staged: the editor's Save writes it. */
  onChange: (next: string | null) => void;
}) {
  const a = useImageActions({ articleId, currentUrl: url, context: "", onAccept: (u) => onChange(u) });
  return (
    <div className="mb-6">
      <div className="mb-1 flex items-center gap-2">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-3">Featured image</span>
      </div>
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="" className="aspect-[3/2] w-full rounded-[8px] border border-line object-cover" />
      ) : (
        <div className="grid aspect-[3/1] w-full place-items-center rounded-[8px] border border-dashed border-line text-[12.5px] text-ink-3">
          No featured image. Upload one or let the AI draw it.
        </div>
      )}
      <ImageToolbar a={a} hasImage={!!url} onRemove={() => onChange(null)} className="mt-1.5" />
      {a.proposal && <ImageProposal current={url} proposed={a.proposal.url} onAccept={a.accept} onDiscard={a.discard} />}
    </div>
  );
}

// --- In-body image node view ---------------------------------------------------

/**
 * Drawn by Tiptap for every `image` node. The alt text is the node's own
 * attribute, so it travels with the document and is what the Markdown export
 * and the published page get.
 */
export function ImageNodeView({ node, updateAttributes, deleteNode, selected }: NodeViewProps) {
  const { articleId, mode, docHtml, onBodyChange } = useEditorAi();
  const src = (node.attrs.src as string | null) ?? "";
  const alt = (node.attrs.alt as string | null) ?? "";
  const [editingAlt, setEditingAlt] = useState(false);
  const a = useImageActions({
    articleId,
    currentUrl: src || null,
    context: surroundingParagraph(docHtml, src),
    onAccept: (u) => {
      updateAttributes({ src: u });
      onBodyChange();
    },
  });

  return (
    <NodeViewWrapper className={cn("my-4 rounded-[8px]", selected && "ring-2 ring-accent-soft")} data-drag-handle>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={alt} className="w-full rounded-[8px]" />
      ) : (
        <div className="grid aspect-[3/1] w-full place-items-center rounded-[8px] bg-panel-2 text-[12.5px] text-ink-3">Image removed</div>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-2" contentEditable={false}>
        {editingAlt || mode === "editor" ? (
          <input
            value={alt}
            onChange={(e) => updateAttributes({ alt: e.target.value })}
            onBlur={() => {
              setEditingAlt(false);
              onBodyChange();
            }}
            aria-label="Alt text"
            placeholder="Alt text: what the image shows"
            className="min-w-[240px] flex-1 rounded-[6px] border border-line bg-bg px-2 py-1 text-[12px] focus:outline-0 focus:border-accent"
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditingAlt(true)}
            className="inline-flex items-center gap-1 rounded-[6px] px-2 py-1 text-[11.5px] text-ink-3 hover:bg-panel-2 hover:text-ink"
          >
            <Icons.edit size={11} />
            {alt ? <span className="truncate max-w-[320px]">Alt: {alt}</span> : "Edit alt text"}
          </button>
        )}
        <ImageToolbar
          a={a}
          hasImage={!!src}
          onRemove={() => {
            deleteNode();
            onBodyChange();
          }}
        />
      </div>
      {a.proposal && (
        <div contentEditable={false}>
          <ImageProposal current={src || null} proposed={a.proposal.url} onAccept={a.accept} onDiscard={a.discard} />
        </div>
      )}
    </NodeViewWrapper>
  );
}
