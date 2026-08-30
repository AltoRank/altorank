"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
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
        startTransition(async () => {
          await updateKeywordStatus(keywordId, "planned");
          router.refresh();
        })
      }
    >
      <Icons.plus size={13} />
    </IconButton>
  );
}
