"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Button, Icons } from "@/components/ui";
import { proposeProfile } from "@/app/actions/onboarding-wizard";
import { fillEmptyProfile, type BusinessProfile, type ProfileSection } from "@/lib/onboarding/business-profile";

const FIELD_LABEL: Record<keyof BusinessProfile, string> = {
  name: "name",
  language: "language",
  country: "market",
  description: "description",
  audiences: "audiences",
  competitors: "competitors",
};

const FAILURE: Record<string, string> = {
  no_model: "No model is configured on this install, so nothing can be proposed.",
  unreadable: "Could not read enough of the site to propose anything. It may be built with JavaScript or block crawlers.",
  model_failed: "The site was read but the proposal failed. Try again in a moment.",
};

/**
 * "Autocomplete with AI", for the settings tabs.
 *
 * Reads the site the same way the wizard does and fills only the fields that
 * are empty: what someone already typed is theirs. The toast names what was
 * filled, or says why nothing was, and never claims a success it did not have.
 */
export function AutocompleteButton({
  workspaceId,
  profile,
  section,
  onFilled,
}: {
  workspaceId: string;
  profile: BusinessProfile;
  section: ProfileSection;
  onFilled: (next: BusinessProfile) => void;
}) {
  const [pending, start] = useTransition();

  function run() {
    start(async () => {
      try {
        const r = await proposeProfile(workspaceId);
        if (!r.profile) {
          toast.error(FAILURE[r.reason] ?? "Nothing could be proposed.");
          return;
        }
        const { profile: next, filled } = fillEmptyProfile(profile, r.profile, section);
        if (filled.length === 0) {
          toast("Nothing to fill: every field already has a value. Clear one and try again to replace it.");
          return;
        }
        onFilled(next);
        toast.success(`Filled ${filled.map((f) => FIELD_LABEL[f]).join(", ")}. Check it before saving.`);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Autocomplete failed.");
      }
    });
  }

  return (
    <Button type="button" size="sm" onClick={run} disabled={pending}>
      <Icons.sparkle size={13} />
      {pending ? "Reading your site…" : "Autocomplete with AI"}
    </Button>
  );
}
