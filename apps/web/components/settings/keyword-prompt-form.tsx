"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button, Card } from "@/components/ui";
import { saveKeywordPrompt } from "@/app/actions/onboarding-wizard";
import { Field, inputClass } from "./fields";

/** `workspace_output_settings.global_keyword_prompt`, the research brief. */
export function KeywordPromptForm({ workspaceId, initial }: { workspaceId: string; initial: string }) {
  const router = useRouter();
  const [prompt, setPrompt] = useState(initial);
  const [pending, start] = useTransition();
  const dirty = prompt !== initial;

  function save() {
    start(async () => {
      try {
        await saveKeywordPrompt(workspaceId, prompt);
        toast.success("Saved. The next research run reads this first.");
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not save.");
      }
    });
  }

  return (
    <Card title="What research should look for">
      <Field
        label="Topics, angles and audiences"
        hint="Describe the topics, angles, or audiences that matter most to you; research follows these. Optional, and the audiences and competitors you confirmed already steer it."
      >
        <textarea
          rows={5}
          className={`${inputClass} resize-none leading-[1.6]`}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="e.g. Focus on comparison and alternative-to queries for mid-market buyers; skip anything about enterprise procurement."
        />
      </Field>
      <div className="mt-4 flex justify-end">
        <Button variant="accent" onClick={save} disabled={pending || !dirty}>
          {pending ? "Saving…" : "Save"}
        </Button>
      </div>
    </Card>
  );
}
