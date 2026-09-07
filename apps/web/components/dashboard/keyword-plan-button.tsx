"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { IconButton } from "@/components/ui/button";
import { Icons } from "@/components/ui";
import { updateKeywordStatus } from "@/app/actions/keywords";
import { canAddToPlan, addToPlanBlockedReason } from "@/lib/keywords/lifecycle";

interface KeywordPlanButtonProps {
  keywordId: string;
  currentStatus: string;
}

export function KeywordPlanButton({ keywordId, currentStatus }: KeywordPlanButtonProps) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  // The guard used to name `planned` and `shipped` only, so a row that was
  // already `drafting` (its article being written), `scheduled` or `error`
  // still offered an enabled "+" that wrote `planned` - driving the keyword
  // backwards through its own lifecycle, with no toast and no pending state.
  if (!canAddToPlan(currentStatus)) {
    return (
      <IconButton ghost disabled title={addToPlanBlockedReason(currentStatus)}>
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
        startTransition(async () => {
          // Was a bare `await`: a refusal or a network failure inside a
          // transition is swallowed, so the user saw nothing either way.
          const res = await updateKeywordStatus(keywordId, "planned");
          if (res?.error) {
            toast.error(res.error);
            return;
          }
          toast.success("Added to the plan");
          router.refresh();
        })
      }
    >
      <Icons.plus size={13} />
    </IconButton>
  );
}
