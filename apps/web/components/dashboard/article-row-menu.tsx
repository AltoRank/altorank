"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { IconButton } from "@/components/ui/button";
import { Icons } from "@/components/ui";
import { updateArticle, deleteArticle } from "@/app/actions/articles";

interface ArticleRowMenuProps {
  articleId: string;
  currentStatus: string;
}

export function ArticleRowMenu({ articleId, currentStatus }: ArticleRowMenuProps) {
  const [open, setOpen] = useState(false);
  const [showStatusMenu, setShowStatusMenu] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
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
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  async function handleStatusChange(status: string) {
    await updateArticle(articleId, { status });
    setOpen(false);
    setShowStatusMenu(false);
    router.refresh();
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
      <IconButton
        ghost
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
          setShowStatusMenu(false);
        }}
      >
        <Icons.more size={14} />
      </IconButton>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 bg-bg border border-line rounded-lg shadow-lg py-1 min-w-[160px]">
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
        </div>
      )}
    </div>
  );
}
