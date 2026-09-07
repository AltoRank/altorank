"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { startDomainAudit } from "@/app/actions/audit";
import { Button, Icons } from "@/components/ui";

/**
 * `startDomainAudit` goes to some trouble to fail well: it marks the audit row
 * failed and throws "Could not start the audit. Please try again." That
 * sentence went nowhere. The transition had no catch, so a refusal and a
 * success looked identical - the spinner stopped, nothing appeared, and the
 * only sign was a row reading "Failed" after a manual reload.
 */
export function StartAuditButton({ workspaceId }: { workspaceId: string }) {
  const [pending, startTransition] = useTransition();

  return (
    <Button
      size="sm"
      variant="accent"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          try {
            await startDomainAudit(workspaceId);
          } catch (err) {
            toast.error(err instanceof Error ? err.message : "Could not start the audit.");
          }
        })
      }
    >
      <Icons.plus size={13} />
      {pending ? "Starting…" : "Run audit"}
    </Button>
  );
}
