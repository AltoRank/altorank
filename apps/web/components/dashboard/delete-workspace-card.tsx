"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button, Card } from "@/components/ui";
import { deleteWorkspace } from "@/app/actions/workspaces";

/**
 * Delete a workspace, from its Settings tab. Owners and admins only; the page
 * does not render it for anyone else, and the action refuses them anyway.
 * The person types the domain to confirm (lib/workspaces/delete.ts).
 */
export function DeleteWorkspaceCard({
  workspaceId,
  confirmText,
}: {
  workspaceId: string;
  /** The domain, or the name for a site without one. */
  confirmText: string;
}) {
  const router = useRouter();
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const matches = typed.trim().toLowerCase() === confirmText.trim().toLowerCase();

  function remove() {
    setError(null);
    startTransition(async () => {
      const result = await deleteWorkspace(workspaceId, typed);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      toast.success(`${confirmText} deleted. Its slot on your plan is free.`);
      router.push("/workspaces");
      router.refresh();
    });
  }

  return (
    <Card className="p-5" flush>
      <h3 className="text-[13px] font-medium mb-1.5">Delete workspace</h3>
      <p className="text-[12.5px] text-ink-2 leading-[1.5] mb-3">
        Deletes this site with its articles, keywords, calendar, reports and connections. This cannot be undone,
        and nothing already published on your site is touched. It frees the workspace&apos;s slot on your plan.
      </p>
      <label className="block text-[11.5px] text-ink-3 mb-1.5" htmlFor={`delete-${workspaceId}`}>
        Type <span className="font-mono text-ink">{confirmText}</span> to confirm
      </label>
      <div className="flex gap-2">
        <input
          id={`delete-${workspaceId}`}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          className="flex-1 px-2.5 py-1.5 bg-bg border border-line rounded-[7px] text-[13px] font-mono focus:outline-0 focus:border-accent"
        />
        <Button size="sm" onClick={remove} disabled={!matches || pending}>
          {pending ? "Deleting…" : "Delete workspace"}
        </Button>
      </div>
      {error && <p className="mt-2 text-[12px] text-err-ink">{error}</p>}
    </Card>
  );
}
