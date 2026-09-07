"use client";

// ---------------------------------------------------------------------------
// A detail page is about one site; the sidebar should agree
// ---------------------------------------------------------------------------
//
// The scope cookie names the site the person is looking at, and every list
// page reads it. A detail page (/content/[id], /improvements/[id]) is
// addressed by row id instead, so a link from an email, a share, or another
// site's list opens fine while the cookie still names the previous site: the
// sidebar, the switcher and every "Back to …" list then belong to one site
// while the page belongs to another (PM-A-P1-1, 2026-09-06).
//
// Refusing the page (404 unless the cookie matches) would break exactly those
// links, and there is nothing wrong with the visit - both sites are theirs.
// So the page tells the scope which site it is about, the same way the
// switcher does, and the server tree re-renders under it. One effect, no UI.

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useWorkspace } from "./workspace-context";

/**
 * Whether the scope has to move: only to a site the account can see (a
 * foreign id is left alone; the page itself already 404s or shows nothing),
 * and only when it is not already there.
 */
export function scopeShouldMove(activeId: string | null | undefined, visibleIds: readonly string[], workspaceId: string): boolean {
  return visibleIds.includes(workspaceId) && activeId !== workspaceId;
}

export function ScopeFollow({ workspaceId }: { workspaceId: string }) {
  const { active, setActiveId, workspaces } = useWorkspace();
  const router = useRouter();
  const mismatch = scopeShouldMove(active?.id, workspaces.map((w) => w.id), workspaceId);

  useEffect(() => {
    if (!mismatch) return;
    setActiveId(workspaceId);
    router.refresh();
  }, [mismatch, workspaceId, setActiveId, router]);

  return null;
}
