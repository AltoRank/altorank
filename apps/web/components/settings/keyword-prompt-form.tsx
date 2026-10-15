"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button, Card } from "@/components/ui";
import { saveKeywordPrompt } from "@/app/actions/onboarding-wizard";
import { Field, inputClass } from "./fields";

/**
 * What the field does, scoped to its real readers. readKeywordInstructions
 * (lib/keyword-research/instructions.ts) is called only by the Research
 * keywords drawer and Playbooks (app/actions/keyword-research.ts). The
 * research that runs by itself, at setup (lib/audit/domain-analysis.ts) and
 * when the queue is topped up, never reads it, so "research follows these"
 * was true of one door out of three.
 */
export const KEYWORD_PROMPT_HINT =
  "Describe the topics, angles, or audiences that matter most to you. Research keywords and Playbooks on the Keywords page start every search from this. The research that runs on its own, at setup and when the queue runs low, does not read it yet; the audiences and competitors you confirmed steer that.";

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
        toast.success("Saved. Research keywords and Playbooks read this first.");
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
        hint={KEYWORD_PROMPT_HINT}
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
