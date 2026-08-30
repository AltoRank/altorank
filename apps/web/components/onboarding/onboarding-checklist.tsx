"use client";

import { motion, AnimatePresence } from "framer-motion";
import { Button, Icons } from "@/components/ui";
import { ONBOARDING_STEPS, type StepId } from "./onboarding-steps";

interface OnboardingChecklistProps {
  completedSteps: Record<string, boolean>;
  onShowMe: (stepId: StepId) => void;
  onDismiss: () => void;
  allDone: boolean;
}

export function OnboardingChecklist({
  completedSteps,
  onShowMe,
  onDismiss,
  allDone,
}: OnboardingChecklistProps) {
  const doneCount = ONBOARDING_STEPS.filter(
    (s) => completedSteps[s.id]
  ).length;
  const total = ONBOARDING_STEPS.length;
  const progress = doneCount / total;

  return (
    <motion.div
      className="fixed bottom-6 right-6 z-[100] w-[320px] bg-bg border border-line rounded-xl shadow-lg overflow-hidden"
      initial={{ y: 20, opacity: 0, scale: 0.95 }}
      animate={{ y: 0, opacity: 1, scale: 1 }}
      exit={{ y: 20, opacity: 0, scale: 0.95 }}
      transition={{ type: "spring", damping: 25, stiffness: 300 }}
    >
      <AnimatePresence mode="wait">
        {allDone ? (
          <motion.div
            key="done"
            className="p-5 flex flex-col items-center gap-2 text-center"
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.9, opacity: 0 }}
          >
            <motion.span
              className="text-2xl"
              animate={{ scale: [1, 1.3, 1] }}
              transition={{ duration: 0.4 }}
            >
              {Icons.sparkle({ size: 28, className: "text-accent-ink" })}
            </motion.span>
            <p className="text-[14px] font-semibold text-ink">All done!</p>
            <p className="text-[12.5px] text-ink-2">
              You&apos;re all set to start ranking.
            </p>
          </motion.div>
        ) : (
          <motion.div key="steps">
            {/* Header */}
            <div className="flex items-center justify-between px-4 pt-4 pb-2">
              <p className="text-[14px] font-semibold text-ink">
                Welcome to AltoRank
              </p>
              <button
                onClick={onDismiss}
                className="w-6 h-6 inline-grid place-items-center text-ink-3 hover:text-ink transition-colors cursor-pointer rounded hover:bg-panel-2"
              >
                {Icons.x({ size: 14 })}
              </button>
            </div>

            {/* Progress bar */}
            <div className="px-4 pb-3">
              <div className="flex items-center justify-between mb-1.5">
                <div className="h-1 flex-1 bg-panel-2 rounded-full overflow-hidden mr-3">
                  <motion.div
                    className="h-full bg-accent rounded-full"
                    initial={{ width: 0 }}
                    animate={{ width: `${progress * 100}%` }}
                    transition={{ type: "spring", damping: 25, stiffness: 200 }}
                  />
                </div>
                <span className="text-[11px] text-ink-3 font-mono tabular-nums whitespace-nowrap">
                  {doneCount} of {total}
                </span>
              </div>
            </div>

            {/* Divider */}
            <div className="border-t border-line" />

            {/* Steps */}
            <div className="py-1">
              {ONBOARDING_STEPS.map((step) => {
                const done = !!completedSteps[step.id];
                return (
                  <div
                    key={step.id}
                    className="flex items-start gap-2.5 px-4 py-2"
                  >
                    <motion.span
                      className={`mt-0.5 flex-shrink-0 w-[18px] h-[18px] rounded-full inline-grid place-items-center ${
                        done
                          ? "bg-ok/15 text-ok-ink"
                          : "border border-line bg-panel"
                      }`}
                      animate={done ? { scale: [1, 1.3, 1] } : {}}
                      transition={{ duration: 0.2 }}
                    >
                      {done && Icons.check({ size: 12 })}
                    </motion.span>
                    <div className="flex-1 min-w-0">
                      <p
                        className={`text-[13px] ${
                          done
                            ? "text-ink-3 line-through"
                            : "text-ink font-medium"
                        }`}
                      >
                        {step.title}
                      </p>
                      {!done && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="mt-1 text-accent-ink px-0 border-0 hover:bg-transparent hover:text-accent-2"
                          onClick={() => onShowMe(step.id)}
                        >
                          Show me
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Footer */}
            <div className="border-t border-line px-4 py-2.5">
              <button
                onClick={onDismiss}
                className="text-[12.5px] text-ink-3 hover:text-ink transition-colors cursor-pointer"
              >
                Skip setup
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
