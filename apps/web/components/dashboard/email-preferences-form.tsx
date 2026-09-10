"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { setEmailPreference } from "@/app/actions/email-preferences";
import { ALL_OPTIONAL, CATEGORY_HELP, EMAIL_CATEGORIES, type EmailCategory } from "@/lib/email/categories";

/**
 * The switches on Settings > Emails.
 *
 * State is held here and corrected from the server's answer rather than
 * re-read: `unsubscribeAddress` does not always store what it was handed - an
 * address with "all" off that turns one category back on gets the other
 * optional categories written out individually - so the row that comes back is
 * the truth and the optimistic flip is only there to keep the switch from
 * lagging a round trip behind the finger.
 */
export function EmailPreferencesForm({
  email,
  optional,
  initialUnsubscribed,
}: {
  email: string;
  optional: EmailCategory[];
  initialUnsubscribed: string[];
}) {
  const [off, setOff] = useState<string[]>(initialUnsubscribed);
  const [pending, startTransition] = useTransition();
  const allOff = off.includes(ALL_OPTIONAL);
  const isOn = (c: EmailCategory) => !allOff && !off.includes(c);

  function apply(target: EmailCategory | typeof ALL_OPTIONAL, wanted: boolean) {
    const before = off;
    // Optimistic, and deliberately naive: the server's list replaces it below.
    setOff(
      target === ALL_OPTIONAL
        ? wanted
          ? []
          : [ALL_OPTIONAL]
        : wanted
          ? off.filter((c) => c !== target)
          : [...off.filter((c) => c !== ALL_OPTIONAL), target],
    );
    startTransition(async () => {
      const res = await setEmailPreference(target, wanted);
      if (!res.ok) {
        setOff(before);
        toast.error(res.error);
        return;
      }
      setOff(res.unsubscribed);
    });
  }

  return (
    <div className="space-y-5">
      <p className="text-[12.5px] leading-relaxed text-ink-3">
        These apply to <strong className="font-medium text-ink-2">{email}</strong>. A colleague on the
        same account sets their own, and a shared inbox that only receives the monthly report uses the
        link in that email&rsquo;s footer.
      </p>

      <div className="divide-y divide-line rounded-[10px] border border-line">
        {optional.map((c) => {
          const on = isOn(c);
          return (
            <div key={c} className="flex items-center justify-between gap-4 px-4 py-3">
              <div>
                <div className="text-[13px] font-medium text-ink">{EMAIL_CATEGORIES[c].label}</div>
                <div className="text-[12px] text-ink-3">{CATEGORY_HELP[c]}</div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={on}
                aria-label={EMAIL_CATEGORIES[c].label}
                disabled={pending}
                onClick={() => apply(c, !on)}
                className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-60 cursor-pointer ${
                  on ? "bg-accent" : "bg-panel-2"
                }`}
              >
                <span
                  className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
                    on ? "translate-x-4" : "translate-x-0.5"
                  }`}
                />
              </button>
            </div>
          );
        })}
      </div>

      <button
        type="button"
        disabled={pending}
        onClick={() => apply(ALL_OPTIONAL, allOff)}
        className="text-[12.5px] text-ink-3 underline underline-offset-2 hover:text-ink disabled:opacity-60 cursor-pointer"
      >
        {allOff ? "Turn everything back on" : "Turn all of these off"}
      </button>
    </div>
  );
}
