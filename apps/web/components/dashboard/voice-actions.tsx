"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Icons, Dialog } from "@/components/ui";
import { useOnboarding } from "@/components/onboarding/use-onboarding";
import { createVoiceProfile } from "@/app/actions/voice";
import type { Workspace } from "@/lib/types";

interface VoiceActionsProps {
  workspaces: Workspace[];
}

export function VoiceActions({ workspaces }: VoiceActionsProps) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const onboarding = useOnboarding();
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    try {
      const fd = new FormData(e.currentTarget);
      const workspaceId = fd.get("workspace_id") as string;
      const sampleText = fd.get("sample_text") as string;
      await createVoiceProfile(workspaceId, sampleText);
      setOpen(false);
      onboarding?.completeStep("train-voice");
      router.refresh();
    } catch (err) {
      console.error(err);
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Button
        variant="accent"
        data-onboarding="train-voice"
        onClick={() => setOpen(true)}
      >
        <Icons.plus size={14} />
        Train new voice
      </Button>

      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Train brand voice"
        description="Paste a writing sample and we'll extract tone, style, and structure rules."
      >
        <form onSubmit={handleSubmit} className="flex flex-col gap-3.5">
          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-medium text-ink-2">Workspace</span>
            <select
              name="workspace_id"
              required
              className="px-3 py-2 rounded-lg border border-line bg-panel text-[13px] text-ink outline-none focus:border-accent transition-colors"
            >
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-medium text-ink-2">Writing sample</span>
            <textarea
              name="sample_text"
              required
              rows={6}
              placeholder="Paste 2-3 paragraphs of your client's existing content…"
              className="px-3 py-2 rounded-lg border border-line bg-panel text-[13px] text-ink placeholder:text-ink-3 outline-none focus:border-accent transition-colors resize-none"
            />
          </label>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="accent" disabled={pending}>
              {pending ? "Training…" : "Train voice"}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
