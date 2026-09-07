"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { IconButton } from "@/components/ui/button";
import { Icons } from "@/components/ui";
import { updateKeywordStatus } from "@/app/actions/keywords";

interface KeywordPlanButtonProps {
  keywordId: string;
  currentStatus: string;
}

export function KeywordPlanButton({ keywordId, currentStatus }: KeywordPlanButtonProps) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  if (currentStatus === "planned" || currentStatus === "shipped") {
    return (
      <IconButton ghost disabled title="Already planned">
        <Icons.check size={13} />
      </IconButton>
    );
  }

  return (
    <IconButton
      ghost
      disabled={pending}
      title="Add to plan"
      onClick={() =>
        // A rejected action inside a transition with no catch is silent: the
        // button un-disables, the row does not change, and nothing says why.
        startTransition(async () => {
          try {
            await updateKeywordStatus(keywordId, "planned");
            router.refresh();
          } catch (err) {
            toast.error(err instanceof Error ? err.message : "Could not add this keyword to the plan.");
          }
        })
      }
    >
      <Icons.plus size={13} />
    </IconButton>
  );
}
