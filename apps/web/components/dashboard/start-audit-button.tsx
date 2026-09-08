"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { startDomainAudit } from "@/app/actions/audit";
import { Button, Icons } from "@/components/ui";

/**
 * `startDomainAudit` goes to some trouble to fail well: it marks the audit row
 * failed and throws "Could not start the audit. Please try again." That
 * sentence went nowhere. The transition had no catch, so a refusal and a
 * success looked identical - the spinner stopped, nothing appeared, and the
 * only sign was a row reading "Failed" after a manual reload.
 *
 * Two shapes of refusal reach here now, and both are said out loud. A worker
 * that would not start still throws. A billing refusal - out of free drafts,
 * account paused, card past due - comes back as data, because a thrown
 * server-action message is a hex digest in production and the whole point of
 * that one is the sentence it carries.
 */
export function StartAuditButton({ workspaceId }: { workspaceId: string }) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  return (
    <Button
      size="sm"
      variant="accent"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          try {
            const res = await startDomainAudit(workspaceId);
            if (!res.ok) {
              toast.error(res.error, { duration: 12_000 });
              return;
            }
            router.refresh();
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
