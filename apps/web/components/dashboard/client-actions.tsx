"use client";

import { useState } from "react";
import Link from "next/link";
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

export function ClientActions({ allowance }: { allowance?: { limit: number | null; remaining: number | null; noPlan: boolean } }) {
  const atLimit = allowance ? allowance.remaining !== null && allowance.remaining <= 0 : false;
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

      onboarding?.completeStep("add-workspace");

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
        router.push(`/workspaces/${workspaceId}`);
      } else {
        setOpen(false);
        setStep("idle");
        router.push(`/workspaces/${workspaceId}`);
      }
    } catch (err) {
      console.error(err);
      setStep("idle");
    }
  }

  return (
    <>
      {atLimit ? (
        <div className="flex flex-col items-end gap-1">
          <Button variant="accent" data-onboarding="add-workspace" disabled>
            <Icons.plus size={14} />
            Add workspace
          </Button>
          <Link href="/settings/billing" className="text-[11.5px] text-accent-ink underline decoration-line underline-offset-[3px]">
            {allowance?.noPlan
              ? "One workspace before choosing a plan. Choose a plan for more sites"
              : `All ${allowance?.limit} workspaces on this plan are in use. Upgrade for more`}
          </Link>
        </div>
      ) : (
        <Button
          variant="accent"
          data-onboarding="add-workspace"
          onClick={() => setOpen(true)}
        >
          <Icons.plus size={14} />
          Add workspace
        </Button>
      )}

      <Dialog
        open={open}
        onOpenChange={(v) => { if (!pending) setOpen(v); }}
        title="Add workspace"
        description="One site or one client. Add the domain and the first analysis starts on its own."
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
              required
              disabled={pending}
              placeholder="acme.com"
              className="px-3 py-2 rounded-lg border border-line bg-panel text-[13px] text-ink placeholder:text-ink-3 outline-none focus:border-accent transition-colors disabled:opacity-50"
            />
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
