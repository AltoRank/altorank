"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button, Card } from "@/components/ui";
import { saveOutputSettings } from "@/app/actions/onboarding-wizard";
import type { OutputSettings } from "@/lib/onboarding/output-settings";
import { ApprovalGateCard, OutputFields } from "./output-fields";

/** The wizard's Articles screen as a settings card, approval gate included. */
export function OutputForm({ workspaceId, initial }: { workspaceId: string; initial: OutputSettings }) {
  const router = useRouter();
  const [output, setOutput] = useState<OutputSettings>(initial);
  const [pending, start] = useTransition();
  const dirty = JSON.stringify(output) !== JSON.stringify(initial);

  function save() {
    start(async () => {
      try {
        await saveOutputSettings(workspaceId, output);
        toast.success("Saved. Drafts written from now on follow these.");
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not save.");
      }
    });
  }

  return (
    <Card title="How your articles should read">
      <div className="flex flex-col gap-4">
        <ApprovalGateCard />
        <OutputFields output={output} setOutput={setOutput} />
      </div>
      <div className="mt-4 flex items-center justify-end gap-3">
        <span className="text-[12px] text-ink-3">Applies to new drafts. Existing articles are not rewritten.</span>
        <Button variant="accent" onClick={save} disabled={pending || !dirty}>
          {pending ? "Saving…" : "Save"}
        </Button>
      </div>
    </Card>
  );
}
