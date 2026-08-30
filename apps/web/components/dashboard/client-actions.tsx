"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Icons, Dialog } from "@/components/ui";
import { useOnboarding } from "@/components/onboarding/use-onboarding";
import { createWorkspace } from "@/app/actions/workspaces";
import { onboardWorkspace } from "@/app/actions/onboard-workspace";

type OnboardStep = "idle" | "creating" | "scraping" | "voice" | "keywords" | "done";

const STEP_LABELS: Record<OnboardStep, string> = {
  idle: "Create workspace",
  creating: "Creating workspace…",
  scraping: "Scanning website…",
  voice: "Training brand voice…",
  keywords: "Discovering keywords…",
  done: "Done!",
};

export function ClientActions() {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<OnboardStep>("idle");
  const onboarding = useOnboarding();
  const router = useRouter();

  const pending = step !== "idle";

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStep("creating");
    try {
      const fd = new FormData(e.currentTarget);
      const hasDomain = !!fd.get("domain");
      const workspaceId = await createWorkspace(fd);

      onboarding?.completeStep("add-client");

      if (hasDomain && workspaceId) {
        // Run onboarding in the background while we show progress
        setStep("scraping");
        const onboardPromise = onboardWorkspace(workspaceId);

        // Animate through steps for feedback
        const timer1 = setTimeout(() => setStep("voice"), 2000);
        const timer2 = setTimeout(() => setStep("keywords"), 4000);

        await onboardPromise;
        clearTimeout(timer1);
        clearTimeout(timer2);

        setStep("done");
        // Brief pause so user sees "Done!" before navigating
        await new Promise((r) => setTimeout(r, 500));
        setOpen(false);
        setStep("idle");
        router.push(`/clients/${workspaceId}`);
      } else {
        setOpen(false);
        setStep("idle");
        router.push(`/clients/${workspaceId}`);
      }
    } catch (err) {
      console.error(err);
      setStep("idle");
    }
  }

  return (
    <>
      <Button disabled>
        <Icons.upload size={14} />
        Import
      </Button>
      <Button
        variant="accent"
        data-onboarding="add-client"
        onClick={() => setOpen(true)}
      >
        <Icons.plus size={14} />
        Add client
      </Button>

      <Dialog
        open={open}
        onOpenChange={(v) => { if (!pending) setOpen(v); }}
        title="Add client"
        description="Create a new workspace for this client."
      >
        <form onSubmit={handleSubmit} className="flex flex-col gap-3.5">
          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-medium text-ink-2">Name</span>
            <input
              name="name"
              required
              disabled={pending}
              placeholder="Acme Corp"
              className="px-3 py-2 rounded-lg border border-line bg-panel text-[13px] text-ink placeholder:text-ink-3 outline-none focus:border-accent transition-colors disabled:opacity-50"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-medium text-ink-2">Domain</span>
            <input
              name="domain"
              disabled={pending}
              placeholder="acme.com"
              className="px-3 py-2 rounded-lg border border-line bg-panel text-[13px] text-ink placeholder:text-ink-3 outline-none focus:border-accent transition-colors disabled:opacity-50"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-medium text-ink-2">Plan</span>
            <select
              name="plan"
              defaultValue="starter"
              disabled={pending}
              className="px-3 py-2 rounded-lg border border-line bg-panel text-[13px] text-ink outline-none focus:border-accent transition-colors disabled:opacity-50"
            >
              <option value="starter">Starter</option>
              <option value="growth">Growth</option>
              <option value="scale">Scale</option>
            </select>
          </label>

          {pending && (
            <div className="flex items-center gap-2 py-2 text-[12.5px] text-ink-2">
              <div className="w-3.5 h-3.5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
              {STEP_LABELS[step]}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" variant="accent" disabled={pending}>
              {pending ? STEP_LABELS[step] : "Create workspace"}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
