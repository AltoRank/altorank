"use client";

import { useTransition } from "react";
import { getReportUrl } from "@/app/actions/reports";
import { Button, Icons } from "@/components/ui";

export function OpenReportButton({ reportId }: { reportId: string }) {
  const [pending, startTransition] = useTransition();

  return (
    <Button
      size="sm"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const url = await getReportUrl(reportId);
          if (url) window.open(url, "_blank");
        })
      }
    >
      <Icons.externalLink size={13} />
      {pending ? "Loading…" : "Open"}
    </Button>
  );
}
