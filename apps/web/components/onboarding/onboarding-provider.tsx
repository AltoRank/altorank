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
import { completeOnboardingStep, dismissOnboarding } from "@/app/actions/onboarding";
import { Icons } from "@/components/ui";
import { OnboardingChecklist } from "./onboarding-checklist";
import { OnboardingSpotlight } from "./onboarding-spotlight";
import { OnboardingTooltip } from "./onboarding-tooltip";

type OnboardingState = "idle" | "spotlighting" | "step-completed" | "completed" | "dismissed";

interface OnboardingContextValue {
  state: OnboardingState;
  completedSteps: Record<string, boolean>;
  activeStepId: StepId | null;
  completeStep: (stepId: StepId) => void;
  dismiss: () => void;
  showStep: (stepId: StepId) => void;
}

export const OnboardingContext = createContext<OnboardingContextValue | null>(
  null
);

interface OnboardingProviderProps {
  children: React.ReactNode;
  initialSteps: Record<string, boolean>;
}

export function OnboardingProvider({
  children,
  initialSteps,
}: OnboardingProviderProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [state, setState] = useState<OnboardingState>("idle");
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

  const completeStep = useCallback(
    async (stepId: StepId, showMessage = false) => {
      const step = ONBOARDING_STEPS.find((s) => s.id === stepId);
      setCompletedSteps((prev) => ({ ...prev, [stepId]: true }));
      setActiveStepId(null);

      if (showMessage && step?.completionMessage) {
        setCompletionMessage(step.completionMessage);
        setState("step-completed");
        completionTimerRef.current = setTimeout(() => {
          setCompletionMessage(null);
          setState("idle");
        }, 3000);
      } else {
        setState("idle");
      }

      const result = await completeOnboardingStep(stepId);
      if (result.allDone) {
        if (completionTimerRef.current) clearTimeout(completionTimerRef.current);
        setCompletionMessage(null);
        setAllDone(true);
        setState("completed");
        autoHideRef.current = setTimeout(() => {
          setState("dismissed");
        }, 2500);
      }
    },
    []
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

  const handleGotIt = useCallback(() => {
    if (activeStepId) {
      completeStep(activeStepId);
    }
  }, [activeStepId, completeStep]);

  const handleNext = useCallback(() => {
    if (!activeStepId) return;

    // Complete current step
    completeStep(activeStepId);

    // Find next incomplete step
    const currentIndex = ONBOARDING_STEPS.findIndex(
      (s) => s.id === activeStepId
    );
    const nextStep = ONBOARDING_STEPS.slice(currentIndex + 1).find(
      (s) => !completedSteps[s.id]
    );

    if (nextStep) {
      // Slight delay so the completion animation plays before spotlight moves
      setTimeout(() => showStep(nextStep.id), 300);
    }
  }, [activeStepId, completedSteps, completeStep, showStep]);

  const handleTargetClick = useCallback(() => {
    // Dismiss the spotlight so the button's native onClick fires (opens modal)
    setActiveStepId(null);
    setState("idle");
  }, []);

  const handleClickOutside = useCallback(() => {
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
    }),
    [state, completedSteps, activeStepId, completeStep, dismiss, showStep]
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
                    onClickOutside={handleClickOutside}
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
                    onGotIt={handleGotIt}
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
