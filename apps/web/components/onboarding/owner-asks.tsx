"use client";

// ---------------------------------------------------------------------------
// What a first look asks of its owner when it could not finish by itself
// ---------------------------------------------------------------------------
//
// Two endings that used to be "nothing planned" (lib/onboarding/setup-retry.ts):
//
//   proposal        the run found a topic and no published article to check
//                   it against, so it started nothing: the topic, why, and
//                   one button that writes it (app/actions/onboard-proposal.ts)
//   owner-question  nothing says what the site sells: the owner tells us, on
//                   the screen the wizard already has for it, and the run
//                   goes again from their answer

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { writeProposedTopic } from "@/app/actions/onboard-proposal";
import type { StepProposal } from "@/lib/onboarding/events";

export function ProposedTopicBox({ workspaceId, proposal, canStart, onStarted }: {
  workspaceId: string;
  proposal: StepProposal;
  /** An owner or an admin: the server refuses anyone else. */
  canStart: boolean;
  /** The article has started, or is on the calendar: the screen reads the run again. */
  onStarted: () => void;
}) {
  const [pending, start] = useTransition();
  const [said, setSaid] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  return (
    <div className="rounded-[10px] border border-line bg-panel p-4" data-testid="proposed-topic">
      <p className="m-0 text-[11.5px] font-medium uppercase tracking-wide text-ink-3">Proposed first article</p>
      <p className="m-0 mt-1.5 text-[15px] font-medium leading-snug text-ink">{proposal.angle || proposal.term}</p>
      <p className="m-0 mt-1 text-[12.5px] text-ink-3">For the search “{proposal.term}”</p>
      <p className="m-0 mt-3 text-[13px] leading-[1.6] text-ink-2">{proposal.why}</p>
      <p className="m-0 mt-2 text-[12.5px] leading-[1.6] text-ink-3">
        Lower confidence: {proposal.checked === false ? "we could not check this search’s results" : "no published article ranks for this search yet"}, so we did not start it without you. The draft is fact-checked like any other.
      </p>
      {done ? (
        <p role="status" className="m-0 mt-3 text-[13px] text-ink-2">{said}</p>
      ) : canStart ? (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          <Button
            variant="accent"
            disabled={pending}
            onClick={() =>
              start(async () => {
                setSaid(null);
                try {
                  const answer = await writeProposedTopic(workspaceId);
                  if (!answer.ok) return setSaid(answer.message);
                  setDone(true);
                  setSaid(answer.writing ? "Writing it now." : "It is on your calendar and is written by the next nightly pass.");
                  onStarted();
                } catch {
                  setSaid("That did not go through. Try again in a minute.");
                }
              })
            }
          >
            {pending ? "Starting…" : "Write this"}
          </Button>
          {said && <span role="status" className="text-[12.5px] text-ink-3">{said}</span>}
        </div>
      ) : (
        <p className="m-0 mt-3 text-[12.5px] text-ink-3">The account’s owner or an admin can start it.</p>
      )}
    </div>
  );
}

/** Nothing says what the site sells: the way to tell us, and to run setup once more from the answer. */
export function OwnerQuestionBox({ onAnswer }: { onAnswer: () => void }) {
  return (
    <div className="rounded-[10px] border border-line bg-panel p-4" data-testid="owner-question">
      <p className="m-0 text-[14px] font-medium text-ink">What do you sell, and to whom?</p>
      <p className="m-0 mb-3 mt-1.5 text-[13px] leading-[1.6] text-ink-2">
        Your site did not give us enough text to tell. One line on what you sell and one on who buys it is enough: we choose a first article from that and write it. Nothing is charged.
      </p>
      <Button variant="accent" onClick={onAnswer}>
        Tell us and write my first article
      </Button>
    </div>
  );
}
