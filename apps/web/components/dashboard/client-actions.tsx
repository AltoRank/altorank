"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Icons, Dialog } from "@/components/ui";
import { useOnboarding } from "@/components/onboarding/use-onboarding";
import { createWorkspace } from "@/app/actions/workspaces";

type OnboardStep = "idle" | "creating";

export function ClientActions({
  allowance,
  canAdd = true,
}: {
  allowance?: { limit: number | null; remaining: number | null; noPlan: boolean; used?: number };
  /**
   * False for an editor. Adding a site takes a plan slot and starts drawing on
   * the account's shared article quota, so it is owner/admin like every other
   * allowance-spending action (lib/team/access.ts). The server refuses it
   * either way; this is so the refusal does not arrive after a filled-in form.
   */
  canAdd?: boolean;
}) {
  const atLimit = allowance ? allowance.remaining !== null && allowance.remaining <= 0 : false;
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<OnboardStep>("idle");
  // The refusal, rendered. This used to be a console.error and nothing else,
  // so the workspace limit, a duplicate domain and a malformed domain all
  // looked identical from the dialog: the spinner stopped and nothing moved.
  const [error, setError] = useState<string | null>(null);
  const onboarding = useOnboarding();
  const router = useRouter();

  const pending = step !== "idle";

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

      // Hand the new site to the wizard rather than running the pipeline from
      // inside this dialog.
      //
      // Running it here produced the work twice. createWorkspace writes no
      // business_profile and no onboarded_at, and (dashboard)/layout bounces
      // any scoped workspace in that state to /onboarding - so the moment the
      // person switched to the site they had just watched being set up, they
      // were put through the wizard, whose finish runs the same pipeline
      // again: a second crawl, a second keyword lookup, and a drafting phase
      // that could only report "This workspace already has a draft."
      //
      // The wizard is also the better version of this screen: it reads the
      // site, shows what it found for checking, and ends on the same live run.
      // Same scope cookie the switcher writes, so it opens on the new site.
      // The literal, not lib/workspace-scope's SCOPE_COOKIE: that module is
      // server-only (next/headers). workspace-context.tsx writes it the same way.
      document.cookie = `active_workspace=${result.workspaceId};path=/;max-age=${60 * 60 * 24 * 365};samesite=lax`;
      setOpen(false);
      setStep("idle");
      router.push("/onboarding");
    } catch (err) {
      // Anything left is a genuine transport or runtime failure, and it has to
      // say so in the dialog rather than only in the console.
      console.error(err);
      setError(err instanceof Error ? err.message : "Could not create the workspace. Try again.");
      setStep("idle");
    }
  }

  if (!canAdd) {
    // Nothing rather than a disabled button with an upgrade link: an editor
    // cannot buy the upgrade either, so the only true thing to say is who can.
    return (
      <span className="text-[11.5px] text-ink-3">
        Owners and admins add workspaces.
      </span>
    );
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
            {/* A downgrade leaves more sites than the tier allows and removes
                none of them, so `used` can be past `limit`. "All 3 are in use"
                above a list of five is a sentence the page can see is false. */}
            {allowance?.noPlan
              ? "One workspace before choosing a plan. Choose a plan for more workspaces"
              : allowance?.limit !== null && allowance?.limit !== undefined && (allowance.used ?? 0) > allowance.limit
                ? `This plan includes ${allowance.limit} workspaces and ${allowance.used} are in use. None removed — upgrade for more`
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
        title="Add workspace"
        description="One site or one client. Add the domain and setup opens for it."
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
      </Dialog>
    </>
  );
}
