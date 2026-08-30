"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Dialog } from "@/components/ui";
import { createVoiceProfile, retrainVoice } from "@/app/actions/voice";

interface VoiceCardButtonProps {
  workspaceId: string;
  trained: boolean;
  hasSample: boolean;
}

export function VoiceCardButton({ workspaceId, trained, hasSample }: VoiceCardButtonProps) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const router = useRouter();

  async function handleTrain(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    try {
      const fd = new FormData(e.currentTarget);
      const sampleText = fd.get("sample_text") as string;
      await createVoiceProfile(workspaceId, sampleText);
      setOpen(false);
      router.refresh();
    } catch (err) {
      console.error(err);
    } finally {
      setPending(false);
    }
  }

  async function handleRetrain() {
    setPending(true);
    try {
      await retrainVoice(workspaceId);
      router.refresh();
    } catch (err) {
      console.error(err);
    } finally {
      setPending(false);
    }
  }

  if (trained) {
    return (
      <Button
        size="sm"
        className="w-full justify-center"
        onClick={handleRetrain}
        disabled={pending}
      >
        {pending ? "Retraining…" : "Edit voice"}
      </Button>
    );
  }

  return (
    <>
      <Button
        size="sm"
        className="w-full justify-center"
        onClick={() => setOpen(true)}
      >
        Train voice
      </Button>

      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Train brand voice"
        description="Paste a writing sample and we'll extract tone, style, and structure rules."
      >
        <form onSubmit={handleTrain} className="flex flex-col gap-3.5">
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
            <Button type="button" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" variant="accent" disabled={pending}>
              {pending ? "Training…" : "Train voice"}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
