"use client";

import {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { usePathname, useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import {
  ONBOARDING_STEPS,
  type StepId,
} from "./onboarding-steps";
import { useElementRect } from "@/lib/hooks/use-element-rect";
import { dismissOnboarding } from "@/app/actions/onboarding";
import { Icons } from "@/components/ui";
import { OnboardingChecklist } from "./onboarding-checklist";
import { OnboardingSpotlight } from "./onboarding-spotlight";
import { OnboardingTooltip } from "./onboarding-tooltip";

type OnboardingState = "idle" | "spotlighting" | "step-completed" | "completed" | "dismissed";

interface OnboardingContextValue {
  state: OnboardingState;
  completedSteps: Record<string, boolean>;
  activeStepId: StepId | null;
  /** Call when the deed is done, not when the explainer is read. */
  completeStep: (stepId: StepId) => void;
  dismiss: () => void;
  showStep: (stepId: StepId) => void;
  /** Reopen the checklist after it was skipped or finished. */
  openGuide: () => void;
}

export const OnboardingContext = createContext<OnboardingContextValue | null>(
  null
);

interface OnboardingProviderProps {
  children: React.ReactNode;
  /** Counted from the tables by `getCompletedOnboardingSteps`. */
  initialSteps: Record<string, boolean>;
  /** The person asked us to stop showing it. Reopening is still allowed. */
  dismissed: boolean;
}

function allComplete(steps: Record<string, boolean>): boolean {
  return ONBOARDING_STEPS.every((s) => steps[s.id]);
}

export function OnboardingProvider({
  children,
  initialSteps,
  dismissed,
}: OnboardingProviderProps) {
  const router = useRouter();
  const pathname = usePathname();
  // Nothing left to do is the same as skipped, as far as the panel is
  // concerned: an account that finished setup a month ago should not be
  // greeted by a congratulations card on every page load. `openGuide` is how
  // it comes back.
  const [state, setState] = useState<OnboardingState>(
    dismissed || allComplete(initialSteps) ? "dismissed" : "idle"
  );
  const [completedSteps, setCompletedSteps] =
    useState<Record<string, boolean>>(initialSteps);
  const [activeStepId, setActiveStepId] = useState<StepId | null>(null);
  const [allDone, setAllDone] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [completionMessage, setCompletionMessage] = useState<string | null>(null);
  const autoHideRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const completionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeStep = activeStepId
    ? ONBOARDING_STEPS.find((s) => s.id === activeStepId) ?? null
    : null;

  // Only track the target element when we're spotlighting and on the right page
  const shouldTrack =
    state === "spotlighting" && activeStep && pathname === activeStep.route;
  const targetRect = useElementRect(
    shouldTrack ? activeStep!.targetSelector : null
  );

  /**
   * Mark a step done because it was done.
   *
   * Called from the action components - `client-actions`, `keyword-actions`,
   * `connect-actions` and so on - on a successful result. Nothing in the tour
   * itself calls this any more, which was the whole bug: "Got it" wrote to the
   * same store as "connected a CMS", and the checklist could not tell them
   * apart.
   *
   * Local only, and deliberately: the server derives this from the tables on
   * the next load, so there is nothing to write and nothing that can drift.
   * This is the optimistic half, so the tick appears now rather than after a
   * refresh.
   */
  const completeStep = useCallback(
    (stepId: StepId) => {
      const step = ONBOARDING_STEPS.find((s) => s.id === stepId);
      setActiveStepId(null);

      // Built outside the updater on purpose. Timers and other setState calls
      // in a functional updater run twice under StrictMode, which would leave
      // an orphaned timeout behind every completion.
      const next = { ...completedSteps, [stepId]: true };
      setCompletedSteps(next);

      if (allComplete(next)) {
        if (completionTimerRef.current) clearTimeout(completionTimerRef.current);
        setCompletionMessage(null);
        setAllDone(true);
        setState("completed");
        autoHideRef.current = setTimeout(() => setState("dismissed"), 2500);
      } else if (step?.completionMessage) {
        setCompletionMessage(step.completionMessage);
        setState("step-completed");
        completionTimerRef.current = setTimeout(() => {
          setCompletionMessage(null);
          setState("idle");
        }, 3000);
      } else {
        setState("idle");
      }
    },
    [completedSteps]
  );

  const dismiss = useCallback(async () => {
    setState("dismissed");
    await dismissOnboarding();
  }, []);

  const showStep = useCallback(
    (stepId: StepId) => {
      const step = ONBOARDING_STEPS.find((s) => s.id === stepId);
      if (!step) return;

      setActiveStepId(stepId);
      setState("spotlighting");

      // Navigate to the step's route if not already there
      if (pathname !== step.route) {
        router.push(step.route);
      }
    },
    [pathname, router]
  );

  const openGuide = useCallback(() => {
    setActiveStepId(null);
    setAllDone(allComplete(completedSteps));
    setState(allComplete(completedSteps) ? "completed" : "idle");
  }, [completedSteps]);

  /** Close the explainer. Reading it is not doing it, so nothing is ticked. */
  const handleClose = useCallback(() => {
    setActiveStepId(null);
    setState("idle");
  }, []);

  /** Move the spotlight on. Also does not tick anything. */
  const handleNext = useCallback(() => {
    if (!activeStepId) return;
    const currentIndex = ONBOARDING_STEPS.findIndex((s) => s.id === activeStepId);
    const nextStep = ONBOARDING_STEPS.slice(currentIndex + 1).find(
      (s) => !completedSteps[s.id]
    );
    if (nextStep) showStep(nextStep.id);
    else handleClose();
  }, [activeStepId, completedSteps, showStep, handleClose]);

  const handleTargetClick = useCallback(() => {
    // Dismiss the spotlight so the button's native onClick fires (opens modal)
    setActiveStepId(null);
    setState("idle");
  }, []);

  useEffect(() => {
    setMounted(true);
    return () => {
      if (autoHideRef.current) clearTimeout(autoHideRef.current);
      if (completionTimerRef.current) clearTimeout(completionTimerRef.current);
    };
  }, []);

  const value = useMemo(
    () => ({
      state,
      completedSteps,
      activeStepId,
      completeStep,
      dismiss,
      showStep,
      openGuide,
    }),
    [state, completedSteps, activeStepId, completeStep, dismiss, showStep, openGuide]
  );

  const stepIndex = activeStep
    ? ONBOARDING_STEPS.indexOf(activeStep)
    : 0;
  const isLastStep =
    activeStep?.id ===
    ONBOARDING_STEPS[ONBOARDING_STEPS.length - 1].id;

  return (
    <OnboardingContext.Provider value={value}>
      {children}
      {mounted &&
        state !== "dismissed" &&
        createPortal(
          <>
            <AnimatePresence>
              {(state === "idle" || state === "completed" || state === "spotlighting" || state === "step-completed") && (
                <OnboardingChecklist
                  completedSteps={completedSteps}
                  onShowMe={showStep}
                  onDismiss={dismiss}
                  allDone={allDone}
                />
              )}
            </AnimatePresence>

            <AnimatePresence>
              {state === "spotlighting" && targetRect && activeStep && (
                <>
                  <OnboardingSpotlight
                    targetRect={targetRect}
                    targetSelector={activeStep.targetSelector}
                    onClickOutside={handleClose}
                    onTargetClick={handleTargetClick}
                  />
                  <OnboardingTooltip
                    targetRect={targetRect}
                    position={activeStep.tooltipPosition}
                    stepIndex={stepIndex}
                    totalSteps={ONBOARDING_STEPS.length}
                    title={activeStep.title}
                    description={activeStep.description}
                    actionLabel={activeStep.actionLabel}
                    onClose={handleClose}
                    onNext={handleNext}
                    isLastStep={isLastStep}
                  />
                </>
              )}
            </AnimatePresence>

            <AnimatePresence>
              {state === "step-completed" && completionMessage && (
                <motion.div
                  className="fixed top-6 left-1/2 z-[300] -translate-x-1/2 flex items-center gap-2.5 bg-bg border border-ok/30 rounded-lg shadow-lg px-4 py-3"
                  initial={{ y: -20, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  exit={{ y: -20, opacity: 0 }}
                  transition={{ type: "spring", damping: 25, stiffness: 300 }}
                >
                  <span className="w-5 h-5 rounded-full bg-ok/15 inline-grid place-items-center flex-shrink-0">
                    <Icons.check size={12} className="text-ok-ink" />
                  </span>
                  <p className="text-[13px] text-ink">{completionMessage}</p>
                </motion.div>
              )}
            </AnimatePresence>
          </>,
          document.body
        )}
    </OnboardingContext.Provider>
  );
}
