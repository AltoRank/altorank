"use client";

import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { IconButton } from "@/components/ui/button";
import { Icons } from "@/components/ui";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { updateArticle, deleteArticle } from "@/app/actions/articles";
import { publishArticle, retryPublish, holdArticle, releaseHold } from "@/app/actions/publish";

interface ArticleRowMenuProps {
  articleId: string;
  currentStatus: string;
  /**
   * The article's workspace has a CMS connected, so "Publish now" can go out
   * from this row. Without one the item still appears for an approved article
   * but opens the editor, where the copy-and-record path lives; publishing
   * from a list an article nobody can see published would be a guess.
   */
  canPublish?: boolean;
  /**
   * Where "Publish now" would send it, for the confirmation. A row menu is a
   * one-click distance from a live customer site, so the site is named in the
   * button that does it.
   */
  publishTarget?: string | null;
  /**
   * The article's last publish attempt failed. "Retry publish" replaces
   * "Publish now": same article, same connection, one more log row.
   */
  canRetry?: boolean;  /** A person held this review draft, so the workspace rule skips it (079). */
  held?: boolean;
  /** The workspace publishes automatically, so Hold is a meaningful action on a review draft. */
  autoApprove?: boolean;
}

/** Tallest the menu gets, with the status submenu open. */
const MENU_MAX_HEIGHT = 280;

export function ArticleRowMenu({ articleId, currentStatus, canPublish = false, publishTarget = null, canRetry = false, held = false, autoApprove = false }: ArticleRowMenuProps) {
  const [open, setOpen] = useState(false);
  /**
   * Publishing writes to a live site and cannot be taken back by closing a
   * menu, so it asks first. Delete already did; publish - the one item here
   * that changes something outside this product - did not.
   */
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [showStatusMenu, setShowStatusMenu] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  /**
   * Where to draw the menu, in viewport coordinates.
   *
   * It used to be positioned `absolute` inside the row, which put it inside
   * Card, which sets `overflow-hidden` so a table's corners do not poke
   * through its rounded border. The menu was therefore clipped to the card and
   * the last row's menu was mostly invisible. Card cannot stop clipping
   * without squaring off every table it holds, so the menu leaves the card
   * instead: a portal to document.body, positioned from the button's rect.
   */
  const [anchor, setAnchor] = useState<{ top?: number; bottom?: number; right: number } | null>(null);
  const buttonRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setShowStatusMenu(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    // The menu is fixed to the viewport, so a scroll would leave it behind the
    // row it belongs to. Close instead of tracking: a menu that follows the
    // page is more surprising than one that dismisses.
    const close = () => { setOpen(false); setShowStatusMenu(false); };
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  /**
   * Which item is mid-flight, so the menu can say so. Status change and
   * delete used to await their action with no pending state and no catch:
   * the menu sat there looking idle, a second click queued a second call,
   * and a failure (RLS, a row already gone) vanished into the console while
   * the row stayed exactly as it was. Every branch now disables its item,
   * relabels it, and reports a failure where the person is looking.
   */
  const [busy, setBusy] = useState<"status" | "delete" | "hold" | null>(null);

  async function handleStatusChange(status: string) {
    if (busy) return;
    setBusy("status");
    try {
      await updateArticle(articleId, { status });
      setOpen(false);
      setShowStatusMenu(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not change the status");
    } finally {
      setBusy(null);
    }
  }

  // Approved and connected: publish from here, through the workspace's
  // default destination, the same one the scheduler would use. Approved and
  // not connected: the editor has the copy buttons and the URL field.
  async function handlePublish() {
    if (!canPublish) {
      router.push(`/content/${articleId}`);
      setOpen(false);
      return;
    }
    setPublishing(true);
    try {
      const result = await publishArticle(articleId);
      toast.success("Published", result?.url ? { description: result.url } : undefined);
      setOpen(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to publish");
    } finally {
      setPublishing(false);
    }
  }

  async function handleRetry() {
    setPublishing(true);
    try {
      const result = await retryPublish(articleId);
      toast.success(
        result.publishMode === "draft" ? "Saved as a draft this time" : "Published this time",
        result?.url ? { description: result.url } : undefined,
      );
      setOpen(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The retry failed too");
    } finally {
      setPublishing(false);
    }
  }

  async function handleDelete() {
    if (busy) return;
    if (!confirm("Delete this article? This cannot be undone.")) return;
    setBusy("delete");
    try {
      await deleteArticle(articleId);
      setOpen(false);
      toast.success("Article deleted");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not delete the article");
    } finally {
      setBusy(null);
    }
  }

  const menuItemClass = "w-full text-left px-3 py-2 text-[13px] hover:bg-panel-2 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-progress";

  return (
    <div className="relative" ref={ref}>
      <div ref={buttonRef} className="inline-flex">
      <IconButton
        ghost
        onClick={(e) => {
          e.stopPropagation();
          const r = buttonRef.current?.getBoundingClientRect();
          if (r) {
            // Flip up when there is not room below. The row that needed this
            // fix most is the last one in the table, which is exactly the row
            // with no space under it: escaping the card only to fall off the
            // viewport is not a fix.
            const below = window.innerHeight - r.bottom;
            setAnchor(
              below < MENU_MAX_HEIGHT
                ? { bottom: window.innerHeight - r.top + 4, right: window.innerWidth - r.right }
                : { top: r.bottom + 4, right: window.innerWidth - r.right },
            );
          }
          setOpen(!open);
          setShowStatusMenu(false);
        }}
      >
        <Icons.more size={14} />
      </IconButton>
      </div>

      <ConfirmDialog
        open={confirmPublish}
        onOpenChange={setConfirmPublish}
        title="Publish this article?"
        body={
          publishTarget
            ? `It goes out to ${publishTarget} now. Taking it down again means unpublishing it from the editor, and anyone who saw it in the meantime saw it.`
            : "It goes out to the connected site now. Taking it down again means unpublishing it from the editor, and anyone who saw it in the meantime saw it."
        }
        confirmLabel={publishTarget ? `Publish to ${publishTarget} now` : "Publish to the live site now"}
        pendingLabel="Publishing…"
        onConfirm={handlePublish}
      />

      {open && anchor && createPortal(
        <div
          ref={ref}
          style={{
            position: "fixed",
            ...(anchor.top !== undefined ? { top: anchor.top } : { bottom: anchor.bottom }),
            right: anchor.right,
          }}
          className="z-[80] bg-bg border border-line rounded-lg shadow-lg py-1 min-w-[160px]">
          <button
            className={menuItemClass}
            onClick={(e) => {
              e.stopPropagation();
              router.push(`/content/${articleId}`);
              setOpen(false);
            }}
          >
            Edit
          </button>
          {canRetry && (
            <button
              className={`${menuItemClass} font-medium text-accent-ink`}
              disabled={publishing}
              onClick={(e) => {
                e.stopPropagation();
                void handleRetry();
              }}
            >
              {publishing ? "Retrying…" : "Retry publish"}
            </button>
          )}
          {currentStatus === "approved" && !canRetry && (
            <button
              className={`${menuItemClass} ${canPublish ? "font-medium text-accent-ink" : ""}`}
              disabled={publishing}
              onClick={(e) => {
                e.stopPropagation();
                // Nothing to confirm when the item only opens the editor.
                if (!canPublish) {
                  void handlePublish();
                  return;
                }
                setConfirmPublish(true);
              }}
            >
              {publishing ? "Publishing…" : canPublish ? "Publish now" : "Publish…"}
            </button>
          )}
          <button
            className={menuItemClass}
            disabled={busy !== null}
            aria-busy={busy === "status" || undefined}
            onClick={(e) => {
              e.stopPropagation();
              setShowStatusMenu(!showStatusMenu);
            }}
          >
            {busy === "status" ? "Changing status…" : <>Change status &rsaquo;</>}
          </button>
          {currentStatus === "review" && (held || autoApprove) && (
            <button
              className={menuItemClass}
              disabled={busy !== null}
              onClick={(e) => {
                e.stopPropagation();
                setBusy("hold");
                (held ? releaseHold(articleId) : holdArticle(articleId))
                  .then(() => {
                    toast.success(held ? "Released. The rule may publish it after its hold." : "Held. It waits for someone to approve it.");
                    setOpen(false);
                    router.refresh();
                  })
                  .catch((err) => toast.error(err instanceof Error ? err.message : "Could not update the hold"))
                  .finally(() => setBusy(null));
              }}
            >
              {busy === "hold" ? "Saving…" : held ? "Release hold" : "Hold"}
            </button>
          )}
          <div className="border-t border-line my-1" />
          <button
            className={`${menuItemClass} text-[var(--err)]`}
            disabled={busy !== null}
            aria-busy={busy === "delete" || undefined}
            onClick={(e) => {
              e.stopPropagation();
              void handleDelete();
            }}
          >
            {busy === "delete" ? "Deleting…" : "Delete"}
          </button>

          {showStatusMenu && (
            <div className="absolute left-full top-0 ml-1 bg-bg border border-line rounded-lg shadow-lg py-1 min-w-[130px]">
              {/* Publishing, scheduling, and approval go through their actions
                  (approveArticle records the sign-off) — not a raw status flip —
                  so 'approved'/'live'/'scheduled' aren't settable here. */}
              {["draft", "review"].map((s) => (
                <button
                  key={s}
                  className={`${menuItemClass} ${s === currentStatus ? "font-medium text-accent-ink" : ""}`}
                  disabled={busy !== null}
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleStatusChange(s);
                  }}
                >
                  {s.charAt(0).toUpperCase() + s.slice(1)}
                </button>
              ))}
            </div>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
