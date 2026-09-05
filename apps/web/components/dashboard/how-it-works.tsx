"use client";

import { useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { Icons } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import { CANNOT_YET_HEADING, type Explainer } from "@/lib/explainers/types";

/**
 * The "How it works" chip and the dialog behind it.
 *
 * Sits in a page's `PageHead` actions beside the buttons that do things, so
 * the explanation is one click from the control it explains rather than on a
 * docs site nobody opens mid-task. The content is data (lib/explainers) and is
 * held to two rules by a test: every section has three to five bullets, and
 * every explainer ends with what it cannot do yet.
 */
export function HowItWorks({
  explainer,
  label = "How it works",
  className,
}: {
  explainer: Explainer;
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid={`how-it-works-${explainer.id}`}
        className={cn(
          "inline-flex items-center gap-1.5 px-[9px] py-[5px] rounded-full text-[12.5px] text-ink-2",
          "border border-line bg-bg hover:bg-panel-2 hover:text-ink transition-colors cursor-pointer whitespace-nowrap",
          className,
        )}
      >
        <Icons.help size={13} />
        {label}
      </button>

      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={explainer.title}
        description={explainer.intro}
        className="max-w-[640px]"
      >
        {/* The dialog frame is fixed to the viewport, so a long explainer has
            to scroll inside it rather than push the close button off screen. */}
        <div className="max-h-[68vh] overflow-y-auto scroll -mx-1 px-1">
          <ol className="m-0 p-0 list-none flex flex-col gap-5">
            {explainer.sections.map((section, i) => (
              <li key={section.title} className="flex gap-3">
                <span className="shrink-0 w-6 h-6 rounded-full bg-ink text-bg font-mono text-[11px] font-semibold grid place-items-center mt-px">
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <h3 className="m-0 text-[13.5px] font-semibold text-ink">{section.title}</h3>
                  <p className="m-0 mt-0.5 text-[12.5px] text-ink-2 leading-[1.55]">{section.lead}</p>
                  <ul className="m-0 mt-2 p-0 list-none flex flex-col gap-1.5">
                    {section.bullets.map((b) => (
                      <li key={b} className="flex gap-2 text-[12.5px] text-ink-2 leading-[1.55]">
                        <span className="shrink-0 mt-[7px] w-1 h-1 rounded-full bg-ink-4" />
                        <span>{b}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </li>
            ))}
          </ol>

          <div
            className="mt-5 rounded-[9px] border border-line bg-panel px-4 py-3"
            data-testid="cannot-yet"
          >
            <h3 className="m-0 text-[12.5px] font-semibold text-ink">{CANNOT_YET_HEADING}</h3>
            <ul className="m-0 mt-1.5 p-0 list-none flex flex-col gap-1">
              {explainer.cannotYet.map((gap) => (
                <li key={gap} className="flex gap-2 text-[12.5px] text-ink-2 leading-[1.55]">
                  <span className="shrink-0 mt-[7px] w-1 h-1 rounded-full bg-warn" />
                  <span>{gap}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Dialog>
    </>
  );
}
