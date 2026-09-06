"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button, Dialog, Icons } from "@/components/ui";
import { ShareCardView } from "@/components/share/card-view";
import { CARD_WIDTH, CARD_HEIGHT, type ShareCard } from "@/lib/share/card";

/**
 * "Share results": the card in a dialog, with copy and download.
 *
 * The preview is the real 1200x630 node scaled down with a transform, and a
 * second, unscaled copy sits off-screen for rasterising: html-to-image reads
 * layout, and a transformed node would hand back a picture of the transform.
 * Both are `ShareCardView`, so what you see is what you copy.
 */
export function ShareResults({ card, ogPath }: { card: ShareCard; ogPath: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<"copy" | "download" | null>(null);
  const fullRef = useRef<HTMLDivElement>(null);
  const PREVIEW_WIDTH = 440;
  const scale = PREVIEW_WIDTH / CARD_WIDTH;

  async function rasterise(): Promise<Blob> {
    if (!fullRef.current) throw new Error("Nothing to render yet.");
    const { toBlob } = await import("html-to-image");
    const blob = await toBlob(fullRef.current, { width: CARD_WIDTH, height: CARD_HEIGHT, pixelRatio: 1, cacheBust: true });
    if (!blob) throw new Error("Could not render the image.");
    return blob;
  }

  async function copy() {
    setBusy("copy");
    try {
      if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
        throw new Error("This browser cannot copy images. Download the PNG instead.");
      }
      const blob = await rasterise();
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      toast.success("Image copied.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Copy failed.");
    } finally {
      setBusy(null);
    }
  }

  async function download() {
    setBusy("download");
    try {
      const blob = await rasterise();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${card.domain || "site"}-altorank.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5_000);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Download failed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Icons.upload size={14} />
        Share results
      </Button>

      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Share results"
        description="A 1200×630 image of what this site has measured. Unmeasured figures are left off rather than shown as zero."
        className="max-w-[520px]"
      >
        <div className="flex flex-col gap-3">
          <div
            className="overflow-hidden rounded-lg border border-line"
            style={{ width: PREVIEW_WIDTH, height: CARD_HEIGHT * scale }}
          >
            <ShareCardView card={card} style={{ transform: `scale(${scale})`, transformOrigin: "top left" }} />
          </div>

          {card.omitted.length > 0 && (
            <p className="m-0 text-[12px] leading-relaxed text-ink-3">
              Not on the card: {card.omitted.join("; ")}.
            </p>
          )}

          <div className="flex items-center justify-between gap-2 pt-1">
            <a href={ogPath} target="_blank" rel="noreferrer" className="text-[12px] text-ink-3 underline decoration-line underline-offset-[3px]">
              Open as image
            </a>
            <div className="flex gap-2">
              <Button onClick={copy} disabled={busy !== null}>
                {busy === "copy" ? "Copying…" : "Copy image"}
              </Button>
              <Button variant="accent" onClick={download} disabled={busy !== null}>
                <Icons.download size={13} />
                {busy === "download" ? "Rendering…" : "Download PNG"}
              </Button>
            </div>
          </div>
        </div>

        {/* Unscaled, off-screen, and only while the dialog is open. */}
        <div aria-hidden style={{ position: "fixed", left: -10_000, top: 0, pointerEvents: "none" }}>
          <div ref={fullRef}>
            <ShareCardView card={card} />
          </div>
        </div>
      </Dialog>
    </>
  );
}
