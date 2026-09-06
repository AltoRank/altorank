"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Icons, Dialog } from "@/components/ui";
import { useOnboarding } from "@/components/onboarding/use-onboarding";
import { createWorkspace } from "@/app/actions/workspaces";
import { OnboardingProgress } from "@/components/onboarding/onboarding-progress";

type OnboardStep = "idle" | "creating";

export function ClientActions({ allowance }: { allowance?: { limit: number | null; remaining: number | null; noPlan: boolean } }) {
  const atLimit = allowance ? allowance.remaining !== null && allowance.remaining <= 0 : false;
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<OnboardStep>("idle");
  // The refusal, rendered. This used to be a console.error and nothing else,
  // so the workspace limit, a duplicate domain and a malformed domain all
  // looked identical from the dialog: the spinner stopped and nothing moved.
  const [error, setError] = useState<string | null>(null);
  // Set once a workspace with a domain exists: the dialog then shows the real
  // pipeline running instead of the form, and hands off to the dashboard.
  const [live, setLive] = useState<{ id: string; domain: string } | null>(null);
  const onboarding = useOnboarding();
  const router = useRouter();

  const pending = step !== "idle" || live !== null;

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStep("creating");
    setError(null);
    try {
      const fd = new FormData(e.currentTarget);
      const result = await createWorkspace(fd);
      if (!result.ok) {
        setError(result.error);
        setStep("idle");
        return;
      }

      onboarding?.completeStep("add-workspace");

      // The dialog becomes the progress screen. What used to be here was
      // three labels on fixed timers running alongside a server action of
      // unknown length; the screen now shows the pipeline's own events and
      // navigates when the pipeline says it is done.
      setStep("idle");
      setLive({ id: result.workspaceId, domain: result.domain });
    } catch (err) {
      // Anything left is a genuine transport or runtime failure, and it has to
      // say so in the dialog rather than only in the console.
      console.error(err);
      setError(err instanceof Error ? err.message : "Could not create the workspace. Try again.");
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
        onOpenChange={(v) => { if (!pending) { setOpen(v); setError(null); } }}
        title={live ? "Setting up your workspace" : "Add workspace"}
        description={live ? undefined : "One site or one client. Add the domain and the first analysis starts on its own."}
      >
        {live ? (
          <OnboardingProgress
            workspaceId={live.id}
            domain={live.domain}
            onDone={() => {
              setOpen(false);
              setLive(null);
            }}
          />
        ) : (
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

          {error && (
            <p
              role="alert"
              className="m-0 rounded-[7px] border border-err/40 bg-err-soft px-3 py-2 text-[12.5px] leading-relaxed text-err-ink"
            >
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" variant="accent" disabled={pending}>
              {step === "creating" ? "Creating workspace…" : "Create workspace"}
            </Button>
          </div>
        </form>
        )}
      </Dialog>
    </>
  );
}
