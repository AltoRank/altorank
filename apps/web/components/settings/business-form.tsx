"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button, Card } from "@/components/ui";
import { saveProfile } from "@/app/actions/onboarding-wizard";
import type { BusinessProfile } from "@/lib/onboarding/business-profile";
import { BusinessFields } from "./business-fields";
import { AutocompleteButton } from "./autocomplete-button";

/** The wizard's Business screen as a settings card. Same fields, same save. */
export function BusinessForm({
  workspaceId,
  domain,
  initial,
}: {
  workspaceId: string;
  domain: string;
  initial: BusinessProfile;
}) {
  const router = useRouter();
  const [profile, setProfile] = useState<BusinessProfile>(initial);
  const [pending, start] = useTransition();
  const dirty = JSON.stringify(profile) !== JSON.stringify(initial);

  function save() {
    start(async () => {
      try {
        await saveProfile(workspaceId, profile);
        toast.success("Saved. New drafts describe the business this way from now on.");
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not save.");
      }
    });
  }

  return (
    <Card
      title="This site"
      meta={
        <span className="flex items-center gap-3">
          <span className="font-mono">{domain}</span>
          <AutocompleteButton workspaceId={workspaceId} profile={profile} section="business" onFilled={setProfile} />
        </span>
      }
    >
      <BusinessFields profile={profile} patch={(p) => setProfile((cur) => ({ ...cur, ...p }))} />
      <div className="mt-4 flex items-center justify-end gap-3">
        <span className="text-[12px] text-ink-3">
          Language and market decide where keyword data comes from.
        </span>
        <Button variant="accent" onClick={save} disabled={pending || !dirty}>
          {pending ? "Saving…" : "Save"}
        </Button>
      </div>
    </Card>
  );
}
