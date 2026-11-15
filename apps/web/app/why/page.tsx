import type { Metadata } from "next";
import { createServiceClient } from "@/lib/supabase/server";
import { readWhyParams } from "@/lib/email/why-link";
import { GATE_ANSWER_NOTE_MAX, GATE_REASON_LABELS } from "@/lib/onboarding/gate-answer";
import { resolveWhyAsker } from "@/lib/onboarding/gate-answer-store";
import { GATE_REASONS } from "@/lib/onboarding/step-props";
import { answerWhy } from "./actions";

/**
 * The page a follow-up email's "what stopped you?" link opens.
 *
 * Public and sessionless on purpose, like /hold: the person is reading mail
 * on a phone and has no reason to sign in to say no. The signature in the
 * URL binds the site to the address the mail went to (lib/email/why-link.ts).
 *
 * The GET only asks. Mail security scanners fetch every link in an inbound
 * message, so an answer written while rendering would be a robot's, and the
 * first answer is the one kept. The write is a button's POST (./actions.ts),
 * which checks the signature and the address again.
 */

export const metadata: Metadata = { title: "What stopped you?", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<{ w?: string; e?: string; s?: string; r?: string; done?: string }> };

export default async function WhyPage(props: Props) {
  const sp = await props.searchParams;
  const parsed = readWhyParams(new URLSearchParams({ w: sp.w ?? "", e: sp.e ?? "", s: sp.s ?? "", ...(sp.r ? { r: sp.r } : {}) }));

  if (!parsed.ok) {
    return (
      <Shell title="That link did not work">
        <p className="text-[14px] leading-relaxed text-ink-2">{parsed.reason}</p>
      </Shell>
    );
  }

  if (sp.done) {
    return (
      <Shell title="Thank you">
        <p className="text-[14px] leading-relaxed text-ink-2">That is what we needed to know. Your article stays in your account.</p>
      </Shell>
    );
  }

  const asker = await resolveWhyAsker(createServiceClient(), parsed.workspaceId, parsed.email);
  if (asker.kind !== "ready") {
    return (
      <Shell title="This link is no longer in use">
        <p className="text-[14px] leading-relaxed text-ink-2">
          {asker.kind === "missing" ? "That site is no longer on AltoRank." : "The address in the link is no longer on this account."} Nothing was recorded.
        </p>
      </Shell>
    );
  }

  // The reason the mail's link named comes first, as the button to press.
  const order = parsed.reason ? [parsed.reason, ...GATE_REASONS.filter((r) => r !== parsed.reason)] : [...GATE_REASONS];
  return (
    <Shell title="What stopped you?">
      <p className="text-[14px] leading-relaxed text-ink-2">
        You read the article we wrote{asker.domain ? ` for ${asker.domain}` : ""} and did not start the trial. Pick the one that is closest. Nothing is
        recorded until you press one.
      </p>
      <form action={answerWhy} className="flex flex-col gap-2">
        <input type="hidden" name="w" value={parsed.workspaceId} />
        <input type="hidden" name="e" value={parsed.email} />
        <input type="hidden" name="s" value={sp.s ?? ""} />
        {order.map((reason, i) => (
          <button
            key={reason}
            type="submit"
            name="reason"
            value={reason}
            className={`w-full cursor-pointer rounded-[8px] border px-4 py-2.5 text-left text-[13px] font-medium hover:opacity-90 ${
              parsed.reason && i === 0 ? "border-ink bg-ink text-bg" : "border-line bg-panel text-ink hover:border-ink"
            }`}
          >
            {GATE_REASON_LABELS[reason]}
          </button>
        ))}
        <label className="mt-2 flex flex-col gap-1.5 text-[12.5px] text-ink-3">
          Anything to add? Optional.
          <textarea
            name="note"
            rows={3}
            maxLength={GATE_ANSWER_NOTE_MAX}
            className="w-full rounded-[8px] border border-line bg-panel px-3 py-2 text-[13px] text-ink outline-none focus:border-accent"
          />
        </label>
      </form>
    </Shell>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-[520px] flex-col justify-center gap-4 px-6 py-16">
      <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-ink">{title}</h1>
      {children}
    </main>
  );
}
