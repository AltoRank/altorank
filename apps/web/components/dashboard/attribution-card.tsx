"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Card } from "@/components/ui";
import { saveAttribution } from "@/app/actions/attribution";
import { attributionLabel, type AttributionSource } from "@/lib/attribution";
import { AttributionPicker, attributionComplete, type AttributionDraft } from "@/components/onboarding/attribution-picker";

/**
 * The onboarding answer, on Settings, so it can be corrected.
 *
 * Read-only until "Change" is pressed: this is a record of what was said,
 * not a preference to fiddle with, and a page that opens with ten radio
 * tiles invites a second answer from someone who only came to rotate a key.
 * An account that skipped past the wizard before the question existed sees
 * "Not answered" and the same picker, which is how the gap gets filled.
 */
export function AttributionCard({ source, note }: { source: AttributionSource | null; note: string | null }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<AttributionDraft>({ source, note: note ?? "" });
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function save() {
    if (!draft.source) return;
    setError(null);
    start(async () => {
      try {
        await saveAttribution(draft.source!, draft.note);
        setEditing(false);
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not save.");
      }
    });
  }

  const answer = source ? (source === "other" && note ? `Other — ${note}` : attributionLabel(source)) : null;

  return (
    <Card
      title="How you found us"
      meta={
        !editing && (
          <button type="button" className="text-ink-2 underline decoration-line underline-offset-[3px] hover:text-ink" onClick={() => setEditing(true)}>
            {answer ? "Change" : "Answer"}
          </button>
        )
      }
    >
      {editing ? (
        <div className="flex flex-col gap-3">
          <AttributionPicker value={draft} onChange={setDraft} columns={5} />
          {error && <p className="m-0 rounded-lg bg-err-soft px-3 py-2 text-[12.5px] text-err-ink">{error}</p>}
          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => {
                setDraft({ source, note: note ?? "" });
                setEditing(false);
              }}
            >
              Cancel
            </Button>
            <Button type="button" variant="accent" size="sm" onClick={save} disabled={pending || !attributionComplete(draft)}>
              {pending ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      ) : (
        <p className="m-0 text-[13px] text-ink-2">
          {answer ?? <span className="text-ink-3">Not answered. One click tells us where to spend our own effort.</span>}
        </p>
      )}
    </Card>
  );
}
