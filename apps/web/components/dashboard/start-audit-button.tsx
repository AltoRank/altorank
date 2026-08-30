"use client";

import { useTransition } from "react";
import { startDomainAudit } from "@/app/actions/audit";
import { Button, Icons } from "@/components/ui";

export function StartAuditButton({ workspaceId }: { workspaceId: string }) {
  const [pending, startTransition] = useTransition();

  return (
    <Button
      size="sm"
      variant="accent"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await startDomainAudit(workspaceId);
        })
      }
    >
      <Icons.plus size={13} />
      {pending ? "Starting…" : "Run audit"}
    </Button>
  );
}
