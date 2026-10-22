"use client";

import { useActionState } from "react";
import { regenerateDraftAction, type RegenerateState } from "@/app/actions/admin-regenerate";
import { Button } from "@/components/ui/button";

/** One form per row, like the Users tab's View as. */
export function RegenerateButton({ articleId, title, disabledReason }: { articleId: string; title: string; disabledReason?: string }) {
  const [state, action, pending] = useActionState<RegenerateState, FormData>(regenerateDraftAction, null);
  const started = state !== null && "ok" in state;
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!window.confirm(`Rewrite "${title}" in place? The current text is replaced and not kept.`)) e.preventDefault();
      }}
      className="flex flex-col items-end gap-1"
    >
      <input type="hidden" name="articleId" value={articleId} />
      <Button type="submit" size="sm" disabled={Boolean(disabledReason) || pending || started} title={disabledReason} aria-label={`Regenerate ${title}`}>
        {pending ? "Starting…" : started ? "Started" : "Regenerate"}
      </Button>
      {state && (
        <span role={"error" in state ? "alert" : "status"} className={`max-w-[280px] text-right text-[11px] leading-snug ${"error" in state ? "text-err-ink" : "text-ink-3"}`}>
          {"error" in state ? state.error : state.ok}
        </span>
      )}
    </form>
  );
}
