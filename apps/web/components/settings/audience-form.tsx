"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button, Card } from "@/components/ui";
import { saveProfile } from "@/app/actions/onboarding-wizard";
import type { BusinessProfile } from "@/lib/onboarding/business-profile";
import { AudienceList, CompetitorList } from "./audience-fields";
import { AutocompleteButton } from "./autocomplete-button";

/**
 * Audiences and competitors, as two cards with one save. The rest of the
 * profile travels along unchanged: `saveProfile` writes the whole object, and
 * the person edited only these two lists.
 */
export function AudienceForm({ workspaceId, initial }: { workspaceId: string; initial: BusinessProfile }) {
  const router = useRouter();
  const [profile, setProfile] = useState<BusinessProfile>(initial);
  const [pending, start] = useTransition();
  const patch = (p: Partial<BusinessProfile>) => setProfile((cur) => ({ ...cur, ...p }));
  const dirty = JSON.stringify(profile) !== JSON.stringify(initial);

  function save() {
    start(async () => {
      try {
        await saveProfile(workspaceId, profile);
        toast.success("Saved. The next keyword research follows these.");
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not save.");
      }
    });
  }

  return (
    <>
      <Card
        title="Audience & Competitors"
        meta={<AutocompleteButton workspaceId={workspaceId} profile={profile} section="audience" onFilled={setProfile} />}
      >
        <p className="m-0 mb-4 text-[12.5px] leading-relaxed text-ink-3">
          These steer which keywords are worth writing for, and every keyword remembers which of them it came
          from. Autocomplete fills only the empty list; what you typed stays.
        </p>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-[10px] border border-line bg-panel p-4">
            <AudienceList profile={profile} patch={patch} />
          </div>
          <div className="rounded-[10px] border border-line bg-panel p-4">
            <CompetitorList profile={profile} patch={patch} />
          </div>
        </div>
        <div className="mt-4 flex justify-end">
          <Button variant="accent" onClick={save} disabled={pending || !dirty}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </div>
      </Card>
    </>
  );
}
