"use client";

import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { IconButton } from "@/components/ui/button";
import { Icons } from "@/components/ui";
import { updateArticle, deleteArticle } from "@/app/actions/articles";
import { publishArticle } from "@/app/actions/publish";

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
}

/** Tallest the menu gets, with the status submenu open. */
const MENU_MAX_HEIGHT = 280;

export function ArticleRowMenu({ articleId, currentStatus, canPublish = false }: ArticleRowMenuProps) {
  const [open, setOpen] = useState(false);
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

  async function handleStatusChange(status: string) {
    await updateArticle(articleId, { status });
    setOpen(false);
    setShowStatusMenu(false);
    router.refresh();
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

  async function handleDelete() {
    if (!confirm("Delete this article? This cannot be undone.")) return;
    await deleteArticle(articleId);
    setOpen(false);
    router.refresh();
  }

  const menuItemClass = "w-full text-left px-3 py-2 text-[13px] hover:bg-panel-2 transition-colors cursor-pointer";

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
          {currentStatus === "approved" && (
            <button
              className={`${menuItemClass} ${canPublish ? "font-medium text-accent-ink" : ""}`}
              disabled={publishing}
              onClick={(e) => {
                e.stopPropagation();
                void handlePublish();
              }}
            >
              {publishing ? "Publishing…" : canPublish ? "Publish now" : "Publish…"}
            </button>
          )}
          <button
            className={menuItemClass}
            onClick={(e) => {
              e.stopPropagation();
              setShowStatusMenu(!showStatusMenu);
            }}
          >
            Change status &rsaquo;
          </button>
          <div className="border-t border-line my-1" />
          <button
            className={`${menuItemClass} text-[var(--err)]`}
            onClick={(e) => {
              e.stopPropagation();
              handleDelete();
            }}
          >
            Delete
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
                  onClick={(e) => {
                    e.stopPropagation();
                    handleStatusChange(s);
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
